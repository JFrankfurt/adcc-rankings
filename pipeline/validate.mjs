// Chronological-holdout backtest for the multi-event ratings. Trains the engine
// on the earliest 80% of clean adult matches (across all events, by date/round)
// and predicts the rest. Each holdout match is scored from a fixed,
// outcome-independent viewpoint (player A = lower id) to avoid trivial framing.
// Reports Brier + log-loss vs two baselines and a calibration table.
//
//   node pipeline/validate.mjs
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEvent } from "./lib/normalize.mjs";
import { createEngine, config } from "./lib/glicko.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS = join(ROOT, "data/events");

// gather + chronologically order all clean adult matches (same as build.mjs)
let all = [];
for (const d of readdirSync(EVENTS)) {
  if (!existsSync(join(EVENTS, d, "event.json"))) continue;
  all = all.concat(normalizeEvent(join(EVENTS, d)).matches);
}
all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.round - b.round || a.match_id - b.match_id));
const clean = all.filter((m) => m.is_clean);
const cut = Math.floor(clean.length * 0.8);
const train = clean.slice(0, cut), holdout = clean.slice(cut);

// train
const eng = createEngine();
const exp = new Map(); // experience baseline: prior training-match count
const bump = (id) => exp.set(id, (exp.get(id) || 0) + 1);
for (const m of train) { eng.process(m); bump(m.winner); bump(m.loser); }

const st = (id) => eng.state.get(id);
const scored = [];
for (const m of holdout) {
  const A = String(m.winner) < String(m.loser) ? m.winner : m.loser; // stable pick
  const B = A === m.winner ? m.loser : m.winner;
  const sa = st(A), sb = st(B);
  if (!sa || !sb) continue; // both must be seen in training
  const pA = config.expected(config.toMu(sa.r), config.toMu(sb.r), config.toPhi(sb.rd));
  const ea = exp.get(A) || 0, eb = exp.get(B) || 0;
  const pExpA = ea === eb ? 0.5 : ea > eb ? 0.75 : 0.25;
  scored.push([pA, pExpA, A === m.winner ? 1 : 0]);
}

const ys = scored.map((s) => s[2]);
const brier = (ps) => ps.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / ys.length;
const logloss = (ps) => {
  const e = 1e-15;
  return -ps.reduce((a, p, i) => a + ys[i] * Math.log(Math.min(Math.max(p, e), 1 - e)) +
    (1 - ys[i]) * Math.log(Math.min(Math.max(1 - p, e), 1 - e)), 0) / ys.length;
};
const pm = scored.map((s) => s[0]), pe = scored.map((s) => s[1]), p5 = ys.map(() => 0.5);
const acc = scored.filter((s) => (s[0] >= 0.5) === (s[2] === 1)).length / ys.length;

console.log(`clean adult matches: ${clean.length} | train ${train.length} | holdout ${holdout.length}`);
console.log(`scored (both seen in training): ${ys.length} | base rate A-won ${(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(3)}\n`);
console.log("model                    Brier   LogLoss");
console.log(`Glicko-2                 ${brier(pm).toFixed(3)}   ${logloss(pm).toFixed(3)}`);
console.log(`always-0.5               ${brier(p5).toFixed(3)}   ${logloss(p5).toFixed(3)}`);
console.log(`experience baseline      ${brier(pe).toFixed(3)}   ${logloss(pe).toFixed(3)}`);
console.log(`\nGlicko-2 accuracy: ${(acc * 100).toFixed(1)}% (n=${ys.length})`);

console.log("\ncalibration (predicted P(A wins) -> observed):");
console.log("bin        n   pred   obs");
for (let b = 0; b < 5; b++) {
  const idx = scored.map((s, i) => [s[0], i]).filter(([p]) => Math.min(Math.floor(p * 5), 4) === b);
  if (!idx.length) continue;
  const pred = idx.reduce((a, [p]) => a + p, 0) / idx.length;
  const obs = idx.reduce((a, [, i]) => a + ys[i], 0) / idx.length;
  console.log(`${(b / 5).toFixed(1)}-${((b + 1) / 5).toFixed(1)}  ${String(idx.length).padStart(4)}   ${pred.toFixed(2)}   ${obs.toFixed(2)}`);
}
