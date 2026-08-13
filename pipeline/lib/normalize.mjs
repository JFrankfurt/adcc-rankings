// Normalize one event's raw Smoothcomp pull into canonical adult no-gi matches.
// Handles BOTH bracket renderers: elimination (state.matches[]) and
// round-robin (state.rounds[n][]). Match objects share the same shape.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// "Men / Adult (age 15+) / Beginner / -60,0 kg" -> parts + derived flags.
function parseDivision(name) {
  const parts = String(name || "").split("/").map((s) => s.trim());
  const [gender = "", age = "", level = "", weight = ""] = parts;
  const blob = name.toLowerCase();
  let type = "standard";
  if (/super\s*fight|exhibition/.test(blob)) type = "exhibition";
  else if (/absolute|open\s*weight/.test(blob)) type = "absolute";
  return { gender, age, level, weight, type };
}

// Adult divisions across EN/PT/ES labels ("Adult", "Adults", "Adulto/a/s").
// Exclude youth (Boys/Girls/Kids/Juvenil/Infantil/Teen) and Masters/veterans —
// they never face adults, so cross-age ratings are not comparable.
const YOUTH_MASTER = /boy|girl|kid|juven|infan|mirim|teen|master|veteran|senior|master?s?\s*\d/i;
const isAdult = (age) => /adult/i.test(age) && !YOUTH_MASTER.test(age);
const DIRTY = new Set(["walkover", "disqualification", "dq", "wo"]);

// Pull the two competitors + winner + method out of one match object.
function readMatch(m, reg2user) {
  if (!m || typeof m !== "object" || m.isBye || m.isCancel) return null;
  const seats = m.seats || {};
  const L = seats.left, R = seats.right;
  if (!L || !R || !L.player || !R.player) return null;
  const idOf = (seat) => {
    const p = seat.player || {};
    // prefer the stable profile id from profile_link, else reg->user join,
    // else a name+country fallback key (resolved to a real id in build.mjs
    // when that person appears with a profile_link anywhere).
    const link = p.profile_link && String(p.profile_link).match(/profile\/(\d+)/);
    if (link) return Number(link[1]);
    const viaReg = reg2user.get(p.registration_id);
    if (viaReg) return viaReg;
    const nm = String(p.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    return nm ? `n:${nm}|${(p.country || "").toLowerCase()}` : null;
  };
  const lid = idOf(L), rid = idOf(R);
  if (!lid || !rid || lid === rid) return null;
  let winner, loser;
  if (L.isWinner) { winner = lid; loser = rid; }
  else if (R.isWinner) { winner = rid; loser = lid; }
  else return null; // undecided
  const method = String(m.wonBy || "").toLowerCase() || "unknown";
  const names = new Map([[lid, L.player.name], [rid, R.player.name]]);
  const clubs = new Map([[lid, L.player.club], [rid, R.player.club]]);
  const countries = new Map([[lid, (L.player.country || "").toUpperCase()],
                             [rid, (R.player.country || "").toUpperCase()]]);
  return {
    match_id: m.id, round: Number(m.round || 0), method,
    is_clean: !DIRTY.has(method),
    score: (m.score && m.score.score) || "",
    winner, loser, names, clubs, countries,
  };
}

// Read participants.json -> registration_id -> user_id, plus a name book.
function loadParticipants(dir) {
  const reg2user = new Map();
  const book = new Map(); // user_id -> {name, club, country}
  const p = join(dir, "participants.json");
  if (!existsSync(p)) return { reg2user, book };
  const data = JSON.parse(readFileSync(p, "utf8"));
  for (const pt of data.participants || []) {
    for (const rg of pt.registrations || []) {
      if (rg.id && rg.user_id) reg2user.set(rg.id, rg.user_id);
      if (rg.user_id && !book.has(rg.user_id)) {
        book.set(rg.user_id, {
          name: `${rg.firstname || ""} ${rg.lastname || ""}`.trim() || `#${rg.user_id}`,
          // Smoothcomp participants use camelCase clubName; fall back to
          // team/affiliation, then the older snake_case just in case.
          club: rg.clubName || rg.teamName || rg.affiliationName || rg.club_name || rg.club || "",
          country: (rg.cn || rg.country || "").toUpperCase(),
        });
      }
    }
  }
  return { reg2user, book };
}

// Public: normalize one event directory -> { event, matches[], book }.
export function normalizeEvent(dir) {
  const event = JSON.parse(readFileSync(join(dir, "event.json"), "utf8"));
  const brackets = JSON.parse(readFileSync(join(dir, "brackets.json"), "utf8")).brackets || [];
  const div = new Map(); // bracket_id -> parsed division
  for (const b of brackets) div.set(b.bracket_id, { ...parseDivision(b.name), raw: b.name });
  const { reg2user, book } = loadParticipants(dir);

  const renderDir = join(dir, "render");
  const files = existsSync(renderDir) ? readdirSync(renderDir).filter((f) => f.endsWith(".json")) : [];
  const matches = [];
  for (const f of files) {
    const bracketId = Number(f.replace(".json", ""));
    const d = JSON.parse(readFileSync(join(renderDir, f), "utf8"));
    const st = d.state || {};
    // collect match objects from either renderer
    const raw = [];
    if (Array.isArray(st.matches)) raw.push(...st.matches);
    if (st.rounds && typeof st.rounds === "object")
      for (const arr of Object.values(st.rounds)) if (Array.isArray(arr)) raw.push(...arr);
    const d0 = div.get(bracketId) || {};
    if (!isAdult(d0.age) || d0.type === "exhibition") continue; // adult headline only
    for (const m of raw) {
      const parsed = readMatch(m, reg2user);
      if (!parsed) continue;
      // fold in athlete book entries from match seats: create for ids missing
      // from participants, and backfill a club when the participants entry had
      // none (the render seat carries the club/team string directly).
      for (const [id, nm] of parsed.names) {
        if (!id) continue;
        const seatClub = parsed.clubs.get(id) || "";
        if (!book.has(id)) {
          book.set(id, { name: nm || `#${id}`, club: seatClub, country: parsed.countries.get(id) || "" });
        } else if (seatClub && !book.get(id).club) {
          book.get(id).club = seatClub;
        }
      }
      matches.push({
        event_id: event.event_id, event_name: event.name, date: event.date,
        bracket_id: bracketId, division: d0.raw, division_type: d0.type,
        weight: d0.weight, gender: d0.gender, ruleset: event.ruleset || "nogi",
        match_id: parsed.match_id, round: parsed.round, method: parsed.method,
        is_clean: parsed.is_clean, score: parsed.score,
        winner: parsed.winner, loser: parsed.loser,
      });
    }
  }
  return { event, matches, book };
}
