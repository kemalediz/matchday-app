import Link from "next/link";
import { UserCog, Users, ArrowRight } from "lucide-react";

export const metadata = { title: "Help & guides" };

export default function HelpLandingPage() {
  return (
    <>
      <h2 className="!mt-0">Welcome</h2>
      <p>
        MatchTime runs your group&apos;s matches from WhatsApp. The bot handles
        attendance, reminds people before kickoff, balances the teams,
        records scores and collects ratings — you just play.
      </p>
      <p>Two guides depending on your role in the group:</p>

      <div className="grid sm:grid-cols-2 gap-4 not-prose mt-6">
        <Link
          href="/help/admin"
          className="group block p-6 rounded-2xl border border-slate-200 bg-white hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <UserCog className="w-6 h-6 text-blue-600 mb-3" />
          <p className="font-semibold text-slate-900">For admins</p>
          <p className="text-sm text-slate-500 mt-1">
            Setting up an organisation, managing players, activities, the
            weekly match lifecycle, and what you can correct from the dashboard.
          </p>
          <span className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 mt-3 group-hover:gap-2 transition-all">
            Read the admin guide <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </Link>
        <Link
          href="/help/player"
          className="group block p-6 rounded-2xl border border-slate-200 bg-white hover:border-purple-300 hover:shadow-sm transition-all"
        >
          <Users className="w-6 h-6 text-purple-600 mb-3" />
          <p className="font-semibold text-slate-900">For players</p>
          <p className="text-sm text-slate-500 mt-1">
            What to say in the group to sign up, drop out, ask questions,
            sign up a mate, post the score — and how ratings &amp; MoM work.
          </p>
          <span className="inline-flex items-center gap-1 text-sm font-medium text-purple-600 mt-3 group-hover:gap-2 transition-all">
            Read the player guide <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </Link>
      </div>

      <h2>What the bot does, in one minute</h2>
      <ul>
        <li>
          <strong>Reads your group chat</strong> — detects <code>IN</code>,{" "}
          <code>OUT</code>, questions, scores, team-generation requests.
        </li>
        <li>
          <strong>Reacts with slot emojis</strong> — 1️⃣–🔟 when you&apos;re in
          the squad, 🪑 bench, 👋 dropped, 🤔 tentative.
        </li>
        <li>
          <strong>Chases a short squad</strong> — asks the group when
          numbers drop below max, proposes a format switch if there&apos;s
          enough for a smaller game.
        </li>
        <li>
          <strong>Generates balanced teams</strong> — position-aware,
          rating-aware, posted to the group before kickoff.
        </li>
        <li>
          <strong>Collects ratings after</strong> — DMs everyone a personal
          link the morning after, nudges daily at 18:00 until they vote or
          the window closes (5 days).
        </li>
        <li>
          <strong>Announces Man of the Match</strong> — 5 days after the
          game so everyone&apos;s had time to vote.
        </li>
      </ul>

      <p className="text-sm text-slate-500 not-prose mt-8">
        Have a question that isn&apos;t covered? Ask your org admin, or
        reach out via{" "}
        <a href="mailto:hello@matchtime.ai" className="text-blue-600 underline">
          hello@matchtime.ai
        </a>
        .
      </p>
    </>
  );
}
