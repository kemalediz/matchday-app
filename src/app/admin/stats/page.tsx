import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

export default async function StatsPage() {
  // Top rated players
  const players = await db.user.findMany({
    where: { isActive: true },
    include: {
      ratingsReceived: { orderBy: { createdAt: "desc" }, take: 60 },
      momVotesReceived: true,
      attendances: { where: { status: "CONFIRMED", match: { status: "COMPLETED" } } },
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
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Player Leaderboard</h2>

      <div className="space-y-2">
        {playerStats.map((player, i) => (
          <Card key={player.id}>
            <CardContent className="py-3 flex items-center gap-4">
              <span className="text-lg font-bold text-muted-foreground w-8">{i + 1}</span>
              <Avatar className="h-8 w-8">
                <AvatarImage src={player.image ?? undefined} />
                <AvatarFallback>{player.name?.charAt(0) ?? "?"}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{player.name}</p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {player.positions.slice(0, 2).map((pos) => (
                    <Badge key={pos} variant="outline" className="text-xs">{pos}</Badge>
                  ))}
                  <span>{player.matchesPlayed} matches</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold">{player.avgRating?.toFixed(1) ?? "N/A"}</p>
                <p className="text-xs text-muted-foreground">{player.momVotes} MoM votes</p>
              </div>
            </CardContent>
          </Card>
        ))}
        {playerStats.length === 0 && (
          <p className="text-muted-foreground text-center py-8">No stats available yet.</p>
        )}
      </div>
    </div>
  );
}
