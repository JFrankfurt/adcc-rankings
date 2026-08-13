// Backfill the participants roster (reg_id -> user_id) for already-pulled
// events. No clicks: a headless browser clears Cloudflare with a GET on the
// brackets page, then fires the participants POST directly (which returns 200
// once CF is cleared — the participants *page* 403s, but the POST does not).
// Match data is already on disk. Existing participants.json files are skipped.
//
//   node ingest/backfill_participants.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = join(ROOT, ".auth/sc-profile");
const EVENTS = join(ROOT, "data/events");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dirs = readdirSync(EVENTS).filter((d) => existsSync(join(EVENTS, d, "event.json")));
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: process.env.HEADLESS !== "0", viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

for (const d of dirs) {
  const out = join(EVENTS, d, "participants.json");
  if (existsSync(out)) { console.log(`event ${d}: participants.json exists — skip`); continue; }
  const ev = JSON.parse(readFileSync(join(EVENTS, d, "event.json"), "utf8"));
  const base = `https://${ev.tenant || "adcc.smoothcomp.com"}/en/event/${d}`;

  // 1. clear Cloudflare via a GET on the brackets page
  await page.goto(`${base}/schedule/brackets`, { waitUntil: "domcontentloaded" }).catch(() => {});
  let cleared = false;
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const s = await page.evaluate(async (u) => {
      try { return (await fetch(u, { credentials: "include" })).status; } catch { return 0; }
    }, `${base}/schedule/brackets.json`);
    if (s === 200) { cleared = true; break; }
  }
  if (!cleared) { console.warn(`event ${d}: Cloudflare did not clear — skipped`); continue; }

  // 2. fire the participants POST directly (200 once CF is cleared)
  const res = await page.evaluate(async (b) => {
    const x = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || "");
    const r = await fetch(`${b}/participants`, {
      method: "POST", credentials: "include",
      headers: { accept: "application/json, text/plain, */*", "x-xsrf-token": x },
    });
    return { status: r.status, body: r.status === 200 ? await r.text() : "" };
  }, base);
  if (res.status === 200) {
    const data = JSON.parse(res.body);
    mkdirSync(join(EVENTS, d), { recursive: true });
    writeFileSync(out, JSON.stringify(data));
    console.log(`event ${d}: saved ${(data.participants || []).length} participants`);
  } else {
    console.warn(`event ${d}: participants POST -> ${res.status} — skipped`);
  }
}
await ctx.close();
console.log("done. Rebuild:  node pipeline/build.mjs");
