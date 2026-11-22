// Render-level smoke test: executes the client bundle's slot components with a
// minimal React stub so render-time crashes (TDZ, lost declarations, bad hook
// order) are caught before an install. Module-load checks alone miss these.
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
  return {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState(init) {
      const i = index++;
      if (slots[i] === undefined) slots[i] = typeof init === 'function' ? init() : init;
      const set = value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; };
      return [slots[i], set];
    },
    useRef(init) {
      const i = index++;
      if (slots[i] === undefined) slots[i] = { current: init };
      return slots[i];
    },
    useEffect() {}, useLayoutEffect() {},
    __reset() { index = 0; },
  };
}

const react = makeReactStub();
const fakeRemote = {
  recommend: async () => ({ ok: true, value: [] }),
  cachedSuggestions: async () => ({ ok: true, value: [] }),
  chipSettings: async () => ({ ok: true, value: { enabled: true, count: 3, contextTurns: 3, doubleClickSend: true, hideWhenTyping: true, keyboard: true } }),
  applyChipSettings: async () => ({ ok: true, value: { enabled: true, count: 3, contextTurns: 3, doubleClickSend: true, hideWhenTyping: true, keyboard: true } }),
  recordFeedback: async () => true,
  resetMemory: async () => true,
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

function render(slotName) {
  const entry = registered.find(item => item.options.name === slotName);
  if (!entry) throw new Error(`slot not registered: ${slotName}`);
  react.__reset();
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

if (!mod.inject || typeof mod.apply !== 'function') throw new Error('client module exports broken');
render('conversation.input.dock');
console.log('ChipsRow rendered ok');
render('settings.section');
console.log('SettingsSection rendered ok');
console.log('RENDER TEST OK');
