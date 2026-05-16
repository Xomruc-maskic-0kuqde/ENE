/**
 * ENE — input sanitization + XSS-containment primitives.
 *
 * Defence-in-depth layer that sits on top of server-side validation.
 * The backend is the source of truth; this module exists so even if a
 * validation rule is missed there, untrusted data never reaches an
 * innerHTML sink, a URL href, or the request body in a dangerous shape.
 *
 * Public surface (window.Sanitize):
 *   escape(s)              — HTML-entity encode for innerHTML contexts
 *   text(s, {maxLength})   — strip tags + control chars, trim, cap length
 *   name(s)                — tighter text() for display names
 *   email(s)               — lowercase + trim + strip control + cap 254
 *   isValidEmail(s)        — RFC-shape check (server still authoritative)
 *   password(s)            — strip only NULL/DEL; never trim or truncate
 *   search(s)              — trim, strip <>, cap 200
 *   number(s, {min,max,integer}) — numeric coercion with clamp
 *   url(s, {schemes})      — whitelist http/https/mailto/tel; block js:
 *   urlParam(key, {type,maxLength,pattern}) — safely read location.search
 *   attr(s)                — escape for HTML attribute context
 *   setText(el, s)         — prefer textContent
 *   setHTML(el, s)         — escape-then-innerHTML (for plain strings)
 *   deepClean(obj, {maxDepth, maxStringLength}) — sanitize request bodies
 *   stripControl(s)        — drop ASCII control chars except \t / \n
 *   wire(root)             — scan root for [data-sanitize] and attach handlers
 *
 * Declarative usage: mark an input with `data-sanitize="email"` and the
 * module auto-cleans it on blur + paste. Supported rules:
 *   email | name | text | search | number
 * (password inputs are deliberately NOT auto-wired — mutation mid-submit
 * would cause login races; they're cleaned at deepClean time instead.)
 *
 * Load order: after assets/config.js, before any page bootstrap that
 * renders server data into the DOM.
 */
(function () {
  'use strict';

  // Entity table — includes `/` + backtick + `=` so string interpolation
  // into attribute values without quoting still can't escape the slot.
  const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;',
  };
  const ENTITY_RE = /[&<>"'`=/]/g;

  function escape(str) {
    if (str == null) return '';
    return String(str).replace(ENTITY_RE, (c) => HTML_ENTITIES[c]);
  }

  // ATTR_RE is tighter than ENTITY_RE to preserve `/` and `=` which are
  // legal in URLs living inside attributes — callers using this for an
  // href should still pass the value through url() first.
  const ATTR_RE = /[<>"'`&]/g;
  function attr(str) {
    if (str == null) return '';
    return String(str).replace(ATTR_RE, (c) => HTML_ENTITIES[c]);
  }

  // Strip C0 control characters except tab (0x09) and LF (0x0A). Also DEL.
  // CRs (0x0D) get stripped too — we normalize to LF-only in text fields.
  const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
  function stripControl(str) {
    if (str == null) return '';
    return String(str).replace(CONTROL_RE, '');
  }

  // Strip anything that looks like an HTML tag. Intentionally simple —
  // we don't try to be a full HTML parser. Any `<...>` sequence dies.
  const TAG_RE = /<\/?[^>]*>/g;
  function text(str, opts) {
    const maxLength = (opts && opts.maxLength) || 10_000;
    let s = stripControl(str).replace(TAG_RE, '').trim();
    if (s.length > maxLength) s = s.slice(0, maxLength);
    return s;
  }

  function name(str) {
    // Display names — drop quote characters that would break out of
    // attribute contexts even after the text pass above. Cap at 100.
    return text(str, { maxLength: 100 }).replace(/["'`<>]/g, '');
  }

  function email(str) {
    return stripControl(str).trim().toLowerCase().slice(0, 254);
  }

  const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function isValidEmail(str) {
    return EMAIL_SHAPE_RE.test(email(str));
  }

  function password(str) {
    // Passwords must survive intact. Only drop bytes that cannot be
    // validly typed or would corrupt the wire format (NULL, backspace,
    // DEL). Never trim — trailing/leading spaces can be legitimate.
    if (str == null) return '';
    return String(str).replace(/[\u0000\u0008\u007F]/g, '');
  }

  function search(str) {
    return stripControl(str).trim().slice(0, 200).replace(/[<>]/g, '');
  }

  function number(str, opts) {
    const o = opts || {};
    const n = o.integer ? parseInt(str, 10) : parseFloat(str);
    if (!Number.isFinite(n)) return null;
    if (o.min !== undefined && n < o.min) return o.min;
    if (o.max !== undefined && n > o.max) return o.max;
    return n;
  }

  const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];
  // Matches javascript:, data:, vbscript:, file:, about: — case/whitespace
  // tolerant so `  JavaScript:alert(1)` is still caught.
  const DANGEROUS_SCHEME_RE = /^\s*(?:javascript|data|vbscript|file|about)\s*:/i;

  function url(str, opts) {
    const o = opts || {};
    const schemes = o.schemes || SAFE_SCHEMES;
    const allowRelative = o.allowRelative !== false;
    const s = String(str == null ? '' : str).trim();
    if (!s) return '';
    if (DANGEROUS_SCHEME_RE.test(s)) return '';
    // Relative references: path, hash, query, or a bare filename.
    if (allowRelative && /^(?:[/#?]|[\w.-]+\.html(?:[?#]|$))/.test(s)) {
      return s;
    }
    try {
      const u = new URL(s, window.location.origin);
      if (!schemes.includes(u.protocol)) return '';
      return u.href;
    } catch (_) {
      return '';
    }
  }

  /**
   * Safely read a URL query parameter.
   *   urlParam('courseId', { type: 'id' })     → validated slug or null
   *   urlParam('email',    { type: 'email' })  → email or null
   *   urlParam('q',        { type: 'text', maxLength: 120 })
   *   urlParam('intent',   { pattern: /^pi_[a-zA-Z0-9]+$/ })
   */
  function urlParam(key, opts) {
    const o = opts || {};
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(key);
    if (raw == null) return null;
    const maxLength = o.maxLength || 200;
    let s = stripControl(raw).slice(0, maxLength);
    if (o.pattern && !o.pattern.test(s)) return null;
    switch (o.type) {
      case 'id':
        return /^[a-zA-Z0-9_-]{1,64}$/.test(s) ? s : null;
      case 'email':
        return isValidEmail(s) ? email(s) : null;
      case 'number': {
        const n = number(s, o);
        return n == null ? null : n;
      }
      case 'url':
        return url(s) || null;
      case 'text':
      default:
        return text(s, { maxLength });
    }
  }

  function setText(el, str) {
    if (!el) return;
    el.textContent = str == null ? '' : String(str);
  }

  function setHTML(el, str) {
    if (!el) return;
    el.innerHTML = escape(str);
  }

  /**
   * Recursively sanitize a plain object (typically a request body).
   * - Strings: stripControl + length cap.
   * - Keys: only string keys under 128 chars are kept.
   * - Depth cap prevents pathological inputs from exploding the call
   *   stack. Past the cap, that branch is dropped.
   *
   * Does NOT escape HTML — that would double-encode content the server
   * stores verbatim. This is transport-layer hygiene, not display escape.
   */
  function deepClean(obj, opts) {
    const o = opts || {};
    const maxDepth = o.maxDepth || 6;
    const maxStringLength = o.maxStringLength || 10_000;
    function walk(v, depth) {
      if (depth > maxDepth) return null;
      if (v == null) return v;
      const t = typeof v;
      if (t === 'string') return stripControl(v).slice(0, maxStringLength);
      if (t === 'number' || t === 'boolean') return v;
      if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < v.length && i < 500; i++) out.push(walk(v[i], depth + 1));
        return out;
      }
      if (t === 'object') {
        // Skip exotic objects — FormData, Blob, File, etc. — let the
        // caller pass them through untouched by returning as-is.
        if (v instanceof FormData || v instanceof Blob ||
            (typeof File !== 'undefined' && v instanceof File)) return v;
        const out = {};
        for (const [k, val] of Object.entries(v)) {
          if (typeof k === 'string' && k.length <= 128) {
            out[k] = walk(val, depth + 1);
          }
        }
        return out;
      }
      return v;
    }
    return walk(obj, 0);
  }

  // ── Auto-wire [data-sanitize] inputs ───────────────────────────────
  //
  // Mid-typing normalization is annoying (lowercasing "Foo" to "foo"
  // while the user is still typing moves the caret). So the handlers
  // fire only on:
  //   • paste   — immediately after paste settles, clean the pasted text
  //   • blur    — once the user leaves the field
  //   • submit  — as a final sweep via Patterns.form integration
  //
  const RULE_FNS = {
    email,
    name,
    search,
    text: (v) => text(v, { maxLength: 2000 }),
    number: (v) => {
      const n = number(v);
      return n == null ? '' : String(n);
    },
  };

  function wireInput(el) {
    if (!el || el.__eneSanitizeWired) return;
    const rule = el.dataset && el.dataset.sanitize;
    const fn = rule && RULE_FNS[rule];
    if (!fn) return;
    el.__eneSanitizeWired = true;

    const cleanValue = () => {
      const current = el.value;
      const cleaned = fn(current);
      if (cleaned !== current) el.value = cleaned;
    };

    el.addEventListener('paste', () => queueMicrotask(cleanValue));
    el.addEventListener('blur', cleanValue);
  }

  function wire(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll('input[data-sanitize], textarea[data-sanitize]');
    nodes.forEach(wireInput);
  }

  if (document.readyState !== 'loading') {
    wire();
  } else {
    document.addEventListener('DOMContentLoaded', () => wire(), { once: true });
  }

  // Catch inputs added by dynamic rendering (dashboard cards, etc.).
  try {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (node.matches && node.matches('input[data-sanitize], textarea[data-sanitize]')) {
            wireInput(node);
          }
          if (node.querySelectorAll) wire(node);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) { /* MutationObserver unavailable — static wire is enough */ }

  window.Sanitize = {
    escape, text, name, email, isValidEmail, password, search, number,
    url, urlParam, attr, setText, setHTML, deepClean, stripControl, wire,
    // Exposed for Patterns.form integration.
    _ruleFns: RULE_FNS,
  };
})();
