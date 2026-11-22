// Host-side integration test: loads lib/index.mjs against stub @deepseek-ai/*
// packages, runs apply(), instantiates the service, and exercises the recommend
// cache, feedback recording, personalization hint, and memory reset end-to-end.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stubRoot = new URL('../node_modules/@deepseek-ai/', import.meta.url);
mkdirSync(new URL('dsh-typert-protocol/', stubRoot), { recursive: true });
mkdirSync(new URL('dsh-home-paths/', stubRoot), { recursive: true });
writeFileSync(new URL('dsh-typert-protocol/package.json', stubRoot), JSON.stringify({ name: 'x', type: 'module', main: 'index.mjs' }));
writeFileSync(new URL('dsh-typert-protocol/index.mjs', stubRoot), 'export class TypertRemoteService { constructor(ctx, service) { this.ctx = ctx; this.service = service; } }');
writeFileSync(new URL('dsh-home-paths/package.json', stubRoot), JSON.stringify({ name: 'x', type: 'module', main: 'index.mjs' }));
writeFileSync(new URL('dsh-home-paths/index.mjs', stubRoot), `import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; export function resolveDshHome() { return globalThis.__dshStubHome ?? join(tmpdir(), 'dsh-stub-home'); }`);

process.on('exit', () => { try { rmSync(new URL('../node_modules/', import.meta.url), { recursive: true, force: true }); } catch { /* best effort */ } });

const mod = await import(new URL('../lib/index.mjs', import.meta.url));
const { parseReleases, compareVersions } = await import(new URL('../lib/common.mjs', import.meta.url));
const t = (name, cond) => { if (!cond) { console.error('FAIL', name); process.exitCode = 1; } else console.log('ok', name); };

let llmCalls = 0;
const llm = { stream: async function* () {
  llmCalls++;
  yield { type: 'text-delta', index: 0, text: '["先跑一下测试","看看有哪些未提交的改动"]' };
} };
const invocations = [];
const ctx = {
  llm,
  typert: { register: info => invocations.push(...info.invocations.map(item => item.method)) },
  plugin: (cls, cfg) => { ctx.captured = { cls, cfg }; },
};
await mod.apply(ctx, { enabled: true, count: 2, STRAY_HOST_KEY: 'ignored' });
t('stray config key ignored', ctx.captured.cfg.count === 2 && !ctx.captured.cfg.STRAY_HOST_KEY);
t('seven RPCs registered', invocations.length === 7 && invocations.includes('cachedSuggestions') && invocations.includes('resetMemory') && invocations.includes('releaseHistory'));

const service = new ctx.captured.cls({ llm }, { enabled: true, count: 2 });
const input = { sessionId: 's1', replyId: 'r1', provider: 'deepseek', model: 'm',
  turns: [{ user: '帮我修登录的 bug', assistant: '已修复并跑了测试。' }] };
const first = await service.recommend(input);
t('generate + parse', JSON.stringify(first) === JSON.stringify(['先跑一下测试', '看看有哪些未提交的改动']));
await service.recordFeedback({ sessionId: 's1', replyId: 'r1', event: 'shown' });
await service.recordFeedback({ sessionId: 's1', replyId: 'r1', event: 'fill', text: '先跑一下测试' });
const second = await service.recommend(input);
t('cache hit without llm call', llmCalls === 1 && JSON.stringify(second) === JSON.stringify(first));
const patched = await service.applyChipSettings({ STRAY_KEY: 1, keyboard: false });
t('unknown patch keys dropped, keyboard applied', patched.keyboard === false);
const backOn = await service.applyChipSettings({ keyboard: true });
t('keyboard back on', backOn.keyboard === true);
const restored = await service.cachedSuggestions(input);
t('cache-only restore', JSON.stringify(restored) === JSON.stringify(first));
const missed = await service.cachedSuggestions({ ...input, replyId: 'rX' });
t('cache miss → empty, no llm call', missed.length === 0 && llmCalls === 1);
service.overrides = { enabled: false };
t('disabled → cache path returns empty', (await service.recommend(input)).length === 0);
service.overrides = {};
t('hint mentions adopted', service.getConfig().hint.includes('最近被采纳') && service.getConfig().hint.includes('先跑一下测试'));
await service.resetMemory();
t('reset clears hint', service.getConfig().hint === '');

// Release history: sanitizer, version compare, and the TTL-cached host RPC.
t('parseReleases drops drafts/prerelease/bad tags, sorts desc, dedupes',
  JSON.stringify(parseReleases([
    { tag_name: '0.6.0', published_at: '2026-11-22T09:00:00Z', prerelease: true },
    { tag_name: 'v0.5.0', published_at: '2026-11-20T10:00:00Z' },
    { tag_name: '0.4.10', published_at: '2026-11-21T08:00:00Z', draft: true },
    { tag_name: 'not-a-version', published_at: '2026-11-21T08:00:00Z' },
    { tag_name: ' v0.4.9 ', published_at: '2026-11-21T07:00:00Z' },
    { tag_name: 'v0.4.9', published_at: '2026-11-21T06:00:00Z' },
  ])) === JSON.stringify([{ version: '0.5.0', date: '2026-11-20' }, { version: '0.4.9', date: '2026-11-21' }]));
t('compareVersions', compareVersions('0.10.0', '0.9.9') === 1 && compareVersions('1.0.0', '1.0.0') === 0
  && compareVersions('0.4.9', '0.4.10') === -1);
const realFetch = globalThis.fetch;
let releaseFetches = 0;
globalThis.fetch = async () => {
  releaseFetches++;
  return { ok: true, status: 200, json: async () => [
    { tag_name: 'v9.9.9', published_at: '2026-11-22T00:00:00Z' },
    { tag_name: 'v0.4.9', published_at: '2026-11-21T00:00:00Z' },
  ] };
};
try {
  const history = await service.releaseHistory({});
  t('releaseHistory sanitizes', history.releases.length === 2 && history.releases[0].version === '9.9.9' && history.checkedAt > 0);
  const cached = await service.releaseHistory({});
  t('releaseHistory caches within TTL', releaseFetches === 1 && cached.releases.length === 2);
  await service.releaseHistory({ force: true });
  t('releaseHistory force refetches', releaseFetches === 2);
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => null });
  const failure = await service.releaseHistory({ force: true }).then(() => null, error => error);
  t('releaseHistory failure throws (never "up to date")', failure instanceof Error && /403/.test(failure.message));
} finally { globalThis.fetch = realFetch; }
console.log('HOST TEST OK');
