# ENE — Deploy guide

Two ways to ship this. Combined mode is simpler. Pick one.

---

## Mode A — Combined deploy (recommended)

One service runs the API **and** serves the frontend HTML. No CORS to configure, one URL, one set of secrets.

### One-click on Render

1. Push the repo (with both `ene-backend/` and `ene-website/`) to GitHub.
2. Render dashboard → **New** → **Blueprint** → point at the repo.
3. Render reads `ene-backend/render.yaml` and provisions the web service.
4. In the env tab, fill in:
   - `MONGO_URI` — your Atlas connection string
   - `JWT_SECRET` — long random string, ≥32 chars
     - Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
5. Deploy. Health check is at `/api/health`. Frontend is at `/`.

### Manual / any host (Railway, Fly, Heroku, plain VPS)

Set these env vars before starting `node server.js`:

```bash
NODE_ENV=production
SERVE_STATIC=1                     # serve the frontend from the same service
STATIC_DIR=../ene-website          # path to the website folder
TRUST_PROXY=1                      # set this when behind a real reverse proxy
MONGO_URI=mongodb+srv://...
JWT_SECRET=<≥32 random chars>
JWT_EXPIRES_IN=7d
PORT=5000                          # most platforms set this for you
```

That's it. The frontend auto-detects same-origin and calls `/api/...`.

---

## Mode B — Split deploy (frontend on Vercel/Netlify, backend on Render)

Use this when you want a CDN in front of the static frontend.

### Backend (Render)

Same as Mode A but **without** `SERVE_STATIC`:

```bash
NODE_ENV=production
TRUST_PROXY=1
MONGO_URI=mongodb+srv://...
JWT_SECRET=<≥32 random chars>
CLIENT_URL=https://your-frontend-domain.com   # comma-separated for multiple
```

### Frontend (Vercel / Netlify / Cloudflare Pages)

Drop the `ene-website/` folder onto the host. No build step.

Then tell the frontend where the API lives — add this `<meta>` tag to the `<head>` of every HTML file (`index.html`, `login.html`, `register.html`, `dashboard.html`, `course.html`):

```html
<meta name="ene-api-base" content="https://your-backend.onrender.com/api">
```

The auto-detect in `assets/config.js` picks it up. No JS rebuild needed.

---

## Local development (unchanged)

Two terminals:

```bash
# Backend
cd ene-backend && npm install && npm run dev   # → http://localhost:5000

# Frontend
cd ene-website && python3 -m http.server 5500   # → http://localhost:5500
```

The frontend auto-detects localhost-on-a-different-port and routes API calls to `http://localhost:5000/api`.

---

## Required env vars at a glance

| Var | Required | Notes |
|---|---|---|
| `MONGO_URI` | ✅ | Atlas or self-hosted MongoDB |
| `JWT_SECRET` | ✅ | ≥32 chars, generate randomly |
| `JWT_EXPIRES_IN` | optional | default `7d` |
| `PORT` | optional | platform usually sets this |
| `NODE_ENV` | optional | `production` in deploys |
| `SERVE_STATIC` | combined mode | `1` to also serve the frontend |
| `STATIC_DIR` | combined mode | path to `ene-website`, default `../ene-website` |
| `TRUST_PROXY` | behind a proxy | `1` for typical PaaS, or a number/CIDR |
| `CLIENT_URL` | split mode | CORS allow-list, comma-separated |
| `SSL_KEY_PATH` | self-hosted TLS | absolute path to private key file |
| `SSL_CERT_PATH` | self-hosted TLS | absolute path to certificate file |
| `SSL_CA_PATH` | self-hosted TLS | optional intermediate CA bundle |
| `HTTPS_PORT` | self-hosted TLS | default `443` when SSL files are set |
| `HTTP_REDIRECT` | self-hosted TLS | `0` to skip the port-80 → HTTPS redirector |
| `SERVER_HEADERS_TIMEOUT_MS` | optional | max ms to receive full request headers, default `10000` |
| `SERVER_REQUEST_TIMEOUT_MS` | optional | max ms to receive full request body, default `30000` |
| `SERVER_KEEPALIVE_TIMEOUT_MS` | optional | idle keep-alive close, default `5000` |
| `SERVER_MAX_CONNECTIONS` | optional | hard cap on concurrent sockets, default `1024` |
| `LOOP_LAG_THRESHOLD_MS` | optional | event-loop lag above this returns 503, default `200` |

---

## SSL / HTTPS

The backend handles HTTPS in three different ways depending on where you deploy.

### Path 1 — Behind a managed proxy (Render, Railway, Heroku, Fly, Vercel)

You don't manage the cert. The platform does. Set:

```bash
NODE_ENV=production
TRUST_PROXY=1
```

That's it. The app will:
- Read `X-Forwarded-Proto` from the proxy so `req.secure` reflects the real protocol
- 308-redirect any plain-HTTP request that slips through (preserves POST/PUT method)
- Send `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (eligible for the [Chromium HSTS preload list](https://hstspreload.org))
- Exempt `/api/health` from HTTPS redirect AND CORS so the platform's health probe always succeeds

The `render.yaml` blueprint already sets these.

### Path 2 — Behind your own Nginx / Caddy

Same as Path 1. Configure your front-end proxy to:
- Terminate TLS with your cert
- Forward to Node on plain HTTP
- Set `X-Forwarded-Proto: https` and `X-Forwarded-For: <client>`

In your env: `TRUST_PROXY=1` (or a CIDR like `10.0.0.0/8` if you want to restrict which proxies are trusted).

**Caddy** does this automatically with one line:

```
ene.example.com {
  reverse_proxy localhost:5000
}
```

Caddy auto-provisions a Let's Encrypt cert.

### Path 3 — Node terminates TLS itself (no proxy)

Set the SSL paths and Node will start an HTTPS server directly:

```bash
SSL_KEY_PATH=/etc/ssl/private/example.key
SSL_CERT_PATH=/etc/ssl/certs/example.crt
SSL_CA_PATH=/etc/ssl/certs/intermediate.pem    # optional
HTTPS_PORT=443
PORT=80                                        # for the HTTP→HTTPS redirector
```

The HTTPS server boots on `HTTPS_PORT`, and a tiny HTTP listener on `PORT` 308-redirects everything to HTTPS. Set `HTTP_REDIRECT=0` to skip the redirector if port 80 isn't available.

To get a real cert, the easy paths are:
- **certbot standalone** (one-time, ~5 min):
  ```bash
  sudo certbot certonly --standalone -d ene.example.com
  # → cert at /etc/letsencrypt/live/ene.example.com/fullchain.pem
  # → key  at /etc/letsencrypt/live/ene.example.com/privkey.pem
  ```
  Then point `SSL_CERT_PATH` and `SSL_KEY_PATH` at those files. Set up a renewal cron — `certbot renew` every 60 days.
- **Caddy in front instead** — way less moving parts (see Path 2).

### Local HTTPS testing (optional)

If you want to test the production HTTPS flow locally, generate a trusted cert with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
brew install mkcert nss      # macOS — nss is needed for Firefox trust
mkcert -install              # registers a local CA
mkcert localhost 127.0.0.1   # produces localhost+1.pem and localhost+1-key.pem
```

Then run the backend with:

```bash
SSL_KEY_PATH=$PWD/localhost+1-key.pem \
SSL_CERT_PATH=$PWD/localhost+1.pem \
HTTPS_PORT=5443 \
PORT=5080 \
NODE_ENV=production \
node server.js
```

Open `https://localhost:5443/` — no browser cert warning because mkcert installed a trusted local CA.

---

## DoS / DDoS hardening

The backend has five layers of application-level defense. None of them stop a volumetric L3/L4 flood — for that you need a proxy in front. Skip to **Cloudflare in front** below.

### What the app already does

| Layer | What it blocks | Tunable via |
| --- | --- | --- |
| HTTP socket timeouts (`headersTimeout`, `requestTimeout`, `keepAliveTimeout`) | Slowloris — clients drip-feeding headers/bodies to pin file descriptors | `SERVER_HEADERS_TIMEOUT_MS`, `SERVER_REQUEST_TIMEOUT_MS`, `SERVER_KEEPALIVE_TIMEOUT_MS` |
| Max connections cap (1024 default) | Socket/FD exhaustion from many concurrent idle peers | `SERVER_MAX_CONNECTIONS` |
| Event-loop shedder | CPU saturation — returns 503 + `Retry-After` when loop lag > 200 ms | `LOOP_LAG_THRESHOLD_MS` |
| Burst rate limiter (30 / 10 s per socket IP) | Sudden spikes (scrapers, retry loops, credential stuffing) | code (`burstLimiter` in `server.js`) |
| Global rate limiter (300 / 15 min per socket IP) | Sustained scraping | code (`globalLimiter` in `server.js`) |
| Auth limiters (5 / hr register, 10 / 5 min login per IP+email) | Brute force, signup spam | code (`routes/authRoutes.js`) |

All limiters key on the TCP peer address (not the `X-Forwarded-For` header), and normalize IPv6 to a /64 prefix so attackers can't carve buckets by rotating low-64 bits. `/api/health` is exempt from the shedder and burst limiter so PaaS health probes stay green during recovery.

### Cloudflare in front (free tier, recommended)

Application-level defenses can't stop a 10 Gbps UDP flood — those packets need to be dropped at the edge, before they ever reach Node. Cloudflare's free tier does this.

**Setup (~5 min, zero downtime if the domain's nameservers are already on Cloudflare):**

1. Create a free Cloudflare account → **Add a Site** → enter your domain.
2. Change your domain's nameservers at your registrar to the ones Cloudflare shows.
3. In Cloudflare DNS, add an `A` record pointing to your backend host (Render's IP, your VPS, whatever). **Toggle the proxy icon to orange/on** — this is the critical step; grey = DNS only = no protection.
4. **SSL/TLS → Overview → Full (strict)**. Requires a valid cert on the origin — managed platforms (Render, Railway, Fly) already have this.
5. **Security → Settings → Security Level → Medium** (or High if under active attack).
6. **Security → WAF → Managed Rules → enable the Cloudflare Free managed ruleset.**
7. **Security → Bots → Bot Fight Mode: on** (free tier).
8. **Rules → Rate Limiting Rules** → add a rule: `10 requests per 10 seconds per IP, action: block for 1 min`. This is on top of the app's own limiters and runs at the edge.

**In the backend env:** keep `TRUST_PROXY=1` so Cloudflare's `X-Forwarded-For` is honored for logging (the app's rate limiters ignore XFF and key on the socket — which is Cloudflare's IP when proxied — so per-Cloudflare-IP limits still apply, and anything that slips through Cloudflare still hits a rate limit).

**Optional — lock the origin.** Once Cloudflare is proxying, restrict the origin host's firewall to only accept inbound 443 from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/). Then an attacker who discovers the origin IP can't bypass Cloudflare.

### Tightening the knobs under attack

If the platform is actively being hit and you need to turn the screws without a code deploy:

```bash
# Shorter timeouts — drop slow clients faster
SERVER_HEADERS_TIMEOUT_MS=5000
SERVER_REQUEST_TIMEOUT_MS=15000

# Lower event-loop threshold — shed earlier, keep the healthy 5% alive
LOOP_LAG_THRESHOLD_MS=100

# Tighter connection cap (match what your box can actually handle)
SERVER_MAX_CONNECTIONS=512
```

Changes take effect on next process restart.

---

## Pre-deploy checklist

- [ ] `JWT_SECRET` is ≥32 chars and not the example value
- [ ] `MONGO_URI` works (Atlas IP allowlist includes the deploy host, or `0.0.0.0/0`)
- [ ] If behind a proxy, `TRUST_PROXY=1` is set (or rate limits will block everyone)
- [ ] Combined mode: visit `/` → landing page; `/api/health` → JSON 200
- [ ] Split mode: `CLIENT_URL` includes the exact frontend origin (no trailing slash)
- [ ] Run the seed scripts once after first deploy:
      `node scripts/seedCourses.js && node scripts/seedMentors.js && …`
- [ ] Promote your admin user: `node scripts/promoteAdmin.js you@example.com`

---

## Troubleshooting

**"We can't reach the service right now" in the browser**
→ Open DevTools → Network. The failing request shows the actual error.

- `(failed) net::ERR_CONNECTION_REFUSED` → backend not running or wrong URL
- `Access to fetch ... blocked by CORS policy` → frontend origin not in `CLIENT_URL` (split mode), or `<meta name="ene-api-base">` is wrong

**Login works but every authed request returns 401 from a deployed instance**
→ Check Atlas IP allowlist. Render's outbound IPs must be allowed.

**Rate limit hits everyone immediately when deployed**
→ Set `TRUST_PROXY=1`. Without it, every request looks like it comes from the proxy IP and shares one bucket.

**Inline script blocked by CSP after deploying combined mode**
→ Confirm `SERVE_STATIC=1` is actually set — the relaxed CSP only activates when that flag is on.
