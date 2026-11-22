window.__ModuleLoader__.load({id:'dsh-suggestion-chips',factory:function(require){
'use strict';
var module={exports:{}};var exports=module.exports;
var PLUGIN_VERSION="0.4.4";
const PACKAGE = 'dsh-suggestion-chips';
const SERVICE = 'suggestionChips';
const CONTEXT_LIMITS = { latest: { user: 400, assistant: 1200 }, older: { user: 200, assistant: 500 }, tools: 140 };
const SUGGESTION_LIMITS = { maxItems: 4, maxChars: 80 };
const CONFIG_KEYS = ['enabled', 'doubleClickSend', 'hideWhenTyping', 'keyboard', 'count', 'contextTurns', 'timeoutMs', 'provider', 'model'];

// Keep the topic and the closing next step; omit code locally, without a summary model call.
function compactContext(text, limit) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; kept.push('[代码略]'); }
    else kept.push(line);
  }
  const characters = Array.from(kept.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  if (characters.length <= limit) return characters.join('');
  const separator = '\n[中间略]\n';
  const available = limit - separator.length;
  const head = Math.floor(available / 3);
  return characters.slice(0, head).join('') + separator + characters.slice(-(available - head)).join('');
}

function normalizeSuggestionItem(value, maxChars = SUGGESTION_LIMITS.maxChars) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (text.startsWith('```')) return '';
  text = text.replace(/^["“「『]|["”」』]$/g, '').trim();
  if (!text || /[\r\n]/.test(text) || text.length > maxChars || text.startsWith('/')) return '';
  return text;
}

// Parse the model output into at most `count` clean, deduplicated candidates.
// Accepts a JSON array (possibly inside a fence or prose), and falls back to plain lines.
function parseSuggestions(raw, count) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return [];
  const fenced = text.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const collected = [];
  const attempt = source => {
    try {
      const parsed = JSON.parse(source);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (typeof item === 'string') collected.push(item);
        else if (item && typeof item === 'object' && typeof item.text === 'string') collected.push(item.text);
      }
    } catch { /* fall through to line splitting */ }
  };
  attempt(fenced);
  if (!collected.length) {
    const start = fenced.indexOf('[');
    const end = fenced.lastIndexOf(']');
    if (start !== -1 && end > start) attempt(fenced.slice(start, end + 1));
  }
  let items = collected;
  if (!items.length) {
    items = fenced.split(/[\r\n]+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, ''));
  }
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const clean = normalizeSuggestionItem(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
    if (result.length >= count) break;
  }
  return result;
}

function toolLabel(block) {
  if (!block || typeof block !== 'object') return '';
  const name = block.name ?? block.tool ?? block.toolName ?? block.title ?? '';
  return typeof name === 'string' ? name.trim().slice(0, 40) : '';
}

// Collect up to `maxTurns` recent (user, assistant) turns, newest first.
// Unlike the jabingu original, tool-call turns qualify: the assistant text plus a
// compact tool-activity line gives the recommender enough context during agent runs.
function selectContext(nodes, sessionId, selectedModel, maxTurns = 3) {
  if (!Array.isArray(nodes)) return null;
  const turns = [];
  let meta = null; // provider/model + replyId come from the newest usable assistant node
  let i = nodes.length - 1;
  while (i >= 0 && turns.length < maxTurns) {
    const node = nodes[i];
    if (!node || typeof node !== 'object' || node.kind !== 'assistant') { i -= 1; continue; }
    const blocks = Array.isArray(node.blocks) ? node.blocks : [];
    const text = blocks.filter(block => block && block.kind === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n').trim();
    const tools = blocks.filter(block => block && block.kind === 'tool-call').map(toolLabel).filter(Boolean)
      .join(', ').slice(0, CONTEXT_LIMITS.tools);
    if (!text && !tools) { i -= 1; continue; }
    let user = '';
    let boundary = i - 1;
    while (boundary >= 0) {
      const candidate = nodes[boundary];
      if (!candidate || typeof candidate !== 'object') { boundary -= 1; continue; }
      if (candidate.kind === 'user' || candidate.kind === 'steering') {
        const content = Array.isArray(candidate.content) ? candidate.content : [];
        user = content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join('\n');
        break;
      }
      if (candidate.kind === 'assistant') break; // consecutive assistant nodes share the user above them
      boundary -= 1;
    }
    if (!meta) {
      const model = node.requestConfig ?? node.providerMetadata ?? selectedModel;
      if (model?.provider && model?.model) meta = { provider: model.provider, model: model.model, replyId: String(node.messageId ?? node.seq) };
    }
    const limits = turns.length === 0 ? CONTEXT_LIMITS.latest : CONTEXT_LIMITS.older;
    turns.push({ user: compactContext(user, limits.user), assistant: compactContext(text, limits.assistant), ...(tools ? { tools } : {}) });
    i = boundary;
  }
  if (!meta || !turns.length) return null;
  return { sessionId, replyId: meta.replyId, provider: meta.provider, model: meta.model, turns };
}

function validateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid recommendation input');
  const allowed = new Set(['sessionId', 'replyId', 'provider', 'model', 'turns']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('Unknown recommendation field');
  for (const key of ['sessionId', 'replyId', 'provider', 'model']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 512) throw new TypeError(`Invalid ${key}`);
  }
  if (!Array.isArray(value.turns) || value.turns.length === 0 || value.turns.length > 4) throw new TypeError('Invalid turns');
  for (const turn of value.turns) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new TypeError('Invalid turn');
    if (Object.keys(turn).some(key => key !== 'user' && key !== 'assistant' && key !== 'tools')) throw new TypeError('Unknown turn field');
    if (typeof turn.user !== 'string' || turn.user.length > 2000) throw new TypeError('Invalid turn user');
    if (typeof turn.assistant !== 'string' || turn.assistant.length > 12000) throw new TypeError('Invalid turn assistant');
    if (!turn.assistant.trim() && !turn.tools) throw new TypeError('Empty turn');
    if (turn.tools !== undefined && (typeof turn.tools !== 'string' || turn.tools.length > 200)) throw new TypeError('Invalid turn tools');
  }
  return { ...value, turns: value.turns.map(turn => ({ ...turn })) };
}

function validateConfigValue(key, value) {
  switch (key) {
    case 'enabled': case 'doubleClickSend': case 'hideWhenTyping': case 'keyboard':
      if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`);
      return value;
    case 'count': case 'contextTurns':
      if (!Number.isInteger(value) || value < 1 || value > 4) throw new TypeError(`${key} must be an integer between 1 and 4`);
      return value;
    case 'timeoutMs':
      if (!Number.isInteger(value) || value < 1000 || value > 60000) throw new TypeError('timeoutMs must be an integer between 1000 and 60000');
      return value;
    case 'provider': case 'model':
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${key} must be a nonempty string`);
      return value;
    default:
      throw new TypeError(`Unknown config key: ${key}`);
  }
}

function validateConfigPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid config patch');
  const patch = {};
  // Unknown keys are dropped, not rejected: a newer client may send keys an older
  // host does not know, and failing the whole patch would desync the settings UI.
  for (const [key, item] of Object.entries(value)) {
    if (!CONFIG_KEYS.includes(key)) continue;
    patch[key] = validateConfigValue(key, item);
  }
  return patch;
}

function validateClientConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid client config');
  for (const key of ['enabled', 'doubleClickSend', 'hideWhenTyping']) {
    if (typeof value[key] !== 'boolean') throw new TypeError(`Invalid ${key}`);
  }
  // `keyboard` arrived in 0.4.1: tolerate snapshots from older hosts (default on).
  if (value.keyboard !== undefined && typeof value.keyboard !== 'boolean') throw new TypeError('Invalid keyboard');
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > 4) throw new TypeError('Invalid count');
  if (!Number.isInteger(value.contextTurns) || value.contextTurns < 1 || value.contextTurns > 4) throw new TypeError('Invalid contextTurns');
  return { enabled: value.enabled, count: value.count, contextTurns: value.contextTurns, doubleClickSend: value.doubleClickSend, hideWhenTyping: value.hideWhenTyping, keyboard: value.keyboard !== false };
}

function descriptor() {
  return {
    id: `${PACKAGE}#recommend`, service: SERVICE, namespace: SERVICE, method: 'recommend',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#Input`, create: () => ({ parse: validateInput }),
    } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#Suggestions`, create: () => ({
      parse: value => {
        if (!Array.isArray(value) || value.length > SUGGESTION_LIMITS.maxItems
          || value.some(item => typeof item !== 'string' || !item || item.length > SUGGESTION_LIMITS.maxChars)) {
          throw new TypeError('Invalid suggestions');
        }
        return value;
      },
    }) },
  };
}

function cachedSuggestionsDescriptor() {
  const base = descriptor();
  return { ...base, id: `${PACKAGE}#cachedSuggestions`, method: 'cachedSuggestions' };
}

function configDescriptor() {
  return { id: `${PACKAGE}#chipSettings`, service: SERVICE, namespace: SERVICE, method: 'chipSettings',
    invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#ClientConfig`, create: () => ({ parse: validateClientConfig }) } };
}

function setConfigDescriptor() {
  return { id: `${PACKAGE}#applyChipSettings`, service: SERVICE, namespace: SERVICE, method: 'applyChipSettings',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#ConfigPatch`, create: () => ({ parse: validateConfigPatch }),
    } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#ClientConfig`, create: () => ({ parse: validateClientConfig }) } };
}

const FEEDBACK_EVENTS = ['shown', 'fill', 'send'];

function validateFeedback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid feedback');
  const allowed = new Set(['sessionId', 'replyId', 'event', 'text']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('Unknown feedback field');
  for (const key of ['sessionId', 'replyId']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 512) throw new TypeError(`Invalid ${key}`);
  }
  if (!FEEDBACK_EVENTS.includes(value.event)) throw new TypeError('Invalid feedback event');
  if (value.text !== undefined && (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 200)) throw new TypeError('Invalid feedback text');
  return { sessionId: value.sessionId, replyId: value.replyId, event: value.event, ...(value.text !== undefined ? { text: value.text.trim() } : {}) };
}

function feedbackDescriptor() {
  return { id: `${PACKAGE}#recordFeedback`, service: SERVICE, namespace: SERVICE, method: 'recordFeedback',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'event', wire: 'event', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#Feedback`, create: () => ({ parse: validateFeedback }),
    } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#Ack`, create: () => ({ parse: value => {
      if (value !== true) throw new TypeError('Unexpected result'); return value;
    } }) } };
}

function resetMemoryDescriptor() {
  return { id: `${PACKAGE}#resetMemory`, service: SERVICE, namespace: SERVICE, method: 'resetMemory',
    invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#Ack`, create: () => ({ parse: value => {
      if (value !== true) throw new TypeError('Unexpected result'); return value;
    } }) } };
}

const { createElement: h, useEffect, useLayoutEffect, useRef, useState } = require('react');

const NS = 'suggestion-chips';
const DICTIONARIES = {
  zh: {
    'settings.nav': '建议追问',
    'settings.title': '建议追问 Chips',
    'settings.subtitle': 'AI 回复后在输入框上方显示建议追问:单击填入,双击直接发送。',
    'settings.enabled': '启用建议追问',
    'settings.doubleClickSend': '双击直接发送',
    'settings.hideWhenTyping': '开始打字时隐藏建议',
    'settings.keyboard': '键盘快捷键(↑ 激活,←→ 选择,Enter 填入,Ctrl+Enter 发送)',
    'settings.count': '每轮建议条数',
    'settings.group.behavior': '建议行为',
    'settings.group.interaction': '交互',
    'settings.group.data': '本地数据',
    'settings.resetMemoryDesc': '删除本机记录的采纳历史与建议缓存(保留 30 天)',
    'settings.resetMemory': '清空采纳记忆与建议缓存',
    'settings.resetMemoryShort': '清空',
    'settings.memoryCleared': '已清空',
    'settings.loading': '正在读取设置…',
    'settings.saved': '已保存',
    'settings.saveFailed': '保存失败，请重试',
  },
  en: {
    'settings.nav': 'Suggestion Chips',
    'settings.title': 'Suggestion Chips',
    'settings.subtitle': 'Follow-up suggestions appear above the composer after each reply: click to fill, double-click to send.',
    'settings.enabled': 'Enable suggestion chips',
    'settings.doubleClickSend': 'Send on double-click',
    'settings.hideWhenTyping': 'Hide suggestions while typing',
    'settings.keyboard': 'Keyboard shortcuts (↑ activate, ←→ move, Enter fill, Ctrl+Enter send)',
    'settings.count': 'Suggestions per turn',
    'settings.group.behavior': 'Suggestions',
    'settings.group.interaction': 'Interaction',
    'settings.group.data': 'Local data',
    'settings.resetMemoryDesc': 'Deletes the locally stored adoption history and suggestion cache (30-day window)',
    'settings.resetMemory': 'Clear adoption memory & cache',
    'settings.resetMemoryShort': 'Clear',
    'settings.memoryCleared': 'Cleared',
    'settings.loading': 'Loading settings…',
    'settings.saved': 'Saved',
    'settings.saveFailed': 'Save failed, please retry',
  },
};
const FALLBACK = DICTIONARIES.zh;

const STYLE_TAG_ID = 'dsh-suggestion-chips-style';
let styleUsers = 0;

// Dock geometry mirrors the host's own dock entries: match the composer card width,
// wrap instead of scrolling, and stay opaque so transcript content never shows through.
const CSS_TEXT = `
.dsh-suggestion-chips-dock {
  box-sizing: border-box;
  flex: none;
  max-width: 100%;
  margin: 0 auto;
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  pointer-events: none;
  margin-bottom: calc(-1 * var(--dsh-composer-stack-gap, 6px));
  transition: grid-template-rows .22s ease, opacity .18s ease, margin-bottom .22s ease;
}
.dsh-suggestion-chips-dock.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
  pointer-events: auto;
  margin-bottom: 0;
}
/* Send-moment exit: fade only, keep the height, snap closed while invisible. */
.dsh-suggestion-chips-dock.is-fading {
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease;
}
.dsh-suggestion-chips-dock.no-anim {
  transition: none !important;
}
.dsh-suggestion-chips-collapse {
  overflow: hidden;
  min-height: 0;
}
.dsh-suggestion-chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 3px 0 3px 2px;
  background: var(--dsw-alias-bg-base, #fff);
  border-radius: 6px 6px 0 0;
}
.dsh-suggestion-chips-bubble {
  box-sizing: border-box;
  flex: none;
  max-width: 100%;
  overflow: hidden;
  padding: 5px 10px;
  border: 1px solid var(--dsw-alias-border-l1, #d8dce2);
  border-radius: 13px;
  background: var(--dsw-specific-tip, rgba(127, 136, 153, 0.12));
  color: var(--dsw-alias-label-primary, #23262d);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform-origin: 0% 100%;
  /* Staggered entry, BaoCode-style: rise from the lower corner first, fade in just after. */
  animation: dsh-suggestion-chips-in .48s cubic-bezier(.215, .61, .355, 1) both;
  transition: background-color .15s ease-out, border-color .15s ease-out;
}
/* Kill the UA focus ring on chips: the is-kbd border is the single selection indicator. */
.dsh-suggestion-chips-bubble:focus,
.dsh-suggestion-chips-bubble:focus-visible { outline: none; }
@keyframes dsh-suggestion-chips-in {
  0% { opacity: 0; transform: translateY(10px) scale(.94); }
  20% { opacity: 0; transform: translateY(7px) scale(.95); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-suggestion-chips-bubble { animation: none; }
}
.dsh-suggestion-chips-bubble:hover {
  border-color: var(--dsw-alias-state-business-primary, #2f6fed);
  background: var(--dsw-alias-interactive-bg-hover, rgba(47, 111, 237, 0.12));
}
.dsh-suggestion-chips-bubble.is-kbd {
  border-color: var(--dsw-alias-state-business-primary, #2f6fed);
  background: var(--dsw-alias-interactive-bg-hover, rgba(47, 111, 237, 0.12));
}
/* Settings UI: card rows + iOS-style switches, themed via dsw alias vars. */
.dsh-suggestion-chips-head { display: flex; align-items: center; gap: 12px; margin: 4px 0 14px; }
.dsh-suggestion-chips-head-icon {
  width: 40px; height: 40px; flex: none; border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2f6fed) 12%, transparent);
  display: flex; align-items: center; justify-content: center; font-size: 19px;
}
.dsh-suggestion-chips-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #23262d); }
.dsh-suggestion-chips-subtitle { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #5c6470); margin-top: 2px; }
.dsh-suggestion-chips-group { font-size: 12px; color: var(--dsw-alias-label-tertiary, #68707d); margin: 16px 2px 6px; }
.dsh-suggestion-chips-card {
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #e2e5ea);
  border-radius: 12px; overflow: hidden;
}
.dsh-suggestion-chips-setrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; }
.dsh-suggestion-chips-card .dsh-suggestion-chips-setrow + .dsh-suggestion-chips-setrow { border-top: 1px solid color-mix(in srgb, currentColor 7%, transparent); }
label.dsh-suggestion-chips-setrow { cursor: pointer; }
.dsh-suggestion-chips-rowlabel { font-size: 13px; color: var(--dsw-alias-label-primary, #23262d); }
.dsh-suggestion-chips-rowdesc { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #68707d); margin-top: 2px; }
.dsh-suggestion-chips-switch { position: relative; display: inline-block; width: 38px; height: 21px; flex: none; }
.dsh-suggestion-chips-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.dsh-suggestion-chips-track { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-border-l2, #c9ced6); transition: background .18s ease; }
.dsh-suggestion-chips-track::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px;
  border-radius: 999px; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25);
  transition: transform .18s ease;
}
.dsh-suggestion-chips-switch input:checked ~ .dsh-suggestion-chips-track { background: var(--dsw-alias-state-business-primary, #2f6fed); }
.dsh-suggestion-chips-switch input:checked ~ .dsh-suggestion-chips-track::after { transform: translateX(17px); }
.dsh-suggestion-chips-switch input:disabled ~ .dsh-suggestion-chips-track { opacity: .45; }
.dsh-suggestion-chips-select {
  color: var(--dsw-alias-label-primary, #23262d); background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, #d8dce2); border-radius: 8px;
  padding: 4px 8px; font-size: 13px;
}
.dsh-suggestion-chips-ghostbtn {
  color: var(--dsw-alias-label-primary, #23262d); background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, #d8dce2); border-radius: 8px;
  padding: 5px 12px; font-size: 12.5px; cursor: pointer;
}
.dsh-suggestion-chips-ghostbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(47, 111, 237, .08)); }
.dsh-suggestion-chips-ghostbtn:disabled { opacity: .5; cursor: default; }
.dsh-suggestion-chips-msg { margin: 10px 2px 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #5c6470); }
`;

// 2D chip navigation: chips are grouped into rows by their rendered position;
// ←→ move within the row (wrapping at both ends), ↑↓ jump to the nearest chip in
// the row above/below (wrapping top↔bottom for a single row).
function moveChipSelection(index, key, container) {
  const chips = container ? Array.from(container.querySelectorAll('.dsh-suggestion-chips-bubble')) : [];
  const n = chips.length;
  if (!n) return index;
  if (key === 'ArrowLeft') return (index - 1 + n) % n;
  if (key === 'ArrowRight') return (index + 1) % n;
  const rects = chips.map(node => node.getBoundingClientRect());
  const centerX = i => rects[i].left + rects[i].width / 2;
  const centerY = i => rects[i].top + rects[i].height / 2;
  const rows = [];
  rects.forEach((_, i) => {
    const row = rows.find(list => Math.abs(centerY(list[0]) - centerY(i)) <= rects[i].height / 2 + 2);
    if (row) row.push(i); else rows.push([i]);
  });
  rows.sort((a, b) => centerY(a[0]) - centerY(b[0]));
  const rowIndex = Math.max(0, rows.findIndex(list => list.includes(index)));
  const step = key === 'ArrowDown' ? 1 : -1;
  const targetRow = rows[(rowIndex + step + rows.length) % rows.length];
  if (!targetRow || targetRow === rows[rowIndex]) return step === 1 ? 0 : n - 1;
  let best = targetRow[0], bestDist = Infinity;
  for (const i of targetRow) {
    const dist = Math.abs(centerX(i) - centerX(index));
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

function useComputedStyleTag() {
  useEffect(() => {
    styleUsers += 1;
    if (document.getElementById(STYLE_TAG_ID) === null) {
      const tag = document.createElement('style');
      tag.id = STYLE_TAG_ID;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
    }
    return () => {
      styleUsers -= 1;
      if (styleUsers !== 0) return;
      document.getElementById(STYLE_TAG_ID)?.remove();
    };
  }, []);
}

function ChipsRow({ sessionId, useInput, useSession, useConversation, useProjection, inputActions, generate, restoreOrGenerate, remote, t }) {
  const tr = typeof t === 'function' ? t : (key => FALLBACK[key] ?? key);
  // Props presence is fixed per mount, so guarded hook calls keep a stable order.
  const input = useInput(value => value);
  const running = useSession ? useSession(value => value.running) : false;
  const removed = useSession ? useSession(value => value.removed) : false;
  const selectedModel = useProjection ? useProjection('modelSelection', value => value?.next ?? value?.lastUsed) : undefined;
  const [suggestions, setSuggestions] = useState([]);
  const [resultKey, setResultKey] = useState(null);
  const [doubleClickSend, setDoubleClickSend] = useState(true);
  const [hideWhenTyping, setHideWhenTyping] = useState(true);
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [kbdIndex, setKbdIndex] = useState(-1);
  const [contextTurns, setContextTurns] = useState(3);
  const candidate = useConversation(value => selectContext(value.views.get('chat')?.legacy.nodes ?? [], sessionId, selectedModel, contextTurns),
    (a, b) => a?.replyId === b?.replyId && JSON.stringify(a?.turns) === JSON.stringify(b?.turns)
      && a?.provider === b?.provider && a?.model === b?.model);
  const turnsSignature = candidate ? JSON.stringify(candidate.turns) : '';
  const replyKey = candidate ? JSON.stringify([sessionId, candidate.replyId, candidate.provider, candidate.model]) : null;
  const [cardWidth, setCardWidth] = useState(0);
  const dockRef = useRef(null);
  const request = useRef(null);
  const filledRef = useRef(null);
  const impressionRef = useRef(null);
  const generatedRef = useRef(null); // last (session, reply, turns) we ran a model call for
  const holdTimer = useRef(null);
  const heldRef = useRef(null);
  const contentRef = useRef(null);
  // The last running-flag we saw for the CURRENT session id. The composer is a
  // resident component (it survives session switches and restarts re-hydrate old
  // transcripts progressively), so "is this a new turn" is decided by watching the
  // running flag go true→false — never by diffing transcript content, which moves
  // while old sessions hydrate.
  const wasRunningRef = useRef(null);

  // Settings can change on the settings page while sessions stay open; re-read once
  // per turn so the next round of chips follows without a restart.
  useEffect(() => {
    let disposed = false;
    remote.chipSettings().then(result => {
      if (disposed || !result.ok || !result.value) return;
      if (typeof result.value.doubleClickSend === 'boolean') setDoubleClickSend(result.value.doubleClickSend);
      if (typeof result.value.hideWhenTyping === 'boolean') setHideWhenTyping(result.value.hideWhenTyping);
      if (typeof result.value.keyboard === 'boolean') setKeyboardEnabled(result.value.keyboard);
      if (Number.isInteger(result.value.contextTurns)) setContextTurns(result.value.contextTurns);
    }).catch(() => { /* Keep the documented defaults. */ });
    return () => { disposed = true; };
  }, [remote, replyKey]);

  const idle = !running && !removed && input.phase === 'plain';
  // Filling via a chip is not "typing": while the draft still holds the text a chip
  // just wrote, the row stays up so the double-click lands on a mounted button.
  const unobstructed = !hideWhenTyping || input.draft === '' || input.draft === filledRef.current;

  // Reset whenever the turn state moves; generate for the current reply when idle.
  useEffect(() => {
    setSuggestions([]); setResultKey(null); setKbdIndex(-1);
    // Fresh = the turn finished while we watched (running true→false for THIS
    // session). Reopening a session never observes that transition, so old replies
    // are cache-only — no model call, even while the transcript hydrates and its
    // content signature moves. Generation failures are silent: no retry UI, the
    // next ended turn simply tries again.
    const seen = wasRunningRef.current && wasRunningRef.current.sessionId === sessionId
      ? wasRunningRef.current.running : false;
    const endedHere = seen === true && running === false;
    wasRunningRef.current = { sessionId, running: Boolean(running) };
    const alive = Boolean(candidate) && !running && !removed;
    if (!alive) return;
    const controller = new AbortController();
    const job = { controller, candidate, replyKey };
    request.current = job;
    const cleanup = () => { controller.abort(); if (request.current === job) request.current = null; };
    if (!idle) return cleanup;
    // An ended turn we already generated for (transcript edits, session round-trips)
    // is served from cache — identical context must not re-cost a model call.
    const alreadyGenerated = generatedRef.current && generatedRef.current.sessionId === sessionId
      && generatedRef.current.replyId === candidate.replyId && generatedRef.current.turns === turnsSignature;
    const fetchImpl = endedHere && !alreadyGenerated ? generate : restoreOrGenerate;
    fetchImpl(job.candidate, job.controller.signal).then(list => {
      if (!job.controller.signal.aborted && request.current === job) {
        if (fetchImpl === generate) generatedRef.current = { sessionId, replyId: candidate.replyId, turns: turnsSignature };
        setSuggestions(Array.isArray(list) ? list : []);
        setResultKey(job.replyKey);
      }
    }).catch(error => {
      console.warn('[suggestion-chips] Suggestion unavailable:', error?.message ?? 'unknown error');
    });
    return cleanup;
  }, [sessionId, replyKey, turnsSignature, running, removed, generate, restoreOrGenerate, idle]);

  useComputedStyleTag();

  // Clicking fills the draft at once (replaces it); a second click on the same chip
  // within the double-tap window sends — BaoCode's pattern, which never depends on
  // the browser's dblclick event surviving the first click's re-render.
  const fill = text => {
    filledRef.current = text;
    try { inputActions.setDraft(text); } catch (error) {
      console.warn('[suggestion-chips] Draft fill unavailable:', error?.message ?? 'unknown error');
    }
  };
  const send = () => {
    if (typeof inputActions.submit !== 'function') return;
    try { inputActions.submit(); } catch (error) {
      console.warn('[suggestion-chips] Submit unavailable:', error?.message ?? 'unknown error');
    }
  };
  const lastClickRef = useRef(null);
  // Best-effort local feedback: the host folds these into future suggestion prompts.
  const record = (event, text) => {
    try {
      if (!candidate) return;
      const p = remote.recordFeedback({ sessionId, replyId: candidate.replyId, event, ...(text ? { text } : {}) });
      p?.catch?.(() => {});
    } catch { /* feedback is optional */ }
  };
  const onChipClick = (text, index) => {
    // Mouse picks move the keyboard highlight too, so ←→ continue from the click.
    setKbdIndex(index);
    const now = Date.now();
    const last = lastClickRef.current;
    if (last && last.text === text && now - last.at <= 300) {
      lastClickRef.current = null;
      fill(text);
      if (doubleClickSend) { record('send', text); send(); } else record('fill', text);
    } else {
      lastClickRef.current = { text, at: now };
      fill(text);
      record('fill', text);
    }
  };

  const showRow = resultKey === replyKey && idle && unobstructed && suggestions.length > 0;

  // Content snapshot held across the exit transition: the row fades out with its
  // chips still inside instead of popping empty. The dock stays mounted and the
  // open/closed states animate via CSS (grid rows + opacity), BaoCode-style.
  // No loading placeholder: the row only appears once the chips exist.
  const contentKey = showRow ? `c:${replyKey}:${suggestions.length}` : '';
  contentRef.current = showRow ? { kind: 'chips', items: suggestions, replyKey } : null;
  const [held, setHeld] = useState(null);
  const [fading, setFading] = useState(false);
  const [noAnim, setNoAnim] = useState(false);
  const setHeldBoth = value => { heldRef.current = value; setHeld(value); };
  useEffect(() => {
    if (contentKey) {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      setFading(false); setNoAnim(false);
      setHeldBoth(contentRef.current);
      if (contentKey.startsWith('c:') && impressionRef.current !== replyKey) {
        impressionRef.current = replyKey;
        record('shown');
      }
    } else if (heldRef.current !== null && holdTimer.current === null) {
      // Every exit is fade-only: keep the height while fading (submit clears the
      // draft BEFORE the running flag flips, so exit reasons cannot be told apart
      // reliably), then reclaim the space with transitions disabled — no visible
      // intermediate frames.
      setFading(true);
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        setNoAnim(true); setHeldBoth(null);
        holdTimer.current = setTimeout(() => { holdTimer.current = null; setNoAnim(false); setFading(false); }, 60);
      }, 180);
    }
  }, [contentKey]);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  // Keyboard navigation: ↑ activates chip selection from the composer OR from an
  // unfocused page (but never while typing in another field or a popup menu),
  // ←→ move, Enter fills, Ctrl/Cmd+Enter sends, Esc/typing/↓ exits. Native ↑
  // behavior elsewhere is untouched.
  useEffect(() => {
    const onKey = event => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Accept keys from the composer, our own dock (mouse-picked chips keep DOM
      // focus), or the unfocused page — everything else (menus, other fields) is
      // left alone.
      const inOurs = !!target.closest('[data-composer-card]')
        || !!target.closest('[data-suggestion-chips-dock]');
      const onBody = target === document.body || target === document.documentElement;
      if (!inOurs && !onBody) return;
      if (target.matches('input, textarea, select')) return;
      const canNavigate = keyboardEnabled && showRow && suggestions.length > 0;
      const active = kbdIndex >= 0 && kbdIndex < suggestions.length;
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && active) {
        event.preventDefault(); event.stopImmediatePropagation();
        const text = suggestions[kbdIndex];
        if (input.draft !== text) fill(text);
        record('send', text); send();
        setKbdIndex(-1);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!canNavigate) { if (active) setKbdIndex(-1); return; }
      if (event.key === 'ArrowUp' && !active) {
        event.preventDefault(); event.stopImmediatePropagation();
        setKbdIndex(0);
        return;
      }
      if (!active) return;
      switch (event.key) {
        case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
          event.preventDefault(); event.stopImmediatePropagation();
          setKbdIndex(i => moveChipSelection(i, event.key, dockRef.current));
          break;
        }
        case 'Enter': {
          const text = suggestions[kbdIndex];
          if (input.draft !== '' && input.draft !== text) {
            // The user typed their own content — DSH's native Enter must send it
            // untouched. Exit selection mode and do not intercept.
            setKbdIndex(-1);
            return;
          }
          event.preventDefault(); event.stopImmediatePropagation();
          if (input.draft === text) {
            // The highlighted chip is already what the draft holds (filled earlier
            // by click or keyboard) → confirm-send it.
            setKbdIndex(-1); record('send', text); send();
          } else {
            fill(text); record('fill', text);
          }
          break;
        }
        case 'Escape': event.preventDefault(); event.stopImmediatePropagation(); setKbdIndex(-1); break;
        default: if (event.key.length === 1) setKbdIndex(-1); break;
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });
  const dockClass = 'dsh-suggestion-chips-dock'
    + ((contentKey || fading) ? ' is-open' : '')
    + (fading ? ' is-fading' : '')
    + (noAnim ? ' no-anim' : '');

  // Align the row with the composer card by measuring it — theme CSS vars for dock
  // insets are not guaranteed across versions, so no calc() shortcut.
  useLayoutEffect(() => {
    const node = dockRef.current;
    if (!node) return;
    const container = node.parentElement;
    const card = container?.querySelector('[data-composer-card]') ?? document.querySelector('[data-composer-card]');
    if (!card) return;
    const measure = () => {
      const width = card.getBoundingClientRect().width;
      if (width > 0) setCardWidth(old => Math.abs(old - width) < 1 ? old : Math.round(width));
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(card);
    window.addEventListener('resize', measure);
    return () => { resize.disconnect(); window.removeEventListener('resize', measure); };
  }, [sessionId]);

  return h('div', { style: { display: 'contents' } },
    h('div', {
      ref: dockRef, className: dockClass,
      'data-suggestion-chips-dock': '', style: cardWidth > 0 ? { width: cardWidth } : undefined,
    },
      h('div', { className: 'dsh-suggestion-chips-collapse' },
        held ? h('div', {
          className: 'dsh-suggestion-chips-row', role: 'toolbar', 'aria-label': tr('settings.nav'),
        },
          held.items.map((text, index) => h('button', {
            key: `${held.replyKey}:${index}`, type: 'button',
            className: 'dsh-suggestion-chips-bubble' + (keyboardEnabled && kbdIndex === index ? ' is-kbd' : ''),
            title: text,
            style: { animationDelay: `${100 + index * 110}ms` },
            onClick: () => onChipClick(text, index),
          }, text))) : null)));
}

function SettingsSwitch({ checked, busy, onChange }) {
  return h('span', { className: 'dsh-suggestion-chips-switch' },
    h('input', { type: 'checkbox', checked, disabled: busy, onChange: event => onChange(event.target.checked) }),
    h('span', { className: 'dsh-suggestion-chips-track' }));
}

function SettingsSection({ t, remote }) {
  const tr = typeof t === 'function' ? t : (key => FALLBACK[key] ?? key);
  useComputedStyleTag(); // Settings can be opened with no conversation mounted — inject our own stylesheet.
  const [config, setLocal] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    remote.chipSettings().then(result => {
      if (!disposed && result.ok) setLocal(result.value);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [remote]);
  const update = patch => {
    const previous = config;
    setLocal(old => ({ ...(old ?? {}), ...patch }));
    setBusy(true); setMessage('');
    remote.applyChipSettings(patch).then(result => {
      if (result.ok) { setLocal(result.value); setMessage(tr('settings.saved')); }
      else { setLocal(previous); setMessage(result.error?.message ?? tr('settings.saveFailed')); }
    }).catch(error => { setLocal(previous); setMessage(error?.message ?? tr('settings.saveFailed')); }).finally(() => setBusy(false));
  };
  const toggleRow = (key, label) => h('label', { className: 'dsh-suggestion-chips-setrow' },
    h('span', { className: 'dsh-suggestion-chips-rowlabel' }, label),
    h(SettingsSwitch, { checked: config[key], busy, onChange: value => update({ [key]: value }) }));
  return h('div', { 'data-suggestion-chips-settings': '', style: { maxWidth: '560px' } },
    h('div', { className: 'dsh-suggestion-chips-head' },
      h('div', { className: 'dsh-suggestion-chips-head-icon' }, '💬'),
      h('div', {},
        h('div', { className: 'dsh-suggestion-chips-title' }, tr('settings.title')),
        h('div', { className: 'dsh-suggestion-chips-subtitle' }, tr('settings.subtitle')))),
    !config ? h('p', { role: 'status', className: 'dsh-suggestion-chips-msg' }, tr('settings.loading')) : [
      h('div', { className: 'dsh-suggestion-chips-group' }, tr('settings.group.behavior')),
      h('div', { className: 'dsh-suggestion-chips-card' },
        h('label', { className: 'dsh-suggestion-chips-setrow' },
          h('span', { className: 'dsh-suggestion-chips-rowlabel' }, tr('settings.enabled')),
          h(SettingsSwitch, { checked: config.enabled, busy, onChange: value => update({ enabled: value }) })),
        h('label', { className: 'dsh-suggestion-chips-setrow' },
          h('span', { className: 'dsh-suggestion-chips-rowlabel' }, tr('settings.count')),
          h('select', { className: 'dsh-suggestion-chips-select', value: String(config.count), disabled: busy,
            onChange: event => update({ count: Number(event.target.value) }) },
            [1, 2, 3, 4].map(n => h('option', { key: n, value: String(n) }, String(n)))))),
      h('div', { className: 'dsh-suggestion-chips-group' }, tr('settings.group.interaction')),
      h('div', { className: 'dsh-suggestion-chips-card' },
        toggleRow('doubleClickSend', tr('settings.doubleClickSend')),
        toggleRow('hideWhenTyping', tr('settings.hideWhenTyping')),
        toggleRow('keyboard', tr('settings.keyboard'))),
      h('div', { className: 'dsh-suggestion-chips-group' }, tr('settings.group.data')),
      h('div', { className: 'dsh-suggestion-chips-card' },
        h('div', { className: 'dsh-suggestion-chips-setrow' },
          h('div', {},
            h('div', { className: 'dsh-suggestion-chips-rowlabel' }, tr('settings.resetMemory')),
            h('div', { className: 'dsh-suggestion-chips-rowdesc' }, tr('settings.resetMemoryDesc'))),
          h('button', { type: 'button', className: 'dsh-suggestion-chips-ghostbtn', disabled: busy,
            onClick: () => { setBusy(true); setMessage('');
              remote.resetMemory().then(result => {
                if (result.ok) setMessage(tr('settings.memoryCleared'));
                else setMessage(result.error?.message ?? tr('settings.saveFailed'));
              }).catch(error => setMessage(error?.message ?? tr('settings.saveFailed'))).finally(() => setBusy(false)); },
            }, tr('settings.resetMemoryShort')))),
      message && h('p', { role: 'status', className: 'dsh-suggestion-chips-msg' }, message),
    ]);
}

// 'locale' is deliberately NOT declared in exports.inject: when the service is
// missing in a build, a declared inject would abort the whole plugin. Probe it
// instead — when present, register the dictionaries and mark both slots as
// localized (the host then injects `t`); when absent, the built-in strings cover
// the UI.
exports.inject = ['slots', 'remote', 'uiConversation'];
exports.apply = async function apply(ctx) {
  console.info(`[suggestion-chips] client bundle v${PLUGIN_VERSION} loaded`);
  await ctx.remote.$mount({ package: PACKAGE, descriptors: [descriptor(), cachedSuggestionsDescriptor(), configDescriptor(), setConfigDescriptor(), feedbackDescriptor(), resetMemoryDescriptor()] });
  let localeReady = false;
  try {
    if (typeof ctx.locale?.register === 'function') {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), `${PACKAGE}: dictionaries`);
      localeReady = true;
    }
  } catch { /* locale unavailable in this build */ }
  const dockLocale = localeReady ? { locale: NS } : {};
  const sectionLocale = localeReady
    ? { locale: NS, label: () => { try { return ctx.locale.bind(NS)('settings.nav'); } catch { return FALLBACK['settings.nav']; } } }
    : { label: () => FALLBACK['settings.nav'] };
  // The settings shell hands every non-reserved section the default gear and has no
  // icon field (same limitation dsh-notify-me documents) — patch our nav row's glyph
  // by label lookup instead. Re-applies whenever the panel re-portals; silently
  // no-ops when the markup doesn't match.
  try {
    const NAV_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
      + '<rect x="2" y="2.8" width="9.5" height="3.4" rx="1.7" fill="currentColor" opacity=".95"/>'
      + '<rect x="4.2" y="7.3" width="9.8" height="3.4" rx="1.7" fill="currentColor" opacity=".65"/>'
      + '<rect x="2" y="11.8" width="7.4" height="3.4" rx="1.7" fill="currentColor" opacity=".4"/></svg>';
    const navLabels = [FALLBACK['settings.nav'], DICTIONARIES.en['settings.nav']].map(s => (s || '').trim()).filter(Boolean);
    let lastPatch = 0;
    const patchNav = () => {
      const now = Date.now();
      if (now - lastPatch < 500) return;
      lastPatch = now;
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        if (el.getAttribute('data-dsh-chips-nav') === '1') continue;
        const text = (el.textContent || '').trim();
        if (!navLabels.includes(text)) continue;
        const svg = el.querySelector('svg');
        if (!svg) continue;
        const tpl = document.createElement('template');
        tpl.innerHTML = NAV_SVG;
        svg.replaceWith(tpl.content.firstChild);
        el.setAttribute('data-dsh-chips-nav', '1');
        break;
      }
    };
    const navObserver = new MutationObserver(() => { try { patchNav(); } catch { /* markup changes: gear stays */ } });
    ctx.effect(() => {
      navObserver.observe(document.body, { childList: true, subtree: true });
      patchNav();
      return () => navObserver.disconnect();
    }, `${PACKAGE}: nav icon`);
  } catch { /* best effort: the default gear stays */ }
  ctx.inject(['remote.suggestionChips'], scope => {
    const remote = scope.get('remote.suggestionChips');
    const generate = async (input, signal) => {
      const result = await remote.recommend(input, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    // Cache-first with silent fallback: old replies restore from cache when present,
    // otherwise generate once (cached afterwards). Failures stay invisible.
    const restoreOrGenerate = async (input, signal) => {
      let cached = { ok: false };
      try { cached = await remote.cachedSuggestions(input, signal); } catch { /* fall through to generate */ }
      if (cached.ok && Array.isArray(cached.value) && cached.value.length) return cached.value;
      return generate(input, signal);
    };
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock', id: PACKAGE, order: 15, ...dockLocale,
      inject: () => ({ generate, restoreOrGenerate, remote }),
    }, ChipsRow));
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: PACKAGE, order: 70, ...sectionLocale,
      inject: () => ({ remote }),
    }, SettingsSection));
  });
};

return module.exports;
}});
