// Overwrite each event.json's name with the authoritative federation-page name.
// The first 8 events were pulled before discover.mjs read the federation page,
// so they carry generic names ("ADCC USA — event 26046"). Re-run discover and
// patch every staged event's name (and tenant) to match.
//
//   node ingest/fix_names.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAdcc } from "./discover.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS = join(ROOT, "data/events");

const fed = new Map((await discoverAdcc()).map((e) => [String(e.id), e]));
let patched = 0;
for (const d of readdirSync(EVENTS)) {
  const p = join(EVENTS, d, "event.json");
  if (!existsSync(p)) continue;
  const ev = JSON.parse(readFileSync(p, "utf8"));
  const good = fed.get(String(ev.event_id));
  if (good && good.name && good.name !== ev.name) {
    ev.name = good.name;
    if (good.tenant) ev.tenant = good.tenant;
    writeFileSync(p, JSON.stringify(ev));
    console.log(`  ${ev.event_id}: -> "${good.name}"`);
    patched++;
  }
}
console.log(`patched ${patched} event names. Rebuild: node pipeline/build.mjs`);
