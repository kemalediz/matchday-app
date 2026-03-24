import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FORMAT_CONFIG } from "@/lib/constants";
import { format } from "date-fns";

export default async function MatchesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const upcomingMatches = await db.match.findMany({
    where: { date: { gte: new Date() } },
    orderBy: { date: "asc" },
    include: {
      activity: true,
      attendances: { where: { status: { in: ["CONFIRMED", "BENCH"] } } },
    },
  });

  const pastMatches = await db.match.findMany({
    where: { status: "COMPLETED" },
    orderBy: { date: "desc" },
    take: 20,
    include: { activity: true },
  });

  // Get user's attendances
  const myAttendances = await db.attendance.findMany({
    where: {
      userId: session.user.id,
      matchId: { in: [...upcomingMatches, ...pastMatches].map((m) => m.id) },
      status: { not: "DROPPED" },
    },
  });
  const myAttendanceMap = new Map(myAttendances.map((a) => [a.matchId, a]));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Matches</h1>

      <Tabs defaultValue="upcoming">
        <TabsList>
          <TabsTrigger value="upcoming">Upcoming ({upcomingMatches.length})</TabsTrigger>
          <TabsTrigger value="past">Past ({pastMatches.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="space-y-3 mt-4">
          {upcomingMatches.length === 0 && (
            <p className="text-muted-foreground py-8 text-center">No upcoming matches</p>
          )}
          {upcomingMatches.map((match) => {
            const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED").length;
            const bench = match.attendances.filter((a) => a.status === "BENCH").length;
            const myAtt = myAttendanceMap.get(match.id);

            return (
              <Link key={match.id} href={`/matches/${match.id}`}>
                <Card className="hover:bg-accent/50 transition-colors">
                  <CardContent className="py-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium">{match.activity.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {format(match.date, "EEE, d MMM yyyy 'at' HH:mm")} &middot; {match.activity.venue}
                      </p>
                      <div className="flex items-center gap-3 mt-1 text-sm">
                        <span>{confirmed}/{match.maxPlayers} players</span>
                        {bench > 0 && <span className="text-muted-foreground">{bench} on bench</span>}
                        <Badge variant="secondary" className="text-xs">{FORMAT_CONFIG[match.format].label}</Badge>
                      </div>
                    </div>
                    <div>
                      {myAtt?.status === "CONFIRMED" && <Badge>In</Badge>}
                      {myAtt?.status === "BENCH" && <Badge variant="outline">Bench</Badge>}
                      {!myAtt && <Badge variant="outline">Not signed up</Badge>}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </TabsContent>

        <TabsContent value="past" className="space-y-3 mt-4">
          {pastMatches.length === 0 && (
            <p className="text-muted-foreground py-8 text-center">No past matches</p>
          )}
          {pastMatches.map((match) => (
            <Link key={match.id} href={`/matches/${match.id}`}>
              <Card className="hover:bg-accent/50 transition-colors">
                <CardContent className="py-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium">{match.activity.name}</p>
                    <p className="text-sm text-muted-foreground">{format(match.date, "EEE, d MMM yyyy")}</p>
                  </div>
                  {match.redScore !== null && match.yellowScore !== null && (
                    <div className="flex items-center gap-2 font-mono">
                      <span className="text-red-500 font-bold">{match.redScore}</span>
                      <span className="text-muted-foreground">-</span>
                      <span className="text-yellow-500 font-bold">{match.yellowScore}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
