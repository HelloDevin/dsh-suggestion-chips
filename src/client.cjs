const { createElement: h, useEffect, useLayoutEffect, useRef, useState } = require('react');

const NS = 'suggestion-chips';
const DICTIONARIES = {
  zh: {
    'settings.nav': '建议追问',
    'settings.enabled': '启用建议追问',
    'settings.doubleClickSend': '双击直接发送',
    'settings.hideWhenTyping': '开始打字时隐藏建议',
    'settings.count': '每轮建议条数',
    'settings.loading': '正在读取设置…',
    'settings.saved': '已保存',
    'settings.saveFailed': '保存失败，请重试',
    'retry': '建议生成失败，点击重试',
    'hide': '隐藏建议',
    'hint.send': '单击填入输入框，双击直接发送',
    'hint.fill': '单击填入输入框',
  },
  en: {
    'settings.nav': 'Suggestion Chips',
    'settings.enabled': 'Enable suggestion chips',
    'settings.doubleClickSend': 'Send on double-click',
    'settings.hideWhenTyping': 'Hide suggestions while typing',
    'settings.count': 'Suggestions per turn',
    'settings.loading': 'Loading settings…',
    'settings.saved': 'Saved',
    'settings.saveFailed': 'Save failed, please retry',
    'retry': 'Suggestion failed, click to retry',
    'hide': 'Hide suggestions',
    'hint.send': 'Click to fill the draft, double-click to send',
    'hint.fill': 'Click to fill the draft',
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
  max-width: min(100%, 320px);
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
.dsh-suggestion-chips-bubble:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2f6fed);
  outline-offset: 2px;
}
.dsh-suggestion-chips-dismiss {
  flex: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #68707d);
  cursor: pointer;
  font-size: 14px;
  line-height: 20px;
  padding: 2px 6px;
}
.dsh-suggestion-chips-dismiss:hover { color: var(--dsw-alias-label-primary, #23262d); }
`;

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

function ChipsRow({ sessionId, useInput, useSession, useConversation, useProjection, inputActions, generate, remote, t }) {
  const tr = typeof t === 'function' ? t : (key => FALLBACK[key] ?? key);
  // Props presence is fixed per mount, so guarded hook calls keep a stable order.
  const input = useInput(value => value);
  const running = useSession ? useSession(value => value.running) : false;
  const removed = useSession ? useSession(value => value.removed) : false;
  const selectedModel = useProjection ? useProjection('modelSelection', value => value?.next ?? value?.lastUsed) : undefined;
  const [suggestions, setSuggestions] = useState([]);
  const [dismissed, setDismissed] = useState(null);
  const [resultKey, setResultKey] = useState(null);
  const [errorKey, setErrorKey] = useState(null);
  const [retryTick, setRetryTick] = useState(0);
  const [doubleClickSend, setDoubleClickSend] = useState(true);
  const [hideWhenTyping, setHideWhenTyping] = useState(true);
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
  const holdTimer = useRef(null);
  const heldRef = useRef(null);
  const contentRef = useRef(null);

  // Settings can change on the settings page while sessions stay open; re-read once
  // per turn so the next round of chips follows without a restart.
  useEffect(() => {
    let disposed = false;
    remote.chipSettings().then(result => {
      if (disposed || !result.ok || !result.value) return;
      if (typeof result.value.doubleClickSend === 'boolean') setDoubleClickSend(result.value.doubleClickSend);
      if (typeof result.value.hideWhenTyping === 'boolean') setHideWhenTyping(result.value.hideWhenTyping);
      if (Number.isInteger(result.value.contextTurns)) setContextTurns(result.value.contextTurns);
    }).catch(() => { /* Keep the documented defaults. */ });
    return () => { disposed = true; };
  }, [remote, replyKey]);

  const idle = !running && !removed && input.phase === 'plain';
  // Filling via a chip is not "typing": while the draft still holds the text a chip
  // just wrote, the row stays up so the double-click lands on a mounted button.
  const unobstructed = !hideWhenTyping || input.draft === '' || input.draft === filledRef.current;

  // Reset whenever the turn state moves; generate for the current reply when idle.
  // A retry bumps retryTick, which rebuilds the job and calls the model again — the
  // host only caches successful results, so failures are genuinely retried.
  useEffect(() => {
    setSuggestions([]); setResultKey(null); setErrorKey(null);
    if (!candidate || running || removed) return;
    const controller = new AbortController();
    const job = { controller, candidate, replyKey };
    request.current = job;
    if (idle && dismissed !== replyKey) {
      generate(job.candidate, job.controller.signal).then(list => {
        if (!job.controller.signal.aborted && request.current === job) {
          setSuggestions(Array.isArray(list) ? list : []);
          setResultKey(job.replyKey);
        }
      }).catch(error => {
        if (!job.controller.signal.aborted && request.current === job) {
          console.warn('[suggestion-chips] Suggestion unavailable:', error?.message ?? 'unknown error');
          setErrorKey(job.replyKey);
        }
      });
    }
    return () => { controller.abort(); if (request.current === job) request.current = null; };
  }, [sessionId, replyKey, turnsSignature, running, removed, generate, idle, dismissed, retryTick]);

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
  const onChipClick = text => {
    const now = Date.now();
    const last = lastClickRef.current;
    if (last && last.text === text && now - last.at <= 300) {
      lastClickRef.current = null;
      fill(text);
      if (doubleClickSend) send();
    } else {
      lastClickRef.current = { text, at: now };
      fill(text);
    }
  };

  const showRow = resultKey === replyKey && dismissed !== replyKey && idle && unobstructed && suggestions.length > 0;
  const showError = errorKey === replyKey && dismissed !== replyKey && idle && unobstructed;
  const hint = doubleClickSend ? 'hint.send' : 'hint.fill';

  // Content snapshot held across the exit transition: the row fades out with its
  // chips still inside instead of popping empty. The dock stays mounted and the
  // open/closed states animate via CSS (grid rows + opacity), BaoCode-style.
  // No loading placeholder: the row only appears once the chips exist.
  const contentKey = showError ? `e:${replyKey}` : showRow ? `c:${replyKey}:${suggestions.length}` : '';
  contentRef.current = showError ? { kind: 'error', replyKey } : showRow ? { kind: 'chips', items: suggestions, replyKey } : null;
  const [held, setHeld] = useState(null);
  const [fading, setFading] = useState(false);
  const [noAnim, setNoAnim] = useState(false);
  const setHeldBoth = value => { heldRef.current = value; setHeld(value); };
  useEffect(() => {
    if (contentKey) {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      setFading(false); setNoAnim(false);
      setHeldBoth(contentRef.current);
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
          className: 'dsh-suggestion-chips-row',
          role: held.kind === 'chips' ? 'toolbar' : 'status', 'aria-label': tr('settings.nav'),
        },
          held.kind === 'error' ? h('button', {
            type: 'button', className: 'dsh-suggestion-chips-bubble',
            title: tr('retry'), onClick: () => setRetryTick(tick => tick + 1),
          }, tr('retry'))
            : [
              ...held.items.map((text, index) => h('button', {
                key: `${held.replyKey}:${index}`, type: 'button', className: 'dsh-suggestion-chips-bubble',
                title: tr(hint),
                style: { animationDelay: `${100 + index * 110}ms` },
                onClick: () => onChipClick(text),
              }, text)),
              h('button', { key: 'dismiss', type: 'button', className: 'dsh-suggestion-chips-dismiss',
                'aria-label': tr('hide'), title: tr('hide'), onClick: () => setDismissed(held.replyKey) }, '×'),
            ]) : null)));
}

function SettingsToggle({ label, checked, busy, onChange }) {
  return h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' } },
    h('input', { type: 'checkbox', checked, disabled: busy, onChange: event => onChange(event.target.checked) }),
    label);
}

function SettingsSection({ t, remote }) {
  const tr = typeof t === 'function' ? t : (key => FALLBACK[key] ?? key);
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
    setLocal(old => ({ ...(old ?? {}), ...patch }));
    setBusy(true); setMessage('');
    remote.applyChipSettings(patch).then(result => {
      if (result.ok) { setLocal(result.value); setMessage(tr('settings.saved')); }
      else setMessage(result.error?.message ?? tr('settings.saveFailed'));
    }).catch(error => setMessage(error?.message ?? tr('settings.saveFailed'))).finally(() => setBusy(false));
  };
  return h('div', { 'data-suggestion-chips-settings': '', style: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '520px' } },
    !config ? h('p', { role: 'status', style: { margin: 0, fontSize: '13px', opacity: 0.75 } }, tr('settings.loading')) : [
      h(SettingsToggle, { key: 'enabled', label: tr('settings.enabled'), checked: config.enabled, busy, onChange: value => update({ enabled: value }) }),
      h(SettingsToggle, { key: 'double', label: tr('settings.doubleClickSend'), checked: config.doubleClickSend, busy, onChange: value => update({ doubleClickSend: value }) }),
      h(SettingsToggle, { key: 'hide', label: tr('settings.hideWhenTyping'), checked: config.hideWhenTyping, busy, onChange: value => update({ hideWhenTyping: value }) }),
      h('label', { key: 'count', style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' } },
        tr('settings.count'),
        h('select', { value: String(config.count), disabled: busy,
          onChange: event => update({ count: Number(event.target.value) }),
          style: { color: 'inherit', background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', borderRadius: '6px', padding: '3px 8px' } },
          [1, 2, 3, 4].map(n => h('option', { key: n, value: String(n), style: { color: 'CanvasText', background: 'Canvas' } }, String(n))))),
      message && h('p', { key: 'msg', role: 'status', style: { margin: 0, fontSize: '12px', opacity: 0.75 } }, message),
    ]);
}

// 'locale' is deliberately NOT declared in exports.inject: when the service is
// missing in a build, a declared inject would abort the whole plugin. Probe it
// instead — when present, register the dictionaries and mark both slots as
// localized (the host then injects `t`); when absent, the built-in strings cover
// the UI.
exports.inject = ['slots', 'remote', 'uiConversation'];
exports.apply = async function apply(ctx) {
  await ctx.remote.$mount({ package: PACKAGE, descriptors: [descriptor(), configDescriptor(), setConfigDescriptor()] });
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
  ctx.inject(['remote.suggestionChips'], scope => {
    const remote = scope.get('remote.suggestionChips');
    const generate = async (input, signal) => {
      const result = await remote.recommend(input, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock', id: PACKAGE, order: 15, ...dockLocale,
      inject: () => ({ generate, remote }),
    }, ChipsRow));
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: PACKAGE, order: 70, ...sectionLocale,
      inject: () => ({ remote }),
    }, SettingsSection));
  });
};
