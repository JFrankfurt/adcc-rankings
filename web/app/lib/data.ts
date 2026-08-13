// Build-time data access. Reading the JSON here (server side) lets the page be
// statically rendered with real ranking content in the HTML — the core SEO win
// over the previous client-only fetch, which shipped an empty shell to crawlers.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Athlete = {
  id: number | string; name: string; club: string; country: string;
  rating: number; rd: number; matches: number; wins: number; losses: number;
  events: number; cross_event: boolean;
  eligible: boolean; rank: number | null; last_event: string;
};
export type Match = {
  match_id: number; date: string; event: string; division: string;
  result: "win" | "loss"; method: string; score: string;
  opponent_id: number; opponent: string;
  elo_before: number; elo_after: number; delta: number;
};
export type Meta = {
  generated: string; events: { name: string; date: string; matches: number }[];
  rated_matches: number; athletes: number; eligible: number; cross_event: number;
  model: string; min_matches: number; scope: string;
};
export type Data = { meta: Meta; athletes: Athlete[]; matches: Record<string, Match[]> };

export function getData(): Data {
  return JSON.parse(readFileSync(join(process.cwd(), "public/data/data.json"), "utf8"));
}
