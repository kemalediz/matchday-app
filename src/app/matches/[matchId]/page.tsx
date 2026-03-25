import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AttendButton } from "@/components/match/attend-button";
import { AttendanceList } from "@/components/match/attendance-list";
import { TeamDisplay } from "@/components/match/team-display";
import { FORMAT_CONFIG, ADMIN_EMAIL } from "@/lib/constants";
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
      teamAssignments: {
        include: { user: true },
      },
      momVotes: true,
    },
  });

  if (!match) redirect("/matches");

  const myAttendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });

  const isAdmin = session.user.email === ADMIN_EMAIL;
  const isPastDeadline = new Date() > match.attendanceDeadline;
  const hasTeams = match.teamAssignments.length > 0;

  const redTeam = match.teamAssignments
    .filter((a) => a.team === "RED")
    .map((a) => a.user);
  const yellowTeam = match.teamAssignments
    .filter((a) => a.team === "YELLOW")
    .map((a) => a.user);

  // Check if rating window is open
  const ratingWindowEnd = new Date(match.date.getTime() + match.activity.ratingWindowHours * 60 * 60 * 1000);
  const canRate =
    match.status === "COMPLETED" &&
    new Date() < ratingWindowEnd &&
    myAttendance?.status === "CONFIRMED";

  // Check if user already rated
  const existingRatings = await db.rating.count({
    where: { matchId, raterId: session.user.id },
  });

  // MoM results
  const momResults = match.status === "COMPLETED"
    ? await db.moMVote.groupBy({
        by: ["playerId"],
        where: { matchId },
        _count: { playerId: true },
        orderBy: { _count: { playerId: "desc" } },
      })
    : [];
  const momWinner = momResults.length > 0 ? momResults[0] : null;
  const momWinnerUser = momWinner
    ? await db.user.findUnique({ where: { id: momWinner.playerId } })
    : null;

  const statusLabel = match.status.replace(/_/g, " ");

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1>{match.activity.name}</h1>
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 mt-2 text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {format(match.date, "EEEE, d MMMM yyyy 'at' HH:mm")}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="h-4 w-4" />
              {match.activity.venue}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-sm px-3 py-1">{FORMAT_CONFIG[match.format].label}</Badge>
          <Badge
            variant={
              match.status === "COMPLETED" || match.status === "TEAMS_PUBLISHED"
                ? "default"
                : "outline"
            }
            className="text-sm px-3 py-1"
          >
            {statusLabel}
          </Badge>
        </div>
      </div>

      {/* Score */}
      {match.status === "COMPLETED" && match.redScore !== null && match.yellowScore !== null && (
        <Card className="shadow-sm bg-gradient-to-br from-card to-accent/20">
          <CardContent className="py-8 text-center">
            <div className="flex items-center justify-center gap-8 text-5xl font-bold">
              <span className="text-red-500">{match.redScore}</span>
              <span className="text-muted-foreground text-3xl">-</span>
              <span className="text-yellow-500">{match.yellowScore}</span>
            </div>
            {momWinnerUser && (
              <p className="mt-4 text-muted-foreground flex items-center justify-center gap-1.5">
                <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                Man of the Match: <span className="font-semibold text-foreground">{momWinnerUser.name}</span> ({momWinner!._count.playerId} votes)
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Attend button */}
      {match.status === "UPCOMING" && (
        <div className="flex items-center gap-4">
          <AttendButton
            matchId={matchId}
            currentStatus={myAttendance?.status as "CONFIRMED" | "BENCH" | "DROPPED" | null}
            isPastDeadline={isPastDeadline}
          />
          {!isPastDeadline && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <Clock className="h-4 w-4" />
              Deadline: {format(match.attendanceDeadline, "EEE d MMM, HH:mm")}
            </p>
          )}
        </div>
      )}

      {/* Teams */}
      {hasTeams && (
        <div>
          <h2 className="mb-4">Teams</h2>
          <TeamDisplay
            redTeam={redTeam}
            yellowTeam={yellowTeam}
            redScore={match.redScore}
            yellowScore={match.yellowScore}
          />
        </div>
      )}

      {/* Attendance list */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">Attendance</CardTitle>
        </CardHeader>
        <CardContent>
          <AttendanceList
            attendances={match.attendances.map((a) => ({
              ...a,
              user: {
                ...a.user,
                positions: a.user.positions as string[],
              },
            }))}
            maxPlayers={match.maxPlayers}
          />
        </CardContent>
      </Card>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-3">
        {canRate && (
          <Button render={<Link href={`/matches/${matchId}/rate`} />} size="lg">
            {existingRatings > 0 ? "Update Ratings" : "Rate Players & Vote MoM"}
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        )}
        {isAdmin && match.status === "UPCOMING" && isPastDeadline && (
          <Button variant="outline" size="lg" render={<Link href={`/admin/matches/${matchId}/teams`} />}>Generate Teams</Button>
        )}
        {isAdmin && (match.status === "TEAMS_GENERATED" || match.status === "TEAMS_PUBLISHED") && (
          <Button variant="outline" size="lg" render={<Link href={`/admin/matches/${matchId}/teams`} />}>Manage Teams</Button>
        )}
      </div>
    </div>
  );
}
