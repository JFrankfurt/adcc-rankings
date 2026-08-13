#!/usr/bin/env python3
"""
BJJ-ELO recursive-plan orchestrator.

Same architecture as h2pack (a deterministic python loop around headless
`cbcode -p` agents, with telemetry / preflight / validation / resume), with one
structural change: the plan is not hard-coded into phases. A PLANNER agent
recursively decomposes the root goal into a tree of sub-goals until each is a
directly-executable LEAF, and the orchestrator then executes that tree.

Phases:
  A  PLAN     recursive planner builds plan.json (goal -> subtree of leaves)
  B  EXECUTE  post-order walk: run each leaf worker; synthesize internal nodes;
              parallelize independent siblings
  C  REVIEW   evaluator + adversary loop over the root report (h2pack-style)
  D  ASSEMBLE FINAL_RANKING.md + out/rankings.csv

Usage:
  python3 run_rankings.py                      # full run
  python3 run_rankings.py --phases A           # build & print the plan only
  python3 run_rankings.py --resume out/run-.../ # reuse plan + node results
  python3 run_rankings.py --max-depth 3 --model fable

Env:
  RANKINGS_PERMISSION_ARGS  override permission flags passed to cbcode.
    The compute/normalize/ingest nodes WRITE FILES and RUN CODE (unlike
    h2pack's read-only agents), so the default grants write+bash in this
    project dir. See preflight().
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import prompts

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
GOAL_FILE = ROOT / "goal.md"
RUBRIC = ROOT / "ranking-rubric.md"

# Compute/ingest/normalize nodes must write files and run the rating engine, so
# unlike h2pack these agents are NOT read-only. `acceptEdits` auto-accepts file
# edits; bash is granted for git-less data pulls and running engine/rate.py,
# scoped to this project dir via --add-dir. cbcode still blocks
# bypassPermissions as a security control.
DEFAULT_PERMISSION_ARGS = "--permission-mode acceptEdits"

MAX_DEPTH = 3          # planner recursion ceiling; hit it -> forced leaves
MAX_REVIEW_ITERS = 3

# Per-task model tiering. h2pack had two tiers (harvest=sonnet, judgment=
# default); here leaves span mechanical -> heavy-judgment, so tier by `kind`.
# None => inherit your configured default model (the strong tier).
#   Precedence: --model (CLI) overrides everything; else KIND_MODEL[kind].
# Rationale per kind:
#   recon         reverse-engineer endpoints/auth/schema      -> default (hard)
#   ingest        implement a written spec, paginate, save     -> sonnet
#   normalize     apply cleaning rules to a known schema       -> sonnet
#   model_design  choose+justify Glicko-2 vs ELO, params       -> default (hard)
#   compute       write, run, and debug the rating engine      -> default (hard)
#   validate      backtest stats, calibration, ablation calls  -> default (hard)
#   report        format a leaderboard to a spec               -> sonnet
KIND_MODEL = {
    "recon": None,
    "ingest": "sonnet",
    "normalize": "sonnet",
    "model_design": None,
    "compute": None,
    "validate": None,
    "report": "sonnet",
}
PLANNER_MODEL = None   # planner is judgment-heavy -> default model
# Internal synthesis + the whole review loop (evaluator/adversary/optimize/
# assemble) are all judgment -> default model (passed model=None at call sites).

# ---------------------------------------------------------------------------
# Logging, telemetry, cbcode runner  (ported from h2pack, unchanged shape)
# ---------------------------------------------------------------------------

LOG_FILE = None
AGENT_STATS = []
STATS_LOCK = threading.Lock()


def ts():
    return datetime.now().strftime("%H:%M:%S")


def log(msg, level="INFO"):
    line = f"[{ts()}] [{level}] {msg}"
    print(line, flush=True)
    if LOG_FILE:
        with STATS_LOCK:
            with open(LOG_FILE, "a") as f:
                f.write(line + "\n")


def run_cbcode(name, prompt, log_dir, timeout_s=1500, max_turns=80,
               model=None, add_dirs=None, retries=1):
    """Run one headless cbcode agent; return its final text result (or None)."""
    perm = os.environ.get("RANKINGS_PERMISSION_ARGS", DEFAULT_PERMISSION_ARGS)
    cmd = ["cbcode", "-p", prompt, "--output-format", "json",
           "--max-turns", str(max_turns)] + shlex.split(perm)
    if model:
        cmd += ["--model", model]
    for d in (add_dirs or []):
        cmd += ["--add-dir", str(Path(d).expanduser())]

    for attempt in range(retries + 1):
        t0 = time.time()
        log(f"▶ {name} (attempt {attempt + 1}, model={model or 'default'}, "
            f"timeout={timeout_s}s)")
        stat = {"agent": name, "attempt": attempt + 1,
                "model": model or "default", "ok": False,
                "prompt_lib": prompts.version()}
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=timeout_s, cwd=ROOT)
        except subprocess.TimeoutExpired:
            stat.update(error="timeout", seconds=timeout_s)
            with STATS_LOCK:
                AGENT_STATS.append(stat)
            log(f"✖ {name}: TIMEOUT after {timeout_s}s", "ERROR")
            continue

        dt = int(time.time() - t0)
        stat["seconds"] = dt
        (log_dir / f"{name}.stdout.json").write_text(proc.stdout or "")
        if proc.stderr:
            (log_dir / f"{name}.stderr.txt").write_text(proc.stderr)

        payload, result = None, None
        try:
            payload = json.loads(proc.stdout)
        except (json.JSONDecodeError, TypeError):
            stat["error"] = "unparseable stdout"

        if payload:
            stat.update(
                cost_usd=round(payload.get("total_cost_usd") or 0, 4),
                turns=payload.get("num_turns"),
                terminal_reason=payload.get("terminal_reason"),
                denials=len(payload.get("permission_denials") or []),
                is_error=payload.get("is_error", False))
            if not payload.get("is_error"):
                result = payload.get("result")
            for d in (payload.get("permission_denials") or []):
                tool = d.get("tool_name", "?")
                arg = str(d.get("tool_input", ""))[:120]
                log(f"⚠ {name}: PERMISSION DENIED {tool} {arg}", "WARN")
            if payload.get("terminal_reason") not in (None, "completed"):
                log(f"⚠ {name}: terminal_reason="
                    f"{payload.get('terminal_reason')} (likely truncated — "
                    f"raise max_turns?)", "WARN")

        if result:
            stat.update(ok=True, chars=len(result))
            with STATS_LOCK:
                AGENT_STATS.append(stat)
            log(f"✔ {name} done in {dt}s — {len(result)} chars, "
                f"{stat.get('turns', '?')} turns, "
                f"${stat.get('cost_usd', 0):.2f}, "
                f"{stat.get('denials', 0)} denials")
            return result

        with STATS_LOCK:
            AGENT_STATS.append(stat)
        err_hint = ""
        if proc.stderr:
            err_hint = " | stderr: " + proc.stderr.strip().splitlines()[0][:200]
        log(f"✖ {name} FAILED in {dt}s (exit {proc.returncode}){err_hint}",
            "ERROR")
    return None


def extract_json(text):
    """Pull the first top-level JSON object out of a model reply."""
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

def preflight():
    problems = []
    from shutil import which
    if not which("cbcode"):
        problems.append("cbcode not on PATH")
    if not GOAL_FILE.exists():
        problems.append(f"missing {GOAL_FILE.name}")
    if not RUBRIC.exists():
        problems.append(f"missing {RUBRIC.name}")
    perm = os.environ.get("RANKINGS_PERMISSION_ARGS", DEFAULT_PERMISSION_ARGS)
    if "bypassPermissions" in perm:
        problems.append("cbcode blocks bypassPermissions; use "
                        "--permission-mode acceptEdits")
    if problems:
        for p in problems:
            log(f"preflight: {p}", "ERROR")
        sys.exit("preflight failed — fix the above and re-run")
    log(f"preflight OK (prompt-lib {prompts.version()})")


def write_summary(run_dir):
    total_cost = sum(s.get("cost_usd", 0) for s in AGENT_STATS)
    total_denials = sum(s.get("denials", 0) for s in AGENT_STATS)
    failed = [s["agent"] for s in AGENT_STATS if not s["ok"]]
    (run_dir / "summary.json").write_text(json.dumps(
        {"finished_at": datetime.now().isoformat(),
         "prompt_lib": prompts.version(),
         "total_cost_usd": round(total_cost, 2),
         "total_permission_denials": total_denials,
         "failed_invocations": failed,
         "agents": AGENT_STATS}, indent=2))
    log(f"run summary: {len(AGENT_STATS)} invocations, ${total_cost:.2f}, "
        f"{total_denials} denials, failures: {failed or 'none'}")


# ---------------------------------------------------------------------------
# Phase A — recursive planner
# ---------------------------------------------------------------------------

def _new_id(counter):
    counter[0] += 1
    return f"n{counter[0]:02d}"


def build_plan(goal, run_dir, log_dir, max_depth, model):
    """Recursively expand `goal` into a plan tree. Returns the root node dict.

    Each node: {id, goal, depth, mode, kind?, children?, reasoning}.
    Expansion is breadth-first with a depth cap; at the cap a node is forced to
    a leaf (default kind 'report') so the tree always terminates.
    """
    counter = [0]

    def make_node(goal, depth, ancestry):
        node = {"id": _new_id(counter), "goal": goal, "depth": depth}
        if depth >= max_depth:
            node.update(mode="leaf", kind="report",
                        reasoning="depth cap reached — forced leaf")
            log(f"plan {node['id']} d{depth}: LEAF (depth cap) — {goal[:70]}")
            return node

        anc = "\n".join(f"  - {a}" for a in ancestry) or "  (none — this is root)"
        prompt = prompts.render(
            "planner", node_id=node["id"], depth=depth, max_depth=max_depth,
            goal=goal, ancestry=anc)
        raw = run_cbcode(f"plan-{node['id']}", prompt, log_dir,
                         timeout_s=600, model=model, add_dirs=[str(ROOT)])
        plan = extract_json(raw) or {}

        if plan.get("mode") == "decompose" and plan.get("children"):
            node.update(mode="decompose",
                        reasoning=plan.get("reasoning", ""), children=[])
            log(f"plan {node['id']} d{depth}: DECOMPOSE into "
                f"{len(plan['children'])} — {goal[:60]}")
            for spec in plan["children"]:
                child = make_node(spec.get("goal", ""), depth + 1,
                                  ancestry + [goal])
                child["depends_on"] = spec.get("depends_on", [])
                child["parallel_safe"] = spec.get("parallel_safe", False)
                node["children"].append(child)
        else:
            leaf = plan.get("leaf") or {}
            kind = leaf.get("kind")
            if kind not in prompts.KIND_TO_ROLE:
                log(f"plan {node['id']}: bad/absent kind {kind!r} -> report",
                    "WARN")
                kind = "report"
            node.update(mode="leaf", kind=kind,
                        goal=leaf.get("goal", goal),
                        reasoning=plan.get("reasoning", ""))
            log(f"plan {node['id']} d{depth}: LEAF/{kind} — {node['goal'][:60]}")
        return node

    root = make_node(goal, 0, [])
    (run_dir / "plan.json").write_text(json.dumps(root, indent=2))
    return root


def plan_outline(node, indent=0):
    """Human-readable tree for logging / --phases A."""
    tag = node.get("kind", node.get("mode"))
    lines = ["  " * indent + f"{node['id']} [{tag}] {node['goal'][:80]}"]
    for c in node.get("children", []):
        lines += plan_outline(c, indent + 1)
    return lines


# ---------------------------------------------------------------------------
# Phase B — post-order executor
# ---------------------------------------------------------------------------

def execute_tree(node, run_dir, log_dir, results_dir, model_override, resume):
    """Post-order: run children first (parallelizing parallel_safe siblings),
    then this node. Leaf -> worker by kind (model tiered by KIND_MODEL unless
    --model overrides). Internal -> synthesis on the default model. Returns the
    path to this node's result file (or None on hard failure)."""
    out = results_dir / f"{node['id']}.md"
    if out.exists() and resume:
        log(f"↷ {node['id']}: reusing {out.name}")
        return out

    if node.get("mode") == "decompose":
        children = node.get("children", [])
        # Serialize dependency-ordered children; run parallel_safe ones (with
        # no deps) together. Conservative: a child with any depends_on waits
        # for all earlier siblings.
        child_paths = []
        pending = list(children)
        done_idx = set()
        while pending:
            batch = [c for i, c in enumerate(children)
                     if c in pending
                     and c.get("parallel_safe")
                     and not c.get("depends_on")]
            if not batch:
                batch = [pending[0]]   # fall back to strict sequential
            with ThreadPoolExecutor(max_workers=len(batch)) as pool:
                futs = {pool.submit(execute_tree, c, run_dir, log_dir,
                                    results_dir, model_override, resume): c
                        for c in batch}
                for fut in as_completed(futs):
                    c = futs[fut]
                    p = fut.result()
                    if p:
                        child_paths.append(str(p))
                    pending.remove(c)
        # Synthesize.
        prompt = prompts.render("synthesize", goal=node["goal"],
                                child_paths="\n".join(f"  - {p}"
                                                      for p in child_paths))
        res = run_cbcode(f"synth-{node['id']}", prompt, log_dir,
                         timeout_s=1200, model=None, add_dirs=[str(ROOT)])
    else:
        kind = node["kind"]
        role = prompts.KIND_TO_ROLE[kind]
        prompt = prompts.render(role, goal=node["goal"])
        # Nodes that probe/pull/write-and-run get more turns; recon iterates on
        # live network probing, ingest paginates, compute debugs the engine.
        turns = 120 if kind in (
            "recon", "ingest", "normalize", "compute") else 80
        # --model beats tiering; else the per-kind tier (None => default model).
        model = model_override or KIND_MODEL.get(kind)
        res = run_cbcode(f"{kind}-{node['id']}", prompt, log_dir,
                         timeout_s=1800, max_turns=turns, model=model,
                         add_dirs=[str(ROOT)])

    if not res:
        out.write_text(f"# {node['id']} FAILED\n\nAgent produced no result — "
                       "treat this subtree's claims as UNVERIFIED. See logs.\n")
        log(f"✖ {node['id']}: hard failure, wrote placeholder", "ERROR")
        return out
    out.write_text(res)
    return out


# ---------------------------------------------------------------------------
# Phase C — evaluator/adversary review loop  (h2pack pattern)
# ---------------------------------------------------------------------------

def review_loop(target, run_dir, log_dir, drafts_dir, max_iters, model):
    current = target
    for i in range(1, max_iters + 1):
        with ThreadPoolExecutor(max_workers=2) as pool:
            f_eval = pool.submit(run_cbcode, f"evaluate-{i}",
                                 prompts.render("evaluator", target=str(current)),
                                 log_dir, timeout_s=900, model=None,
                                 add_dirs=[str(ROOT)])
            f_adv = pool.submit(run_cbcode, f"adversary-{i}",
                                prompts.render("adversary", target=str(current)),
                                log_dir, timeout_s=900, model=None,
                                add_dirs=[str(ROOT)])
            ev = extract_json(f_eval.result()) or {}
            adv = extract_json(f_adv.result()) or {}

        feedback = drafts_dir / f"feedback-{i}.json"
        feedback.write_text(json.dumps({"evaluator": ev, "adversary": adv},
                                       indent=2))
        blockers = [x for x in ev.get("issues", [])
                    if x.get("severity") == "blocker"]
        unanswered = [o for o in adv.get("objections", [])
                      if o.get("severity") in ("fatal", "serious")]
        log(f"iter {i}: eval pass={ev.get('pass')} score={ev.get('score')} "
            f"blockers={len(blockers)} redflags={len(ev.get('red_flags', []))} "
            f"| adversary={adv.get('verdict')} unanswered={len(unanswered)}")
        for b in blockers:
            log(f"  blocker[{b.get('area')}]: {b.get('issue')}", "WARN")
        for o in unanswered:
            log(f"  {o.get('severity')}: {o.get('objection')}", "WARN")

        if ev.get("pass") and not unanswered:
            log(f"converged at iteration {i}")
            break
        if i == max_iters:
            log("max review iterations reached — shipping best report with "
                "open feedback attached", "WARN")
            break
        res = run_cbcode(f"optimize-{i}",
                         prompts.render("optimize", target=str(current),
                                        feedback=str(feedback)),
                         log_dir, timeout_s=1500, model=None,
                         add_dirs=[str(ROOT)])
        if not res:
            log(f"optimize-{i} failed; keeping prior report", "WARN")
            break
        current = drafts_dir / f"report-{i}.md"
        current.write_text(res)
    return current


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phases", default="ABCD",
                    help="subset of ABCD (A=plan B=execute C=review D=assemble)")
    ap.add_argument("--resume", default=None, help="run dir to reuse artifacts")
    ap.add_argument("--max-depth", type=int, default=MAX_DEPTH)
    ap.add_argument("--max-iters", type=int, default=MAX_REVIEW_ITERS)
    ap.add_argument("--model", default=None,
                    help="model override for ALL agents (beats tiering)")
    args = ap.parse_args()

    run_dir = Path(args.resume) if args.resume else \
        ROOT / "out" / f"run-{datetime.now():%Y%m%d-%H%M%S}"
    results_dir = run_dir / "results"
    drafts_dir = run_dir / "drafts"
    log_dir = run_dir / "logs"
    for d in (results_dir, drafts_dir, log_dir):
        d.mkdir(parents=True, exist_ok=True)

    global LOG_FILE
    LOG_FILE = run_dir / "run.log"
    log(f"run dir: {run_dir}")
    log(f"phases={args.phases} max_depth={args.max_depth} "
        f"model={args.model or 'tiered'}")
    preflight()

    import atexit
    atexit.register(write_summary, run_dir)

    planner_model = args.model or PLANNER_MODEL

    # ---- Phase A: plan ---------------------------------------------------
    plan_path = run_dir / "plan.json"
    if "A" in args.phases and not (plan_path.exists() and args.resume):
        goal = GOAL_FILE.read_text()
        root = build_plan(goal, run_dir, log_dir, args.max_depth, planner_model)
    else:
        root = json.loads(plan_path.read_text())
        log(f"loaded plan.json ({plan_path})")
    log("PLAN:\n" + "\n".join(plan_outline(root)))
    if args.phases == "A":
        return

    # ---- Phase B: execute ------------------------------------------------
    root_result = results_dir / f"{root['id']}.md"
    if "B" in args.phases:
        root_result = execute_tree(root, run_dir, log_dir, results_dir,
                                   args.model, resume=bool(args.resume))

    # ---- Phase C: review loop --------------------------------------------
    reviewed = root_result
    if "C" in args.phases:
        reviewed = review_loop(root_result, run_dir, log_dir, drafts_dir,
                               args.max_iters, args.model)

    # ---- Phase D: assemble -----------------------------------------------
    if "D" in args.phases:
        res = run_cbcode("assemble",
                         prompts.render("assemble", target=str(reviewed),
                                        history_dir=str(drafts_dir)),
                         log_dir, timeout_s=2400, max_turns=120,
                         model=None, add_dirs=[str(ROOT)])
        if not res:
            sys.exit("assembly failed")
        final = run_dir / "FINAL_RANKING.md"
        final.write_text(res)
        log("=" * 60)
        log(f"DONE: {final}")
        log("=" * 60)


if __name__ == "__main__":
    main()
