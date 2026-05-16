# ENE — Enterprise Ops Playbook

Config recipes for the parts of the 10/10 upgrade that require external accounts. Pair with `DEPLOY.md` (infra basics) and `PROJECT_STATE.md` (architecture).

---

## 1. Secrets — AWS Secrets Manager

One JSON secret, one IAM role. No static creds anywhere in the container env.

### AWS setup

```bash
# Create the secret (values are examples; use real ones)
aws secretsmanager create-secret \
  --name ene/prod \
  --description "ENE prod secrets" \
  --secret-string '{
    "MONGO_URI": "mongodb+srv://ene_prod:<32-char-random>@cluster0.mongodb.net/ene",
    "JWT_SECRET": "<64-hex-chars-from-randomBytes>",
    "TURNSTILE_SECRET": "0x4AAAAA..."
  }'

# IAM policy — attach to the compute role (ECS task role / EC2 instance profile / Lambda exec role)
cat > ene-secrets-read.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:us-east-1:123456789012:secret:ene/prod-*"
  }]
}
JSON
aws iam create-policy --policy-name ENESecretsRead --policy-document file://ene-secrets-read.json
aws iam attach-role-policy --role-name ene-task-role --policy-arn arn:aws:iam::123456789012:policy/ENESecretsRead
```

### Container env

```bash
# In the task definition / deploy platform — only these stay as plain env:
SECRETS_PROVIDER=aws
AWS_REGION=us-east-1
AWS_SECRETS_NAME=ene/prod
NODE_ENV=production
TRUST_PROXY=1
COOKIE_SAMESITE=strict
CLIENT_URL=https://ene.app

# NO MONGO_URI, NO JWT_SECRET — lib/secrets.js fetches them at boot.
```

### Rotation

- Atlas: rotate password → update the secret JSON in AWS SM.
- App picks it up on the next refresh tick (default 5 min).
- No restart needed unless `lib/secrets.onRotate()` handlers need a reconnect.

### Vault / Doppler

Same pattern, different provider. See `lib/secrets.js`:

```
SECRETS_PROVIDER=vault     VAULT_ADDR=...   VAULT_TOKEN=...   VAULT_PATH=secret/data/ene/prod
SECRETS_PROVIDER=doppler   # run under: doppler run -- node server.js
```

---

## 2. Cloudflare Zero Trust Access — protect `/admin`

Admin routes shouldn't rely solely on the JWT role check. Add Cloudflare Access in front so admin is only reachable via Google / Okta / email OTP, from specific countries, on a managed device.

### Setup (Cloudflare dashboard)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Application domain: `ene.app`, path: `/admin` (or the specific API subpath like `/api/admin/*`).
3. Session duration: 8 hours.
4. Identity providers: enable Google + Okta (or whatever IdP you use).
5. **Policies → Add a policy:**

   ```
   Name:       ene-admin-access
   Action:     Allow
   Include:    Emails ending in @yourcompany.com
   Require:    Country is US | UK (geofence)
               Authentication Method MFA
               Device Posture: WARP client + managed device
   ```
6. Save. Cloudflare will now enforce this at the edge — unauthorized users never reach Node.

### Backend assertion (belt + braces)

Add a middleware that checks the `Cf-Access-Authenticated-User-Email` header Cloudflare injects after successful auth:

```js
// middleware/cfAccess.js
module.exports = function requireCfAccess(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (!cfEmail || !cfEmail.endsWith('@yourcompany.com')) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  req.cfEmail = cfEmail;
  next();
};

// server.js (before adminRoutes)
app.use('/api/admin', require('./middleware/cfAccess'));
```

Plus verify the JWT — `Cf-Access-Jwt-Assertion` header is a signed JWT issued by Cloudflare; validate with Cloudflare's public key for true zero-trust. Required for high-security compliance (SOC2, ISO 27001).

---

## 3. SIEM integration

All structured logs flow through `lib/logger.js` (pino). In production, point pino at a transport that forwards to your SIEM.

### Option A — Datadog

```bash
npm install pino-datadog-transport
```

```js
// lib/logger.js — production branch
const transport = pino.transport({
  target: 'pino-datadog-transport',
  options: {
    ddClientConf: { authMethods: { apiKeyAuth: process.env.DD_API_KEY } },
    service: 'ene-backend',
    ddsource: 'nodejs',
    ddtags: 'env:prod',
  },
});
module.exports = pino({ ... }, transport);
```

### Option B — Better Stack (Logtail)

```bash
npm install @logtail/pino
```

```js
const transport = pino.transport({
  target: '@logtail/pino',
  options: { sourceToken: process.env.LOGTAIL_TOKEN },
});
```

### Option C — Grafana Loki (self-hosted)

Ship via Promtail reading the container stdout, or direct push:

```bash
npm install pino-loki
```

```js
const transport = pino.transport({
  target: 'pino-loki',
  options: {
    host: 'https://logs-prod.grafana.net',
    basicAuth: { username: 'xxx', password: process.env.LOKI_KEY },
    labels: { app: 'ene', env: 'prod' },
  },
});
```

### Alerting rules (SIEM side)

Regardless of SIEM, configure these rules:

| Rule | Trigger | Action |
|---|---|---|
| Brute force | `count(action="auth.login.bad_password") > 50` in 5 min | Slack `#sec-alerts` |
| Token theft | any `action="auth.refresh.refresh_reused"` | Page on-call |
| Admin lockout | any `action="auth.login.locked" AND actorRole="admin"` | Page on-call |
| Mass register spam | `count(action="auth.register.duplicate") > 100` in 10 min | Slack `#sec-alerts` |
| Error rate | `rate(http_requests_total{status=~"5.."}) > 0.05` | Page on-call |
| p99 latency | `histogram_quantile(0.99, http_request_duration_seconds) > 2s` for 5 min | Slack `#ene-ops` |
| Event loop lag | `nodejs_eventloop_lag_seconds > 0.2` for 2 min | Slack `#ene-ops` |

---

## 4. Redis / ElastiCache

Set `REDIS_URL` in production and:

- `lib/cache.js` uses Redis for query caching (courses list, stats)
- `lib/rateLimiterStore.js` moves rate-limit counters to Redis — limits are GLOBAL across pods instead of per-instance

Providers: Upstash (serverless, free tier), AWS ElastiCache (VPC-bound, prod-grade), Railway Redis (simple), Fly.io Redis (edge, pricey).

```bash
REDIS_URL=rediss://default:<pass>@host:6379
CACHE_SCHEMA_VERSION=1  # bump on breaking cache payload changes
```

---

## 5. Turnstile (Cloudflare)

Protects register + login against scripted attacks.

### Setup

1. Cloudflare dashboard → **Turnstile → Add site.**
2. Copy the **site key** (public) and **secret key** (server).
3. Set env: `TURNSTILE_SECRET=0x4AAAAA...`
4. Frontend forms (register, login): add the widget.

```html
<!-- Before the submit button in register.html / login.html -->
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>
<div class="cf-turnstile" data-sitekey="YOUR_SITE_KEY" data-callback="onTurnstile"></div>

<script nonce="{{NONCE}}">
  // Read the token right before submit
  window.onTurnstile = (t) => { window.__turnstileToken = t; };
  form.addEventListener('submit', (e) => {
    // ... existing body + include turnstileToken:
    body.turnstileToken = window.__turnstileToken;
  });
</script>
```

Backend `requireTurnstile()` middleware on `/auth/register` + `/auth/login` (already wired — no-op if `TURNSTILE_SECRET` is unset).

---

## 6. Metrics scraping

`/api/metrics` outputs Prometheus text format. Scrape options:

### Prometheus / Grafana Cloud

```yaml
# prometheus.yml
scrape_configs:
  - job_name: ene-backend
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials: ${METRICS_TOKEN}
    static_configs:
      - targets: ['api.ene.app:443']
    scheme: https
```

### Grafana dashboards to create

1. **Golden signals** — requests/sec, error rate, p50/p95/p99 latency, saturation.
2. **Auth events** — login success vs fail, register success vs dup, lockouts, refresh reuse.
3. **Rate-limit blocks** — by layer (burst/global/login/register).
4. **Node runtime** — event-loop lag, heap, GC pauses.

Set up in Grafana → Import dashboard IDs: 11159 (Node.js Application Dashboard) + custom.

---

## 7. Attack simulation (CI)

Add to CI so every deploy verifies defenses hold:

```yaml
# .github/workflows/security-regression.yml
name: security-regression
on: [push, pull_request]
jobs:
  simulate:
    runs-on: ubuntu-latest
    services:
      mongo:
        image: mongo:7
        ports: ['27017:27017']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: ene-backend
      - run: node server.js &
        working-directory: ene-backend
        env:
          MONGO_URI: mongodb://localhost:27017/ene-test
          JWT_SECRET: ${{ secrets.TEST_JWT_SECRET }}
          NODE_ENV: test
      - run: sleep 5 && npm run attack:simulate
        working-directory: ene-backend
```

The `npm run attack:simulate` script exercises: NoSQL injection, XSS echo, distributed brute-force, refresh-token reuse, CSRF, admin unauth, mass assignment, weak password, slowloris timing, open-redirect — 11 assertions, exit non-zero on any failure.
