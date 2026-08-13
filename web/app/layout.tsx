import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ADCC Open Rankings — Adult No-Gi",
  description: "Glicko-2 rankings from ADCC Open tournament data on Smoothcomp.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
