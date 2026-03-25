"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { submitRatings, submitMoMVote } from "@/app/actions/ratings";
import { toast } from "sonner";
import { Star, Send } from "lucide-react";

interface Player {
  id: string;
  name: string | null;
  image: string | null;
  positions: string[];
}

export default function RatePlayersPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const { data: session } = useSession();
  const router = useRouter();
  const [players, setPlayers] = useState<Player[]>([]);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [momPick, setMomPick] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/matches/${matchId}`);
      if (!res.ok) return;
      const data = await res.json();
      const otherPlayers = data.attendances
        .filter((a: { userId: string; status: string }) => a.status === "CONFIRMED" && a.userId !== session?.user?.id)
        .map((a: { user: Player }) => a.user);
      setPlayers(otherPlayers);

      // Load existing ratings
      if (data.existingRatings) {
        const ratingMap: Record<string, number> = {};
        data.existingRatings.forEach((r: { playerId: string; score: number }) => {
          ratingMap[r.playerId] = r.score;
        });
        setRatings(ratingMap);
      }
      if (data.existingMoMVote) {
        setMomPick(data.existingMoMVote.playerId);
      }

      // Default all unrated to 5
      const defaultRatings: Record<string, number> = {};
      otherPlayers.forEach((p: Player) => {
        defaultRatings[p.id] = data.existingRatings?.find((r: { playerId: string }) => r.playerId === p.id)?.score ?? 5;
      });
      setRatings(defaultRatings);
      setLoading(false);
    }
    if (session?.user?.id) load();
  }, [matchId, session?.user?.id]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await submitRatings(matchId, {
        ratings: Object.entries(ratings).map(([playerId, score]) => ({ playerId, score })),
      });
      if (momPick) {
        await submitMoMVote(matchId, { playerId: momPick });
      }
      toast.success("Ratings submitted!");
      router.push(`/matches/${matchId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-muted-foreground text-lg">Loading...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <div>
        <h1>Rate Players</h1>
        <p className="text-muted-foreground mt-1 text-lg">Rate each player&apos;s performance (1-10) and pick your Man of the Match.</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">Player Ratings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          {players.map((player) => (
            <div key={player.id} className="space-y-3">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={player.image ?? undefined} />
                  <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                    {player.name?.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <span className="font-semibold text-[15px] flex-1">{player.name}</span>
                <span className="text-2xl font-bold text-primary w-10 text-center">{ratings[player.id] ?? 5}</span>
              </div>
              <Slider
                value={[ratings[player.id] ?? 5]}
                onValueChange={(value) => {
                  const num = Array.isArray(value) ? value[0] : value;
                  setRatings((prev) => ({ ...prev, [player.id]: num }));
                }}
                min={1}
                max={10}
                step={1}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground px-1">
                <span>1</span>
                <span>5</span>
                <span>10</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Separator />

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <Star className="h-5 w-5 text-yellow-500" />
            Man of the Match
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {players.map((player) => (
              <button
                key={player.id}
                onClick={() => setMomPick(player.id)}
                className={`flex items-center gap-3 p-4 rounded-xl border-2 transition-all ${
                  momPick === player.id
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-border hover:bg-accent/50 hover:border-primary/30"
                }`}
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage src={player.image ?? undefined} />
                  <AvatarFallback className="text-xs bg-primary/10 text-primary">{player.name?.charAt(0)}</AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium truncate">{player.name}</span>
                {momPick === player.id && <Badge className="ml-auto text-xs shrink-0">MoM</Badge>}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSubmit} disabled={submitting} size="lg" className="w-full text-base py-6">
        <Send className="h-4 w-4 mr-2" />
        {submitting ? "Submitting..." : "Submit Ratings"}
      </Button>
    </div>
  );
}
