# Smoothcomp data-source spec — recon for event 30665 (ADCC US Open Austin)

Recon performed live against `adcc.smoothcomp.com` / `smoothcomp.com` on
2026-08-11 (UTC timestamps in samples). Method: `curl` (headers/status/body
inspection) plus one headless-Chrome DOM dump attempt. No bulk pulls — every
claim below traces to one of the sampled requests in `data/recon/`.

## 1. Access surface map (what actually happened, not assumptions)

| Path family | Example | Result | Evidence |
|---|---|---|---|
| Event detail page (SSR HTML) | `GET https://adcc.smoothcomp.com/en/event/30665` | **403**, Cloudflare **managed challenge** (`cf-mitigated: challenge`, "Just a moment..." interstitial) | headers captured 2026-08-11T20:39:22Z |
| Same page, headless Chrome (`--headless=new --dump-dom`) | same URL | Never resolves past the challenge in a 60s budget (Turnstile requires real browser signals we didn't spoof) | `/tmp/chrome_dump.html` still shows the challenge shell |
| Event sub-paths | `/en/event/30665/schedule`, `/en/event/30665/results` | Same 403 challenge | confirms the WAF rule is bound to the `/en/event/*` prefix specifically, not the whole site |
| Guessed non-`/en/event/*` paths | `/scoreboard/30665`, `/live/30665`, `/embed/30665`, `/en/event/30665/scoreboard` | **404** (app's generic catch-all, see `sample-spa-404-catchall.json`) — reachable, just wrong route name, no challenge | confirms challenge is scoped to `/en/event/*`, not a general bot-wall |
| REST API namespace | `GET https://adcc.smoothcomp.com/api/v1/event/30665` | **401** `{"error":"Unauthenticated."}` — real, registered route, but requires a logged-in user session. Guest cookies (`sc_session`/`XSRF-TOKEN` from an unauthenticated page load) + decoded `X-XSRF-TOKEN` header + `Referer` did **not** unlock it. | `data/recon/sample-api-v1-event-401.json` |
| API sub-resources probed | `/api/v1/event/30665/brackets` → 401 (real, auth-gated); `/api/v1/event/30665/entries` → 401 (real, auth-gated); `/api/v1/event/30665/{divisions,categories,classes,participants,athletes,competitors,matches,schedule,results}` → 404 (not real routes under this event, or named differently) | Confirms `brackets` and `entries` exist as first-class sub-resources in the `/api/v1/event/{id}/` namespace; division/match naming is unconfirmed | manual curl probes, 2026-08-11T20:4x |
| Marketing / account pages | `https://smoothcomp.com/en`, `/en/agreements`, `/en/privacypolicy`, `/en/support`, `/en/user` | **200**, no challenge | `/tmp/home.html`, `/tmp/agreements.html` |
| Event **listing** pages | `https://smoothcomp.com/en/events/past?page=N` | **200**, no challenge, contains a `schema.org` `ItemList` JSON-LD block with event URLs (id + tenant subdomain) | `data/recon/sample-events-past-jsonld.json` |
| robots.txt | `https://adcc.smoothcomp.com/robots.txt` (identical on apex domain) | 200, plain text | `data/recon/sample-robots.txt` |

**Bottom line:** there is no reachable public JSON endpoint for event 30665's
divisions/brackets/matches/profiles in this headless session. The one
API namespace that clearly maps to the data we need (`/api/v1/event/{id}`,
`/api/v1/event/{id}/brackets`, `/api/v1/event/{id}/entries`) requires an
authenticated Smoothcomp user account — a guest/anonymous session is not
enough. The public HTML event page that a logged-out spectator sees is
itself blocked to non-browser clients by a Cloudflare managed challenge
scoped to the `/en/event/*` path prefix.

## 2. Auth requirement

- **Event/bracket/match data: requires a logged-in Smoothcomp account.**
  `/api/v1/event/{id}` and its sub-resources return `401 Unauthenticated`
  for guest sessions. This is a genuine login wall, not a bot check — the
  request reached the app (401, JSON body, no Cloudflare challenge headers)
  and was rejected by application auth middleware, not the CDN.
- **The public event page itself is additionally CDN-gated** (Cloudflare
  managed challenge, JS-execution required) independent of the above —
  even a real logged-in browser session would need to pass this once per
  session/cookie lifetime; a plain HTTP client cannot.
- Session mechanics observed: Laravel-style stack — `sc_session` (httponly)
  + `XSRF-TOKEN` cookies set on any page load (`domain=.smoothcomp.com`,
  ~10–120 min TTL observed), consistent with Sanctum SPA cookie auth. This
  means: once a human logs in via a real browser and the ingest step reuses
  that browser's session cookie + matching `X-XSRF-TOKEN` header, `/api/v1/`
  calls should authenticate the same way the site's own front-end does.
  **Not verified live** — no credentials were available/used in this recon
  pass (see Blocked section).
- The event-listing pages (`/en/events/past`, presumably `/en/events/upcoming`
  and `/en/events/my`) and marketing/legal pages are public, unauthenticated,
  and **not** challenge-gated.

## 3. Pagination scheme

- Event listings (`/en/events/past?page=N`): classic Laravel/Blade pagination,
  `?page=` query param, 1-indexed. Observed 46 `ListItem`s on page 1 and a
  pager exposing links up to `?page=509` for the "past" feed alone — so this
  is a large, deep-paginated resource (~509 × 46 ≈ 23,000+ past events),
  confirmed structurally, not fully walked (recon does not bulk-pull).
- No pagination scheme observed for `/api/v1/event/{id}/brackets` or
  `/entries` — blocked by auth before a response body with a shape could be
  inspected. **Unconfirmed**, flagged below.

## 4. Rate limits / throttling

- No explicit `Retry-After` or `X-RateLimit-*` headers observed on any
  response in this session (all requests were low-volume, well under any
  plausible threshold).
- `robots.txt` sets `Crawl-delay: 10` for `User-agent: *` — treat this as the
  **polite floor**: ≥10s between requests to any path for automated clients,
  even though it's advisory (robots.txt is not enforced server-side).
- `robots.txt` fully disallows `SemrushBot` (`Disallow: /`) — a signal
  Smoothcomp actively curates/blocks specific known crawlers.
- The Cloudflare managed challenge on `/en/event/*` is itself a strong
  rate/bot-control signal independent of robots.txt — it fires on the very
  first unauthenticated, non-browser request observed (no threshold to
  cross), so "rate limiting" here is really "zero automated requests
  allowed" for that path family.

## 5. robots.txt (full, both `adcc.smoothcomp.com` and `smoothcomp.com`)

```
User-agent: *
Disallow: /order/
Disallow: /checkout
Disallow: /scoreboard
Crawl-delay: 10

User-agent: SemrushBot
Disallow: /
```

`/en/event/*` (the page we actually need) is **not** listed in
`Disallow`, but is nonetheless hard-blocked at the CDN layer for
non-browser clients (see §1). `/scoreboard` is `Disallow`'d for crawlers
but returns 404 for the exact paths guessed here — it may exist under a
different URL shape (e.g. tenant-specific), not confirmed.

## 6. Terms of Service / legal constraints

- ToS is served at `https://smoothcomp.com/en/agreements` (per-locale
  variants exist, e.g. `/es/agreements`, `/fr/agreements`). **Full text
  was not obtained** — the page is a client-rendered SPA shell; a plain
  HTTP fetch returns only "You need to enable JavaScript in order to use
  Smoothcomp", and a first headless-Chrome DOM-dump attempt (8s virtual
  time budget) also did not render body content in time. See Blocked
  section for the exact next step.
- In the absence of confirmed ToS text, treat the **technical signals as
  the binding constraint**: an active Cloudflare managed challenge scoped
  specifically to the event/bracket/match page family, plus an
  authentication wall on the matching API namespace, are a clear
  operator signal that automated access to tournament results is not
  intended to be open. Any ingest implementation should be built to run
  **through a real, authenticated user session** (i.e., a human logs in
  via a real browser once; the ingest step reuses that session's cookies)
  rather than attempting to defeat the challenge headlessly, and should
  get an explicit human go/no-go against the actual ToS text before doing
  even single-event ingest at automated scale.

## 7. Recommended fetch strategy for ingest (single event 30665, per goal.md Scope)

Given the confirmed constraints, there is exactly one viable path, and it
is **not fully automatable from a clean headless environment**:

1. **Pre-req (manual, one-time, human-in-the-loop):** log into
   `smoothcomp.com` in a real browser with a Smoothcomp account. Capture
   the resulting `sc_session` cookie and the matching (decoded) `XSRF-TOKEN`
   value from that authenticated session.
2. **Ingest replays that session** against the confirmed real routes:
   - `GET https://adcc.smoothcomp.com/api/v1/event/30665`
     Headers: `Accept: application/json`, `Cookie: sc_session=<captured>; XSRF-TOKEN=<captured>`, `X-XSRF-TOKEN: <decoded XSRF-TOKEN>`, a normal browser `User-Agent`, `Referer: https://adcc.smoothcomp.com/en/event/30665`.
     Expected: event metadata (name, dates, org) + likely links/ids to
     divisions and brackets — **schema unconfirmed**, first real
     authenticated call must be treated as exploratory, not assumed.
   - `GET https://adcc.smoothcomp.com/api/v1/event/30665/brackets`
     Same headers. Confirmed to be a real route (401 without auth); response
     shape unconfirmed.
   - `GET https://adcc.smoothcomp.com/api/v1/event/30665/entries`
     Same headers. Confirmed real route; likely maps to competitor/profile
     registrations for the event; response shape unconfirmed.
   - Division and match-level endpoints were **not** located under guessed
     names (`divisions`, `categories`, `classes`, `matches`, `schedule`,
     `results` all 404'd). They are most likely nested inside the
     `brackets` response (e.g. bracket → matches inline) rather than being
     separate top-level routes — **verify on first authenticated call**.
3. **Throttling:** minimum 10s between requests (robots.txt Crawl-delay),
   sequential (not parallel) requests, since this is a single-event pilot
   the total call volume is tiny (event + brackets + entries + however
   many bracket-detail calls divisions require — likely single digits to
   low tens of calls).
4. **If the authenticated `/api/v1/` path is blocked by ToS** (pending
   human review, §6): fall back to authorized manual export — Smoothcomp
   organizer/spectator UIs typically offer CSV/PDF bracket exports from
   the logged-in event page; that would need to be pulled by a human and
   handed to ingest as a static file. Not verified live in this recon
   (no account credentials available).

## 8. Enumerating the target event set (goal.md Scope)

Current `goal.md` Scope is a **single-event pilot**: event id `30665` is
already given explicitly — no search/enumeration needed for this run.

For future multi-event scope expansion, the enumeration mechanism is
confirmed and public:

- `https://smoothcomp.com/en/events/past?page=N` (and presumably
  `/en/events/upcoming`, same pattern, not yet checked) returns
  unauthenticated, non-challenged HTML containing a `schema.org` `ItemList`
  JSON-LD block: each entry gives the event's canonical URL, which encodes
  both the numeric event id and the tenant subdomain (e.g.
  `https://adcc.smoothcomp.com/en/event/30665`). Federation-specific
  tenants (`adcc.`, `usjf.`, `pbjjf.`, `nanka.`, etc.) all resolve through
  the same `/en/event/{id}` and `/api/v1/event/{id}` shape.
- Pagination goes at least to `page=509` on the past-events feed alone
  (46 items/page observed) — walking this fully for a broad ranking run
  would be its own throttled, resumable ingest job, not a recon-time
  bulk pull.
- No dedicated `/search` or `/api/v1/events` endpoint was found to exist
  (guessed variants all 404'd) — enumeration for now means paging through
  `/en/events/past` and `/en/events/upcoming` HTML and extracting the
  JSON-LD block, filtered by whatever criteria (sport, federation, date
  range) goal.md's Scope specifies when it's expanded.

## Blocked — manual follow-up

1. **Division/bracket/match JSON schema (the core deliverable).** Every
   route that would return this is either CDN-challenge-gated
   (`/en/event/30665*` HTML) or auth-gated (`/api/v1/event/30665*` JSON).
   Next probe: obtain one real Smoothcomp login (human creates/uses an
   account), capture the browser's `sc_session` + `XSRF-TOKEN` via
   DevTools → Application → Cookies after logging in, then repeat the
   exact `curl` recipes in §7 with those headers against
   `GET /api/v1/event/30665`, `GET /api/v1/event/30665/brackets`, and
   `GET /api/v1/event/30665/entries`, and paste the first real response
   bodies into `data/recon/` for schema confirmation before ingest builds
   parsers against assumed field names.
2. **Full ToS text.** `https://smoothcomp.com/en/agreements` is a
   client-rendered SPA; a plain fetch and one short headless-Chrome
   DOM-dump attempt (8s budget) both returned only the "enable
   JavaScript" placeholder. Next probe: re-run the headless-Chrome dump
   with a longer `--virtual-time-budget` (e.g. 20–30s) and
   `--dump-dom` after `--run-all-compositor-stages-before-draw`, or
   simply open the URL in a real browser and copy the rendered text —
   then re-check for scraping/automated-access/API-use clauses before
   any authenticated ingest run.
3. **`/scoreboard` public route.** `robots.txt` disallows it for crawlers
   (implying it's a real, human-facing page, likely a live/venue display),
   but every guessed path shape (`/scoreboard/30665`,
   `/en/event/30665/scoreboard`, `/en/scoreboard/30665`) 404'd. If a
   scoreboard/live-display route exists and is unauthenticated +
   non-challenged for a specific event, it could be a much cheaper path to
   match-level results than the authenticated API. Next probe: open a
   live/current Smoothcomp event's scoreboard link from the actual site
   nav in a real browser and read the resulting URL pattern.
4. **`/api/v1/event/{id}` response shape once authenticated** — includes
   whether division/ruleset/belt/weight metadata lives on the event
   payload directly, inside `brackets`, or behind a further id (e.g.
   `division_id`) requiring one more authenticated call per division.
   Unknown until item 1 above is done.

## Confidence notes

**Verified directly (this session, live requests, evidence in
`data/recon/`):**
- `/en/event/*` is Cloudflare-managed-challenge-gated (403, `cf-mitigated:
  challenge` header) for non-browser clients, and headless Chrome without
  challenge-solving also fails to get past it in a reasonable time budget.
- `/api/v1/event/{id}`, `/api/v1/event/{id}/brackets`, and
  `/api/v1/event/{id}/entries` are real, registered API routes that require
  authenticated-user auth (401 `Unauthenticated`, not a CDN block) — guest
  session cookies are insufficient.
- `robots.txt` content, `Crawl-delay: 10`, and the specific
  `Disallow` list.
- `/en/events/past?page=N` is a public, unauthenticated, non-challenged
  HTML page containing a JSON-LD `ItemList` of event URLs (id + tenant
  subdomain), with pagination to at least page 509.
- The generic Smoothcomp SPA 404 shape (`App\Federation\MenuItem` catch-all
  error), used here to distinguish "route doesn't exist" (404) from "route
  exists, auth required" (401) across ~25 guessed paths.

**Inferred, not directly confirmed:**
- That a real authenticated browser session's cookies, replayed via
  `curl`/ingest with the matching `X-XSRF-TOKEN` header, will actually
  satisfy `/api/v1/` auth — this is the standard Sanctum SPA pattern
  matching the cookies observed, but it was never tested against a real
  logged-in session (no credentials available in this recon pass).
- The exact JSON field names for division ruleset/belt/weight/age,
  bracket structure, match competitors/winner/method/time, and
  competitor profile id — none of this was observed in a real response
  body; §7's endpoint list is a route map, not a schema, until Blocked
  item 1 is resolved.
- Whether `/scoreboard` or another unauthenticated route could avoid the
  login requirement entirely (Blocked item 3).

**Biggest risk to this node's output:** the ingest step cannot proceed
data-complete without a real authenticated Smoothcomp session — this
recon could not obtain or simulate one. If no such account/credential is
made available to ingest, the entire event-30665 pilot is blocked at the
data-access layer, not just delayed, until either (a) credentials are
provided and ToS-reviewed, or (b) an unauthenticated fallback (scoreboard
route, manual CSV export) is found and confirmed to carry the same
fields (competitor ids, winner, method) the rating model requires.
