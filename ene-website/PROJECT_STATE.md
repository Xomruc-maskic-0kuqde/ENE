# ENE Project State — Snapshot 2026-04-17

This file captures where the project stands so a future session (or another dev) can pick up cleanly.

## How to run locally

Two services are needed. Keep each in its own terminal tab.

```bash
# Tab 1 — backend (Express on port 5000, nodemon auto-restart)
cd ../ene-backend
npm run dev

# Tab 2 — frontend static server (port 5500)
cd ene-website
python3 -m http.server 5500
```

**Open the site at `http://localhost:5500/index.html`** — not `file://...`.
CORS rejects `file://` origin (which arrives as `null`), so opening HTML files directly will show "We can't reach the service right now".

## What's working end-to-end

### Auth
- `POST /api/auth/register`, `/api/auth/login` — rate-limited per peer IP (XFF spoofing closed)
- Password policy: 8–72 chars (bcrypt boundary enforced)
- JWT stored in `localStorage` (flagged for future migration to HttpOnly cookie)
- Test account: `smoke17698@test.com / smokepass` — promoted to admin

### Learner flow
- Register → login → dashboard → browse catalog → enroll → watch lessons → mark complete/uncomplete
- Progress recomputes automatically via `services/lessonService.recalcProgress()`
- Lesson content is **gated** — non-enrolled users see metadata only, `locked: true` in the API response

### Admin flow
- Admin-only mutations on `/api/courses`, `/api/lessons/...`, `/api/mentors`, `/api/testimonials`, `/api/stats`
- `GET /api/admin/users`, `/api/admin/enrollments`, `/api/admin/stats`

### Landing page (`index.html`)
- Hero → trust bar → about → **Inside ENE** (scroll-tilt cinematic card) → programs → why ENE → **Mentors marquee** → **Pricing** → final CTA (with sparkles) → testimonials → footer
- Chatbot FAB bottom-left with scripted quick replies
- Floats live data from `/api/stats`, `/api/mentors`, `/api/testimonials`, `/api/courses` — falls back silently to static HTML if any request fails

## Key file map

```
ene-backend/
├── server.js              # helmet, CORS, rate limit, mongo-sanitize, query-parser 'simple'
├── lib/
│   ├── ApiError.js        # status-code-aware error class
│   └── asyncHandler.js    # removes try/catch boilerplate
├── services/
│   └── lessonService.js   # enrollment checks, recalcProgress, CRUD
├── models/
│   ├── User.js  Course.js  Lesson.js  Enrollment.js
│   └── SiteStats.js  Mentor.js  Testimonial.js   # new
├── controllers/   # all now asyncHandler-wrapped, ApiError-throwing
├── routes/        # statsRoutes, mentorRoutes, testimonialRoutes added
└── scripts/
    ├── seedCourses.js  seedLessons.js  promoteAdmin.js
    └── seedStats.js  seedMentors.js  seedTestimonials.js

ene-website/
├── index.html       # landing — heavy, fully backend-wired
├── dashboard.html   # logged-in dashboard
├── course.html      # single-lesson learning page
├── login.html  register.html
├── assets/
│   ├── auth.js  logo.png
```

## Security posture (passed)

- ✅ `trust proxy: false` + `ipKeyGenerator(req.socket.remoteAddress)` → XFF spoofing defeated
- ✅ `query parser: simple` + `express-mongo-sanitize` → NoSQL operator injection closed
- ✅ `videoUrl` validated server-side against allowlist of hosts + http(s) scheme
- ✅ helmet with strict CSP + HSTS + X-Frame-Options + Referrer-Policy
- ✅ Lesson content gated by enrollment
- ✅ Email enumeration on /register defused
- ✅ JWT `alg: none` + garbage tokens rejected
- ✅ JWT_SECRET rotated to 96-hex-char random string

### Still to address
- ❗ **Atlas DB user password** is still `NADER` — rotate in the MongoDB Atlas console and update `MONGO_URI` in `.env`. Can't fix from code.
- JWT in `localStorage` → HttpOnly cookie migration (bigger refactor; shorten `JWT_EXPIRES_IN` to `1h` as stopgap if you deploy)
- Admin action audit log (write every course/lesson/mentor/testimonial mutation to a log collection)

## Environment

### `.env` (in ene-backend/)
```
MONGO_URI=mongodb+srv://ene:<PASSWORD>@cluster0.qvttmlc.mongodb.net/ene
JWT_SECRET=<96 hex chars, rotated 2026-04-17>
JWT_EXPIRES_IN=7d
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:5500,http://127.0.0.1:5500
```

### Dependencies installed
- Production: `express`, `cors`, `helmet`, `express-rate-limit@8`, `express-validator`, `express-mongo-sanitize`, `bcryptjs`, `jsonwebtoken`, `mongoose`, `dotenv`
- Dev: `nodemon`
- Frontend CDN: `@tsparticles/slim@3` (sparkles effect on landing page CTA)

## Open work for next session (ranked)

1. **Rotate Atlas password** (human-only action in Atlas console)
2. Extract `enrollmentService` + `courseService` following the `lessonService` pattern — 15 min each
3. Add admin audit log model + middleware that records every admin mutation
4. Consolidate shared frontend utilities (`apiRequest`, `escapeHtml`) from 5 HTML files into `assets/api.js` + `assets/dom.js`
5. Extract the drifting `:root` CSS variables into `assets/brand.css` — stops the `--text-muted 0.45 vs 0.52` drift
6. Build an admin UI (new `admin.html`) to edit stats / mentors / testimonials via the existing PUT/POST endpoints
7. Migrate JWT storage: HttpOnly cookie + CSRF token + refresh endpoint

## Seeded data

- 6 courses with Unsplash images (`scripts/seedCourses.js`)
- 36 lessons — 6 per course (`scripts/seedLessons.js`)
- 6 mentors with Unsplash portraits (`scripts/seedMentors.js`)
- 3 testimonials (`scripts/seedTestimonials.js`)
- SiteStats singleton: `{ graduates: 500, placementRate: 94, seniorMentors: 40, techTracks: 12, avgPromotion: '6 mo' }`

Re-run any seed anytime — all are idempotent. Seeds wipe + reinsert (except stats, which upserts).
