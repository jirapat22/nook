# 🌿 Nook

> Your personal, AI-powered journal. Warm, cosy, and just for you.

## Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js + Express |
| Database | PostgreSQL (Railway managed) |
| Frontend | Vanilla JS (ES modules) + Chart.js |
| AI | Groq API — Llama 3.3 70B + Whisper |
| Hosting | Railway |
| PWA | Service worker + offline sync queue |

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in env vars
cp .env.example .env

# 3. Init the database (requires psql + DATABASE_URL set)
npm run db:init

# 4. Start dev server
npm run dev
```

Open http://localhost:3000

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | Your Groq API key (from console.groq.com — free tier) |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Server port (default: 3000) |

> **Note:** You can also set the Groq API key in the app's Settings view — it will be stored in the database.

---

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project → deploy from GitHub
3. Add a PostgreSQL service to the project
4. Set environment variables in Railway dashboard:
   - `GROQ_API_KEY`
   - `DATABASE_URL` (auto-set by Railway PostgreSQL)
5. After first deploy, run the DB init:
   ```
   railway run npm run db:init
   ```

---

## Project Structure

```
nook/
├── server.js              # Express server + API routes
├── db/
│   ├── schema.sql         # PostgreSQL schema
│   └── db.js              # pg pool
├── routes/
│   ├── entries.js         # Journal CRUD + calendar
│   ├── ai.js              # Groq transcription + analysis
│   ├── insights.js        # Analytics queries + weekly summary
│   └── people.js          # People tracker
└── public/
    ├── index.html         # App shell
    ├── manifest.json      # PWA manifest
    ├── sw.js              # Service worker (cache + offline queue)
    └── app/
        ├── app.js         # Router + global state
        ├── style.css      # Full design system (3 themes)
        ├── views/         # Page views
        └── components/    # Reusable UI components
```

---

## PWA / iPhone Install

1. Open the app in Safari on iPhone
2. Tap the Share button → "Add to Home Screen"
3. Nook will install as a standalone app

> **Icons:** The manifest references `icon-192.png` and `icon-512.png` in `/public/icons/`. 
> Convert `icon.svg` to PNG at those sizes for full PWA install support.
> Quick command: `npx sharp-cli resize 192 --input public/icons/icon.svg --output public/icons/icon-192.png`

---

## Features

- **Voice journaling** — tap mic, ramble, Nook cleans it up
- **Drive mode** — fully voice-operated with "done" keyword stop
- **AI analysis** — themes, mood scores, action items, people detection
- **Follow-up questions** — up to 3 rounds of conversational clarification
- **Love life section** — private, non-judgmental with reflection prompts
- **People tracker** — auto-extracts facts from entries, tracks sentiment
- **Calendar view** — colour-coded mood dots per day
- **Insights** — mood trends, life area correlations, heatmap, weekly summaries
- **3 themes** — Warm Earthy · Dark Intimate · Clean Minimal
- **Offline support** — service worker queues entries when disconnected
- **PWA** — installable on iPhone as a standalone app
