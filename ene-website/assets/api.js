/**
 * ENE — shared frontend API helpers.
 *
 * All requests use credentials: 'include' so the HttpOnly auth cookies
 * (ene_at / ene_rt) travel automatically. JS never touches the tokens.
 * This is the core XSS-containment primitive: even if an attacker runs
 * JS in this origin, they cannot read or exfiltrate the tokens.
 *
 * Auto-refresh:
 *   If any call returns 401 AND the failure wasn't a refresh itself,
 *   we call /api/auth/refresh once, then retry the original request.
 *   If the refresh also fails, we treat the session as dead, wipe the
 *   UI-hint cookie, and redirect to login.
 *
 * Usage:
 *   const { ok, status, body } = await api.get('/users/me');
 *   await api.post('/enroll/123');
 *   await api.put('/users/me', { name: 'x' });
 *   await api.logout();
 *   if (api.isAuthed()) renderAuthedUI();
 */
(function () {
  const BASE = window.ENE_API_BASE;
  if (!BASE) {
    console.warn('[api] window.ENE_API_BASE not set — include assets/config.js first');
  }

  // Non-HttpOnly UI hint. Presence ≠ authorized (server still verifies)
  // but its presence is a good-enough signal to render the authed shell
  // without blocking on /users/me.
  function hasUiHint() {
    return /(?:^|; )ene_auth=1(?:;|$)/.test(document.cookie);
  }

  function dropUiHint() {
    // Expire it client-side so subsequent isAuthed() checks return false.
    // Real tokens are HttpOnly — logout API call is what actually revokes.
    document.cookie = 'ene_auth=; Path=/; Max-Age=0; SameSite=Strict';
    // Purge the cached user snapshot too. If we don't, `api.me()` keeps
    // returning the stale cache even though the server-side session is
    // dead — pages render a ghost-authed UI where every sub-call 401s.
    try {
      sessionStorage.removeItem('ene.state.user');
      if (window.ENE_STATE) {
        window.ENE_STATE.user = null;
        window.ENE_STATE.isAuthenticated = false;
      }
    } catch (_) {}
  }

  async function rawFetch(path, { method = 'GET', body, headers, raw } = {}) {
    const finalHeaders = { ...(headers || {}) };
    if (body !== undefined && !(body instanceof FormData)) {
      finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
    }
    const init = {
      method,
      headers: finalHeaders,
      credentials: 'include',
    };
    if (body !== undefined) {
      if (body instanceof FormData) {
        init.body = body;
      } else {
        // Last-line-of-defence body hygiene: strip control chars and cap
        // string lengths before serialising. Server validation is still
        // authoritative; this just ensures a field like `name` can never
        // smuggle a NULL byte or a 10 MB payload to the backend.
        // Callers that need a verbatim pass-through (binary JSON, etc.)
        // can opt out with `{ raw: true }`.
        const clean = (raw === true || !window.Sanitize)
          ? body
          : window.Sanitize.deepClean(body);
        init.body = JSON.stringify(clean);
      }
    }

    let response;
    try {
      response = await fetch(`${BASE}${path}`, init);
    } catch (err) {
      return {
        ok: false, status: 0,
        body: { success: false, message: "We can't reach the service right now. Please try again in a moment." },
      };
    }

    // Parse JSON if the body is JSON; tolerate empty bodies.
    let data = {};
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = await response.json(); } catch { /* empty body */ }
    }

    return { ok: response.ok, status: response.status, body: data };
  }

  // Single-flight refresh so multiple concurrent 401s don't each fire one.
  let refreshInFlight = null;
  async function attemptRefresh() {
    if (!refreshInFlight) {
      refreshInFlight = rawFetch('/auth/refresh', { method: 'POST' })
        .finally(() => { refreshInFlight = null; });
    }
    const { ok } = await refreshInFlight;
    return ok;
  }

  async function request(path, opts = {}) {
    const first = await rawFetch(path, opts);

    // Don't recursively retry the refresh endpoint, or anything that isn't
    // an auth-gated 401.
    if (first.status !== 401 || path.startsWith('/auth/refresh') || path.startsWith('/auth/logout')) {
      return first;
    }

    const refreshed = await attemptRefresh();
    if (!refreshed) {
      dropUiHint();
      return first;
    }
    return rawFetch(path, opts);
  }

  // ── Global state cache ────────────────────────────────────────────
  // `ENE_STATE` holds a session-scoped snapshot of the authed user.
  // Pages that used to fetch /users/me independently now call api.me()
  // which returns the cached record or fetches once. Reduces dashboard
  // navigation to zero redundant round-trips after the first page.
  //
  // sessionStorage is the right backing store — cleared on tab close so
  // stale state never haunts a re-login, but reused across hard
  // navigations within the same tab (the common case).
  const STATE_KEY = 'ene.state.user';

  function loadCachedUser() {
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Max 60s freshness. Any stale state forces a refetch so gamification
      // values (XP, streak, level) stay accurate after mutations.
      if (!parsed || !parsed.user || (Date.now() - parsed.at) > 60_000) return null;
      return parsed.user;
    } catch { return null; }
  }
  function saveCachedUser(user) {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify({ user, at: Date.now() }));
    } catch (_) {}
  }
  function clearCachedUser() {
    try { sessionStorage.removeItem(STATE_KEY); } catch (_) {}
  }

  // Hydrate the global on script load — lets code check
  // `window.ENE_STATE.user` synchronously without awaiting.
  window.ENE_STATE = {
    user: loadCachedUser(),
    isAuthenticated: false,
    // Callback registry — components can subscribe to state updates.
    _subs: new Set(),
    subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
    _notify() { for (const f of this._subs) { try { f(this); } catch (_) {} } },
  };
  window.ENE_STATE.isAuthenticated = !!window.ENE_STATE.user;

  // Single-flight /users/me so concurrent `api.me()` callers share one fetch.
  let meInFlight = null;
  async function me(opts = {}) {
    const force = opts && opts.force === true;
    if (!force) {
      const cached = window.ENE_STATE.user || loadCachedUser();
      if (cached) return { ok: true, status: 200, body: { success: true, data: cached }, cached: true };
    }
    if (!meInFlight) {
      meInFlight = request('/users/me').finally(() => { meInFlight = null; });
    }
    const res = await meInFlight;
    if (res.ok && res.body && res.body.data) {
      const u = res.body.data;
      window.ENE_STATE.user = u;
      window.ENE_STATE.isAuthenticated = true;
      saveCachedUser(u);
      window.ENE_STATE._notify();
    }
    return res;
  }

  // ── Debug mode (perf tracing) ─────────────────────────────────────
  // Set `window.ENE_DEBUG = true` from the console, or pass ?debug=1 on
  // the URL, to log request timings + render timings. Off by default so
  // no overhead in production.
  const DEBUG = window.ENE_DEBUG === true ||
                /(?:^|[?&])debug=1(?:&|$)/.test(window.location.search);
  if (DEBUG) window.ENE_DEBUG = true;

  function dtime(label) {
    if (!DEBUG) return () => {};
    const t0 = performance.now();
    return () => {
      const ms = (performance.now() - t0).toFixed(1);
      console.log('%c[ENE]%c ' + label + ' %c' + ms + 'ms',
        'color:#f48003;font-weight:700', 'color:inherit', 'color:#15c7bc');
    };
  }

  // Wrap request() with timing instrumentation when debug is on.
  const _baseRequest = request;
  const timedRequest = async (path, opts) => {
    const end = dtime('→ ' + (opts?.method || 'GET') + ' ' + path);
    const r = await _baseRequest(path, opts);
    end();
    return r;
  };

  // Convenience verbs
  const api = {
    BASE,
    DEBUG,
    isAuthed: hasUiHint,
    get:  (p)         => timedRequest(p),
    post: (p, body)   => timedRequest(p, { method: 'POST', body }),
    put:  (p, body)   => timedRequest(p, { method: 'PUT',  body }),
    del:  (p)         => timedRequest(p, { method: 'DELETE' }),

    /** Cached /users/me — single fetch per tab, shared across pages. */
    me,

    /** Drop cached user (call after password change, logout, etc.). */
    invalidateMe() { clearCachedUser(); window.ENE_STATE.user = null; window.ENE_STATE.isAuthenticated = false; },

    /** Mark render done (for debug timing). */
    mark(label) { if (DEBUG) console.log('%c[ENE]%c ✓ ' + label + ' %c' + performance.now().toFixed(0) + 'ms',
      'color:#f48003;font-weight:700', 'color:inherit', 'color:#888'); },

    /** Server revokes the refresh token + clears cookies. */
    async logout() {
      try { await rawFetch('/auth/logout', { method: 'POST' }); } catch (_) {}
      dropUiHint();
      clearCachedUser();
      window.ENE_STATE.user = null;
      window.ENE_STATE.isAuthenticated = false;
    },

    /** Redirect to login if not authed. Cheap check via UI-hint cookie. */
    requireAuth() {
      if (!hasUiHint()) window.location.replace('login.html');
    },

    /**
     * Redirect authed users away from login/register pages.
     *
     * The UI hint cookie (`ene_auth`) lasts 30 days but access tokens expire
     * in 15 min and refresh tokens can be revoked (password change, logout-
     * everywhere). A naive hint-only redirect creates a ping-pong: login →
     * dashboard → /users/me 401 → login → … Worse, if a cached user sits in
     * sessionStorage, dashboard paints authed but every sub-call 401s.
     *
     * So: optimistically redirect on UI hint, BUT fire a probe in parallel.
     * If the probe fails (refresh token dead), nuke the hint + cache and
     * stay on the login page so the user can actually re-authenticate.
     */
    redirectIfAuthed() {
      if (!hasUiHint()) return;
      // Fire-and-forget probe. If it fails, dropUiHint() (inside request())
      // already wiped the hint + cache — we just need to stop the redirect
      // from happening. Since navigation hasn't started yet, awaiting is
      // fine; the branch below only fires on explicit failure.
      (async () => {
        const r = await rawFetch('/auth/refresh', { method: 'POST' });
        if (r.ok) {
          window.location.replace('dashboard.html');
        } else {
          // Clear stale state so the login form is usable.
          dropUiHint();
        }
      })();
    },
  };

  window.api = api;
  if (DEBUG) api.mark('api.js loaded');
})();
