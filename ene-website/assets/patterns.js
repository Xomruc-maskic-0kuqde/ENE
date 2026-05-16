/**
 * ENE — frontend pattern primitives.
 *
 * Vanilla equivalents of the React-era patterns we keep reinventing:
 *   - `ready(fn)`  — DOM + api.js ready gate (like useEffect on mount)
 *   - `store(init)` — tiny reactive store (like useReducer / Zustand)
 *   - `form(el,opts)` — unified form lifecycle (loading / validate /
 *                      submit / render error / safety timeout / no-double-submit)
 *   - `modal({backdrop, ..})` — focus trap + backdrop-click + Escape
 *   - `lazy(fn)` — memoize a zero-arg async function (like useQuery cache)
 *   - `on(root, event, selector, fn)` — delegated listener
 *
 * Zero dependencies. ~200 lines. Drop `<script src="assets/patterns.js">`
 * after api.js on any page that wants them. Attaches one namespace,
 * `window.Patterns`, to avoid global sprawl.
 */
(function () {
  'use strict';

  // ── ready(fn) ──────────────────────────────────────────────────
  // Fires fn() once the DOM is interactive AND `window.api` exists.
  // Pages that want to stay dumb about script order wrap their boot
  // code in this. Idempotent — multiple calls stack.
  const _readyQueue = [];
  let _readyFired = false;
  function _maybeFire() {
    if (_readyFired) return;
    if (document.readyState === 'loading') return;
    if (!window.api) return;
    _readyFired = true;
    const q = _readyQueue.splice(0);
    for (const fn of q) { try { fn(); } catch (e) { console.error('[patterns.ready]', e); } }
  }
  function ready(fn) {
    _readyQueue.push(fn);
    if (_readyFired) _maybeFire();
  }
  if (document.readyState !== 'loading') {
    queueMicrotask(_maybeFire);
  } else {
    document.addEventListener('DOMContentLoaded', _maybeFire, { once: true });
  }
  // Poll briefly for api.js in case it's deferred.
  let _apiTries = 0;
  const _apiPoll = setInterval(() => {
    if (window.api || ++_apiTries > 40) { clearInterval(_apiPoll); _maybeFire(); }
  }, 25);

  // ── store(initial) — reactive mini-store ───────────────────────
  // Public API:
  //   const s = store({ count: 0 });
  //   s.get()            // returns current state
  //   s.set(next)        // shallow-merge if object; or reducer fn: s.set(prev => ...)
  //   s.subscribe(fn)    // fires on every change; returns unsubscribe
  //
  // Intentionally smaller than Zustand. Use it for page-scoped state
  // that multiple components read. For cross-page state, prefer
  // `window.ENE_STATE` which persists in sessionStorage via api.js.
  function store(initial) {
    let state = initial;
    const subs = new Set();
    return {
      get: () => state,
      set(next) {
        const prev = state;
        if (typeof next === 'function') state = next(state);
        else if (prev && typeof prev === 'object' && !Array.isArray(prev)
              && next && typeof next === 'object' && !Array.isArray(next)) {
          state = Object.assign({}, prev, next);
        } else {
          state = next;
        }
        for (const fn of subs) { try { fn(state, prev); } catch (e) { console.error('[store]', e); } }
      },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
  }

  // ── form(el, opts) — unified form lifecycle ───────────────────
  // Consolidates every hand-rolled "disable / loading / submit /
  // render-error / re-enable / safety-timeout" we had across login,
  // register, profile edit, password change.
  //
  // Required:
  //   el            — <form> element
  //   opts.submit   — async ({ values }) => result|void
  //                   Resolves: success (any truthy), error (throws), or
  //                   object { ok: false, message, status } for user-facing errs
  // Optional:
  //   opts.read     — (el) => values object (default: FormData-based)
  //   opts.validate — (values) => string|null  (null = ok, string = err text)
  //   opts.button   — button element (default: form.querySelector('[type="submit"]'))
  //   opts.msg      — error/success msg element (default: form.querySelector('[data-msg]'))
  //   opts.loadingText  — label during submit (default: 'Loading…')
  //   opts.idleText     — label after submit completes (default: button's initial text)
  //   opts.onSuccess    — (result) => void
  //   opts.onError      — (err, {status,message,values}) => void
  //   opts.timeoutMs    — safety-net timeout (default 20s)
  //   opts.renderError  — custom error renderer (replaces default shake)
  function form(el, opts) {
    if (!el || !opts || !opts.submit) {
      throw new Error('[patterns.form] requires element + opts.submit');
    }
    const button = opts.button || el.querySelector('[type="submit"],button[type="submit"]');
    const msg = opts.msg || el.querySelector('[data-msg]');
    const idleText = opts.idleText || (button && button.textContent) || 'Submit';
    const loadingText = opts.loadingText || 'Loading…';
    const timeoutMs = opts.timeoutMs || 20_000;

    let submitting = false;

    function readDefault() {
      const values = {};
      for (const [k, v] of new FormData(el)) values[k] = v;
      return values;
    }

    // Apply per-field sanitization based on `data-sanitize` attributes on
    // inputs. Runs after the caller's `read()` (or the default FormData
    // reader) so it catches anything that wasn't pre-cleaned by the
    // blur/paste handlers in sanitize.js. Password fields are
    // intentionally excluded — mutating them at submit time can break
    // authentication for legitimate inputs.
    function applySanitize(values) {
      if (!values || typeof values !== 'object' || !window.Sanitize) return values;
      const fns = window.Sanitize._ruleFns || {};
      const inputs = el.querySelectorAll('input[data-sanitize], textarea[data-sanitize]');
      inputs.forEach((input) => {
        const key = input.name || input.id;
        if (!key || !(key in values)) return;
        const rule = input.dataset.sanitize;
        const fn = fns[rule];
        if (!fn) return;
        if (typeof values[key] === 'string') values[key] = fn(values[key]);
      });
      return values;
    }

    function setError(text) {
      if (opts.renderError) return opts.renderError(text, msg, { el });
      if (!msg) return;
      msg.textContent = text || '';
      msg.className = text ? 'msg show error' : 'msg';
      if (text) {
        // Re-trigger shake keyframe on repeat errors.
        msg.classList.remove('shake');
        void msg.offsetWidth;
        msg.classList.add('shake');
      }
    }
    function setOk(text) {
      if (!msg) return;
      msg.textContent = text || '';
      msg.className = 'msg show ok';
    }
    function clearMsg() { if (msg) { msg.textContent = ''; msg.className = 'msg'; } }

    function setLoading(loading) {
      if (!button) return;
      button.disabled = loading;
      button.textContent = loading ? loadingText : idleText;
    }

    async function handleSubmit(e) {
      e && e.preventDefault && e.preventDefault();
      if (submitting) return;

      clearMsg();
      let values = (opts.read ? opts.read(el) : readDefault());
      values = applySanitize(values);

      if (opts.validate) {
        const v = opts.validate(values);
        if (v) { setError(v); return; }
      }

      submitting = true;
      setLoading(true);

      // Safety net — never leave button permanently stuck.
      const safety = setTimeout(() => {
        if (submitting) {
          setError("This is taking longer than expected. Check your connection and try again.");
          submitting = false;
          setLoading(false);
        }
      }, timeoutMs);

      let result;
      try {
        result = await opts.submit({ values });
      } catch (err) {
        clearTimeout(safety);
        submitting = false;
        setLoading(false);
        // `err` from api.* already carries { ok, status, body } shape.
        // Use opts.onError if provided, otherwise render a generic message.
        const { message, status } = err || {};
        if (opts.onError) {
          opts.onError(err, { status, message, values });
        } else {
          setError(message || 'Something went wrong. Please try again.');
        }
        return;
      }
      clearTimeout(safety);

      // Convention: our api.* helpers return `{ ok, status, body }`.
      // If the submit handler returned one, honor it.
      if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
        submitting = false;
        setLoading(false);
        const b = result.body || {};
        const errText = (Array.isArray(b.errors) && b.errors.length)
          ? b.errors.map(e => e.message || '').filter(Boolean).join(' · ')
          : (b.message || 'Something went wrong.');
        if (opts.onError) {
          opts.onError({ status: result.status, message: errText, body: b },
                       { status: result.status, message: errText, values });
        } else {
          setError(errText);
        }
        return;
      }

      // Success path. Caller usually navigates; we leave the button in
      // loading state unless they say otherwise (feels correct during nav).
      if (opts.onSuccess) opts.onSuccess(result, { values });
    }

    el.addEventListener('submit', handleSubmit);

    // Public handle so callers can trigger programmatically.
    return {
      submit: () => handleSubmit({ preventDefault() {} }),
      setError, setOk, clearMsg, setLoading,
      destroy: () => el.removeEventListener('submit', handleSubmit),
    };
  }

  // ── modal({ backdrop, content, onOpen, onClose }) ────────────
  // Accessible modal primitive — focus trap, backdrop click, Escape,
  // return focus on close. Consolidates the exit-intent / settings /
  // chat modals that each reimplement this from scratch.
  function modal(opts) {
    const backdrop = opts.backdrop;
    const content = opts.content || backdrop.querySelector('[data-modal-content]') || backdrop.firstElementChild;
    if (!backdrop) throw new Error('[patterns.modal] requires opts.backdrop');

    let previousFocus = null;
    let opened = false;

    const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function trapKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      const focusables = content.querySelectorAll(FOCUSABLE);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }

    function onBackdropClick(e) {
      if (e.target === backdrop && opts.closeOnBackdrop !== false) close();
    }

    function open() {
      if (opened) return;
      opened = true;
      previousFocus = document.activeElement;
      backdrop.hidden = false;
      // rAF so transitions (e.g. `.show` class) can fire.
      requestAnimationFrame(() => backdrop.classList.add('show'));
      document.addEventListener('keydown', trapKey);
      backdrop.addEventListener('click', onBackdropClick);
      // Focus the first focusable in content.
      const first = content.querySelector(FOCUSABLE);
      if (first) setTimeout(() => first.focus(), 60);
      if (opts.onOpen) opts.onOpen();
    }

    function close() {
      if (!opened) return;
      opened = false;
      backdrop.classList.remove('show');
      document.removeEventListener('keydown', trapKey);
      backdrop.removeEventListener('click', onBackdropClick);
      // Give the transition a beat to finish before hiding.
      setTimeout(() => { backdrop.hidden = true; }, 260);
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus(); } catch (_) {}
      }
      if (opts.onClose) opts.onClose();
    }

    return { open, close, isOpen: () => opened };
  }

  // ── lazy(fn) — memoize zero-arg async ─────────────────────────
  // Perfect for "load this data once per page lifetime":
  //   const plans = lazy(() => api.get('/subscriptions/plans'));
  //   const res1 = await plans();  // network
  //   const res2 = await plans();  // cached
  //   plans.reset();               // force refetch next call
  function lazy(fn) {
    let cached;
    const wrapped = async () => (cached !== undefined ? cached : (cached = await fn()));
    wrapped.reset = () => { cached = undefined; };
    return wrapped;
  }

  // ── on(root, event, selector, handler) — delegated listener ──
  // One listener on a root element handles many dynamic children.
  // Returns an unsubscribe function.
  function on(root, event, selector, handler) {
    if (!root || !event || !selector || !handler) return () => {};
    const listener = (e) => {
      const target = e.target.closest(selector);
      if (target && root.contains(target)) handler.call(target, e, target);
    };
    root.addEventListener(event, listener);
    return () => root.removeEventListener(event, listener);
  }

  // ── Export ────────────────────────────────────────────────────
  window.Patterns = { ready, store, form, modal, lazy, on };
})();
