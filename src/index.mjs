import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE, SERVICE, descriptor, configDescriptor, setConfigDescriptor, validateConfigValue, CONFIG_KEYS } from './common.mjs';
import { createRecommender } from './engine.mjs';

export const name = PACKAGE;
export const inject = ['llm', 'typert'];

function settingsFile() { return join(resolveDshHome(), 'storages', PACKAGE, 'settings.json'); }

class SuggestionChips extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, SERVICE);
    this.staticConfig = { ...config };
    this.overrides = this.loadOverrides();
    // Live accessor: settings-page changes apply to the very next recommendation.
    this.getConfig = () => this.effective();
    this.generate = createRecommender(ctx.llm, this.getConfig);
  }
  get(key) { return this.overrides[key] !== undefined ? this.overrides[key] : this.staticConfig[key]; }
  effective() {
    return {
      enabled: this.get('enabled') !== false,
      doubleClickSend: this.get('doubleClickSend') !== false,
      hideWhenTyping: this.get('hideWhenTyping') !== false,
      count: this.get('count'),
      contextTurns: this.get('contextTurns'),
      timeoutMs: this.get('timeoutMs'),
      provider: this.get('provider'),
      model: this.get('model'),
    };
  }
  loadOverrides() {
    try {
      const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  saveOverrides() {
    try {
      const file = settingsFile();
      mkdirSync(join(file, '..'), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.overrides, null, 1));
      renameSync(tmp, file);
      return true;
    } catch (error) {
      console.warn('[suggestion-chips] Settings persistence unavailable:', error?.code ?? error?.message ?? 'unknown');
      return false;
    }
  }
  snapshot() {
    const current = this.effective();
    return { enabled: current.enabled, count: current.count, contextTurns: current.contextTurns, doubleClickSend: current.doubleClickSend, hideWhenTyping: current.hideWhenTyping };
  }
  async recommend(input, signal) { return this.generate(input, signal); }
  async chipSettings() { return this.snapshot(); }
  async applyChipSettings(patch, signal) {
    signal?.throwIfAborted?.();
    const normalized = {};
    for (const [key, value] of Object.entries(patch)) normalized[key] = validateConfigValue(key, value);
    this.overrides = { ...this.overrides, ...normalized };
    if (!this.saveOverrides()) throw new Error('Settings could not be persisted to disk');
    return this.snapshot();
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
    invocations: [descriptor(), configDescriptor(), setConfigDescriptor()] });
}
