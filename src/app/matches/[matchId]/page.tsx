import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AttendButton } from "@/components/match/attend-button";
import { AttendanceList } from "@/components/match/attendance-list";
import { TeamDisplay } from "@/components/match/team-display";
import { FORMAT_CONFIG } from "@/lib/constants";
import { isOrgAdmin } from "@/lib/org";
import { format } from "date-fns";
import { Calendar, MapPin, Clock, Star, ChevronRight } from "lucide-react";

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const { matchId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: true,
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: { user: true },
        orderBy: { position: "asc" },
      },
      teamAssignments: { include: { user: true } },
      momVotes: true,
    },
  });
  if (!match) redirect("/matches");

  const myAttendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });

  const isAdmin = await isOrgAdmin(session.user.id, match.activity.orgId);
  const isPastDeadline = new Date() > match.attendanceDeadline;
  const hasTeams = match.teamAssignments.length > 0;

  const redTeam = match.teamAssignments.filter((a) => a.team === "RED").map((a) => a.user);
  const yellowTeam = match.teamAssignments.filter((a) => a.team === "YELLOW").map((a) => a.user);

  const ratingWindowEnd = new Date(
    match.date.getTime() + match.activity.ratingWindowHours * 60 * 60 * 1000,
  );
  const canRate =
    match.status === "COMPLETED" &&
    new Date() < ratingWindowEnd &&
    myAttendance?.status === "CONFIRMED";

  const existingRatings = await db.rating.count({
    where: { matchId, raterId: session.user.id },
  });

  const momResults =
    match.status === "COMPLETED"
      ? await db.moMVote.groupBy({
          by: ["playerId"],
          where: { matchId },
          _count: { playerId: true },
          orderBy: { _count: { playerId: "desc" } },
        })
      : [];
  const momWinner = momResults[0] ?? null;
  const momWinnerUser = momWinner
    ? await db.user.findUnique({ where: { id: momWinner.playerId } })
    : null;

  const statusLabel = match.status.replace(/_/g, " ").toLowerCase();
  const statusPill =
    match.status === "COMPLETED"
      ? "bg-green-100 text-green-700"
      : match.status === "TEAMS_PUBLISHED"
      ? "bg-blue-100 text-blue-700"
      : match.status === "TEAMS_GENERATED"
      ? "bg-amber-100 text-amber-700"
      : "bg-slate-100 text-slate-600";

  return (
    <div className="p-6 sm:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{match.activity.name}</h1>
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 mt-2 text-sm text-slate-500">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4" />
              {format(match.date, "EEEE, d MMMM yyyy 'at' HH:mm")}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4" />
              {match.activity.venue}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">
            {FORMAT_CONFIG[match.format].label}
          </span>
          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium capitalize ${statusPill}`}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Score */}
      {match.status === "COMPLETED" && match.redScore !== null && match.yellowScore !== null && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm py-8 text-center">
          <div className="flex items-center justify-center gap-8 text-5xl font-bold">
            <span className="text-red-500">{match.redScore}</span>
            <span className="text-slate-300 text-3xl">-</span>
            <span className="text-amber-500">{match.yellowScore}</span>
          </div>
          {momWinnerUser && (
            <p className="mt-4 text-sm text-slate-500 flex items-center justify-center gap-1.5">
              <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
              Man of the Match:{" "}
              <span className="font-semibold text-slate-800">{momWinnerUser.name}</span>
              <span className="text-slate-400">({momWinner!._count.playerId} votes)</span>
            </p>
          )}
        </div>
      )}

      {/* Attend button */}
      {match.status === "UPCOMING" && (
        <div className="flex items-center gap-4 flex-wrap">
          <AttendButton
            matchId={matchId}
            currentStatus={myAttendance?.status as "CONFIRMED" | "BENCH" | "DROPPED" | null}
            isPastDeadline={isPastDeadline}
          />
          {!isPastDeadline && (
            <p className="text-sm text-slate-500 flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              Deadline: {format(match.attendanceDeadline, "EEE d MMM, HH:mm")}
            </p>
          )}
        </div>
      )}

      {/* Teams */}
      {hasTeams && (
        <section>
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Teams</h2>
          <TeamDisplay
            redTeam={redTeam}
            yellowTeam={yellowTeam}
            redScore={match.redScore}
            yellowScore={match.yellowScore}
          />
        </section>
      )}

      {/* Attendance list */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-lg font-semibold text-slate-800">Attendance</h2>
        </div>
        <div className="p-6">
          <AttendanceList
            attendances={match.attendances.map((a) => ({
              ...a,
              user: { ...a.user, positions: a.user.positions as string[] },
            }))}
            maxPlayers={match.maxPlayers}
          />
        </div>
      </section>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        {canRate && (
          <Link
            href={`/matches/${matchId}/rate`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
          >
            {existingRatings > 0 ? "Update ratings" : "Rate players & vote MoM"}
            <ChevronRight className="w-4 h-4" />
          </Link>
        )}
        {isAdmin && match.status === "UPCOMING" && isPastDeadline && (
          <Link
            href={`/admin/matches/${matchId}/teams`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            Generate teams
          </Link>
        )}
        {isAdmin && (match.status === "TEAMS_GENERATED" || match.status === "TEAMS_PUBLISHED") && (
          <Link
            href={`/admin/matches/${matchId}/teams`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            Manage teams
          </Link>
        )}
      </div>
    </div>
  );
}
