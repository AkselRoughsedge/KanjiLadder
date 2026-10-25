# Kanji Ladder

A personal WaniKani-style app for learning Japanese: 2,136 jōyō kanji and about 7,000 words across 60 levels, spaced-repetition reviews with typed answers, recorded audio, a daily graded short story written by Claude, and an "Ask Claude" chat on every answer.

It's an installable web app (PWA): open it in Safari on iPhone → Share → **Add to Home Screen**. It then opens full screen, works offline for lessons and reviews, and syncs when back online.

## How it's put together

| Part | Where | What it does |
|---|---|---|
| App | `public/` | Static files served by Vercel: `index.html`, `app.js`, `data.json` (levels, kanji, words), `audio/` (pronunciation clips), `sw.js` (offline cache) |
| Claude | `api/claude.js` | Vercel function. Checks the Supabase sign-in and `ALLOWED_EMAILS`, then calls the Anthropic API with the server-side key |
| Database + sign-in | Supabase | Tables `progress`, `stories`, `hooks`, each protected by row-level security (`supabase/schema.sql`) |
| Data tools | `tools/` | Python scripts that built `data.json` and the audio (see below) |

No build step: Vercel serves `public/` as is.

## Setup

### 1. Supabase (database and sign-in)
1. Open the project → **SQL Editor** → paste all of `supabase/schema.sql` → **Run**.
2. **Authentication → Sign In / Providers → Email**: turn **Confirm email** off (so creating your account signs you straight in).
3. After you've created your account in the app, turn **Allow new users to sign up** off (Authentication → Sign In / Providers), so nobody else can register.
4. To bring over progress from the old artifact: **SQL Editor** → paste `supabase/import_from_artifact.sql` → **Run**, then reload the app.

### 2. Vercel (hosting)
1. vercel.com/new → import this repo. No framework, no build command (it's read from `vercel.json`).
2. **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
| `ALLOWED_EMAILS` | The email you sign in with (comma-separate several). Only these accounts can use Claude features |
| `CLAUDE_MODEL` | Optional. Defaults to `claude-sonnet-5-5` |

3. Redeploy after adding variables. Every push to `main` deploys automatically.

## Updating the content
- `tools/build_levels.py` builds `data.json` from KANJIDIC2-derived kanji data and JMdict common words (`jmdict-simplified`). Level order: mostly usage frequency, then stroke count and school grade.
- `tools/main_readings.py` picks each kanji's main reading from how common words read it, and drops word cards that would repeat it.
- `tools/gen_audio.py` generates the clips with VOICEVOX (voice: No.7, Announce). Credit "VOICEVOX:No.7" must stay visible in the app.

After changing `public/app.js` or `data.json` in a way installed copies must pick up immediately, bump `VERSION` in `public/sw.js`.

## Data sources and credits
- Kanji data: KANJIDIC2 (EDRDG, CC BY-SA 4.0) via kanji-data; vocabulary: JMdict (EDRDG, CC BY-SA 4.0) via jmdict-simplified.
- Audio: VOICEVOX:No.7.
- Kana input: WanaKana (MIT). Database client: supabase-js (MIT).
