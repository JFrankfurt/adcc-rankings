// Build the web app's data: read every staged event under data/events/,
// normalize to adult no-gi matches, run per-match Glicko-2 in true
// chronological order across all events, and emit web/public/data/data.json:
//   { meta, athletes:[ranked...], matches:{ [id]: [match log with +/- elo] } }
//
// Run: node pipeline/build.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEvent } from "./lib/normalize.mjs";
import { createEngine } from "./lib/glicko.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS_DIR = join(ROOT, "data/events");
const OUT = join(ROOT, "web/public/data/data.json");

const MIN_MATCHES = 5;   // leaderboard eligibility (matches earlier pilot)
const MAX_RD = 200;

// 1. Normalize every event, merge the athlete name book.
const eventDirs = existsSync(EVENTS_DIR)
  ? readdirSync(EVENTS_DIR).filter((d) => existsSync(join(EVENTS_DIR, d, "event.json")))
  : [];
if (!eventDirs.length) { console.error("no events under data/events/"); process.exit(1); }

const book = new Map();
let allMatches = [];
const events = [];
for (const d of eventDirs) {
  const { event, matches, book: b } = normalizeEvent(join(EVENTS_DIR, d));
  for (const [id, info] of b) if (!book.has(id)) book.set(id, info);
  allMatches = allMatches.concat(matches);
  events.push({ id: event.event_id, name: event.name, date: event.date, matches: matches.length });
  console.log(`event ${event.event_id} (${event.name}): ${matches.length} adult matches`);
}

// 1b. Resolve name+country fallback keys ("n:name|cc") to a real numeric
// user_id when that same person appears with a profile_link/participants entry
// anywhere. This recovers cross-event identity without the participants POST.
const nameKey = (name, country) =>
  `n:${String(name || "").trim().toLowerCase().replace(/\s+/g, " ")}|${(country || "").toLowerCase()}`;
const nameToNum = new Map();
for (const [id, info] of book) {
  if (typeof id !== "number") continue;
  const k = nameKey(info.name, info.country);
  nameToNum.set(k, nameToNum.has(k) ? "AMB" : id); // AMB = ambiguous, don't merge
}
let merged = 0;
const resolve = (id) => {
  if (typeof id !== "string") return id;
  const hit = nameToNum.get(id);
  if (hit && hit !== "AMB") { merged++; return hit; }
  return id;
};
for (const m of allMatches) { m.winner = resolve(m.winner); m.loser = resolve(m.loser); }
console.log(`identity: ${nameToNum.size} name keys, merged ${merged} name-fallback slots to numeric ids`);

// 2. Chronological order across all events; dirty matches excluded from rating.
allMatches.sort((a, b) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 :
  a.round - b.round || a.match_id - b.match_id);
const rated = allMatches.filter((m) => m.is_clean);

// 3. Run the engine; record a per-match log per athlete with +/- elo.
const engine = createEngine();
const log = new Map(); // id -> [entries]
const push = (id, e) => { if (!log.has(id)) log.set(id, []); log.get(id).push(e); };
for (const m of rated) {
  const r = engine.process(m);
  const oppName = (id) => (book.get(id)?.name) || `#${id}`;
  push(m.winner, {
    match_id: m.match_id, date: m.date, event: m.event_name, division: m.division,
    result: "win", method: m.method, score: m.score,
    opponent_id: m.loser, opponent: oppName(m.loser),
    elo_before: Math.round(r.winner.before), elo_after: Math.round(r.winner.after),
    delta: Math.round(r.winner.after - r.winner.before),
  });
  push(m.loser, {
    match_id: m.match_id, date: m.date, event: m.event_name, division: m.division,
    result: "loss", method: m.method, score: m.score,
    opponent_id: m.winner, opponent: oppName(m.winner),
    elo_before: Math.round(r.loser.before), elo_after: Math.round(r.loser.after),
    delta: Math.round(r.loser.after - r.loser.before),
  });
}

// events competed per athlete — cross-event athletes are the ones the backtest
// validates (single-event ratings are descriptive, not predictive).
const eventsOf = new Map();
for (const m of rated) {
  for (const id of [m.winner, m.loser]) {
    if (!eventsOf.has(id)) eventsOf.set(id, new Set());
    eventsOf.get(id).add(m.event_id);
  }
}

// 4. Build the athlete table; rank the eligible, keep the rest searchable.
const athletes = [];
for (const [id, st] of engine.state) {
  const info = book.get(id) || {};
  const nEvents = eventsOf.get(id)?.size || 0;
  athletes.push({
    id, name: info.name || `#${id}`, club: info.club || "", country: info.country || "",
    rating: Math.round(st.r), rd: Math.round(st.rd), sigma: Number(st.sigma.toFixed(4)),
    matches: st.played, wins: st.wins, losses: st.losses,
    events: nEvents, cross_event: nEvents >= 2,
    eligible: st.played >= MIN_MATCHES && st.rd <= MAX_RD,
    last_event: (log.get(id)?.at(-1)?.event) || "",
  });
}
// eligible first (by rating), then everyone else (by rating) so search still finds them
athletes.sort((a, b) =>
  (b.eligible - a.eligible) || (b.rating - a.rating));
let rank = 0;
for (const a of athletes) a.rank = a.eligible ? ++rank : null;

// 5. Emit. matches log newest-first for the athlete view.
const matchesById = {};
for (const [id, entries] of log) matchesById[id] = entries.slice().reverse();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  meta: {
    generated: new Date().toISOString().slice(0, 10),
    events, total_matches: allMatches.length, rated_matches: rated.length,
    athletes: athletes.length, eligible: rank,
    cross_event: athletes.filter((a) => a.cross_event).length,
    model: "Glicko-2 per match", min_matches: MIN_MATCHES, max_rd: MAX_RD,
    scope: "Adult no-gi divisions across ADCC Open events",
  },
  athletes, matches: matchesById,
}));
console.log(`\nwrote ${OUT}`);
console.log(`athletes: ${athletes.length} | eligible (ranked): ${rank} | rated matches: ${rated.length}`);
console.log("top 5:", athletes.slice(0, 5).map((a) => `${a.name} ${a.rating}`).join(" · "));
