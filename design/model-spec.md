# BJJ Rating Model Spec — v1

Authoritative spec for the `compute` node (rating engine) and the `validate` node (backtest). Implement verbatim. Any deviation from this document must be logged as an explicit, named deviation in the node's output — never silently substituted.

## 0. Status of upstream inputs at design time

Verified directly this session (filesystem + log reads, no network tool used):

- No `data/` directory and no `*.csv` anywhere in the repo (`find … -iname "*.csv"` → empty; `find … -iname data` → empty).
- No `design/` directory existed before this node created it just now.
- `out/run-20260811-093438/logs/recon-n02.stdout.json`: recon (n02) reports **BLOCKED at network layer** — every `curl`/`WebFetch`/`WebSearch` attempt was denied pre-request by the sandbox, zero bytes fetched from Smoothcomp, no endpoint/schema/auth model confirmed.
- `out/run-20260811-093438/logs/normalize-n04.stdout.json`: normalize (n04) independently re-confirms the block, reports 0 rows written to `data/matches.csv` / `data/athletes.csv`, and explicitly declined to stub placeholder rows.
- `out/run-20260811-093438/logs/model_design-n05.stdout.json`: a prior pass over this same task (node id `n05`) ran under identical blocked conditions and reached the same algorithmic conclusions below; its `design/model-spec.md` output is no longer present on disk (not found by filesystem search this session), so this document is written fresh rather than assumed valid from that log, though it converges with it because none of the inputs changed.

**Consequence:** no real event-30665 match/bracket/profile data exists to measure "observed data volume" against. Everywhere this spec depends on volume (§1, §5, §7), the justification is **generic single-elimination bracket arithmetic** (public combat-sports structure, not a Smoothcomp-sourced count) and is explicitly flagged for re-validation once `normalize` produces real counts. See `## Blocked — manual follow-up`.

## 1. Algorithm: Glicko-2 (decision) — rejected: ELO with decaying K

**Decision: Glicko-2.**

Justification against expected pilot volume:

- A single-elimination bracket of `n` competitors produces exactly `n − 1` matches and `2(n − 1)` match-participations → **mean matches-per-athlete ≈ 2**, and the eventual bracket winner plays at most `⌈log₂ n⌉` matches (5 for a 32-man bracket). First-round losers — the majority of entrants — get exactly **1** match. (Generic bracket math, not a measured event-30665 statistic — see §0.)
- At matches-per-athlete ≈ 1–2, a decaying-K schedule (e.g. "high K for first N games, then taper") has almost nothing to taper over: it either degenerates to a fixed-K ELO with no real provisional behavior, or requires arbitrary step tuning against data that doesn't exist yet.
- Glicko-2 carries per-athlete uncertainty (`RD`) and volatility (`σ`) as first-class state instead of a hand-tuned K-schedule. A new athlete starts at max `RD` — automatically more rating-mobile per match and automatically excluded from confident placement. This is the "provisional" behavior goal.md and the rubric require, falling out of the algorithm rather than a bolted-on flag.
- Glicko-2's inactivity handling (`RD` inflates with elapsed time since an athlete's last rated match) directly satisfies "inactivity must raise uncertainty over time" (`goal.md` § Rating requirements #3) with no separate decay job to write.
- Cost: a per-match iterative volatility solve (Illinois/regula-falsi root-find), O(few iterations) per match — negligible at one-event pilot scale and does not change qualitatively at multi-event scale.

Source for the canonical algorithm and default constants: Mark Glickman, "Example of the Glicko-2 System" (glicko.net/glicko/glicko2.pdf) — a standard, publicly documented reference. **Not re-fetched live this session** (no network tool available); `compute` must sanity-check the formulas in §4 against that paper before first run.

## 2. Segmentation

- **Rating pools are keyed by `(profile_id, ruleset)`**, `ruleset ∈ {gi, nogi}`. An athlete competing in both carries two fully independent Glicko-2 states (own `r`, `RD`, `σ`, match count, history).
- **Belt, weight class, and age group are metadata only.** Stored on every match/athlete record for filtering, display, and audit. They never create additional rating pools and never enter the baseline rating-update math.
- **Open/absolute divisions** (rubric bar 3): a match tagged `division_type ∈ {open, absolute}` is rated in the **same** ruleset pool, with the **same** baseline update math as every other match — no belt-gap or weight-gap adjustment by default. `belt_a`, `belt_b`, `weight_class_a`, `weight_class_b`, `division_type` are retained on the match row so `validate`/a human can audit or slice cross-belt results after the fact. Rationale: `goal.md`'s baseline is explicitly binary win/loss; a belt-gap multiplier would be a second, undeclared weighting scheme co-mingled with the method-weighting ablation in §4b, breaking "ablation honesty" (rubric bar 6). A belt-gap adjustment is noted as a possible **future**, separately-ablatable extension — **not implemented, not enabled** here.

## 3. Required fields — normalize → compute contract

`normalize` (n04)'s existing spec already carries: `match_id, event_id, division_id, ruleset, bracket_id, round/sequence, competitor_a_profile_id, competitor_b_profile_id, winner_profile_id, method, dirty_flag, match_datetime, source pointers`.

This spec additionally requires the following **metadata-only** fields per match (needed for §2's audit/display requirement, never for the rating math):

| field | values | purpose |
|---|---|---|
| `belt_a`, `belt_b` | white/blue/purple/brown/black (or org equivalent) | display + open-division audit |
| `weight_class_a`, `weight_class_b` | as listed on the Smoothcomp division | display + open-division audit |
| `age_group` | adult/master/juvenile/etc. | display only |
| `division_type` | `standard` \| `open` \| `absolute` | audit tag only, drives no rating logic |

If `normalize` cannot populate one of these for a given match (source gap), emit `null` and keep the match — §4's math consumes none of these fields.

## 4. Baseline update math (binary win/loss, mandatory default)

Rating period = **one match** (not a batched period), processed one at a time in true chronological order, ties within an event broken by bracket round order (`goal.md` #1).

Constants (Glickman defaults):
- `r0 = 1500`, `RD0 = 350`, `σ0 = 0.06`.
- System constant `τ = 0.5` (mid-range of Glickman's recommended 0.3–1.2; pilot has too little data to tune empirically — `validate` may sweep this in a future iteration, but it is NOT part of the method-weighting ablation).
- Scale conversion: `μ = (r − 1500) / 173.7178`, `φ = RD / 173.7178`.

Pre-match inactivity step (applied before each athlete's next match, using elapsed time since their previous rated match in this ruleset pool):
```
φ_pre = min( sqrt(φ_prev² + σ_prev² · t_periods), φ_max )      // φ_max = 350 / 173.7178
```

Per-match update, player with pre-match `(μ, φ)` vs opponent with pre-match `(μ_j, φ_j)`, result `s ∈ {1, 0}` (win = 1, loss = 0 — no draws in BJJ; DQ/forfeit/walkover/no-show are excluded per §6, never scored as 0.5):
```
g(φ_j)       = 1 / sqrt(1 + 3·φ_j² / π²)
E(μ,μ_j,φ_j) = 1 / (1 + exp(-g(φ_j)·(μ − μ_j)))
v            = [ g(φ_j)² · E · (1 − E) ]⁻¹        // single opponent per match
Δ            = v · g(φ_j) · (s − E)
```
Solve for new volatility `σ'` via the standard Glicko-2 iterative (Illinois/regula-falsi) procedure using `τ, Δ, v, φ, σ`. Then:
```
φ*  = sqrt(φ² + σ'²)
φ'  = 1 / sqrt( 1/φ*² + 1/v )
μ'  = μ + w_method · φ'² · g(φ_j) · (s − E)      // w_method defined in §4b
r'  = 173.7178·μ' + 1500
RD' = 173.7178·φ'
```
`w_method` multiplies only the mean-shift term — it never touches `φ'`/`σ'`, so RD/volatility mechanics are byte-identical with or without method-weighting. This is what keeps the ablation clean (rubric bar 6: the toggle changes exactly one term).

**Baseline default: `w_method = 1.0` for every match** (pure binary win/loss).

### 4b. Method-weighting multiplier (opt-in, ablatable, OFF by default)

Single compute-time flag `method_weighting: bool`. When `false` (default), `w_method = 1.0` unconditionally — this IS the required baseline. When `true`, `w_method` is looked up per `goal.md`'s explicit ordering (submission > points > advantage > decision):

| `method` | `w_method` |
|---|---|
| `submission` | 1.20 |
| `points` | 1.05 |
| `advantage` | 0.95 |
| `decision` | 0.85 |
| `dq` / `forfeit` / `noshow` / `other` | n/a — excluded, see §6 |

`validate` (n07) **must** run the full backtest twice — `method_weighting=false` and `=true` — and report Brier score and log-loss for both. Per rubric bar 6: if `true` does not beat `false` on both metrics on the chronological holdout, method-weighting is dropped; `false` ships as the headline model. No partial adoption, no cherry-picked metric.

## 5. Inactivity / time-decay schedule

- Rating period length: **30 days**. `t_periods = days_since_athlete's_last_rated_match_in_this_pool / 30` (fractional, not rounded).
- Diffusion constant `c`: sized so an athlete fully inactive for **5 years (60 periods)** has `RD` inflate from a practical floor `RD_min ≈ 30` back to `RD0 = 350`: `c = sqrt((350² − 30²) / 60) ≈ 45.0` (in the `173.7178`-scaled RD units — convert consistently, don't apply to raw `φ`).
- Applies automatically before every athlete's next match, and (for reporting "current" ratings between events) can be applied against wall-clock "now" so a permanently-inactive athlete's `RD` keeps climbing toward 350 even with zero new matches.
- **Single-event pilot caveat:** with one event, an athlete's own matches fall on the same date or within the event's short window, so `t_periods ≈ 0` between an athlete's own matches. Decay is only visible once a second event enters the corpus — this is expected, not a bug, and `report` should state it plainly.

## 6. Dirty-match handling (DQ / forfeit / walkover / no-show)

- `dirty_flag = true` (set by `normalize`) on any match with `method ∈ {dq, forfeit, noshow, walkover}`. If Smoothcomp's actual method taxonomy uses different labels, `normalize` maps them into this closed set — confirm the real label set against `design/data-source-spec.md` once recon is unblocked.
- **Default: excluded from rating entirely.** Excluded matches do not update `r`/`RD`/`σ` for either side and do not count toward `matches_played` (§7). They remain in the canonical match table and in a per-athlete "excluded matches" list for audit (rubric bar 1 provenance, bar 7 cleanliness).
- Opt-in flag `include_dirty: bool` (default `false`) lets `validate` test sensitivity: if `true`, dirty matches score with the declared winner (`s = 1/0`) using `w_method = 1.0` only — method-weighting never applies to a dirty match even when `method_weighting=true` (the §4b table has no entry for dq/forfeit/noshow/other, by design). Any run with `include_dirty=true` must be labeled wherever its numbers appear; the shipped report uses `false`.

## 7. Minimum-matches-to-rank (public leaderboard gate)

- `provisional_flag = true` when, within a ruleset pool: `matches_played < 5 OR RD > 200` (RD in the same `173.7178`-scaled units as `r`).
- `leaderboard_eligible = NOT provisional_flag`.
- Provisional athletes are still computed and stored (full history + current snapshot) but rendered in a separate "provisional / unranked" section, never in the ranked top section (rubric bar 4; red flag "a provisional / low-match athlete topping the board").
- **Explicit pilot-scale expectation:** per §1's bracket math, most event-30665 athletes will have 1–2 matches, so few or zero athletes are expected to clear `matches_played ≥ 5` from a single event. A thin-to-empty ranked section with a large provisional section is the **correct** output of this spec at pilot scale (`goal.md` already states ratings will be provisional until more events are added). `report` (n08) must state this plainly rather than hide the empty ranked table.

## 8. Win-probability formula for backtest (validate node, mandatory)

For a pre-match pairing of A `(μ_A, φ_A)` vs B `(μ_B, φ_B)`, same ruleset pool:
```
φ_comb    = sqrt(φ_A² + φ_B²)
g(φ_comb) = 1 / sqrt(1 + 3·φ_comb² / π²)
P(A beats B) = 1 / (1 + exp(-g(φ_comb) · (μ_A − μ_B)))
```
This symmetrically extends Glicko-2's single-opponent expected-score function by combining both players' pre-match uncertainty, rather than treating one side as a fixed "field" (the original paper's tournament-vs-field framing) — the correct generalization for a head-to-head backtest. `validate` scores this against actual `s ∈ {0,1}` outcomes on a chronological holdout with Brier score and log-loss, and must report the same two metrics for both required baselines from `goal.md`: always-50% and higher-belt/seed-wins.

## 9. Compute node output contract

`compute` (n06) must emit:

**`out/ratings_history.csv`** — one row per (match, competitor side): `match_id, event_id, bracket_id, profile_id, ruleset, opponent_profile_id, score (0/1), method, method_weighting_enabled, w_method_applied, r_pre, RD_pre, sigma_pre, r_post, RD_post, sigma_post, match_datetime, dirty_flag, excluded_from_rating (bool)`.

**`out/ratings_current.csv`** — one row per `(profile_id, ruleset)`: `profile_id, ruleset, rating, RD, sigma, matches_played, last_rated_match_datetime, provisional_flag, leaderboard_eligible`.

Both files must carry (directly, or via join key to the canonical match table) enough of `event_id`/`bracket_id`/`match_id` per row that every leaderboard number traces to a specific Smoothcomp match (rubric bar 1).

## Blocked — manual follow-up

1. **Recon/ingest network access.** `recon` (n02) and `ingest` (n03) were denied all `curl`/`WebFetch`/`WebSearch` egress this session (sandbox-side block, confirmed pre-request, no Smoothcomp-side response observed). A network-enabled session must run: `curl https://smoothcomp.com/robots.txt` and `.../adcc.smoothcomp.com/robots.txt`; check ToS for scraping clauses; open `https://adcc.smoothcomp.com/en/event/30665` with devtools Network tab to capture division/bracket/match/profile XHR/JSON; save sample payloads to `data/recon/sample-*.json`. Until this exists, `design/data-source-spec.md` has no confirmed endpoint/schema/auth model for `ingest` to implement.
2. **Real bracket/match-count distribution.** §1's "mean matches-per-athlete ≈ 2" is generic single-elimination arithmetic, not a measured count from event 30665. Once `data/matches.csv` (normalize) exists with real rows: recompute the actual matches-per-athlete distribution. If the real format includes round-robin pools or repechage (richer than simple single-elim), matches-per-athlete rises and the `matches_played ≥ 5` gate in §7 may need to move; the Glicko-2-vs-decaying-K choice in §1 would not change (the RD/volatility argument holds regardless of bracket format).
3. **Method taxonomy confirmation.** §6 assumes Smoothcomp exposes a method field mappable onto `{submission, points, advantage, decision, dq, forfeit, noshow, walkover}`. Confirm exact source labels once `design/data-source-spec.md` has a real schema.
4. **Glicko-2 formula re-verification.** Constants and update equations in §1/§4 are stated from the standard published reference (Glickman, glicko.net/glicko/glicko2.pdf), not re-fetched live this session (no network tool available). `compute` should diff its implementation against that paper before first run — the volatility root-find step is the easiest part to mis-transcribe.

## Confidence notes

- **Verified directly, this session:** repo filesystem state (no `data/`, no pre-existing `design/`, zero CSVs anywhere); full contents of `ranking-rubric.md`, `goal.md`, `EXECUTION_PLAN.md`, `out/run-20260811-093438/plan.json`; full text of `out/run-20260811-093438/logs/recon-n02.stdout.json` and `.../normalize-n04.stdout.json`, both independently confirming a network-layer block with zero bytes fetched from Smoothcomp.
- **Inferred, not measured:** the matches-per-athlete volume claim (§1, §7) is derived from generic single-elimination bracket math, not from event 30665's real bracket sizes/format (unavailable — recon/ingest blocked). Glicko-2's default constants (§1, §4, §5) are stated from the standard published reference, not re-verified via a live fetch this session.
- **Biggest risk to this node's output:** §7's `matches_played ≥ 5` threshold and §5's diffusion constant `c ≈ 45.0` are reasoned defaults, not fit against real event-30665 match-count data (none exists yet). If the actual bracket format isn't simple single-elimination, both numbers should be revisited by `validate` once real data lands — but the core algorithm choice (Glicko-2 over decaying-K ELO) and the ruleset-segmentation / method-weighting / dirty-match-exclusion rules are format-independent and don't need revisiting for that reason. The larger structural risk is unchanged from recon/normalize's own reports: every downstream node (compute, validate, report) must treat this spec's parameters as provisional-until-real-data, not as measured fact, and must not present pilot-run output as a meaningful ranking.
