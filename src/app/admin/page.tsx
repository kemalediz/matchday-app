import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Users, Calendar, Clock, CheckCircle, ChevronRight } from "lucide-react";

const TILE = {
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  green: "bg-green-50 text-green-700 border-green-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
} as const;

export default async function AdminDashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  const [playerCount, activeActivities, upcomingMatches, completedMatches] = await Promise.all([
    db.membership.count({ where: { orgId, leftAt: null } }),
    db.activity.count({ where: { orgId, isActive: true } }),
    db.match.count({
      where: {
        activity: { orgId },
        status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      },
    }),
    db.match.count({
      where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Link href="/admin/players" className={`p-5 rounded-xl border ${TILE.purple} hover:shadow-md transition-shadow`}>
          <div className="flex items-center gap-2 opacity-75">
            <Users className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Players</p>
          </div>
          <p className="text-3xl font-bold mt-2">{playerCount}</p>
        </Link>
        <Link href="/admin/activities" className={`p-5 rounded-xl border ${TILE.blue} hover:shadow-md transition-shadow`}>
          <div className="flex items-center gap-2 opacity-75">
            <Calendar className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Activities</p>
          </div>
          <p className="text-3xl font-bold mt-2">{activeActivities}</p>
        </Link>
        <div className={`p-5 rounded-xl border ${TILE.amber}`}>
          <div className="flex items-center gap-2 opacity-75">
            <Clock className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Upcoming</p>
          </div>
          <p className="text-3xl font-bold mt-2">{upcomingMatches}</p>
        </div>
        <div className={`p-5 rounded-xl border ${TILE.green}`}>
          <div className="flex items-center gap-2 opacity-75">
            <CheckCircle className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Completed</p>
          </div>
          <p className="text-3xl font-bold mt-2">{completedMatches}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/admin/activities"
          className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
        >
          Manage activities <ChevronRight className="w-4 h-4" />
        </Link>
        <Link
          href="/admin/players"
          className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
        >
          Manage players <ChevronRight className="w-4 h-4" />
        </Link>
        <Link
          href="/admin/settings"
          className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
        >
          Org settings
        </Link>
      </div>
    </div>
  );
}
