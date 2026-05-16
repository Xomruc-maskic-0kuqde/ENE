# ENE — Handoff (2026-04-22)

Welcome. This note is for whoever is picking this project up next. It
summarizes what works, what doesn't, and what you need to do to get a
local copy running.

## What this project is

ENE — Engineering New Era — a Coursera-style learning platform built as:

- **Frontend** — vanilla HTML + JavaScript + `assets/tokens.css` design
  system. No framework, no build step. 12 HTML pages.
- **Backend** — separate repo at `../ene-backend/`. Node.js + Express +
  MongoDB + JWT + Stripe. Serves `/api/*` on port 5000.

Design direction: **industrial-editorial dark-navy + orange accent**,
Space Grotesk display + Inter body + JetBrains Mono chrome, corner
brackets on surfaces, mono `[ BRACKETED ]` labels, flat CTA buttons.

## What's shipped (works end-to-end against the backend)

### Auth
- Register, login, logout, forgot password, reset password, verify email
- HttpOnly cookie sessions (`ene_at` / `ene_rt`), single-flight refresh
- Rate-limited server-side; UI hint cookie for fast redirects
- Test account: `smoke17698@test.com / smokepass` (promoted to admin)

### Learner flow
- Browse catalog (`courses.html`), pick a course, land on
  `course-landing.html?id=...`, enrol, watch lessons in `course.html`,
  mark lessons complete/uncomplete, see progress, dashboard stats
- Lesson content is gated — non-enrolled users see metadata only

### Admin
- All mutations on courses / lessons / mentors / testimonials / stats
  require admin role. No admin UI yet — use the API directly.

### Landing page
- Hero → trust bar → about → scroll-tilt preview → programs → why →
  mentors marquee → pricing interaction → final CTA (with tsparticles
  sparkles) → testimonials → footer → chatbot FAB (scripted, not AI)
- Populates live from `/api/stats|mentors|testimonials|courses`
- Silent fallback to static HTML when the backend is down

### Pages
- `index.html` — landing
- `courses.html` — browsable catalog (search + category chips)
- `course-landing.html` — per-course sales page
- `course.html` — lesson reader
- `dashboard.html` — logged-in dashboard
- `pricing.html` — plans & checkout launch
- `payment.html` / `payment-success.html` — Stripe Checkout integration
- `login.html` / `register.html` / `forgot-password.html` /
  `reset-password.html` / `verify-email.html`
- `privacy.html` / `terms.html` — full legal pages (draft — see below)
- `404.html` — branded error page

## Shared assets

- `assets/tokens.css` — design system (colors, type, cards, buttons,
  forms, motion primitives). Every page links this.
- `assets/config.js` — resolves `window.ENE_API_BASE` by environment
- `assets/sanitize.js` — XSS-hardening helpers (escape, url scheme
  allowlist, deepClean). Auto-wires `[data-sanitize]` inputs.
- `assets/api.js` — fetch wrapper with cookie auth + single-flight
  refresh + cached `/users/me`
- `assets/patterns.js` — form submit / state helpers
- `assets/analytics.js` — provider-agnostic analytics forwarder
  (Plausible + GA4). No-op unless an `ene-analytics-provider` meta tag
  is set on the page. Respects Do-Not-Track.
- `assets/og-cover.svg` — 1200x630 social share image. **Rasterize to
  `assets/og-cover.png` before deploy** (instructions in the SVG file).
- `robots.txt` + `sitemap.xml` — SEO. Replace `{{DOMAIN}}` with the
  real host before deploy.

## How to run locally

Two services needed.

```bash
# Tab 1 — backend
cd ../ene-backend
npm install     # once
npm run dev     # nodemon on port 5000

# Tab 2 — frontend (any static server)
cd ene-website
python3 -m http.server 5500
```

Open `http://localhost:5500/index.html`. **Don't open HTML files via
`file://`** — the backend CORS rejects the `null` origin.

### Backend env (`.env` in `ene-backend/`)
```
MONGO_URI=mongodb+srv://ene:<PASSWORD>@...mongodb.net/ene
JWT_SECRET=<96 hex chars, see PROJECT_STATE.md>
JWT_EXPIRES_IN=7d
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:5500,http://127.0.0.1:5500
```

## What's missing / needed before launch

Ranked by impact.

### Blockers for going live with payments

1. **Rotate Atlas DB password** — `PROJECT_STATE.md:84` still lists it
   as `NADER`. Must be changed in the MongoDB Atlas console, then
   update `MONGO_URI` in `.env`.
2. **Fill legal placeholders** — search `privacy.html` + `terms.html`
   for `{{` tokens. Company name, jurisdiction, registered address,
   currency, refund window, dispute venue. Have a lawyer in your
   jurisdiction review both documents.
3. **Stripe live mode** — create real products, set
   `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` env vars on the
   hosting platform, test checkout end-to-end.
4. **Transactional email** — password reset, email verification, and
   payment receipts all assume a provider. Not wired yet. Options:
   SendGrid, Postmark, Resend.
5. **Host + domain** — not deployed anywhere. Recommended stack:
   Railway or Render (single Node service, serves `/api/*` + frontend
   statics from the same origin). See `DEPLOY.md`.

### Important but not hard blockers

6. **Real content** — the 6 seeded courses use Unsplash stock photos
   and generic descriptions. 36 lesson records exist but no actual
   video content. This is the biggest real-world gap by far.
7. **Real mentors** — all 6 mentor cards are Unsplash stock photos +
   placeholder Arabic/English names. Nobody is actually lined up.
8. **Admin UI** — mutations are API-only right now.
9. **Rasterize OG image** — `assets/og-cover.svg` → `og-cover.png`.
10. **Replace `{{DOMAIN}}`** in `robots.txt` + `sitemap.xml`.
11. **Turn on analytics** — add one meta tag (see
    `assets/analytics.js` header for exact tag).

### Nice to have

- i18n — Arabic toggle in `index.html` only covers hero + nav; rest
  is English-only
- Monitoring (Sentry) + uptime checks
- Lighthouse performance audit
- Real device mobile testing
- Newsletter opt-in / CRM

## Security posture

Already passed in backend:
- trust-proxy hardening + XFF spoofing defeated
- NoSQL operator injection closed (`express-mongo-sanitize`)
- Strict CSP + HSTS + X-Frame-Options via helmet
- `videoUrl` validated against host allowlist
- Email enumeration on `/register` defused
- JWT `alg: none` + garbage tokens rejected
- 96-hex-char `JWT_SECRET`

Frontend:
- All `innerHTML` sinks go through `Sanitize.escape` / `escapeHtml`
- API-provided image URLs go through `Sanitize.url()` scheme allowlist
- Video iframe sandbox documented inline (see `course.html`)
- Auth pages `noindex`, payment pages `noindex`

## Git + deployment

- Local git at `.git/`. No remote yet.
- Suggested: create a private GitHub repo, `git remote add origin ...`,
  `git push -u origin main`, then connect Railway/Render to GitHub
  for auto-deploy.
- Keep the backend repo + frontend repo co-located so a single Node
  service can serve both.

## Files you probably want to read first

1. `PROJECT_STATE.md` — 2026-04-17 backend-focused snapshot
2. `DEPLOY.md` — deployment guide
3. `ENTERPRISE.md` — prod-grade infrastructure (AWS Secrets Manager,
   Vault, Datadog wiring)
4. This file — 2026-04-22 frontend snapshot + handoff

## Who to ping

- Original author: Nader (repo owner)
- This handoff doc was written 2026-04-22 after a design + polish pass.

Good luck. Ship something worth the code.
