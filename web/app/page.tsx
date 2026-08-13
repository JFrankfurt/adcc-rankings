import { getData } from "./lib/data";
import RankingsClient from "./RankingsClient";

const SITE = "https://jfrankfurt.github.io/adcc-rankings";

// Serialize JSON-LD safely: escape "<" so an athlete name containing "</script>"
// (external data) cannot break out of the inline script tag.
function ldJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

export default function Page() {
  const data = getData();
  const ranked = data.athletes.filter((a) => a.eligible);
  const initial = ranked.slice(0, 200); // server-rendered for SEO + first paint
  const m = data.meta;

  // Structured data: a Dataset + an ItemList of the top athletes so search
  // engines can surface the ranking and its top names directly.
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        name: "ADCC Open Adult No-Gi Rankings",
        description: `Glicko-2 rankings of ${m.athletes} adult no-gi grapplers over ${m.events.length} ADCC Open events (${m.rated_matches} matches).`,
        url: SITE + "/",
        creator: { "@type": "Person", name: "Jordan Frankfurt" },
        dateModified: m.generated,
        keywords: ["ADCC", "no-gi", "BJJ", "grappling", "rankings", "Glicko-2", "jiu-jitsu"],
      },
      {
        "@type": "ItemList",
        name: "Top ADCC Open no-gi athletes",
        numberOfItems: Math.min(ranked.length, 50),
        itemListElement: ranked.slice(0, 50).map((a, i) => ({
          "@type": "ListItem", position: i + 1,
          item: { "@type": "Person", name: a.name, ...(a.club ? { affiliation: a.club } : {}) },
        })),
      },
    ],
  };

  return (
    <main className="wrap">
      <script type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: ldJson(jsonLd) }} />
      <h1>ADCC Open Rankings — Adult No-Gi</h1>
      <p className="sub">
        {m.events.length} ADCC Opens · <b>{m.eligible.toLocaleString()}</b> ranked
        of {m.athletes.toLocaleString()} · Glicko-2
      </p>
      <p className="note">◆ validated across 2+ events. Others reflect one event.</p>
      <RankingsClient initial={initial} meta={m} />
    </main>
  );
}
