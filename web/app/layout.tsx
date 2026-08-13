import type { Metadata } from "next";
import "./globals.css";

const SITE = "https://jfrankfurt.github.io/adcc-rankings";
const TITLE = "ADCC Open Rankings — Adult No-Gi";
const DESC =
  "Glicko-2 rankings of adult no-gi grapplers computed from every ADCC Open " +
  "tournament on Smoothcomp. Search any athlete and see their match history " +
  "with per-match rating changes.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESC,
  applicationName: "ADCC Open Rankings",
  keywords: ["ADCC", "ADCC Open", "no-gi", "nogi", "BJJ", "jiu-jitsu",
    "grappling rankings", "Glicko-2", "ELO", "submission grappling"],
  authors: [{ name: "Jordan Frankfurt" }],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website", url: SITE + "/", siteName: "ADCC Open Rankings",
    title: TITLE, description: DESC,
  },
  twitter: { card: "summary", title: TITLE, description: DESC },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
