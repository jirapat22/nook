# CLAUDE.md

Guidance for Claude Code working in the Nook repo.

## Hosting (since 22/10/2026): read this first

Production runs on Pat's home **Mac mini** (at Lily's), **not Railway**: Docker Compose in `~/Projects/mac-server`
(repo jirapat22/mac-server, compose service `nook`), public at https://nook.jirapat.dev through a Cloudflare tunnel.

- **Deploy:** push to `master`, then on the Mac run `cd ~/Projects/mac-server && bash scripts/update.sh`
  (or `docker compose up -d --build nook`). **Pushing alone no longer deploys anything.**
- **Settings/secrets:** `~/Projects/mac-server/env/nook.env` (never committed). **Data:** Postgres database `nook` in the shared Postgres 18 container (`docker compose exec postgres psql -U apps -d nook`).
- **Logs:** `docker compose logs -f nook`. Server health: https://status.jirapat.dev
- **Railway** is a stopped cold backup (deployment removed, GitHub auto-deploy disconnected). Railway-specific
  notes elsewhere in this file are history; App Sleeping no longer applies, so the app is always on.
- Full runbook: `~/Projects/mac-server/README.md`.
