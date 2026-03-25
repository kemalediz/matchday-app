"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Calendar, Star, Trophy, TrendingUp } from "lucide-react";

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

  if (!data) return <p className="mx-auto max-w-4xl px-6 py-10 text-muted-foreground text-lg">Loading...</p>;

  const { player, stats } = data;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 space-y-8">
      <Card className="shadow-sm">
        <CardContent className="py-8 flex items-center gap-6">
          <Avatar className="h-20 w-20 ring-4 ring-primary/10">
            <AvatarImage src={player.image ?? undefined} />
            <AvatarFallback className="text-2xl bg-primary/10 text-primary font-bold">{player.name?.charAt(0)}</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-2xl sm:text-3xl">{player.name}</h1>
            <div className="flex items-center gap-2 mt-3">
              {player.positions.map((pos) => (
                <Badge key={pos} variant="secondary" className="text-sm px-3 py-1">{pos}</Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 sm:grid-cols-4">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Matches
            </CardTitle>
          </CardHeader>
          <CardContent><p className="text-4xl font-bold">{stats.matchesPlayed}</p></CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Star className="h-4 w-4" />
              Avg Rating
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{stats.avgRating ? stats.avgRating.toFixed(1) : "N/A"}</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Trophy className="h-4 w-4" />
              MoM Awards
            </CardTitle>
          </CardHeader>
          <CardContent><p className="text-4xl font-bold">{stats.momCount}</p></CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Attendance
            </CardTitle>
          </CardHeader>
          <CardContent><p className="text-4xl font-bold">{stats.attendanceRate}%</p></CardContent>
        </Card>
      </div>
    </div>
  );
}
