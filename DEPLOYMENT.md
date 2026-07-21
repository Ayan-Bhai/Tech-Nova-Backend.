# TechNova — Separated Frontend + Backend Deployment Guide

Your project is now split into two independent deliverables:

```
webapp/
├── backend/     → Node.js (Hono) API server  → deploy to RAILWAY
└── frontend/    → Pure static HTML/JS/CSS    → deploy to ANY static host
```

Database: **Supabase Postgres** (replaces Cloudflare D1).

Deploy in this order: **1) Supabase → 2) Railway → 3) Static host**.

---

## Step 1 — Supabase (Database)

1. Go to https://supabase.com → create a new project (pick a strong DB password, save it).
2. In your project, open **SQL Editor** → **New query**.
3. Copy the ENTIRE contents of `backend/schema.sql` and paste it → click **Run**.
   - This creates all tables AND seeds: admin account, 5 categories, 15 products.
4. Get your connection string: **Project Settings → Database → Connection string → URI**.
   - Use the **"Transaction pooler"** URI (port `6543`) — it looks like:
     ```
     postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
     ```
   - Replace `[YOUR-PASSWORD]` with your database password.

Default admin login (change the password after first login):
- Email: `admin@technova.pk`
- Password: `TN-ADMIN-2949`
- Role: `owner`

---

## Step 2 — Railway (Backend API)

1. Push the `backend/` folder to a GitHub repo (or use Railway CLI).
   - If your repo contains the whole `webapp/`, set Railway's **Root Directory** to `backend`.
2. On https://railway.app → **New Project → Deploy from GitHub repo**.
3. In the service → **Variables**, add:

   | Variable | Value | Required |
   |---|---|---|
   | `DATABASE_URL` | your Supabase pooler URI from Step 1 | ✅ Yes |
   | `FRONTEND_URL` | your frontend site URL, e.g. `https://technova.netlify.app` (no trailing slash; comma-separate multiple) | ✅ Yes (for CORS + Stripe redirects) |
   | `GMAIL_USER` | your Gmail address (for verification emails) | Optional* |
   | `GMAIL_APP_PASSWORD` | 16-char Gmail App Password | Optional* |
   | `STRIPE_SECRET_KEY` | `sk_live_...` or `sk_test_...` | Optional* |
   | `PORT` | Railway sets this automatically — do not set | — |

   \* Gmail and Stripe can also be configured later from the Admin Panel → Settings (values stored in DB override env vars).

4. Railway auto-detects Node and runs `npm start` (also declared in `railway.json`).
5. After deploy, Railway gives you a URL like `https://technova-backend.up.railway.app`.
6. Verify: open `https://YOUR-RAILWAY-URL/health` → should return `{"ok":true,"db":"up"}`.

---

## Step 3 — Static Host (Frontend)

Deploy the `frontend/` folder to Netlify / Vercel / GitHub Pages / Cloudflare Pages / any static host.

**The ONLY file you must edit:** `frontend/static/api-config.js`

```js
// Change this to your Railway backend URL (no trailing slash):
window.API_BASE = 'https://technova-backend.up.railway.app';
```

Then upload/deploy the whole `frontend/` folder as-is.

- **Netlify**: drag-drop the `frontend` folder on app.netlify.com/drop, or connect repo with publish dir = `frontend`.
- **Vercel**: import repo, framework = "Other", output dir = `frontend`.
- **GitHub Pages**: push `frontend/` contents to a `gh-pages` branch.

Finally, go back to Railway and make sure `FRONTEND_URL` matches your final frontend URL
(this controls CORS and where Stripe redirects after payment).

---

## Pages

| File | Purpose |
|---|---|
| `index.html` | Home |
| `shop.html` | Shop / catalog |
| `about.html`, `contact.html` | Info pages |
| `login.html`, `signup.html`, `account.html` | Auth + customer account |
| `cart.html`, `pay-success.html` | Cart / checkout / Stripe return |
| `admin.html` | Admin panel (owner/admin roles) |

## Local Development

```bash
# Backend (needs a local Postgres or your Supabase URL in backend/.env)
cd backend
cp .env.example .env      # fill in DATABASE_URL
npm install
npm run db:init           # applies schema.sql (safe to re-run)
npm run dev               # starts on http://localhost:8080

# Frontend — just serve the folder statically:
cd frontend
python3 -m http.server 3210
# open http://localhost:3210  (api-config.js already points at localhost:8080)
```

## How It Works

- Frontend calls the backend cross-origin using `window.API_BASE` (set in `api-config.js`).
- CORS on the backend allows origins listed in `FRONTEND_URL` (+ localhost always, for dev).
- Product images and logo are served by the backend (`/img/:id`, `/logo`) — frontend builds absolute URLs automatically.
- Site branding/SEO (name, logo, colors set in admin) is fetched from `/api/site` and cached in localStorage so pages don't flash defaults.
- Stripe success/cancel redirects go to `FRONTEND_URL + /pay-success.html` / `/cart.html`.
