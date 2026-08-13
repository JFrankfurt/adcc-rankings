// Pull events that sit behind Cloudflare's HARD interactive challenge (some
// ADCC Trials), which headless Chromium cannot auto-solve. Opens a VISIBLE
// browser: you clear the "verify you are human" checkbox ONCE, then the script
// detects clearance and pulls everything automatically (brackets, participants,
// per-bracket match trees) — same output as browser_pull.mjs.
//
//   node ingest/pull_interactive.mjs <eventId> [eventId2 ...]
//
// The window stays on each event until Cloudflare clears (up to 5 min), so take
// your time clicking. Runs headed regardless of HEADLESS.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAdcc } from "./discover.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = join(ROOT, ".auth/sc-profile");
const EVENTS = join(ROOT, "data/events");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ids = process.argv.slice(2);
if (!ids.length) { console.error("usage: node ingest/pull_interactive.mjs <eventId> [more ids]"); process.exit(1); }

// federation name lookup (best-effort; falls back to a generic name)
let fed = new Map();
try { fed = new Map((await discoverAdcc()).map((e) => [String(e.id), e])); } catch {}

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

async function jget(url, method = "GET") {
  const r = await page.evaluate(async ([u, m]) => {
    const x = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || "");
    const res = await fetch(u, { method: m, credentials: "include",
      headers: { accept: "application/json, text/plain, */*", ...(m === "POST" ? { "x-xsrf-token": x } : {}) } });
    return { status: res.status, body: res.status === 200 ? await res.text() : "" };
  }, [url, method]);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} on ${url}`);
  return JSON.parse(r.body);
}

for (const id of ids) {
  const meta = fed.get(String(id)) || {};
  const tenant = meta.tenant || "adcc.smoothcomp.com";
  const base = `https://${tenant}/en/event/${id}`;
  console.log(`\n=== event ${id} (${meta.name || "?"}) ===`);
  console.log("  opening browser — CLICK the Cloudflare 'verify you are human' box if shown…");
  await page.goto(`${base}/schedule/brackets`, { waitUntil: "domcontentloaded" }).catch(() => {});

  // wait up to 5 min for a human to clear CF (brackets.json returns 200).
  // Clicking the challenge navigates the page, which destroys the JS context
  // mid-poll — so tolerate evaluate() throwing and just retry next tick.
  let cleared = false;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    let s = 0;
    try {
      s = await page.evaluate(async (u) => {
        try { return (await fetch(u, { credentials: "include" })).status; } catch { return 0; }
      }, `${base}/schedule/brackets.json`);
    } catch { s = 0; } // context destroyed by the CF navigation — retry
    if (s === 200) { cleared = true; console.log(`  cleared after ~${(i + 1) * 2}s — pulling…`); break; }
  }
  if (!cleared) { console.warn(`  event ${id}: not cleared in 5 min — skipped`); continue; }

  const dir = join(EVENTS, String(id));
  mkdirSync(join(dir, "render"), { recursive: true });
  const brackets = await jget(`${base}/schedule/brackets.json`);
  writeFileSync(join(dir, "brackets.json"), JSON.stringify(brackets));
  const list = brackets.brackets || [];

  try {
    const cap = page.waitForResponse((r) => r.url().includes(`/event/${id}/participants`) && r.request().method() === "POST" && r.ok(), { timeout: 25000 });
    await page.goto(`${base}/participants`, { waitUntil: "domcontentloaded" }).catch(() => {});
    writeFileSync(join(dir, "participants.json"), JSON.stringify(await (await cap).json()));
    await page.goto(`${base}/schedule/brackets`, { waitUntil: "domcontentloaded" }).catch(() => {});
  } catch { console.warn("  participants skipped (identity via profile_link + name)"); }

  const est = list.map((b) => b.estimated_start).filter(Boolean).sort();
  const date = est.length ? String(est[0]).slice(0, 10) : new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, "event.json"), JSON.stringify({ event_id: Number(id), name: meta.name || `event ${id}`, date, ruleset: "nogi", tenant }));

  let ok = 0, bad = 0;
  for (const b of list) {
    try { writeFileSync(join(dir, "render", `${b.bracket_id}.json`), JSON.stringify(await jget(`${base}/bracket/${b.bracket_id}/getRenderData`))); ok++; }
    catch { bad++; }
    await sleep(500);
  }
  console.log(`  event ${id}: ${list.length} brackets, render ${ok} ok / ${bad} fail`);
}
await ctx.close();
console.log("\ndone. Rebuild: node pipeline/build.mjs");
