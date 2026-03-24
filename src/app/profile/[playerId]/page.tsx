"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface PlayerProfile {
  player: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    positions: string[];
    role: string;
  };
  stats: {
    matchesPlayed: number;
    avgRating: number | null;
    momCount: number;
    attendanceRate: number;
  };
}

export default function PlayerProfilePage() {
  const { playerId } = useParams<{ playerId: string }>();
  const [data, setData] = useState<PlayerProfile | null>(null);

  useEffect(() => {
    fetch(`/api/players/${playerId}`)
      .then((r) => r.json())
      .then(setData);
  }, [playerId]);

  if (!data) return <p className="mx-auto max-w-3xl px-4 py-8 text-muted-foreground">Loading...</p>;

  const { player, stats } = data;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <Card>
        <CardContent className="py-6 flex items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarImage src={player.image ?? undefined} />
            <AvatarFallback className="text-xl">{player.name?.charAt(0)}</AvatarFallback>
          </Avatar>
          <div>
            <h2 className="text-xl font-bold">{player.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              {player.positions.map((pos) => (
                <Badge key={pos} variant="secondary">{pos}</Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Matches</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{stats.matchesPlayed}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Rating</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats.avgRating ? stats.avgRating.toFixed(1) : "N/A"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">MoM Awards</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{stats.momCount}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Attendance</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{stats.attendanceRate}%</p></CardContent>
        </Card>
      </div>
    </div>
  );
}
