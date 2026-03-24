import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FORMAT_CONFIG } from "@/lib/constants";
import { format } from "date-fns";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (!user?.onboarded) redirect("/onboarding");

  // Next upcoming match
  const nextMatch = await db.match.findFirst({
    where: { date: { gte: new Date() }, status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    orderBy: { date: "asc" },
    include: {
      activity: true,
      attendances: { where: { status: { in: ["CONFIRMED", "BENCH"] } } },
    },
  });

  // User's attendance for next match
  const myAttendance = nextMatch
    ? await db.attendance.findUnique({
        where: { matchId_userId: { matchId: nextMatch.id, userId: session.user.id } },
      })
    : null;

  // Recent completed matches
  const recentMatches = await db.match.findMany({
    where: { status: "COMPLETED" },
    orderBy: { date: "desc" },
    take: 5,
    include: { activity: true },
  });

  // Player stats
  const matchesPlayed = await db.attendance.count({
    where: { userId: session.user.id, status: "CONFIRMED", match: { status: "COMPLETED" } },
  });
  const momWins = await db.moMVote.groupBy({
    by: ["matchId"],
    where: { playerId: session.user.id },
    _count: true,
  });

  const confirmedCount = nextMatch?.attendances.filter((a) => a.status === "CONFIRMED").length ?? 0;
  const benchCount = nextMatch?.attendances.filter((a) => a.status === "BENCH").length ?? 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Welcome back, {user.name}!</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Matches Played</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{matchesPlayed}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">MoM Awards</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{momWins.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-1 flex-wrap">
              {user.positions.map((pos) => (
                <Badge key={pos} variant="secondary">{pos}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {nextMatch && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Next Match</CardTitle>
              <Badge variant={myAttendance && myAttendance.status !== "DROPPED" ? "default" : "outline"}>
                {myAttendance?.status === "CONFIRMED"
                  ? "You're in!"
                  : myAttendance?.status === "BENCH"
                  ? "On bench"
                  : "Not signed up"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="font-medium">{nextMatch.activity.name}</p>
              <p className="text-sm text-muted-foreground">
                {format(nextMatch.date, "EEEE, d MMMM yyyy 'at' HH:mm")}
              </p>
              <p className="text-sm text-muted-foreground">{nextMatch.activity.venue}</p>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span>{confirmedCount}/{nextMatch.maxPlayers} players</span>
              {benchCount > 0 && <span className="text-muted-foreground">{benchCount} on bench</span>}
              <span className="text-muted-foreground">{FORMAT_CONFIG[nextMatch.format].label}</span>
            </div>
            <Button render={<Link href={`/matches/${nextMatch.id}`} />}>View Match</Button>
          </CardContent>
        </Card>
      )}

      {!nextMatch && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No upcoming matches scheduled. Check back later!
          </CardContent>
        </Card>
      )}

      {recentMatches.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Recent Results</h2>
          <div className="space-y-2">
            {recentMatches.map((match) => (
              <Link key={match.id} href={`/matches/${match.id}`}>
                <Card className="hover:bg-accent/50 transition-colors">
                  <CardContent className="py-3 flex items-center justify-between">
                    <div>
                      <p className="font-medium">{match.activity.name}</p>
                      <p className="text-sm text-muted-foreground">{format(match.date, "d MMM yyyy")}</p>
                    </div>
                    {match.redScore !== null && match.yellowScore !== null && (
                      <div className="flex items-center gap-2 text-sm font-mono">
                        <span className="text-red-500 font-bold">{match.redScore}</span>
                        <span className="text-muted-foreground">-</span>
                        <span className="text-yellow-500 font-bold">{match.yellowScore}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
