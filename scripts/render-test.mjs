// Render-level smoke test: executes the client bundle's slot components with a
// minimal React stub so render-time crashes (TDZ, lost declarations, bad hook
// order) are caught before an install. The settings section is additionally
// flushed through its async mount flow (mount effects → RPC → state → re-render)
// so the release-history "update available" branch renders for real.
import { readFileSync } from 'node:fs';

const testNodes = [
  { kind: 'user', content: [{ type: 'text', text: '顺便看下注册接口' }] },
  { kind: 'assistant', messageId: 'a1', blocks: [{ kind: 'text', text: '旧回答' }] },
  { kind: 'user', content: [{ type: 'text', text: '帮我修一下登录的 bug' }] },
  { kind: 'assistant', messageId: 'a2', requestConfig: { provider: 'deepseek', model: 'deepseek-flash' },
    blocks: [{ kind: 'text', text: '我先读一下 auth.py' }, { kind: 'tool-call', name: 'read_file' },
      { kind: 'text', text: '找到了,已修复并跑了测试。' }] },
];

function makeReactStub() {
  const slots = [];
  let index = 0;
  const react = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState(init) {
      const i = index++;
      if (slots[i] === undefined) slots[i] = typeof init === 'function' ? init() : init;
      const set = value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; react.__dirty = true; };
      return [slots[i], set];
    },
    useRef(init) {
      const i = index++;
      if (slots[i] === undefined) slots[i] = { current: init };
      return slots[i];
    },
    // Mount semantics: an effect runs once per slot (stable deps ⇒ once per mount).
    // The slot is allocated UNCONDITIONALLY so hook indices stay identical between
    // effects-off and effects-on passes. Opt in with __runEffects to exercise
    // mount-time effects; the dock keeps them inert (they would need a DOM:
    // ResizeObserver, window listeners).
    useEffect(callback) {
      const i = index++;
      slots[i] = true;
      if (react.__runEffects) callback?.();
    },
    useLayoutEffect() {},
    __reset(clear = false) { index = 0; if (clear) slots.length = 0; },
    __dirty: false,
    __runEffects: false,
  };
  return react;
}

const react = makeReactStub();
const fakeRemote = {
  recommend: async () => ({ ok: true, value: [] }),
  cachedSuggestions: async () => ({ ok: true, value: [] }),
  chipSettings: async () => ({ ok: true, value: { enabled: true, count: 3, contextTurns: 3, doubleClickSend: true, hideWhenTyping: true, keyboard: true } }),
  applyChipSettings: async () => ({ ok: true, value: { enabled: true, count: 3, contextTurns: 3, doubleClickSend: true, hideWhenTyping: true, keyboard: true } }),
  recordFeedback: async () => true,
  resetMemory: async () => true,
  releaseHistory: async () => ({ ok: true, value: { releases: [
    { version: '9.9.9', date: '2026-11-22' }, { version: '0.4.9', date: '2026-11-21' },
  ], checkedAt: Date.now() } }),
};
const registered = [];
const slots = {
  inject(name, factory) { factory(); return () => {}; },
  register(options, Component) { registered.push({ options, Component }); return () => {}; },
};

const requireStub = name => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`); };
const fakeWindow = { __ModuleLoader__: { load({ factory }) { globalThis.__dshTestModule = factory(requireStub); } } };
new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(fakeWindow);
const mod = globalThis.__dshTestModule;

await mod.apply({
  remote: { $mount: async () => {} },
  effect: () => () => {},
  locale: { register() {}, bind: () => key => key },
  inject(keys, cb) { if (keys.includes('remote.suggestionChips')) cb({ get: () => fakeRemote, slots }); },
});

function render(slotName, clear = true) {
  const entry = registered.find(item => item.options.name === slotName);
  if (!entry) throw new Error(`slot not registered: ${slotName}`);
  react.__reset(clear);
  return entry.Component({
    sessionId: 's1',
    useInput: sel => sel({ draft: '', draftRev: 0, phase: 'plain', attachmentIds: [], occurrences: [], queue: [] }),
    useSession: sel => sel({ running: false, removed: false }),
    useConversation: sel => sel({ views: new Map([['chat', { legacy: { nodes: testNodes } }]]) }),
    useProjection: (key, sel) => sel({ next: { provider: 'deepseek', model: 'm' } }),
    inputActions: { setDraft() {}, submit() {} },
    ...(entry.options.inject ? entry.options.inject() : {}),
  });
}

function treeText(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const kid of node) treeText(kid, out); return out; }
  if (node && typeof node === 'object') {
    if (typeof node.type === 'string') out.push(node.type);
    for (const kid of node.kids ?? []) treeText(kid, out);
  }
  return out;
}

if (!mod.inject || typeof mod.apply !== 'function') throw new Error('client module exports broken');
render('conversation.input.dock');
console.log('ChipsRow rendered ok');
render('settings.section');
console.log('SettingsSection rendered ok');

// Flush the settings section: mount effects fire once, the release-history RPC
// resolves through real microtask hops, and state re-renders the available branch
// (stub latest 9.9.9 > the built version). A minimal DOM stub covers the
// style-tag effect the flush now exercises.
const styleTags = new Map();
globalThis.document = {
  getElementById: id => styleTags.get(id) ?? null,
  createElement: () => ({}),
  head: { appendChild: () => {} },
};
react.__runEffects = true;
let flushed = null;
for (let i = 0; i < 8; i++) {
  react.__dirty = false;
  flushed = render('settings.section', false);
  await new Promise(resolve => setImmediate(resolve));
  if (!react.__dirty) break;
}
const text = treeText(flushed).join('|');
if (text.includes('正在检查更新')) throw new Error(`settings flush stuck on loading: ${text.slice(0, 300)}`);
if (!text.includes('可更新到 9.9.9')) throw new Error(`available-state render missing headline: ${text.slice(0, 300)}`);
if (!text.includes('发布于 2026-11-22')) throw new Error('available-state render missing release date');
if (!text.includes('latest')) throw new Error(`available-state render missing latest badge: ${text.slice(0, 600)}`);
if (!text.includes('检查于')) throw new Error('available-state render missing checked-at footer');
console.log('SettingsSection flushed through release flow ok');
console.log('RENDER TEST OK');
