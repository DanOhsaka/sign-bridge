# Deploying SignBridge

The site is hosted on Vercel as a static site plus three Serverless Functions.

- Static site: served from the repo root (there is no build step).
- API: `api/**` — Vercel turns each file there into an endpoint whose URL is its path.
- Production URL: https://signbridge-lilac-zeta.vercel.app
- Pushing to `main` deploys automatically.

## Layout

```
api/
  health.js          → GET  /api/health
  auth/register.js   → POST /api/auth/register
  auth/login.js      → POST /api/auth/login
  _lib/              → shared code, NOT endpoints
    app.js           the Express app those three files export
    db.js            Mongo connection
    User.js          User model
    authRoutes.js    register + login handlers
```

Files and folders in `api/` whose names begin with `_` are **not** turned into
endpoints — that is why `api/_lib/` is safe to keep helpers in.

## The two copies of the backend

`server/` and `api/_lib/` contain the same auth logic. This is deliberate, not an
oversight:

- `server/` is the local development server (`node server/index.js`, port 3000).
  It also serves the static files, which Vercel does for you.
- `api/_lib/` is what actually runs in production.
- `.vercelignore` excludes `server/`, so the deployed functions **cannot** import
  from it. The exclusion is load-bearing: without it, `server/` would be uploaded
  as public static files, and `server/.env` — where your `MONGODB_URI` and
  `JWT_SECRET` belong for local dev — would be downloadable by anyone.

**This means any change to auth logic or the `User` schema must be made in both
places.** Each file in `api/_lib/` carries a `MIRROR of server/...` header saying
so. If you change one and not the other, production and localhost will quietly
disagree, and localhost will keep passing while production fails.

## Two things that must never be created

1. A root-level `index.js`, `app.js` or `server.js`. Vercel's zero-config
   detection treats those as a whole-project server entrypoint, which collapses
   the site into a single function and drops static serving.
2. A `public/` directory. Vercel would start serving from it instead of the repo
   root, and every page would 404.

`vercel.json` pins `"framework": null` as insurance against the first one.

## Environment variables

Set in Vercel → project `signbridge` → Settings → Environment Variables:

| Name | Notes |
|---|---|
| `MONGODB_URI` | Atlas connection string |
| `JWT_SECRET` | Long random string. Changing it logs everyone out. |
| `JWT_EXPIRES_IN` | Optional, defaults to `7d` |

For local development, put the same values in `server/.env` (gitignored).

**MongoDB Atlas must allow connections from `0.0.0.0/0`.** Vercel functions call
out from rotating IP addresses, so an IP allowlist without that entry will refuse
every connection. This is the most common cause of a deployed-but-failing API.

## Dependencies

Run `npm install` **in the repo root**. Node resolves `express` and friends by
walking up from `api/_lib/`, which never passes through `server/node_modules`.
The same root install also covers `server/`, which resolves upward to it.

## Verifying a deploy

```
curl https://signbridge-lilac-zeta.vercel.app/api/health
```

- `{"ok":true,"db":"connected"}` — API up, database reachable.
- `{"ok":true,"db":"down"}` — the function is running but cannot reach Atlas.
  Check `MONGODB_URI` and the Atlas network allowlist above.
- `503 {"message":"Database unavailable."}` — the connection threw outright.
- `FUNCTION_INVOCATION_FAILED` — a module failed to load. Check the build log for
  which files Vercel bundled, and that nothing imports from `server/`.
