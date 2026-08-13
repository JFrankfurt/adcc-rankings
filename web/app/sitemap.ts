import type { MetadataRoute } from "next";
import { getData } from "./lib/data";

export const dynamic = "force-static"; // required by output: export

// Single-page site; use the data's generated date as lastModified so the
// sitemap reflects each weekly refresh.
export default function sitemap(): MetadataRoute.Sitemap {
  const { meta } = getData();
  return [{
    url: "https://jfrankfurt.github.io/adcc-rankings/",
    lastModified: meta.generated,
    changeFrequency: "weekly",
    priority: 1,
  }];
}
