#!/usr/bin/env python3
"""
Glicko-2 rating engine for the BJJ ranking pipeline.

Implements design/model-spec.md verbatim (Glicko-2, per-(profile_id, ruleset)
pools, mandatory binary win/loss baseline, opt-in method-weighting ablation,
opt-in dirty-match inclusion). See KNOWN DEVIATIONS below for the places
this implementation diverges from the spec's assumed input contract, forced
by the actual schema of data/matches.csv.

KNOWN DEVIATIONS from design/model-spec.md (logged per spec line 3):

1. Spec S3 expects normalize to supply `division_id`, per-competitor
   `belt_a`/`belt_b`/`weight_class_a`/`weight_class_b`. The actual
   data/matches.csv header (written by engine/normalize.py from real
   Smoothcomp data, see data/normalize-exclusions-30665.txt for excluded
   rows) is: `match_id,date,event_id,bracket_id,round,ruleset,belt,
   weight_class,age_group,gender,division_type,division_id,winner_id,
   loser_id,winner_registration_id,loser_registration_id,method,is_clean`
   -- `bracket_id` and `round` ARE now present (resolves this file's prior
   deviations #2/#3); one belt/weight_class per match (not per side, both
   competitors in a bracket division share the same weight class/skill
   level by construction); `is_clean` instead of `dirty_flag`.
2. Chronological ordering is (date, round, match_id) -- date is the primary
   key (real per-match `estimated_starttime` timestamps from Smoothcomp),
   round is the model-spec.md #1 tie-break, match_id is the final
   deterministic tie-break.
3. `bracket_id` is populated from real data (the Smoothcomp render
   bracket id) for every row -- full event/bracket/match provenance now
   available in ratings_history.csv per model-spec.md S9 / rubric bar 1.
4. `dirty_flag` is derived as `not is_clean` (from the `is_clean` column),
   OR `method` falling in the closed dirty-method set, whichever fires.

Section 5's optional "project current RD to wall-clock now" reporting decay
uses the diffusion constant `c` (model-spec.md S5), which is independent of
the mandatory per-match S4 pre-match decay step (which uses each athlete's
own volatility `sigma_prev`, not `c`). Both are implemented; `c`-based decay
only fires when --as-of is passed.
"""
import argparse
import csv
import math
import sys
from datetime import datetime, timezone

SCALE = 173.7178
R0 = 1500.0
RD0 = 350.0
SIGMA0 = 0.06
TAU = 0.5
PHI_MAX = RD0 / SCALE
RD_MIN = 30.0
DIFFUSION_C = 45.0            # model-spec.md S5, RD-scaled units
DIFFUSION_C_PHI = DIFFUSION_C / SCALE
PERIOD_DAYS = 30.0
DECAY_PERIODS_5Y = 60.0

DIRTY_METHODS = {"dq", "forfeit", "noshow", "walkover"}
METHOD_WEIGHTS = {
    "submission": 1.20,
    "points": 1.05,
    "advantage": 0.95,
    "decision": 0.85,
}
PROVISIONAL_MIN_MATCHES = 5
PROVISIONAL_MAX_RD = 200.0

HISTORY_FIELDS = [
    "match_id", "event_id", "bracket_id", "profile_id", "ruleset",
    "opponent_profile_id", "score", "method", "method_weighting_enabled",
    "w_method_applied", "r_pre", "RD_pre", "sigma_pre", "r_post", "RD_post",
    "sigma_post", "match_datetime", "dirty_flag", "excluded_from_rating",
]
CURRENT_FIELDS = [
    "profile_id", "ruleset", "rating", "RD", "sigma", "matches_played",
    "last_rated_match_datetime", "provisional_flag", "leaderboard_eligible",
]


def parse_date(s):
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    raise ValueError(f"unrecognized date format: {s!r}")


def to_bool(s):
    return str(s).strip().lower() in ("1", "true", "t", "yes", "y")


class AthleteState:
    __slots__ = ("profile_id", "ruleset", "r", "rd", "sigma",
                 "matches_played", "wins", "losses", "last_rated_dt")

    def __init__(self, profile_id, ruleset):
        self.profile_id = profile_id
        self.ruleset = ruleset
        self.r = R0
        self.rd = RD0
        self.sigma = SIGMA0
        self.matches_played = 0
        self.wins = 0
        self.losses = 0
        self.last_rated_dt = None

    def mu(self):
        return (self.r - R0) / SCALE

    def phi(self):
        return self.rd / SCALE


def g(phi):
    return 1.0 / math.sqrt(1.0 + 3.0 * phi * phi / (math.pi ** 2))


def expected_score(mu, mu_j, phi_j):
    return 1.0 / (1.0 + math.exp(-g(phi_j) * (mu - mu_j)))


def solve_volatility(phi, sigma, v, delta, tau):
    """Standard Glicko-2 Illinois/regula-falsi volatility root-find."""
    a = math.log(sigma * sigma)

    def f(x):
        ex = math.exp(x)
        num = ex * (delta * delta - phi * phi - v - ex)
        den = 2.0 * (phi * phi + v + ex) ** 2
        return num / den - (x - a) / (tau * tau)

    big_a = a
    if delta * delta > phi * phi + v:
        big_b = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * tau) < 0:
            k += 1
        big_b = a - k * tau

    f_a, f_b = f(big_a), f(big_b)
    epsilon = 1e-6
    for _ in range(100):
        if abs(big_b - big_a) <= epsilon:
            break
        big_c = big_a + (big_a - big_b) * f_a / (f_b - f_a)
        f_c = f(big_c)
        if f_c * f_b < 0:
            big_a, f_a = big_b, f_b
        else:
            f_a = f_a / 2.0
        big_b, f_b = big_c, f_c
    return math.exp(big_a / 2.0)


def pre_match_phi(phi_prev, sigma_prev, t_periods):
    """model-spec.md S4 pre-match inactivity step."""
    phi_pre = math.sqrt(phi_prev ** 2 + (sigma_prev ** 2) * max(t_periods, 0.0))
    return min(phi_pre, PHI_MAX)


def diffusion_phi(phi_last, t_periods):
    """model-spec.md S5 wall-clock reporting decay (uses fixed c, not sigma)."""
    phi_min = RD_MIN / SCALE
    base = max(phi_last, phi_min)
    phi_now = math.sqrt(base ** 2 + (DIFFUSION_C_PHI ** 2) * max(t_periods, 0.0))
    return min(phi_now, PHI_MAX)


class Engine:
    def __init__(self, method_weighting=False, include_dirty=False):
        self.method_weighting = method_weighting
        self.include_dirty = include_dirty
        self.pools = {}  # (profile_id, ruleset) -> AthleteState
        self.history_rows = []

    def get_state(self, profile_id, ruleset):
        key = (profile_id, ruleset)
        st = self.pools.get(key)
        if st is None:
            st = AthleteState(profile_id, ruleset)
            self.pools[key] = st
        return st

    def w_method(self, method, dirty):
        if dirty:
            return 1.0
        if not self.method_weighting:
            return 1.0
        return METHOD_WEIGHTS.get(method, 1.0)

    def process_match(self, match):
        ruleset = match["ruleset"]
        winner = self.get_state(match["winner_id"], ruleset)
        loser = self.get_state(match["loser_id"], ruleset)
        dt = match["match_datetime"]
        dirty = match["dirty_flag"]
        excluded = dirty and not self.include_dirty

        r_pre_w, rd_pre_w, sigma_pre_w = winner.r, winner.rd, winner.sigma
        r_pre_l, rd_pre_l, sigma_pre_l = loser.r, loser.rd, loser.sigma
        w_applied = self.w_method(match["method"], dirty)

        if excluded:
            self._emit_pair(match, winner, loser, r_pre_w, rd_pre_w, sigma_pre_w,
                             r_pre_l, rd_pre_l, sigma_pre_l, w_applied,
                             winner.r, winner.rd, winner.sigma,
                             loser.r, loser.rd, loser.sigma, excluded)
            return

        t_w = self._periods_since(winner, dt)
        t_l = self._periods_since(loser, dt)
        phi_w = pre_match_phi(winner.phi(), winner.sigma, t_w)
        phi_l = pre_match_phi(loser.phi(), loser.sigma, t_l)
        mu_w, mu_l = winner.mu(), loser.mu()

        new_r_w, new_rd_w, new_sigma_w = self._update_side(
            mu_w, phi_w, winner.sigma, mu_l, phi_l, s=1.0, w_method=w_applied)
        new_r_l, new_rd_l, new_sigma_l = self._update_side(
            mu_l, phi_l, loser.sigma, mu_w, phi_w, s=0.0, w_method=w_applied)

        winner.r, winner.rd, winner.sigma = new_r_w, new_rd_w, new_sigma_w
        loser.r, loser.rd, loser.sigma = new_r_l, new_rd_l, new_sigma_l
        winner.matches_played += 1
        loser.matches_played += 1
        winner.wins += 1
        loser.losses += 1
        winner.last_rated_dt = dt
        loser.last_rated_dt = dt

        self._emit_pair(match, winner, loser, r_pre_w, rd_pre_w, sigma_pre_w,
                         r_pre_l, rd_pre_l, sigma_pre_l, w_applied,
                         new_r_w, new_rd_w, new_sigma_w,
                         new_r_l, new_rd_l, new_sigma_l, excluded)

    def _periods_since(self, state, dt):
        if state.last_rated_dt is None:
            return 0.0
        days = (dt - state.last_rated_dt).total_seconds() / 86400.0
        return max(days, 0.0) / PERIOD_DAYS

    def _update_side(self, mu, phi, sigma, mu_j, phi_j, s, w_method):
        e = expected_score(mu, mu_j, phi_j)
        gphi_j = g(phi_j)
        v = 1.0 / (gphi_j ** 2 * e * (1.0 - e))
        delta = v * gphi_j * (s - e)
        sigma_new = solve_volatility(phi, sigma, v, delta, TAU)
        phi_star = math.sqrt(phi ** 2 + sigma_new ** 2)
        phi_new = 1.0 / math.sqrt(1.0 / phi_star ** 2 + 1.0 / v)
        mu_new = mu + w_method * (phi_new ** 2) * gphi_j * (s - e)
        r_new = SCALE * mu_new + R0
        rd_new = SCALE * phi_new
        return r_new, rd_new, sigma_new

    def _emit_pair(self, match, winner, loser, r_pre_w, rd_pre_w, sigma_pre_w,
                    r_pre_l, rd_pre_l, sigma_pre_l, w_applied,
                    r_post_w, rd_post_w, sigma_post_w,
                    r_post_l, rd_post_l, sigma_post_l, excluded):
        common = dict(
            match_id=match["match_id"], event_id=match["event_id"],
            bracket_id=match.get("bracket_id", ""),
            method=match["method"],
            method_weighting_enabled=self.method_weighting,
            w_method_applied=w_applied,
            match_datetime=match["match_datetime_raw"],
            dirty_flag=match["dirty_flag"],
            excluded_from_rating=excluded,
        )
        self.history_rows.append({
            **common, "profile_id": winner.profile_id, "ruleset": winner.ruleset,
            "opponent_profile_id": loser.profile_id, "score": 1,
            "r_pre": r_pre_w, "RD_pre": rd_pre_w, "sigma_pre": sigma_pre_w,
            "r_post": r_post_w, "RD_post": rd_post_w, "sigma_post": sigma_post_w,
        })
        self.history_rows.append({
            **common, "profile_id": loser.profile_id, "ruleset": loser.ruleset,
            "opponent_profile_id": winner.profile_id, "score": 0,
            "r_pre": r_pre_l, "RD_pre": rd_pre_l, "sigma_pre": sigma_pre_l,
            "r_post": r_post_l, "RD_post": rd_post_l, "sigma_post": sigma_post_l,
        })

    def current_snapshot(self, as_of_dt=None):
        rows = []
        for (profile_id, ruleset), st in sorted(self.pools.items()):
            rd = st.rd
            if as_of_dt is not None and st.last_rated_dt is not None:
                days = (as_of_dt - st.last_rated_dt).total_seconds() / 86400.0
                t_periods = max(days, 0.0) / PERIOD_DAYS
                rd = diffusion_phi(st.phi(), t_periods) * SCALE
            provisional = (st.matches_played < PROVISIONAL_MIN_MATCHES or
                           rd > PROVISIONAL_MAX_RD)
            rows.append({
                "profile_id": profile_id,
                "ruleset": ruleset,
                "rating": st.r,
                "RD": rd,
                "sigma": st.sigma,
                "matches_played": st.matches_played,
                "last_rated_match_datetime":
                    st.last_rated_dt.isoformat() if st.last_rated_dt else "",
                "provisional_flag": provisional,
                "leaderboard_eligible": not provisional,
            })
        return rows


def load_matches(path):
    """Reads the actual data/matches.csv schema (see KNOWN DEVIATIONS)."""
    matches = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            method = (row.get("method") or "").strip().lower()
            is_clean = row.get("is_clean")
            dirty_flag = (is_clean is not None and not to_bool(is_clean)) or (
                method in DIRTY_METHODS)
            dt = parse_date(row.get("date"))
            round_raw = row.get("round", "")
            try:
                round_sortkey = int(round_raw)
            except (TypeError, ValueError):
                round_sortkey = 0
            matches.append({
                "match_id": row["match_id"],
                "event_id": row["event_id"],
                "bracket_id": row.get("bracket_id", ""),
                "ruleset": row["ruleset"],
                "winner_id": row["winner_id"],
                "loser_id": row["loser_id"],
                "method": method,
                "dirty_flag": dirty_flag,
                "match_datetime": dt,
                "match_datetime_raw": row.get("date", ""),
                "_round_sortkey": round_sortkey,
                "_match_id_sortkey": row["match_id"],
            })
    return matches


def sort_matches(matches):
    """Chronological order; ties within the same event broken by bracket
    round order (model-spec.md #1), then match_id (bracket_id + round now
    supplied by normalize -- resolves engine/rate.py's prior KNOWN
    DEVIATIONS #2/#3, see data/normalize-report-30665.md)."""
    return sorted(matches, key=lambda m: (m["match_datetime"] or datetime.min.replace(tzinfo=timezone.utc),
                                           m["_round_sortkey"],
                                           m["_match_id_sortkey"]))


def run(input_path, history_out, current_out, method_weighting, include_dirty, as_of):
    matches = sort_matches(load_matches(input_path))
    engine = Engine(method_weighting=method_weighting, include_dirty=include_dirty)
    for m in matches:
        engine.process_match(m)

    with open(history_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=HISTORY_FIELDS)
        w.writeheader()
        for row in engine.history_rows:
            w.writerow(row)

    with open(current_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CURRENT_FIELDS)
        w.writeheader()
        for row in engine.current_snapshot(as_of_dt=as_of):
            w.writerow(row)

    return engine, matches


def summarize(engine, matches):
    by_ruleset = {}
    for (profile_id, ruleset), st in engine.pools.items():
        d = by_ruleset.setdefault(ruleset, {"athletes": 0, "provisional": 0, "ratings": []})
        d["athletes"] += 1
        d["ratings"].append(st.r)
        if st.matches_played < PROVISIONAL_MIN_MATCHES or st.rd > PROVISIONAL_MAX_RD:
            d["provisional"] += 1
    dirty = sum(1 for m in matches if m["dirty_flag"])
    print(f"matches read: {len(matches)} (dirty/excluded-by-default: {dirty})")
    for ruleset, d in sorted(by_ruleset.items()):
        ratings = d["ratings"]
        lo = min(ratings) if ratings else None
        hi = max(ratings) if ratings else None
        print(f"  ruleset={ruleset}: athletes={d['athletes']} "
              f"provisional={d['provisional']} rating_range=[{lo}, {hi}]")
    if not by_ruleset:
        print("  no athletes rated (0 matches in input)")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", default="data/matches.csv")
    ap.add_argument("--history-out", default="out/ratings_history.csv")
    ap.add_argument("--current-out", default="out/ratings_current.csv")
    ap.add_argument("--method-weighting", action="store_true",
                     help="opt-in ablation flag, model-spec.md S4b (default off)")
    ap.add_argument("--include-dirty", action="store_true",
                     help="opt-in, model-spec.md S6 (default off)")
    ap.add_argument("--as-of", default=None,
                     help="ISO date to project current RD forward to, model-spec.md S5")
    args = ap.parse_args()

    as_of_dt = parse_date(args.as_of) if args.as_of else None
    engine, matches = run(args.input, args.history_out, args.current_out,
                           args.method_weighting, args.include_dirty, as_of_dt)
    summarize(engine, matches)


if __name__ == "__main__":
    main()
