// Discover ALL ADCC events from the authoritative federation past-events page
// (federation 176 = ADCC). That page is on the CF-gated adcc tenant and renders
// event links into the DOM, so we read them with a headless browser — the same
// mechanism used for pulling. This replaces the old approach of scanning the
// generic global past-events listing, which buried ADCC events across hundreds
// of pages and only surfaced a handful.
//
//   node ingest/discover.mjs        # print the ADCC event table
import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = join(ROOT, ".auth/sc-profile");
const FEDERATION = "https://adcc.smoothcomp.com/en/federation/176/events/past";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function discoverAdcc() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: process.env.HEADLESS !== "0", viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const byId = new Map(); // dedupe by id, keep the longest (most descriptive) name
  try {
    // The federation past-events listing is paginated (?page=N). Walk pages
    // until one yields no events. Guard with a hard page cap.
    for (let p = 1; p <= 30; p++) {
      await page.goto(`${FEDERATION}?page=${p}`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      let links = [];
      for (let i = 0; i < 14; i++) { // wait for CF clear + event links to render
        await sleep(1500);
        links = await page.evaluate(() =>
          [...document.querySelectorAll('a[href*="/event/"]')].map((a) => {
            const m = a.href.match(/\/\/([a-z0-9-]+\.)?smoothcomp\.com\/en\/event\/(\d+)/);
            return m ? { id: m[2], name: (a.textContent || "").trim().replace(/\s+/g, " "),
              tenant: (m[1] ? m[1].replace(/\.$/, "") + ".smoothcomp.com" : "smoothcomp.com") } : null;
          }).filter(Boolean));
        if (links.length) break;
      }
      if (!links.length) break; // no events on this page -> past the last page
      const before = byId.size;
      for (const e of links) {
        const prev = byId.get(e.id);
        if (!prev || e.name.length > prev.name.length) byId.set(e.id, e);
      }
      if (byId.size === before) break; // page added nothing new -> stop (no infinite loop)
    }
    return [...byId.values()];
  } finally {
    await ctx.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const adcc = await discoverAdcc();
  console.log(`ADCC federation past events: ${adcc.length}\n`);
  for (const e of adcc) console.log(`  ${e.id}\t${e.tenant}\t${e.name}`);
  console.log(`\nPull all:  node ingest/browser_pull.mjs all`);
}
