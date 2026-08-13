// Discover ADCC Open event ids from Smoothcomp's PUBLIC past-events listing
// (no auth needed — only per-event bracket data is gated). Prints a table of
// candidate events to then pull with ingest/pull.mjs.
//
//   node ingest/discover.mjs [maxPages=6]
const UA = process.env.SC_UA || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

function walk(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) walk(x, out); return; }
  const url = node.url || node["@id"];
  // ld+json ItemList entries carry the event URL (id + tenant subdomain) but no
  // name; the tenant subdomain identifies the organizer (ADCC -> adcc.*).
  const m = typeof url === "string" && url.match(/\/\/([a-z0-9-]+\.)?smoothcomp\.com\/en\/event\/(\d+)/);
  if (m) {
    const tenant = ((m[1] || "").replace(/\.$/, "")) ? m[1].replace(/\.$/, "") + ".smoothcomp.com" : "smoothcomp.com";
    if (!out.has(m[2])) out.set(m[2], { id: m[2], name: node.name ? String(node.name).trim() : "", tenant });
  }
  for (const v of Object.values(node)) walk(v, out);
}

export function extractEvents(html) {
  const found = new Map();
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try { walk(JSON.parse(m[1]), found); } catch { /* skip malformed block */ }
  }
  return [...found.values()];
}

// Scan the public past-events listing and return events on an ADCC tenant.
export async function discoverAdcc(maxPages = 20) {
  const all = new Map();
  for (let p = 1; p <= maxPages; p++) {
    const res = await fetch(`https://smoothcomp.com/en/events/past?page=${p}`, { headers: { "user-agent": UA } });
    if (!res.ok) break;
    for (const e of extractEvents(await res.text())) all.set(e.id, e);
  }
  return {
    total: all.size,
    adcc: [...all.values()].filter((e) => /adcc/i.test(e.tenant) || /adcc/i.test(e.name)),
  };
}

// CLI: `node ingest/discover.mjs [maxPages]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const maxPages = Number(process.argv[2] || 20);
  const { total, adcc } = await discoverAdcc(maxPages);
  console.log(`scanned ${maxPages} pages · ${total} past events · ${adcc.length} on an ADCC tenant:\n`);
  for (const e of adcc) console.log(`  ${e.id}\t${e.tenant}\t${e.name || "(name at pull time)"}`);
  console.log(`\nPull all with a logged-in browser:  node ingest/browser_pull.mjs all`);
  if (!adcc.length) console.log(`(no ADCC-tenant events found; try more pages: node ingest/discover.mjs 40)`);
}
