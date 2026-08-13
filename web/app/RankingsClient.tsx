"use client";
import { useEffect, useMemo, useState } from "react";
import type { Athlete, Match, Meta } from "./lib/data";

// Interactive layer. Server-rendered with `initial` (top ranked athletes) so
// the leaderboard is in the static HTML for crawlers; on mount it fetches the
// full dataset (all athletes + per-match history) for search and detail views.
export default function RankingsClient({ initial, meta }: { initial: Athlete[]; meta: Meta }) {
  const [athletes, setAthletes] = useState<Athlete[]>(initial);
  const [matches, setMatches] = useState<Record<string, Match[]>>({});
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<number | string | null>(null);

  useEffect(() => {
    const bp = process.env.NEXT_PUBLIC_BASE_PATH || "";
    fetch(`${bp}/data/data.json`).then((r) => r.json())
      .then((d) => { setAthletes(d.athletes); setMatches(d.matches); })
      .catch(() => {});
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return athletes.filter((a) => a.eligible).slice(0, 50);
    return athletes
      .filter((a) => a.name.toLowerCase().includes(term) || a.club.toLowerCase().includes(term))
      .slice(0, 100);
  }, [athletes, q]);

  const selAthlete = sel != null ? athletes.find((a) => a.id === sel) : null;

  if (selAthlete) {
    return <AthleteView a={selAthlete} matches={matches[String(selAthlete.id)] || []}
      onOpen={(id) => setSel(id)} onBack={() => setSel(null)} />;
  }

  return (
    <>
      <input className="search" placeholder="Search any athlete by name or club…"
        value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search athletes" />
      {results.length === 0 ? (
        <p className="empty">No athlete matches “{q}”.</p>
      ) : (
        <table>
          <thead>
            <tr><th>#</th><th>Athlete</th><th>Rating</th><th>Record</th><th>Matches</th></tr>
          </thead>
          <tbody>
            {results.map((a) => (
              <tr key={a.id} onClick={() => setSel(a.id)}>
                <td className={"rank" + (a.rank && a.rank <= 3 ? " top" : "")}>{a.rank ?? "—"}</td>
                <td>
                  {a.cross_event && <span className="xe" title={`competed in ${a.events} ADCC Opens — cross-event validated`}>◆</span>}
                  {a.name}{a.country ? <span className="club"> · {a.country}</span> : null}
                  {!a.eligible && <span className="prov">provisional</span>}
                  {a.club ? <div className="club">{a.club}</div> : null}
                </td>
                <td><span className="rating">{a.rating}</span> <span className="rd">±{a.rd}</span></td>
                <td className="wl">{a.wins}-{a.losses}</td>
                <td className="wl">{a.matches}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!q && <p className="sub" style={{ marginTop: 14 }}>
        Top {results.length} of {meta.eligible} ranked. Search for anyone else
        (needs ≥{meta.min_matches} clean matches to rank).
      </p>}
    </>
  );
}

function AthleteView({ a, matches, onBack, onOpen }:
  { a: Athlete; matches: Match[]; onBack: () => void; onOpen: (id: number | string) => void }) {
  const byMethod = matches.reduce((acc, m) => {
    const k = m.method || "unknown"; acc[k] = (acc[k] || 0) + 1; return acc;
  }, {} as Record<string, number>);
  return (
    <div>
      <button className="back" onClick={onBack}>← All rankings</button>
      <div className="card">
        <div className="athHead">
          <span>{a.rank ? `#${a.rank}` : "Unranked"}</span>
          <strong style={{ fontSize: 20 }}>{a.cross_event ? "◆ " : ""}{a.name}</strong>
          <span className="big">{a.rating}</span>
          <span className="rd">±{a.rd}</span>
          {!a.eligible && <span className="prov">provisional</span>}
        </div>
        <div className="stats">
          <span>Record <b>{a.wins}-{a.losses}</b></span>
          <span>Matches <b>{a.matches}</b></span>
          <span>Events <b>{a.events}</b></span>
          {Object.entries(byMethod).map(([k, v]) => <span key={k}>{k} <b>{v}</b></span>)}
          {a.club && <span><b>{a.club}</b></span>}
          {a.country && <span>{a.country}</span>}
        </div>
        {matches.length > 0 && <Sparkline matches={matches} />}
      </div>

      <div className="card">
        {matches.length === 0 ? <p className="empty">Loading matches…</p> :
          matches.map((m) => (
            <div className="match" key={m.match_id}>
              <div>
                <div className={"res " + m.result}>{m.result === "win" ? "WIN" : "LOSS"}</div>
                <div className="meta2">{m.date}</div>
              </div>
              <div>
                <div className="opp">vs <a onClick={(e) => { e.preventDefault(); onOpen(m.opponent_id); }} href="#">{m.opponent}</a></div>
                <div className="meta2">{m.method}{m.score ? ` (${m.score})` : ""} · {m.division}</div>
              </div>
              <div>
                <div className={"delta " + (m.delta >= 0 ? "up" : "down")}>{m.delta >= 0 ? "+" : ""}{m.delta}</div>
                <div className="eloflow">{m.elo_before}→{m.elo_after}</div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function Sparkline({ matches }: { matches: Match[] }) {
  const chron = matches.slice().reverse();
  if (chron.length < 2) return null;
  const pts = [chron[0].elo_before, ...chron.map((m) => m.elo_after)];
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const W = 260, H = 44, n = pts.length - 1;
  const xy = pts.map((p, i) => [(i / n) * W, H - ((p - min) / span) * (H - 6) - 3]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <div className="spark">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        {xy.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2"
          fill={i === 0 ? "var(--dim)" : chron[i - 1].result === "win" ? "var(--win)" : "var(--loss)"} />)}
      </svg>
      <span className="rd">{min} – {max} over {chron.length} matches</span>
    </div>
  );
}
