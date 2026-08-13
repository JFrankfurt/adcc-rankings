# Goal — BJJ athlete ELO ranking from Smoothcomp data

This file is the root goal handed to the recursive planner. It is the analog of
h2pack's thesis: the domain ground truth every agent reasons from. Edit the
**Scope** block to point the pipeline at a specific event set, then run
`python3 run_rankings.py`.

## Objective

Produce a trustworthy, auditable athlete rating/ranking for Brazilian
Jiu-Jitsu competitors, computed from match outcomes in tournament data on
Smoothcomp, split by ruleset (gi / no-gi). The deliverable is a leaderboard per
ruleset plus a methodology a competitor would believe, with every rating
traceable down to individual matches and their Smoothcomp source.

## Scope (EDIT THIS)

- Events: PILOT RUN — a single event: **ADCC US Open — Austin, TX**,
  Smoothcomp event id **30665** (https://adcc.smoothcomp.com/en/event/30665).
  Recon resolves the id to its bracket/match/profile endpoints; ingest pulls
  only this event. This is a pipeline-validation run, not a broad ranking.
- Rulesets: gi and no-gi (rated separately) — pull whichever this event ran.
- Divisions: all belts/weights/ages; open/absolute matches included but handled
  per the model spec.
- Window: this single event's date only (a one-event ELO is a smoke test of the
  full recon→ingest→normalize→compute→validate→report path; ratings will be
  provisional and NOT a meaningful ranking until more events are added).

## Data source notes (Smoothcomp)

- Structure: event → division (ruleset, belt, age, weight) → bracket → match.
- A competitor is a **profile** with a stable numeric id. Identity resolution is
  by profile id, never by name string (names collide; one human = one id).
- Match fields: two competitor profile ids, winner, method (submission /
  points / advantage / decision / DQ / injury-forfeit), time or round when
  present, and date (fall back to event date if per-match time is absent).
- Access path is unknown up front and researching it is real work, so it gets a
  dedicated **recon** step: probe public event pages for JSON/XHR endpoints,
  determine auth/pagination/rate limits/schema, and write
  `design/data-source-spec.md`. The **ingest** step then implements that spec at
  scale. Respect robots.txt / ToS and rate limits. Never fabricate data when a
  source is blocked; log it for manual follow-up.

## Rating requirements (the model-design node decides the exact variant)

1. **Chronological** — matches processed in true time order; intra-event ties
   broken by bracket round order.
2. **Segmented by ruleset** — gi and no-gi are separate pools. Belt, weight,
   and age are metadata/context, not separate pools, because open/absolute
   divisions cross them.
3. **Provisional + decay** — new athletes have high uncertainty until enough
   matches; inactivity raises uncertainty over time. Glicko-2 is the
   recommended default (rating deviation + volatility); a decaying-K ELO is the
   acceptable simpler baseline. Justify the choice against observed data volume.
4. **Method weighting is opt-in and ablatable** — baseline is binary win/loss.
   Any method multiplier must be defined explicitly and validated with an
   ablation (with vs without), and dropped if it does not improve accuracy.
5. **Dirty matches flagged** — DQ / forfeit / walkover / no-show marked and, by
   default, excluded from rating.
6. **Minimum matches to rank** — athletes below a threshold are provisional and
   not shown at the top of the public leaderboard.

## Definition of done

- `out/rankings.csv` and readable per-ruleset leaderboards.
- A backtest that **beats both** a 50/50 baseline and a higher-belt/seed-wins
  heuristic, reported with Brier score and log-loss on a chronological holdout,
  plus a calibration table.
- Every leaderboard number traceable to matches; every match to its Smoothcomp
  source (event / bracket / match id).
- An honest methodology + limitations section.
