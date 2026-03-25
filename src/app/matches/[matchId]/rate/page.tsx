"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { submitRatings, submitMoMVote } from "@/app/actions/ratings";
import { toast } from "sonner";
import { Star, Send, Trophy } from "lucide-react";

interface Player {
  id: string;
  name: string | null;
  image: string | null;
  positions: string[];
}

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function ScoreButton({ score, selected, onClick }: { score: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full text-sm font-bold transition-all ${
        selected
          ? "bg-primary text-primary-foreground shadow-md scale-110"
          : "bg-muted hover:bg-accent text-muted-foreground hover:text-foreground"
      }`}
    >
      {score}
    </button>
  );
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

      const defaultRatings: Record<string, number> = {};
      otherPlayers.forEach((p: Player) => {
        defaultRatings[p.id] = data.existingRatings?.find((r: { playerId: string }) => r.playerId === p.id)?.score ?? 6;
      });
      setRatings(defaultRatings);

      if (data.existingMoMVote) {
        setMomPick(data.existingMoMVote.playerId);
      }
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
      toast.success("Ratings submitted! Thanks for voting.");
      router.push(`/matches/${matchId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-lg px-4 py-10 text-center">
        <p className="text-muted-foreground text-lg">Loading players...</p>
      </div>
    );
  }

  const allRated = players.every((p) => ratings[p.id] !== undefined);

  return (
    <div className="mx-auto max-w-lg px-4 py-6 space-y-4">
      {/* Header */}
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-bold">Rate Players</h1>
        <p className="text-muted-foreground text-sm">Tap a score for each player, then pick MoM</p>
      </div>

      {/* Player ratings - compact cards */}
      <div className="space-y-3">
        {players.map((player) => (
          <div
            key={player.id}
            className={`rounded-xl border p-3 transition-all ${
              ratings[player.id] ? "border-primary/20 bg-card" : "border-border bg-card"
            }`}
          >
            <div className="flex items-center gap-2.5 mb-2.5">
              <Avatar className="h-8 w-8">
                <AvatarImage src={player.image ?? undefined} />
                <AvatarFallback className="text-xs bg-primary/10 text-primary font-semibold">
                  {player.name?.charAt(0)}
                </AvatarFallback>
              </Avatar>
              <span className="font-semibold text-sm flex-1 truncate">{player.name}</span>
              {player.positions.length > 0 && (
                <Badge variant="outline" className="text-xs shrink-0">{player.positions[0]}</Badge>
              )}
              {ratings[player.id] && (
                <span className="text-lg font-bold text-primary w-7 text-center">{ratings[player.id]}</span>
              )}
            </div>
            <div className="flex justify-between gap-1">
              {SCORES.map((score) => (
                <ScoreButton
                  key={score}
                  score={score}
                  selected={ratings[player.id] === score}
                  onClick={() => setRatings((prev) => ({ ...prev, [player.id]: score }))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* MoM Selection - inline */}
      <div className="rounded-xl border-2 border-yellow-200 dark:border-yellow-900/50 bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-yellow-500" />
          <h2 className="font-bold text-base">Man of the Match</h2>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {players.map((player) => (
            <button
              key={player.id}
              type="button"
              onClick={() => setMomPick(player.id)}
              className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all text-left ${
                momPick === player.id
                  ? "border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 shadow-sm"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarImage src={player.image ?? undefined} />
                <AvatarFallback className="text-xs bg-primary/10 text-primary">{player.name?.charAt(0)}</AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium truncate">{player.name}</span>
              {momPick === player.id && (
                <Star className="h-4 w-4 text-yellow-500 fill-yellow-500 ml-auto shrink-0" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Submit */}
      <Button
        onClick={handleSubmit}
        disabled={submitting || !allRated}
        size="lg"
        className="w-full text-base py-6 sticky bottom-4 shadow-lg"
      >
        <Send className="h-4 w-4 mr-2" />
        {submitting ? "Submitting..." : "Submit Ratings"}
      </Button>
    </div>
  );
}
