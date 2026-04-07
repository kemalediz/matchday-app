import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Trophy, Star } from "lucide-react";

export default async function StatsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  const players = await db.user.findMany({
    where: { memberships: { some: { orgId } } },
    include: {
      ratingsReceived: { where: { match: { activity: { orgId } } }, orderBy: { createdAt: "desc" }, take: 60 },
      momVotesReceived: { where: { match: { activity: { orgId } } } },
      attendances: { where: { status: "CONFIRMED", match: { status: "COMPLETED", activity: { orgId } } } },
    },
  });

  const playerStats = players
    .map((p) => ({
      ...p,
      avgRating:
        p.ratingsReceived.length > 0
          ? p.ratingsReceived.reduce((sum, r) => sum + r.score, 0) / p.ratingsReceived.length
          : null,
      matchesPlayed: p.attendances.length,
      momVotes: p.momVotesReceived.length,
    }))
    .filter((p) => p.matchesPlayed > 0)
    .sort((a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0));

  return (
    <div className="space-y-8">
      <h2>Player Leaderboard</h2>

      <div className="space-y-3">
        {playerStats.map((player, i) => (
          <Card key={player.id} className={`shadow-sm ${i < 3 ? "border-primary/20" : ""}`}>
            <CardContent className="py-4 flex items-center gap-4">
              <span className={`text-xl font-bold w-10 text-center ${i < 3 ? "text-primary" : "text-muted-foreground"}`}>
                {i === 0 ? <Trophy className="h-6 w-6 text-yellow-500 mx-auto" /> : i + 1}
              </span>
              <Avatar className="h-10 w-10">
                <AvatarImage src={player.image ?? undefined} />
                <AvatarFallback className="bg-primary/10 text-primary font-semibold">{player.name?.charAt(0) ?? "?"}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold truncate">{player.name}</p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-0.5">
                  {player.positions.slice(0, 2).map((pos) => (
                    <Badge key={pos} variant="outline" className="text-xs">{pos}</Badge>
                  ))}
                  <span>{player.matchesPlayed} matches</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold">{player.avgRating?.toFixed(1) ?? "N/A"}</p>
                <p className="text-xs text-muted-foreground flex items-center justify-end gap-1">
                  <Star className="h-3 w-3" /> {player.momVotes} MoM
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
        {playerStats.length === 0 && (
          <p className="text-muted-foreground text-center py-12 text-lg">No stats available yet.</p>
        )}
      </div>
    </div>
  );
}
