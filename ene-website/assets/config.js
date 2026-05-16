/**
 * ENE — runtime API configuration.
 *
 * Single source of truth for the backend base URL. Loaded via a <script>
 * tag at the top of every page so window.ENE_API_BASE is set before any
 * fetch() runs.
 *
 * Resolution order (first match wins):
 *
 *   1. <meta name="ene-api-base" content="https://api.example.com/api">
 *      Lets a deploy override the default without touching JS.
 *
 *   2. localhost / 127.0.0.1 development:
 *      Frontend at :5500 hitting backend at :5000 → http://localhost:5000/api
 *      Frontend ALREADY at :5000 (combined deploy locally) → /api
 *
 *   3. Production same-origin (recommended deploy):
 *      Backend serves the frontend statics; API lives at /api on the same
 *      origin. No CORS, no config drift.
 *
 * To run a split frontend/backend deploy, set the meta tag in each HTML
 * file's <head>:
 *
 *   <meta name="ene-api-base" content="https://your-api-host.com/api">
 */
(function () {
  function resolve() {
    // 1. Explicit override via <meta name="ene-api-base">
    var meta = document.querySelector('meta[name="ene-api-base"]');
    if (meta && meta.getAttribute('content')) {
      return meta.getAttribute('content').replace(/\/+$/, '');
    }

    var loc = window.location;
    var host = loc.hostname;
    var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';

    // 2. Opened directly from disk (file://) — assume backend on localhost:5000.
    //    Some browsers will still block file:// → http: fetches, but this at
    //    least gives the right URL. The server's dev-mode CORS now accepts
    //    `null` Origin so the browser side will succeed where it can.
    if (loc.protocol === 'file:') {
      return 'http://localhost:5000/api';
    }

    // 3. Local dev — frontend on a different port from the backend
    if (isLocal && loc.port !== '5000') {
      return 'http://localhost:5000/api';
    }

    // 4. Same-origin production deploy (or local combined-mode)
    return loc.origin + '/api';
  }

  window.ENE_API_BASE = resolve();
})();
