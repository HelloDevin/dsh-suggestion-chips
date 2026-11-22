import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE, SERVICE, descriptor, cachedSuggestionsDescriptor, configDescriptor, setConfigDescriptor, feedbackDescriptor, resetMemoryDescriptor, releaseHistoryDescriptor, parseReleases, validateConfigValue, CONFIG_KEYS } from './common.mjs';

import { createRecommender } from './engine.mjs';

export const name = PACKAGE;
export const inject = ['llm', 'typert'];

const DATA_DIR = () => join(resolveDshHome(), 'storages', PACKAGE);
const settingsFile = () => join(DATA_DIR(), 'settings.json');
const memoryFile = () => join(DATA_DIR(), 'memory.json');
const MEMORY_MAX_ENTRIES = 400;
const MEMORY_MAX_AGE = 30 * 86400000;
// Release history for the settings-page 版本 section, straight from GitHub Releases.
const RELEASES_URL = 'https://api.github.com/repos/HelloDevin/dsh-suggestion-chips/releases?per_page=30';
const RELEASE_TTL_MS = 30 * 60000;

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } }
function writeJsonAtomic(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, file);
}

class SuggestionChips extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, SERVICE);
    this.staticConfig = { ...config };
    this.overrides = this.loadOverrides();
    this.cache = this.loadMemory();
    this.persistTimer = null;
    this.releaseCache = null;
    // Live accessor: settings-page changes and the memory hint apply immediately.
    this.getConfig = () => ({ ...this.effective(), hint: this.buildHint() });
    this.generate = createRecommender(ctx.llm, this.getConfig);
  }
  get(key) { return this.overrides[key] !== undefined ? this.overrides[key] : this.staticConfig[key]; }
  effective() {
    return {
      enabled: this.get('enabled') !== false,
      doubleClickSend: this.get('doubleClickSend') !== false,
      hideWhenTyping: this.get('hideWhenTyping') !== false,
      keyboard: this.get('keyboard') !== false,
      count: this.get('count'),
      contextTurns: this.get('contextTurns'),
      timeoutMs: this.get('timeoutMs'),
      provider: this.get('provider'),
      model: this.get('model'),
    };
  }
  loadOverrides() {
    const parsed = readJson(settingsFile());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  saveOverrides() {
    try { writeJsonAtomic(settingsFile(), this.overrides); return true; }
    catch (error) { console.warn('[suggestion-chips] Settings persistence unavailable:', error?.code ?? error?.message ?? 'unknown'); return false; }
  }
  loadMemory() {
    const map = new Map();
    const parsed = readJson(memoryFile());
    const entries = parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    const now = Date.now();
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object' || typeof entry.ts !== 'number') continue;
      if (now - entry.ts > MEMORY_MAX_AGE) continue;
      map.set(key, entry);
    }
    while (map.size > MEMORY_MAX_ENTRIES) map.delete(map.keys().next().value);
    return map;
  }
  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try { writeJsonAtomic(memoryFile(), { entries: Object.fromEntries(this.cache) }); }
      catch (error) { console.warn('[suggestion-chips] Memory persistence unavailable:', error?.code ?? error?.message ?? 'unknown'); }
    }, 800);
    this.persistTimer.unref?.();
  }
  staticKey(sessionId, replyId) { return `${sessionId}::${replyId}`; }
  // Short, local-data-driven preference note appended to the system prompt: what the
  // user adopted vs ignored recently, so suggestions converge on their habits.
  buildHint() {
    const now = Date.now();
    const adopted = [], ignored = [];
    for (const entry of this.cache.values()) {
      if (!entry || typeof entry.ts !== 'number' || now - entry.ts > MEMORY_MAX_AGE) continue;
      for (const item of Array.isArray(entry.items) ? entry.items : []) {
        if (typeof item.text !== 'string' || !item.text) continue;
        if ((item.state === 'fill' || item.state === 'send') && !adopted.includes(item.text) && adopted.length < 5) adopted.push(item.text);
        else if (item.state === 'shown' && !ignored.includes(item.text) && !adopted.includes(item.text) && ignored.length < 3) ignored.push(item.text);
      }
    }
    // One adoption is already a signal; ignored-only needs a bit more evidence.
    if (adopted.length < 1 && ignored.length < 2) return '';
    const parts = [];
    if (adopted.length) parts.push(`最近被采纳:「${adopted.join('」「')}」`);
    if (ignored.length) parts.push(`最近未被理会:「${ignored.join('」「')}」`);
    return `用户对以往建议的反馈(供参考,优先给出与被采纳风格一致、可立即执行的具体下一步):${parts.join(';')}。`;
  }
  snapshot() {
    const current = this.effective();
    return { enabled: current.enabled, count: current.count, contextTurns: current.contextTurns, doubleClickSend: current.doubleClickSend, hideWhenTyping: current.hideWhenTyping, keyboard: current.keyboard };
  }
  async recommend(input, signal) {
    if (this.getConfig().enabled === false) return []; // The cache path must honor the toggle too.
    const key = this.staticKey(input.sessionId, input.replyId);
    const entry = this.cache.get(key);
    if (entry && Array.isArray(entry.suggestions) && entry.suggestions.length) return entry.suggestions;
    const list = await this.generate(input, signal);
    if (list.length) {
      this.cache.set(key, { sessionId: input.sessionId, replyId: input.replyId, suggestions: list,
        items: entry?.items, ts: Date.now() });
      this.schedulePersist();
    }
    return list;
  }
  // Cache-only restore for replies that predate this view: never a model call.
  async cachedSuggestions(input, signal) {
    signal?.throwIfAborted?.();
    if (this.getConfig().enabled === false) return [];
    const entry = this.cache.get(this.staticKey(input.sessionId, input.replyId));
    if (entry && !entry.dismissed && Array.isArray(entry.suggestions) && entry.suggestions.length) return entry.suggestions;
    return [];
  }
  async chipSettings() { return this.snapshot(); }
  async applyChipSettings(patch, signal) {
    signal?.throwIfAborted?.();
    const normalized = {};
    if (patch && typeof patch === 'object') {
      for (const [key, value] of Object.entries(patch)) {
        if (!CONFIG_KEYS.includes(key)) continue; // forward-compatible: drop unknown keys
        normalized[key] = validateConfigValue(key, value);
      }
    }
    if (Object.keys(normalized).length) {
      this.overrides = { ...this.overrides, ...normalized };
      if (!this.saveOverrides()) throw new Error('Settings could not be persisted to disk');
    }
    return this.snapshot();
  }
  async recordFeedback(event, signal) {
    signal?.throwIfAborted?.();
    const key = this.staticKey(event.sessionId, event.replyId);
    const entry = this.cache.get(key) || { sessionId: event.sessionId, replyId: event.replyId, ts: Date.now() };
    if (event.text !== undefined) {
      entry.items = Array.isArray(entry.items) ? entry.items : [];
      let item = entry.items.find(candidate => candidate.text === event.text);
      if (!item) { item = { text: event.text, state: 'shown' }; entry.items.push(item); }
      if (event.event !== 'shown') item.state = event.event;
    } else if (event.event === 'shown') {
      entry.items = Array.isArray(entry.items) && entry.items.length
        ? entry.items
        : (entry.suggestions ?? []).map(text => ({ text, state: 'shown' }));
    }
    entry.ts = Date.now();
    this.cache.set(key, entry);
    this.schedulePersist();
    return true;
  }
  async resetMemory() {
    this.cache = new Map();
    this.generate.clearCache?.(); // Also drop the engine's in-memory result cache.
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    try { rmSync(memoryFile(), { force: true }); } catch { /* nothing to clean */ }
    return true;
  }
  // GitHub Releases with a 30-minute TTL so reopening the settings page does not
  // re-fetch; `force` bypasses the cache. Failures throw — the client renders them
  // as 检查失败 with a retry, never as "up to date".
  async releaseHistory(options, signal) {
    signal?.throwIfAborted?.();
    const now = Date.now();
    if (!options?.force && this.releaseCache && now - this.releaseCache.at < RELEASE_TTL_MS) {
      return { releases: this.releaseCache.list, checkedAt: this.releaseCache.at };
    }
    const response = await fetch(RELEASES_URL, {
      headers: { 'user-agent': 'dsh-suggestion-chips', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`GitHub Releases HTTP ${response.status}`);
    const list = parseReleases(await response.json());
    this.releaseCache = { at: now, list };
    return { releases: list, checkedAt: now };
  }
}

export function apply(ctx, config = {}) {
  // Validate only the keys we own and ignore anything else the host adds to the
  // composed entry — rejecting unknown keys would take the whole plugin down.
  const normalized = {};
  if (config && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (!CONFIG_KEYS.includes(key)) continue;
      normalized[key] = validateConfigValue(key, value);
    }
  }
  ctx.plugin(SuggestionChips, normalized);
  ctx.typert.register({ package: PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [descriptor(), cachedSuggestionsDescriptor(), configDescriptor(), setConfigDescriptor(), feedbackDescriptor(), resetMemoryDescriptor(), releaseHistoryDescriptor()] });
}
