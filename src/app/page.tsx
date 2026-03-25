import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FORMAT_CONFIG } from "@/lib/constants";
import { format } from "date-fns";
import { Calendar, Trophy, MapPin, Users, Clock, ChevronRight } from "lucide-react";

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
    <div className="mx-auto max-w-6xl px-6 py-10 space-y-8">
      <div>
        <h1>Welcome back, {user.name}!</h1>
        <p className="text-muted-foreground mt-1">Here&apos;s what&apos;s happening with your matches.</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Matches Played
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{matchesPlayed}</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Trophy className="h-4 w-4" />
              MoM Awards
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{momWins.length}</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 flex-wrap">
              {user.positions.map((pos) => (
                <Badge key={pos} variant="secondary" className="text-sm px-3 py-1">{pos}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {nextMatch && (
        <Card className="shadow-sm border-primary/20 bg-gradient-to-br from-card to-accent/30">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">Next Match</CardTitle>
              <Badge
                variant={myAttendance && myAttendance.status !== "DROPPED" ? "default" : "outline"}
                className="text-sm px-3 py-1"
              >
                {myAttendance?.status === "CONFIRMED"
                  ? "You're in!"
                  : myAttendance?.status === "BENCH"
                  ? "On bench"
                  : "Not signed up"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-lg font-semibold">{nextMatch.activity.name}</p>
              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 mt-2 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Clock className="h-4 w-4" />
                  {format(nextMatch.date, "EEEE, d MMMM yyyy 'at' HH:mm")}
                </span>
                <span className="flex items-center gap-1.5">
                  <MapPin className="h-4 w-4" />
                  {nextMatch.activity.venue}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-5 text-[15px]">
              <span className="flex items-center gap-1.5">
                <Users className="h-4 w-4 text-muted-foreground" />
                {confirmedCount}/{nextMatch.maxPlayers} players
              </span>
              {benchCount > 0 && <span className="text-muted-foreground">{benchCount} on bench</span>}
              <Badge variant="secondary">{FORMAT_CONFIG[nextMatch.format].label}</Badge>
            </div>
            <Button render={<Link href={`/matches/${nextMatch.id}`} />} size="lg" className="mt-2">
              View Match
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </CardContent>
        </Card>
      )}

      {!nextMatch && (
        <Card className="shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground text-lg">
            No upcoming matches scheduled. Check back later!
          </CardContent>
        </Card>
      )}

      {recentMatches.length > 0 && (
        <div>
          <h2 className="mb-4">Recent Results</h2>
          <div className="space-y-3">
            {recentMatches.map((match) => (
              <Link key={match.id} href={`/matches/${match.id}`}>
                <Card className="hover:bg-accent/50 transition-all hover:shadow-sm shadow-none">
                  <CardContent className="py-4 flex items-center justify-between">
                    <div>
                      <p className="text-[15px] font-semibold">{match.activity.name}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{format(match.date, "d MMM yyyy")}</p>
                    </div>
                    {match.redScore !== null && match.yellowScore !== null && (
                      <div className="flex items-center gap-3 text-lg font-mono font-bold">
                        <span className="text-red-500">{match.redScore}</span>
                        <span className="text-muted-foreground text-base">-</span>
                        <span className="text-yellow-500">{match.yellowScore}</span>
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
