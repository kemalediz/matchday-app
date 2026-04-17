import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FORMAT_CONFIG } from "@/lib/constants";
import { format, formatDistanceToNow, isToday, isTomorrow } from "date-fns";
import { Calendar, MapPin, Users } from "lucide-react";
import { Progress } from "@/components/ui/progress";

function relativeLabel(date: Date): string {
  if (isToday(date)) return `Today at ${format(date, "HH:mm")}`;
  if (isTomorrow(date)) return `Tomorrow at ${format(date, "HH:mm")}`;
  const dist = formatDistanceToNow(date, { addSuffix: false });
  // Only use relative for near-term dates
  if (dist.includes("day") && parseInt(dist) <= 7) {
    return `${format(date, "EEE 'at' HH:mm")} (in ${dist})`;
  }
  return format(date, "EEE, d MMM 'at' HH:mm");
}

export default async function MatchesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  const upcomingMatches = await db.match.findMany({
    where: { activity: { orgId }, date: { gte: new Date() } },
    orderBy: { date: "asc" },
    include: {
      activity: true,
      attendances: { where: { status: { in: ["CONFIRMED", "BENCH"] } } },
    },
  });

  const pastMatches = await db.match.findMany({
    where: { activity: { orgId }, status: "COMPLETED" },
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
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-8">Matches</h1>

      <Tabs defaultValue="upcoming">
        <TabsList className="mb-6">
          <TabsTrigger value="upcoming" className="text-[15px] px-5">Upcoming ({upcomingMatches.length})</TabsTrigger>
          <TabsTrigger value="past" className="text-[15px] px-5">Past ({pastMatches.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="space-y-3">
          {upcomingMatches.length === 0 && (
            <p className="text-muted-foreground py-12 text-center text-lg">No upcoming matches</p>
          )}
          {upcomingMatches.map((match) => {
            const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED").length;
            const bench = match.attendances.filter((a) => a.status === "BENCH").length;
            const myAtt = myAttendanceMap.get(match.id);

            const statusColor = myAtt?.status === "CONFIRMED" ? "border-l-green-500" : myAtt?.status === "BENCH" ? "border-l-amber-500" : "border-l-transparent";

            return (
              <Link key={match.id} href={`/matches/${match.id}`}>
                <Card className={`hover:bg-accent/50 transition-all hover:shadow-sm shadow-none border-l-4 ${statusColor}`}>
                  <CardContent className="py-5 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1.5">
                        <p className="text-[15px] font-semibold">{match.activity.name}</p>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <Calendar className="h-3.5 w-3.5" />
                            {relativeLabel(match.date)}
                          </span>
                          <span className="flex items-center gap-1.5">
                            <MapPin className="h-3.5 w-3.5" />
                            {match.activity.venue}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0">
                        {myAtt?.status === "CONFIRMED" && <Badge className="text-sm px-3 py-1">In</Badge>}
                        {myAtt?.status === "BENCH" && <Badge variant="outline" className="text-sm px-3 py-1">Bench</Badge>}
                        {!myAtt && <Badge variant="outline" className="text-sm px-3 py-1">Not signed up</Badge>}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <Users className="h-3.5 w-3.5" />
                          {confirmed}/{match.maxPlayers}
                          {bench > 0 && <span className="ml-2">· {bench} bench</span>}
                        </span>
                        <Badge variant="secondary" className="text-xs">{FORMAT_CONFIG[match.format].label}</Badge>
                      </div>
                      <Progress
                        value={confirmed}
                        max={match.maxPlayers}
                        className="h-1.5"
                        indicatorClassName={
                          confirmed >= match.maxPlayers
                            ? "bg-green-500"
                            : confirmed >= match.maxPlayers * 0.75
                            ? "bg-primary"
                            : "bg-amber-500"
                        }
                      />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </TabsContent>

        <TabsContent value="past" className="space-y-3">
          {pastMatches.length === 0 && (
            <p className="text-muted-foreground py-12 text-center text-lg">No past matches</p>
          )}
          {pastMatches.map((match) => (
            <Link key={match.id} href={`/matches/${match.id}`}>
              <Card className="hover:bg-accent/50 transition-all hover:shadow-sm shadow-none">
                <CardContent className="py-5 flex items-center justify-between">
                  <div>
                    <p className="text-[15px] font-semibold">{match.activity.name}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">{format(match.date, "EEE, d MMM yyyy")}</p>
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
