// Per-match Glicko-2. Each match is treated as a one-game rating period for
// both athletes, using the opponent's pre-match rating/RD. This yields a clean
// per-match rating delta (what the UI shows) while keeping Glicko-2's RD +
// volatility handling of provisional athletes and time-decay between events.
const SCALE = 173.7178;
const R0 = 1500, RD0 = 350, SIGMA0 = 0.06, TAU = 0.5;
const RD_MAX = 350;
const PERIOD_DAYS = 30; // one Glicko-2 rating period ~ one month for decay

const toMu = (r) => (r - R0) / SCALE;
const toPhi = (rd) => rd / SCALE;
const fromMu = (mu) => mu * SCALE + R0;
const fromPhi = (phi) => phi * SCALE;
const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

function newVolatility(phi, sigma, v, delta) {
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * TAU) < 0) k++; B = a - k * TAU; }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA /= 2; }
    B = C; fB = fC;
  }
  return Math.exp(A / 2);
}

// Update one player (mu,phi,sigma) against one opponent, outcome s in {1,0}.
function updateOne(mu, phi, sigma, muJ, phiJ, s) {
  const gj = g(phiJ);
  const ej = E(mu, muJ, phiJ);
  const v = 1 / (gj * gj * ej * (1 - ej));
  const delta = v * gj * (s - ej);
  const sigmaP = newVolatility(phi, sigma, v, delta);
  const phiStar = Math.sqrt(phi * phi + sigmaP * sigmaP);
  const phiP = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muP = mu + phiP * phiP * gj * (s - ej);
  return { mu: muP, phi: phiP, sigma: sigmaP };
}

export function createEngine() {
  const state = new Map(); // id -> {r, rd, sigma, last, played, wins, losses}
  const get = (id) => {
    if (!state.has(id)) state.set(id, { r: R0, rd: RD0, sigma: SIGMA0, last: null, played: 0, wins: 0, losses: 0 });
    return state.get(id);
  };
  // inflate RD for time elapsed since the athlete's last rated match
  const decay = (st, date) => {
    if (st.last) {
      const days = Math.max(0, (new Date(date) - new Date(st.last)) / 86400000);
      const t = days / PERIOD_DAYS;
      const phi = Math.min(Math.sqrt(toPhi(st.rd) ** 2 + st.sigma * st.sigma * t), toPhi(RD_MAX));
      st.rd = fromPhi(phi);
    }
  };

  // Process one match; returns per-athlete before/after for the log.
  function process(m) {
    const w = get(m.winner), l = get(m.loser);
    decay(w, m.date); decay(l, m.date);
    const before = { winner: w.r, loser: l.r, winnerRd: w.rd, loserRd: l.rd };
    // both updated from each other's PRE-match values
    const wu = updateOne(toMu(w.r), toPhi(w.rd), w.sigma, toMu(l.r), toPhi(l.rd), 1);
    const lu = updateOne(toMu(l.r), toPhi(l.rd), l.sigma, toMu(w.r), toPhi(w.rd), 0);
    w.r = fromMu(wu.mu); w.rd = fromPhi(wu.phi); w.sigma = wu.sigma;
    l.r = fromMu(lu.mu); l.rd = fromPhi(lu.phi); l.sigma = lu.sigma;
    w.last = l.last = m.date;
    w.played++; l.played++; w.wins++; l.losses++;
    return {
      winner: { before: before.winner, after: w.r, rd: w.rd },
      loser: { before: before.loser, after: l.r, rd: l.rd },
    };
  }
  return { state, get, process };
}

export const config = { R0, RD0, SIGMA0, TAU, PERIOD_DAYS, expected: E, toMu, toPhi };
