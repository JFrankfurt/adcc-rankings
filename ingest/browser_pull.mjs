// Unattended Smoothcomp ingest via Playwright — no login, no cookies, no expiry.
// The event data endpoints are public once past Cloudflare; a real Chromium
// solves the Cloudflare challenge automatically in a couple of seconds, after
// which in-page fetches (exactly what the site's own JS does) return 200. That
// sidesteps the cookie-expiry problem entirely: nothing to refresh.
//
//   node ingest/browser_pull.mjs <eventId> [tenant] # pull one event
//   node ingest/browser_pull.mjs all [pages]         # discover ADCC events + pull all
//   node ingest/browser_pull.mjs login               # optional: only if an endpoint
//                                                     # ever needs a signed-in session
//
// A persistent profile is kept so Cloudflare clearance is reused across runs.
// Env: HEADLESS=0 to watch the browser (default headless — it clears CF fine).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAdcc } from "./discover.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = join(ROOT, ".auth/sc-profile");   // gitignored: holds the session
const HEADLESS = process.env.HEADLESS !== "0"; // headless by default; it clears CF
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Events behind a hard Cloudflare block the automated browser cannot clear.
// Skipped in `all` runs so they do not cost a 5-min timeout each.
let SKIP = {};
try { SKIP = JSON.parse(readFileSync(join(ROOT, "ingest/skip-events.json"), "utf8")); } catch {}

// Poll an event's public JSON until Cloudflare has cleared (status 200).
async function waitForClearance(page, base, tries = 20) {
  for (let i = 0; i < tries; i++) {
    await sleep(1500);
    const s = await page.evaluate(async (u) => {
      try { return (await fetch(u, { credentials: "include" })).status; } catch { return 0; }
    }, `${base}/schedule/brackets.json`);
    if (s === 200) return true;
  }
  throw new Error("Cloudflare did not clear (try HEADLESS=0 to solve interactively)");
}

async function open() {
  mkdirSync(PROFILE, { recursive: true });
  return chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
  });
}

// One in-page fetch (real browser origin -> CF clearance + cookies attach).
async function fetchInPage(page, url, method) {
  return page.evaluate(async ([u, m]) => {
    const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || "");
    const res = await fetch(u, {
      method: m, credentials: "include",
      headers: { accept: "application/json, text/plain, */*", ...(m === "POST" ? { "x-xsrf-token": xsrf } : {}) },
    });
    return { status: res.status, body: await res.text() };
  }, [url, method]);
}

// Fetch with resilience to Cloudflare's intermittent re-challenge (403): retry,
// and if it persists, reload the page so Chromium re-solves the challenge.
async function pageJSON(page, url, method = "GET", tenantBase = null) {
  let last = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetchInPage(page, url, method);
    if (r.status === 200) return JSON.parse(r.body);
    last = r.status;
    if (r.status === 403 || r.status === 429 || r.status === 0) {
      if (attempt === 2 && tenantBase) { // re-solve CF, then keep trying
        await page.goto(`${tenantBase}/schedule/brackets`, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      await sleep(2000 + attempt * 1000);
      continue;
    }
    break; // a non-CF error (e.g. 401/404) won't fix itself
  }
  throw new Error(`HTTP ${last} on ${url}`);
}

async function ensureLoggedIn(page) {
  await page.goto("https://smoothcomp.com/en/user", { waitUntil: "domcontentloaded" });
  await sleep(1500);
  const loggedIn = await page.evaluate(() => /log ?out|my account/i.test(document.body.innerText));
  return loggedIn;
}

async function login() {
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://smoothcomp.com/en/login", { waitUntil: "domcontentloaded" });
  console.log("\nA browser window opened. Log in to Smoothcomp there.");
  console.log("When you see your account is logged in, press ENTER here to save the session…");
  await new Promise((res) => process.stdin.once("data", res));
  const ok = await ensureLoggedIn(page);
  await ctx.close();
  console.log(ok ? "session saved -> you can now run: node ingest/browser_pull.mjs all"
                 : "could not confirm login; re-run `login` and finish signing in before pressing ENTER");
}

async function pullEvent(ctx, id, tenant = "adcc.smoothcomp.com", knownName = "") {
  const dirPre = join(ROOT, "data/events", String(id));
  if (process.env.FORCE !== "1" && existsSync(join(dirPre, "brackets.json")) &&
      existsSync(join(dirPre, "render")) && readdirSync(join(dirPre, "render")).length > 0) {
    console.log(`event ${id}: already pulled — skipping (FORCE=1 to re-pull)`);
    return { skipped: true };
  }
  const page = ctx.pages()[0] || (await ctx.newPage());
  const base = `https://${tenant}/en/event/${id}`;
  // land on the event so we're same-origin on the tenant, then wait for CF
  await page.goto(`${base}/schedule/brackets`, { waitUntil: "domcontentloaded" });
  await waitForClearance(page, base);

  const dir = join(ROOT, "data/events", String(id));
  mkdirSync(join(dir, "render"), { recursive: true });

  const brackets = await pageJSON(page, `${base}/schedule/brackets.json`, "GET", base);
  writeFileSync(join(dir, "brackets.json"), JSON.stringify(brackets));
  const list = brackets.brackets || [];

  // participants is a POST that Cloudflare guards much harder than GETs and
  // often won't clear headless. It's OPTIONAL — normalize resolves identity
  // from getRenderData's profile_link + name matching without it. Best-effort:
  // intercept the app's own POST if it comes through; otherwise skip.
  let pCount = 0;
  try {
    const cap = page.waitForResponse(
      (r) => r.url().includes(`/event/${id}/participants`) && r.request().method() === "POST" && r.ok(),
      { timeout: 20000 });
    await page.goto(`${base}/participants`, { waitUntil: "domcontentloaded" }).catch(() => {});
    const participants = await (await cap).json();
    pCount = (participants.participants || []).length;
    writeFileSync(join(dir, "participants.json"), JSON.stringify(participants));
  } catch {
    console.warn(`  participants POST blocked (CF) — proceeding without it (identity via profile_link + name match)`);
  }
  // return to the bracket origin for the getRenderData GETs
  await page.goto(`${base}/schedule/brackets`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitForClearance(page, base).catch(() => {});

  // prefer the federation-page name (accurate, e.g. "ADCC US Open - Atlanta");
  // fall back to the info panel's organizer name only if none was passed.
  let name = knownName;
  if (!name) {
    try { const info = await pageJSON(page, `${base}/getInfoPanelsData`, "GET", base); name = info?.organizer?.name ? `${info.organizer.name} — event ${id}` : `event ${id}`; } catch { name = `event ${id}`; }
  }
  const est = list.map((b) => b.estimated_start).filter(Boolean).sort();
  const date = est.length ? String(est[0]).slice(0, 10) : new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, "event.json"), JSON.stringify({ event_id: Number(id), name, date, ruleset: "nogi", tenant }));

  let ok = 0, bad = 0;
  for (const b of list) {
    try { writeFileSync(join(dir, "render", `${b.bracket_id}.json`), JSON.stringify(await pageJSON(page, `${base}/bracket/${b.bracket_id}/getRenderData`, "GET", base))); ok++; }
    catch (e) { bad++; if (bad <= 3) console.error(`  ${b.bracket_id}: ${e.message}`); }
    await sleep(600);
  }
  console.log(`event ${id}: ${list.length} brackets, ${pCount} participants, render ${ok} ok / ${bad} fail`);
  return { ok, bad, brackets: list.length };
}

const [cmd, arg2] = process.argv.slice(2);
if (cmd === "login") {
  await login();
} else {
  const ctx = await open();
  if (cmd === "all") {
    const adcc = (await discoverAdcc()).filter((e) => {
      if (SKIP[e.id]) { console.log(`event ${e.id}: skip-listed (${SKIP[e.id]})`); return false; }
      return true;
    });
    console.log(`pulling ${adcc.length} ADCC events…`);
    for (const e of adcc) { try { await pullEvent(ctx, e.id, e.tenant, e.name); } catch (err) { console.error(`event ${e.id} FAILED: ${err.message}`); } }
  } else if (cmd) {
    await pullEvent(ctx, cmd, arg2 || "adcc.smoothcomp.com");
  } else {
    console.error("usage: browser_pull.mjs login | <eventId> [tenant] | all");
  }
  await ctx.close();
  console.log("done. Now run: node pipeline/build.mjs");
}
