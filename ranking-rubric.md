# Ranking quality rubric

The evaluator (mechanical) and the adversary (skeptical) grade the final report
against these bars. `pass` requires zero blockers and zero red flags. Analog of
h2pack's `rubric.md`.

## Bars (each is pass/fail)

1. **Provenance** — every rating and every leaderboard number traces to
   matches; every match traces to its Smoothcomp source (event / bracket /
   match id or URL). No orphan numbers.
2. **Identity** — athletes resolved by profile id, not name. Suspected
   duplicate/merged ids are reported, not silently ignored.
3. **Segmentation** — gi and no-gi rated in separate pools. Open/absolute
   cross-belt/weight matches are handled by a stated rule, not dropped silently.
4. **Uncertainty** — provisional athletes flagged and kept off the top of the
   board; inactivity/decay handled; ratings shown with an uncertainty measure.
5. **Accuracy** — chronological-holdout backtest beats BOTH baselines
   (always-50%, higher-belt/seed-wins) on Brier score and log-loss, with the
   numbers sourced. A calibration table is present and roughly diagonal.
6. **Ablation honesty** — if method-weighting is used, an ablation shows it
   helps; if it does not help, it is dropped. No unvalidated knobs.
7. **Cleanliness** — DQ/forfeit/walkover matches flagged; no top rating driven
   by a single dirty or fluke match.
8. **Reproducibility** — the rating engine is deterministic and re-runnable
   from the canonical match table.

## Red flags (any one blocks)

- A leaderboard number with no traceable match support.
- A fabricated or guessed match result, profile id, or metric.
- Gi and no-gi results pooled into one rating.
- Backtest that does not beat the higher-belt-wins heuristic (then it is
  seeding, not a rating).
- A provisional / low-match athlete topping the board.
- "Accuracy" claimed without a holdout, or measured on the training matches.
