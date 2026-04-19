import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/layout/app-shell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://matchtime.ai";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "MatchTime — Run your weekly match on autopilot",
    template: "%s · MatchTime",
  },
  description:
    "MatchTime is the sports-group autopilot: WhatsApp-first attendance, auto-balanced teams, player ratings, Man-of-the-Match voting and payment polls — built for recurring 5-a-side, 7-a-side, basketball and any weekly sports group.",
  keywords: [
    "sports team management",
    "5-a-side attendance",
    "whatsapp football bot",
    "team balancer",
    "match attendance tracker",
    "pickup football",
    "5v5 basketball manager",
    "sports group organiser",
    "man of the match voting",
    "elo rating football",
  ],
  authors: [{ name: "Cressoft", url: "https://cressoft.io" }],
  creator: "Cressoft",
  publisher: "Cressoft",
  applicationName: "MatchTime",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "MatchTime",
    title: "MatchTime — Run your weekly match on autopilot",
    description:
      "WhatsApp-first attendance, auto-balanced teams, player ratings and MoM voting for recurring sports groups.",
  },
  twitter: {
    card: "summary_large_image",
    title: "MatchTime — Run your weekly match on autopilot",
    description:
      "WhatsApp-first attendance, auto-balanced teams, player ratings and MoM voting for recurring sports groups.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-slate-50 text-slate-800">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
