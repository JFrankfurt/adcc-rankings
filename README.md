# ADCC Open Rankings

A Next.js single-page app that ranks adult no-gi grapplers by a Glicko-2 rating
computed over ADCC Open tournament results from Smoothcomp, tracked across events
over time. View the top 50, search any athlete by name, and see every match with
result, method, and the ±elo change it produced.

## Layout

```
ingest/          pull raw event data from Smoothcomp (headless browser)
  discover.mjs        list ADCC-tenant events from the public past-events listing
  browser_pull.mjs    pull events via headless Playwright (no cookies)
  backfill_participants.mjs  fetch participant rosters (reg_id -> user_id)
pipeline/        turn raw events into the app's data
  lib/normalize.mjs   parse both bracket renderers, adult filter, identity join
  lib/glicko.mjs      per-match Glicko-2 (records before/after -> ±elo)
  build.mjs           chronological ELO across all events -> web/public/data/data.json
web/             the Next.js app (single page: top 50, search, athlete detail)
data/events/<id>/    staged raw pulls (brackets.json, participants.json, render/, event.json)
```

## Run the app

```bash
cd web
pnpm install
pnpm run data     # rebuild web/public/data/data.json from data/events/*
pnpm run dev      # http://localhost:3000
```

The page loads one static JSON file — no server/database needed. `pnpm run build`
produces a fully static export.

## Ingest events (no cookies, no login)

The match data (`schedule/brackets.json`, `bracket/<id>/getRenderData`) is public
once you're past Cloudflare — and a real browser passes Cloudflare on its own. So
ingest drives a headless Playwright Chromium that lands on the event page, lets
Chromium clear the challenge (~1–2s), then reads the JSON via in-page fetches.
**No session, no cookies, nothing that expires.** (`/api/v1/` is token-gated and
unused; the participants POST is guarded harder by Cloudflare and is optional —
identity is resolved from `getRenderData`'s `profile_link` + name matching.)

One-time setup:
```bash
pnpm install                        # root deps (Playwright)
npx playwright install chromium
```

Pull and build:
```bash
node ingest/discover.mjs 20        # list ADCC-tenant events
node ingest/browser_pull.mjs all   # pull every ADCC event (skips already-pulled)
# or one:  node ingest/browser_pull.mjs <eventId> adcc.smoothcomp.com
node pipeline/build.mjs            # -> web/public/data/data.json
```

`HEADLESS=0` opens a visible browser (useful if a stricter Cloudflare challenge
ever needs a human click). `FORCE=1` re-pulls events already on disk.

## Running it live + keeping data fresh

The app is **pure static** — `pnpm run build` emits `web/out/` (HTML + JS + one
`data/data.json`), no server, nothing to "revalidate". Host `web/out/` anywhere:
drag to Netlify, `vercel deploy web/out`, GitHub Pages, or `npx serve web/out`.

Data freshness is a separate job because ingest drives a real headless Chromium
to pass Cloudflare (no cookies, no clicks). One command does the whole cycle:

```bash
./refresh.sh          # pull all ADCC events -> rebuild data.json -> export web/out/
```

### Live site

Deployed at **https://jfrankfurt.github.io/adcc-rankings/** (GitHub Pages).
Every push to `main` that touches `web/**` triggers `.github/workflows/deploy.yml`,
which builds the static site (with `BASE_PATH=/adcc-rankings`) and publishes it.
CI never scrapes — it deploys the committed `web/public/data/data.json`. The Mac
refresh regenerates that file and pushes it, which redeploys the site.

Note: the workflow installs with **pnpm via corepack**, not npm — the current
Ubuntu runner image crashes npm ("Exit handler never called") on install.

### Scheduled (macOS launchd)

A weekly job (Mondays 11:00) runs `refresh.sh` automatically:

```bash
# already installed at ~/Library/LaunchAgents/com.jfrankfurt.adcc-rankings.plist
launchctl list | grep adcc-rankings      # confirm it's loaded
launchctl start com.jfrankfurt.adcc-rankings   # run now, on demand
tail -f refresh.log                      # watch a run
launchctl unload ~/Library/LaunchAgents/com.jfrankfurt.adcc-rankings.plist  # disable
```

It refreshes when the Mac is on (catches up at next wake if asleep). To publish
after a refresh, point your host at `web/out/` — or add a `git commit && push`
(or `netlify deploy`) line to the end of `refresh.sh` if your host auto-deploys
from a repo/folder.

## Model

Per-match Glicko-2 (start 1500, RD 350, τ 0.5), one no-gi pool, processed in true
chronological order across events. Age is a hard boundary — **adult divisions
only** (youth/masters never face adults, so cross-age ratings aren't comparable).
Absolute/open-weight adult matches count; exhibition and DQ/walkover matches are
excluded from rating. An athlete needs ≥5 clean matches and low uncertainty
(RD ≤ 200) to be ranked; everyone else stays searchable as *provisional*.

Seeded with 8 ADCC Open events (USA, Canada, Mexico, Brazil, South America, US
Open Austin) — 2,551 rated adult matches, 1,561 athletes, 284 ranked. Ratings
carry across events by date, so an athlete's number reflects their whole ADCC
history, not a single tournament.
