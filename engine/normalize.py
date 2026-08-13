#!/usr/bin/env python3
"""
Normalize raw Smoothcomp JSON (data/raw/*.json) into the canonical
data/matches.csv contract that engine/rate.py consumes.

Source files (all verified on disk, fetched by a prior ingest run this
session, event 30665 / ADCC US Open Austin):
  data/raw/brackets.json      -- 187 bracket/division listing records
  data/raw/participants.json  -- division roster: registration_id -> user_id
                                  (stable profile id), plus division name
  data/raw/render/<bracket_id>.json -- per-bracket match state (two schemas
                                  observed: {state:{rounds:{n:[...]}}} for
                                  single/double-elim brackets, and
                                  {state:{matches:[...] or {...}}} for
                                  round-robin/repechage brackets; both use
                                  the same per-match record shape)

KNOWN DEVIATIONS / EXCLUSIONS (logged, not silently dropped):
  1. Matches with wonBy in {"bye","double-bye"} are excluded -- one or both
     seats is a placeholder ("type":"bye","player":null), not a real
     contest between two competitors.
  2. Matches with wonBy == "double-dq" are excluded -- both sides show
     isWinner=false, no declared winner to score s in {0,1} against
     (model-spec.md S4 requires a winner; there isn't one for these).
  3. Matches referencing a registration_id absent from participants.json's
     roster are excluded -- these registrations are unapproved entries
     (seat player "approved":0 observed in every such case) not present in
     the roster snapshot this session pulled, so no stable profile_id
     (user_id) can be resolved for them. goal.md: "never invent ... a
     profile id" -- these are skipped rather than keyed by registration_id
     (registration_id is NOT the stable cross-event profile id).
  4. ruleset is hardcoded "nogi" for every match. Source data carries no
     per-division gi/nogi field (checked: no bracket name contains the
     token "gi" as a whole word, only the substring inside "Beginner").
     This event is on the adcc.smoothcomp.com tenant; ADCC is a federation
     that runs no-gi submission grappling exclusively (published ADCC
     rules, not re-fetched this session) -- inferred from tenant identity,
     not read from a per-match field. Flagged for re-verification the
     moment a mixed-ruleset event is added to the corpus.
  5. method vocabulary mapped from Smoothcomp's wonBy values to the
     model-spec.md S6 closed set: submission->submission, points->points,
     decision->decision, walkover->walkover (dirty), disqualification->dq
     (dirty). No "advantage" or "noshow"/"forfeit" wonBy value was observed
     in this event's data.
  6. belt_a/belt_b: ADCC divisions use skill levels (Beginner/Intermediate/
     Advanced), not BJJ belt colors. model-spec.md S3 explicitly allows
     "(or org equivalent)" for this field -- skill level is stored there.
  7. division name parsing is best-effort across three observed shapes
     (standard "Gender / AgeGroup / Skill / Weight", absolute "Gender's
     Absolute / AgeGroup / Skill" with no weight, and kids "Boys [11-12
     years] / Skill / Weight" where age is embedded in segment 0). All
     parsed fields are metadata-only (model-spec.md S3) -- they never feed
     the rating math, only display/audit.
"""
import csv
import json
import re
import sys
from pathlib import Path

RAW = Path("data/raw")
OUT = Path("data/matches.csv")
EVENT_ID = "30665"

DIRTY_METHOD_MAP = {
    "walkover": "walkover",
    "disqualification": "dq",
}
CLEAN_METHOD_MAP = {
    "submission": "submission",
    "points": "points",
    "decision": "decision",
}
EXCLUDE_WONBY = {"bye", "double-bye", "double-dq"}

WEIGHT_RE = re.compile(r"^[+-]\d+,\d+\s*kg$", re.I)


def iter_matches(container):
    return container.values() if isinstance(container, dict) else container


def load_registration_map(participants):
    reg_map = {}
    division_meta = {}
    for div in participants["participants"]:
        for reg in div["registrations"]:
            reg_map[reg["id"]] = reg["user_id"]
        division_meta[div["bracket_id"]] = {
            "division_id": div["id"],
            "name": div["name"],
        }
    return reg_map, division_meta


def parse_division_name(name):
    segs = [s.strip() for s in name.split("/")]
    gender = age_group = belt = weight_class = None
    division_type = "standard"

    if "Absolute" in segs[0]:
        division_type = "absolute"
        gender = segs[0].replace("'s Absolute", "").replace("Absolute", "").strip()
        if len(segs) >= 2:
            age_group = segs[1]
        if len(segs) >= 3:
            belt = segs[2]
    elif len(segs) >= 2 and re.match(r"^(Boys|Girls)\b", segs[0]):
        m = re.match(r"^(Boys|Girls)", segs[0])
        gender = m.group(1)
        age_group = segs[0]
        belt = segs[1] if len(segs) >= 2 else None
        if len(segs) >= 3 and WEIGHT_RE.match(segs[2]):
            weight_class = segs[2]
    elif len(segs) >= 4 and segs[0] in ("Men", "Women"):
        gender = segs[0]
        age_group = segs[1]
        belt = segs[2]
        weight_class = segs[3] if WEIGHT_RE.match(segs[3]) else None
    else:
        division_type = "exhibition"
        age_group = name

    return {
        "gender": gender or "",
        "age_group": age_group or "",
        "belt": belt or "",
        "weight_class": weight_class or "",
        "division_type": division_type,
    }


def main():
    brackets = json.loads((RAW / "brackets.json").read_text())["brackets"]
    participants = json.loads((RAW / "participants.json").read_text())
    reg_map, division_meta = load_registration_map(participants)

    bracket_render_ids = {b["bracket_id"] for b in brackets}

    rows = []
    excluded = {"bye": 0, "double_dq": 0, "unmapped_profile": 0}
    excluded_detail = []

    for bracket_id in sorted(bracket_render_ids):
        render_path = RAW / "render" / f"{bracket_id}.json"
        if not render_path.exists():
            excluded_detail.append(f"bracket {bracket_id}: no render file on disk")
            continue
        state = json.loads(render_path.read_text())["state"]
        all_matches = []
        if "rounds" in state:
            for _, ms in state["rounds"].items():
                all_matches.extend(iter_matches(ms))
        else:
            all_matches.extend(iter_matches(state["matches"]))

        meta = division_meta.get(bracket_id, {"division_id": "", "name": ""})
        parsed = parse_division_name(meta["name"]) if meta["name"] else {
            "gender": "", "age_group": "", "belt": "", "weight_class": "",
            "division_type": "",
        }

        for m in all_matches:
            won_by = m.get("wonBy")
            if won_by in EXCLUDE_WONBY:
                if won_by == "double-dq":
                    excluded["double_dq"] += 1
                else:
                    excluded["bye"] += 1
                continue

            left, right = m["seats"]["left"], m["seats"]["right"]
            if left.get("type") != "registration" or right.get("type") != "registration":
                excluded["bye"] += 1
                continue

            left_reg = left["player"]["registration_id"]
            right_reg = right["player"]["registration_id"]
            if left_reg not in reg_map or right_reg not in reg_map:
                excluded["unmapped_profile"] += 1
                excluded_detail.append(
                    f"match {m['id']} bracket {bracket_id}: "
                    f"left_reg={left_reg}({left_reg in reg_map}) "
                    f"right_reg={right_reg}({right_reg in reg_map})"
                )
                continue

            winner_side, loser_side = (left, right) if left.get("isWinner") else (right, left)
            winner_reg = winner_side["player"]["registration_id"]
            loser_reg = loser_side["player"]["registration_id"]

            if won_by in CLEAN_METHOD_MAP:
                method = CLEAN_METHOD_MAP[won_by]
                is_clean = "true"
            elif won_by in DIRTY_METHOD_MAP:
                method = DIRTY_METHOD_MAP[won_by]
                is_clean = "false"
            else:
                excluded_detail.append(f"match {m['id']}: unmapped wonBy={won_by!r}, excluded")
                continue

            rows.append({
                "match_id": m["id"],
                "date": m.get("estimated_starttime", ""),
                "event_id": EVENT_ID,
                "bracket_id": bracket_id,
                "round": m.get("round", ""),
                "ruleset": "nogi",
                "belt": parsed["belt"],
                "weight_class": parsed["weight_class"],
                "age_group": parsed["age_group"],
                "gender": parsed["gender"],
                "division_type": parsed["division_type"],
                "division_id": meta["division_id"],
                "winner_id": reg_map[winner_reg],
                "loser_id": reg_map[loser_reg],
                "winner_registration_id": winner_reg,
                "loser_registration_id": loser_reg,
                "method": method,
                "is_clean": is_clean,
            })

    fieldnames = [
        "match_id", "date", "event_id", "bracket_id", "round", "ruleset",
        "belt", "weight_class", "age_group", "gender", "division_type",
        "division_id", "winner_id", "loser_id", "winner_registration_id",
        "loser_registration_id", "method", "is_clean",
    ]
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)

    print(f"wrote {len(rows)} rows to {OUT}")
    print(f"excluded: bye/no-opponent={excluded['bye']} "
          f"double-dq={excluded['double_dq']} "
          f"unmapped-profile={excluded['unmapped_profile']}")
    print(f"brackets processed: {len(bracket_render_ids)}")
    Path("data/normalize-exclusions-30665.txt").write_text("\n".join(excluded_detail) + "\n")
    print(f"exclusion detail written to data/normalize-exclusions-30665.txt "
          f"({len(excluded_detail)} lines)")


if __name__ == "__main__":
    main()
