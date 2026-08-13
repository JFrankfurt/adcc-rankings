#!/usr/bin/env python3
"""Chronological-holdout backtest + calibration for the adult no-gi ratings.

Trains the Glicko-2 engine on the earliest 80% of clean adult matches (by
date, bracket round, match_id) and predicts the remaining 20%. To avoid the
degenerate "predict the winner wins" framing, each holdout match is scored from
the viewpoint of a fixed, outcome-independent player A = the lower profile_id;
the label is 1 iff A actually won. Metrics are reported against two baselines:
always-0.5, and an experience baseline (more prior training matches wins).

Run: python3 engine/backtest.py
"""
import csv, math, subprocess, sys, collections
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rate import R0, SCALE, expected_score  # reuse the real engine's win-prob

ROOT = Path(__file__).resolve().parent.parent
CLEAN = [r for r in csv.DictReader(open(ROOT / "data/matches_adult.csv"))
         if r["is_clean"] == "true"]
CLEAN.sort(key=lambda r: (r["date"], int(r["round"] or 0), int(r["match_id"])))
cut = int(len(CLEAN) * 0.8)
train, holdout = CLEAN[:cut], CLEAN[cut:]

# Write the training subset and rate it with the untouched engine.
tp = ROOT / "data/matches_adult_train.csv"
with open(tp, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=CLEAN[0].keys()); w.writeheader(); w.writerows(train)
subprocess.run([sys.executable, str(ROOT / "engine/rate.py"), "--input", str(tp),
                "--current-out", str(ROOT / "out/ratings_adult_train.csv"),
                "--history-out", str(ROOT / "out/ratings_adult_train_history.csv")],
               check=True, capture_output=True)

rt = {r["profile_id"]: r for r in csv.DictReader(open(ROOT / "out/ratings_adult_train.csv"))}
exp = collections.Counter()          # experience = # training matches
for r in train:
    exp[r["winner_id"]] += 1; exp[r["loser_id"]] += 1

def mu(r): return (float(r["rating"]) - R0) / SCALE
def phi(r): return float(r["RD"]) / SCALE

scored = []   # (p_model_A_wins, p_exp_A_wins, label_A_won)
for m in holdout:
    w, l = m["winner_id"], m["loser_id"]
    if w not in rt or l not in rt:   # need both seen in training
        continue
    a, b = sorted([w, l], key=int)    # A = lower profile_id, outcome-independent
    pA = expected_score(mu(rt[a]), mu(rt[b]), phi(rt[b]))
    # experience baseline: more prior matches -> favored (0.5 on tie)
    ea, eb = exp[a], exp[b]
    pexpA = 0.5 if ea == eb else (0.75 if ea > eb else 0.25)
    scored.append((pA, pexpA, 1 if a == w else 0))

def brier(ps, ys): return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ys)
def logloss(ps, ys):
    e = 1e-15
    return -sum(y * math.log(min(max(p, e), 1 - e)) + (1 - y) * math.log(min(max(1 - p, e), 1 - e))
                for p, y in zip(ps, ys)) / len(ys)

ys = [s[2] for s in scored]
pm = [s[0] for s in scored]
pe = [s[1] for s in scored]
p5 = [0.5] * len(ys)
acc = sum(1 for p, y in zip(pm, ys) if (p >= .5) == (y == 1)) / len(ys)

print(f"holdout matches scored (both athletes seen in training): {len(ys)} of {len(holdout)}")
print(f"base rate A-won: {sum(ys)/len(ys):.3f}\n")
print(f"{'model':<22}{'Brier':>8}{'LogLoss':>9}")
print(f"{'Glicko-2':<22}{brier(pm,ys):>8.3f}{logloss(pm,ys):>9.3f}")
print(f"{'always-0.5':<22}{brier(p5,ys):>8.3f}{logloss(p5,ys):>9.3f}")
print(f"{'experience (more matches)':<22}{brier(pe,ys):>8.3f}{logloss(pe,ys):>9.3f}")
print(f"\nGlicko-2 accuracy: {acc:.1%}  (n={len(ys)})")

# Calibration table (5 buckets on predicted P(A wins))
print("\ncalibration (predicted P(A wins) -> observed):")
buckets = collections.defaultdict(list)
for p, y in zip(pm, ys):
    buckets[min(int(p * 5), 4)].append(y)
print(f"{'bin':<12}{'n':>4}{'pred':>7}{'obs':>7}")
for b in range(5):
    ys_b = buckets.get(b, [])
    if not ys_b: continue
    lo, hi = b / 5, (b + 1) / 5
    ps_b = [p for p, y in zip(pm, ys) if min(int(p * 5), 4) == b]
    print(f"{lo:.1f}-{hi:.1f}      {len(ys_b):>4}{sum(ps_b)/len(ps_b):>7.2f}{sum(ys_b)/len(ys_b):>7.2f}")
