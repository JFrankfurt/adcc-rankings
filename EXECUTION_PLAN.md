# Recursive-Plan Execution — BJJ ELO Ranking

**Run:** `python3 run_rankings.py` → `out/run-<ts>/FINAL_RANKING.md`
**Architecture:** copies h2pack's bones — a deterministic Python loop around
headless `cbcode -p` agents with telemetry, preflight, validation, and resume —
and replaces the hard-coded phase list with a **recursive planner** that builds
the plan tree at runtime.

## What changed vs h2pack

| h2pack | this system |
|---|---|
| 5 phases hard-coded in `main()` | plan tree built at runtime by a PLANNER agent |
| prompts inlined in the orchestrator | externalized in `prompts.py` (a prompt-management layer: fragments + roles + version hash) |
| read-only harvest agents | ingest/normalize/compute agents WRITE files + RUN the rating engine |
| evidence ledger anti-hallucination gate | canonical match table + provenance rubric as the gate |

## Components

- **`prompts.py`** — the prompt-management layer. `FRAGMENTS` (domain context,
  output contract, planner rules) are written once; `ROLES` compose them;
  `render(role, **kw)` fills runtime params; `version()` hashes the whole
  library and stamps it into every telemetry record, so any artifact is
  traceable to the exact prompts that made it. Edit one fragment, re-run with
  `--resume`, regenerate only affected nodes.
- **`goal.md`** — root goal + domain ground truth (Smoothcomp data shape, rating
  requirements). Analog of h2pack's thesis. Edit **Scope** to target events.
- **`ranking-rubric.md`** — quality bars + red flags the review loop enforces.
- **`run_rankings.py`** — orchestrator: planner, executor, review loop, assembly.

## Phase A — Plan (recursive)

The planner agent is called on the root goal. For each node it returns JSON:
either `leaf` (with a `kind`) or `decompose` (with child sub-goals, their
`depends_on`, and `parallel_safe`). The orchestrator recurses on children until
leaves or `--max-depth` (default 3, then forced leaf). Tree persisted to
`plan.json` — auditable and hand-editable before Phase B.

Leaf `kind`s map to the natural pipeline: `recon → ingest → normalize →
model_design → compute → validate → report`. `recon` is a dedicated step
because how to pull Smoothcomp data is unresearched — it reverse-engineers the
access surface and writes `design/data-source-spec.md`, which `ingest`
implements at scale.

## Phase B — Execute (post-order)

Walk the tree bottom-up. Independent `parallel_safe` siblings run concurrently
(ThreadPoolExecutor); anything with `depends_on` waits. Leaves run their worker
role by `kind`; internal nodes run a `synthesize` agent that merges child
reports. `compute`/`normalize` get extra turns (they write + run + debug code).
Each node's output saved to `results/<id>.md`; `--resume` skips completed nodes.

Artifacts the workers produce in the project dir:
`design/data-source-spec.md` → `data/raw/*` → `data/matches.csv` +
`data/athletes.csv` → `design/model-spec.md` → `engine/rate.py` +
`out/ratings.csv` → `out/rankings.csv`.

## Phase C — Review (evaluator + adversary loop, ≤ `--max-iters`)

Same as h2pack. Two judges in parallel per iteration:
- **Evaluator** — mechanical rubric check → JSON verdict.
- **Adversary** — skeptical statistician + black belt trying to discredit the
  ranking → JSON objections.

Converge when evaluator passes AND no fatal/serious objection is unanswered;
else the optimizer revises (fix / defend with a sourced metric / escalate to a
`[verify:]` tag) and loops.

## Phase D — Assemble → `FINAL_RANKING.md`

Note → leaderboards → methodology → Appendix A provenance → Appendix B
validation (backtest + calibration) → Appendix C manual follow-up → Appendix D
adversarial-hardening log.

## Ops

- **Models (tiered per task):** the planner, internal synthesis, and the whole
  review loop → your default (strong) model. Leaf workers tier by `kind` via
  `KIND_MODEL`: judgment-heavy leaves (`recon`, `model_design`, `compute`,
  `validate`) → default model; mechanical leaves (`ingest`, `normalize`,
  `report`) → `sonnet`. `--model X` overrides every tier. Each invocation's
  resolved model is recorded in `summary.json`.
- **Permissions:** default `--permission-mode acceptEdits` — unlike h2pack these
  agents write files and run the engine. Scoped to the project dir via
  `--add-dir`. cbcode still blocks `bypassPermissions`. Override with
  `RANKINGS_PERMISSION_ARGS`.
- **Resume:** `--resume out/run-<ts>/` reuses `plan.json` and any completed
  `results/*.md`; `--phases A` builds and prints the plan only.
- **Telemetry:** per-agent cost/turns/denials + prompt-lib version in
  `summary.json`; all raw transcripts in `logs/`.

## Manual steps

1. Set the event scope in `goal.md`.
2. Confirm the ingest access path is authorized for your Smoothcomp usage.
3. Review `plan.json` after `--phases A` before the full run if you want to edit
   the plan by hand.
4. Verify every Appendix C follow-up item before trusting the leaderboard.
