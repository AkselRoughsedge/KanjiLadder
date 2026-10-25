# Kanji Ladder — notes for working on this repo

- Plain static app, no bundler: `public/index.html` + `public/app.js` (one IIFE). Vercel serves `public/`; `api/claude.js` is the only server code.
- The app code began as a claude.ai artifact. `app.js` keeps small adapters (`progressDoc`, `storiesAdapter`, `hooksAdapter`, `makeSample`) that mimic the artifact's db/sample APIs on top of Supabase and `/api/claude`; extend those rather than rewriting call sites.
- Progress shape: `state.kanji[k]` and `state.vocab[w]` are `[stage, nextReviewHour]` (hours since epoch). Stages 1–4 Apprentice, 5–6 Guru, 7 Master, 8 Enlightened, 9 Burned.
- Kanji cards quiz the main reading (`data.json` kanji fields `p`, `pt`); other genuine readings get a "try again" nudge, never a fail.
- Saved data from Supabase may be shared/frozen objects: copy before mutating (see `adopt`).
- Security: the publishable Supabase key is public by design; row-level security in `supabase/schema.sql` protects data. Never put secret keys in `public/`.
- Before pushing: `npm run check` (syntax). Bump `VERSION` in `public/sw.js` when installed copies must update right away.
