import Link from "next/link";
import {
  MessageCircle,
  Scale,
  Star,
  Trophy,
  Users,
  CreditCard,
  Zap,
  Shield,
  ArrowRight,
  Check,
} from "lucide-react";

/**
 * Public marketing landing page served at `/` for signed-out visitors.
 * Signed-in visitors see the player dashboard instead — branching happens
 * in app/page.tsx. Everything here is presentational: no auth state, no
 * data fetching.
 */
export function LandingPage() {
  return (
    <div className="bg-slate-950 text-slate-100 overflow-x-hidden">
      {/* ── Top nav ───────────────────────────────────────────────────── */}
      <header className="absolute top-0 inset-x-0 z-20">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-5 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <span className="relative inline-flex w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-teal-400 items-center justify-center text-white font-black shadow-lg shadow-blue-500/30">
              M
              <span className="absolute -inset-0.5 rounded-lg bg-gradient-to-br from-blue-400 to-teal-300 opacity-0 group-hover:opacity-40 blur-md transition-opacity" />
            </span>
            <span className="font-bold tracking-tight text-lg">
              Match<span className="text-blue-400">Time</span>
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-7 text-sm text-slate-300">
            <a href="#features" className="hover:text-white transition-colors">
              Features
            </a>
            <a href="#how-it-works" className="hover:text-white transition-colors">
              How it works
            </a>
            <a href="#for-whom" className="hover:text-white transition-colors">
              Who it&apos;s for
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white text-slate-900 font-semibold text-sm hover:bg-slate-100 transition-colors shadow-sm"
            >
              Sign in
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative pt-36 pb-24 sm:pt-44 sm:pb-32 px-5 sm:px-8">
        {/* Background flourishes */}
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950 via-blue-950 to-slate-950" />
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(600px circle at 20% 20%, rgba(59,130,246,0.25), transparent 40%), radial-gradient(800px circle at 80% 60%, rgba(20,184,166,0.18), transparent 50%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
            backgroundSize: "64px 64px",
            maskImage:
              "radial-gradient(ellipse 80% 50% at 50% 40%, black 40%, transparent 80%)",
          }}
        />

        <div className="relative max-w-6xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/10 text-xs font-medium text-blue-200 backdrop-blur mb-6">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Live in WhatsApp — no app install for players
          </div>
          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-black tracking-tight leading-[1.05]">
            Run your weekly match
            <br />
            <span className="bg-gradient-to-r from-blue-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
              on autopilot.
            </span>
          </h1>
          <p className="mt-7 text-base sm:text-lg lg:text-xl text-slate-300 max-w-2xl mx-auto leading-relaxed">
            MatchTime is the organiser&apos;s autopilot for recurring sports groups.
            Attendance, balanced teams, player ratings and payment polls —
            handled in the WhatsApp group you already use.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-3 items-center justify-center">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-gradient-to-br from-blue-500 to-teal-500 hover:from-blue-400 hover:to-teal-400 text-white font-semibold text-base shadow-xl shadow-blue-500/30 transition-all hover:-translate-y-0.5"
            >
              Start your group
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="#how-it-works"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium text-base border border-white/10 backdrop-blur transition-colors"
            >
              See how it works
            </Link>
          </div>

          {/* Social proof */}
          <div className="mt-14 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs sm:text-sm text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-4 h-4 text-emerald-400" />
              No player sign-ups required
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-4 h-4 text-emerald-400" />
              Football, basketball, custom sports
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-4 h-4 text-emerald-400" />
              Multi-org and multi-team ready
            </span>
          </div>
        </div>
      </section>

      {/* ── Features grid ─────────────────────────────────────────────── */}
      <section id="features" className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-50 text-slate-800">
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
              Why MatchTime
            </span>
            <h2 className="mt-3 text-3xl sm:text-5xl font-black tracking-tight text-slate-900">
              The boring admin, done for you.
            </h2>
            <p className="mt-5 text-lg text-slate-600">
              Every weekly-match organiser knows the pain: chasing names, rebalancing teams, collecting money, nagging late replies. MatchTime automates the lot — in the same WhatsApp group you already use.
            </p>
          </div>

          <div className="mt-16 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard
              color="green"
              icon={<MessageCircle className="w-6 h-6" />}
              title="WhatsApp-first attendance"
              body="Players say &ldquo;IN&rdquo; or &ldquo;OUT&rdquo; in the group — the bot reacts with 👍 and logs them. No app install, no sign-up."
            />
            <FeatureCard
              color="blue"
              icon={<Scale className="w-6 h-6" />}
              title="Auto-balanced teams"
              body="Elo-style ratings plus per-position composition. Snake-draft seed, hill-climb refine. Posted on match-day morning."
            />
            <FeatureCard
              color="amber"
              icon={<Trophy className="w-6 h-6" />}
              title="Ratings & Man of the Match"
              body="Players rate each other 1–10 after every match. MoM announced 5 days later. Builds a real skill picture over time."
            />
            <FeatureCard
              color="purple"
              icon={<Users className="w-6 h-6" />}
              title="Smart bench promotion"
              body="Someone drops? Bot DMs the first bencher, waits 2h for 👍/👎, then moves on automatically. No manual chasing."
            />
            <FeatureCard
              color="teal"
              icon={<CreditCard className="w-6 h-6" />}
              title="Payment polls"
              body="Tick to pay. The bot posts a payment poll after every game and tracks who&apos;s paid. Admins see the list."
            />
            <FeatureCard
              color="rose"
              icon={<Zap className="w-6 h-6" />}
              title="Short-week safety net"
              body="Low numbers? Bot DMs admins to switch to 5-a-side at 10am, or cancel at 6pm the day before. One tap."
            />
          </div>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────────── */}
      <section id="how-it-works" className="relative py-24 sm:py-32 px-5 sm:px-8 bg-white text-slate-800">
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl mx-auto text-center">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
              How it works
            </span>
            <h2 className="mt-3 text-3xl sm:text-5xl font-black tracking-tight text-slate-900">
              Three steps to autopilot.
            </h2>
            <p className="mt-5 text-lg text-slate-600">
              Set it up once, play every week. The bot takes care of the rest.
            </p>
          </div>

          <ol className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-6">
            <Step
              n={1}
              title="Create your group"
              body="Pick a sport preset (football 7-a-side, basketball 5v5, or custom). Set your venue, day, time, and the size of your squad."
            />
            <Step
              n={2}
              title="Connect WhatsApp"
              body="Add the MatchTime bot to your WhatsApp group. It auto-onboards everyone, logs IN/OUT as they come in, and posts the daily roll-call."
            />
            <Step
              n={3}
              title="Play & rate"
              body="The bot announces balanced teams, asks for the score, DMs rating links, tallies MoM votes, and drives it all again next week."
            />
          </ol>

          <div className="mt-16 p-6 sm:p-10 rounded-2xl bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 text-slate-100 border border-white/10 relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  "radial-gradient(400px circle at 20% 50%, rgba(20,184,166,0.3), transparent 50%)",
              }}
            />
            <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 items-center">
              <div>
                <h3 className="text-2xl sm:text-3xl font-black tracking-tight">
                  Built around the admin, not the player.
                </h3>
                <p className="mt-3 text-slate-300 max-w-xl leading-relaxed">
                  Players never have to download anything. Admins get a proper
                  dashboard — override positions, seed ratings, switch formats,
                  even flip the bot off for a specific match while you&apos;re
                  testing.
                </p>
              </div>
              <Link
                href="/signup"
                className="inline-flex shrink-0 items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-slate-900 font-semibold shadow-xl transition-all hover:-translate-y-0.5"
              >
                Get started
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Who it's for ──────────────────────────────────────────────── */}
      <section id="for-whom" className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-50 text-slate-800">
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
              Who it&apos;s for
            </span>
            <h2 className="mt-3 text-3xl sm:text-5xl font-black tracking-tight text-slate-900">
              If you play every week, this is for you.
            </h2>
          </div>

          <div className="mt-16 grid grid-cols-1 md:grid-cols-2 gap-6">
            <PersonaCard
              role="Organisers & captains"
              bullets={[
                "No more chasing WhatsApp replies to get a final 11",
                "One click to switch to 5-a-side if numbers drop",
                "Automatic balanced teams instead of arguing over drafts",
                "Paper-trail for attendance, ratings and payments",
              ]}
            />
            <PersonaCard
              role="Players"
              bullets={[
                "Reply IN in WhatsApp — you&apos;re in. That&apos;s it.",
                "Balanced teams every match, no favouritism",
                "One-tap rating link after each game",
                "Your own stats: matches played, MoMs, rating over time",
              ]}
            />
          </div>

          <div className="mt-14 flex flex-wrap items-center justify-center gap-3 text-sm text-slate-500">
            {[
              "Football 7-a-side",
              "Football 5-a-side",
              "Futsal",
              "Basketball 5v5",
              "Basketball 3v3",
              "Custom sport",
            ].map((s) => (
              <span
                key={s}
                className="inline-flex items-center px-3.5 py-1.5 rounded-full bg-white border border-slate-200 text-slate-700 text-xs font-medium shadow-sm"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────────────── */}
      <section className="relative py-24 sm:py-32 px-5 sm:px-8 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 text-white overflow-hidden">
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(600px circle at 50% 50%, rgba(59,130,246,0.3), transparent 60%)",
          }}
        />
        <div className="relative max-w-3xl mx-auto text-center">
          <Shield className="w-10 h-10 mx-auto text-blue-400 mb-5" />
          <h2 className="text-3xl sm:text-5xl font-black tracking-tight">
            Ready for a quieter
            <br /> match-day morning?
          </h2>
          <p className="mt-5 text-lg text-slate-300">
            Set your group up in under five minutes. First month on us — no
            credit card needed.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-3 items-center justify-center">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-slate-900 font-semibold text-base shadow-xl transition-all hover:-translate-y-0.5"
            >
              Create your group
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-medium text-base border border-white/10 backdrop-blur transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="bg-slate-950 text-slate-400 py-10 px-5 sm:px-8 border-t border-white/5">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-teal-400 items-center justify-center text-white font-black text-sm">
              M
            </span>
            <span className="font-bold text-white">
              Match<span className="text-blue-400">Time</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <Link href="/login" className="hover:text-white transition-colors">
              Sign in
            </Link>
            <Link href="/signup" className="hover:text-white transition-colors">
              Sign up
            </Link>
            <a
              href="mailto:admin@cressoft.io"
              className="hover:text-white transition-colors"
            >
              Contact
            </a>
            <a
              href="https://cressoft.io"
              target="_blank"
              rel="noreferrer"
              className="hover:text-white transition-colors"
            >
              By Cressoft
            </a>
          </div>
          <p className="text-xs text-slate-500">
            © {new Date().getFullYear()} MatchTime. All rights reserved.
          </p>
        </div>
      </footer>

      {/* JSON-LD for rich results */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "MatchTime",
            applicationCategory: "SportsApplication",
            operatingSystem: "Web, WhatsApp",
            description:
              "WhatsApp-first attendance, auto-balanced teams, player ratings and payment automation for recurring sports groups.",
            url: "https://matchtime.ai",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "GBP",
            },
            publisher: {
              "@type": "Organization",
              name: "Cressoft",
              url: "https://cressoft.io",
            },
          }),
        }}
      />
    </div>
  );
}

const COLORS = {
  blue: "bg-blue-50 text-blue-600 border-blue-100",
  green: "bg-emerald-50 text-emerald-600 border-emerald-100",
  amber: "bg-amber-50 text-amber-600 border-amber-100",
  purple: "bg-purple-50 text-purple-600 border-purple-100",
  teal: "bg-teal-50 text-teal-600 border-teal-100",
  rose: "bg-rose-50 text-rose-600 border-rose-100",
} as const;

function FeatureCard({
  color,
  icon,
  title,
  body,
}: {
  color: keyof typeof COLORS;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="group relative p-7 rounded-2xl bg-white border border-slate-200 hover:border-slate-300 hover:shadow-xl shadow-slate-900/5 transition-all hover:-translate-y-1">
      <div
        className={`w-12 h-12 rounded-xl border flex items-center justify-center ${COLORS[color]}`}
      >
        {icon}
      </div>
      <h3 className="mt-5 text-lg font-bold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="relative p-7 rounded-2xl bg-white border border-slate-200">
      <div className="absolute -top-4 left-7 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-teal-500 text-white font-black flex items-center justify-center shadow-lg shadow-blue-500/30">
        {n}
      </div>
      <h3 className="mt-2 text-lg font-bold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
    </li>
  );
}

function PersonaCard({ role, bullets }: { role: string; bullets: string[] }) {
  return (
    <div className="p-7 rounded-2xl bg-white border border-slate-200 shadow-sm">
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold mb-4">
        <Star className="w-3 h-3" />
        {role}
      </div>
      <ul className="space-y-3">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-3 text-sm text-slate-700">
            <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
            <span dangerouslySetInnerHTML={{ __html: b }} />
          </li>
        ))}
      </ul>
    </div>
  );
}
