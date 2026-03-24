"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generateTeams, swapPlayers, publishTeams } from "@/app/actions/teams";
import { updateMatchScore } from "@/app/actions/matches";
import { toast } from "sonner";

interface Player {
  id: string;
  name: string | null;
  image: string | null;
  positions: string[];
}

interface TeamAssignment {
  userId: string;
  team: "RED" | "YELLOW";
  user: Player;
}

export default function TeamManagementPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const router = useRouter();
  const [match, setMatch] = useState<{
    status: string;
    teamAssignments: TeamAssignment[];
    redScore: number | null;
    yellowScore: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSwap, setSelectedSwap] = useState<string[]>([]);
  const [redScore, setRedScore] = useState("");
  const [yellowScore, setYellowScore] = useState("");

  useEffect(() => { loadMatch(); }, [matchId]);

  async function loadMatch() {
    const res = await fetch(`/api/matches/${matchId}`);
    if (res.ok) {
      const data = await res.json();
      setMatch(data);
      if (data.redScore !== null) setRedScore(String(data.redScore));
      if (data.yellowScore !== null) setYellowScore(String(data.yellowScore));
    }
    setLoading(false);
  }

  async function handleGenerate() {
    try {
      await generateTeams(matchId);
      toast.success("Teams generated!");
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleSwap() {
    if (selectedSwap.length !== 2) return;
    try {
      await swapPlayers(matchId, selectedSwap[0], selectedSwap[1]);
      toast.success("Players swapped!");
      setSelectedSwap([]);
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handlePublish() {
    try {
      await publishTeams(matchId);
      toast.success("Teams published!");
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleScore() {
    try {
      await updateMatchScore(matchId, {
        redScore: parseInt(redScore),
        yellowScore: parseInt(yellowScore),
      });
      toast.success("Score saved! Match marked as completed.");
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  function toggleSwap(playerId: string) {
    setSelectedSwap((prev) => {
      if (prev.includes(playerId)) return prev.filter((id) => id !== playerId);
      if (prev.length >= 2) return [playerId];
      return [...prev, playerId];
    });
  }

  if (loading) return <p className="text-muted-foreground">Loading...</p>;
  if (!match) return <p className="text-muted-foreground">Match not found</p>;

  const redTeam = match.teamAssignments.filter((a) => a.team === "RED");
  const yellowTeam = match.teamAssignments.filter((a) => a.team === "YELLOW");
  const hasTeams = match.teamAssignments.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Team Management</h2>
        <Badge>{match.status.replace("_", " ")}</Badge>
      </div>

      {!hasTeams && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground mb-4">No teams generated yet.</p>
            <Button onClick={handleGenerate}>Generate Teams</Button>
          </CardContent>
        </Card>
      )}

      {hasTeams && (
        <>
          {selectedSwap.length === 2 && (
            <div className="flex items-center gap-3 p-3 bg-accent rounded-lg">
              <p className="text-sm flex-1">Swap these two players?</p>
              <Button size="sm" onClick={handleSwap}>Confirm Swap</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedSwap([])}>Cancel</Button>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="border-red-200 dark:border-red-900">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-red-500" /> Red Team
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {redTeam.map((a) => (
                    <li
                      key={a.userId}
                      onClick={() => toggleSwap(a.userId)}
                      className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                        selectedSwap.includes(a.userId) ? "bg-primary/10 ring-1 ring-primary" : "hover:bg-accent"
                      }`}
                    >
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={a.user.image ?? undefined} />
                        <AvatarFallback className="text-xs">{a.user.name?.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm">{a.user.name}</span>
                      {a.user.positions.length > 0 && (
                        <Badge variant="outline" className="text-xs ml-auto">{a.user.positions[0]}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card className="border-yellow-200 dark:border-yellow-900">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-yellow-400" /> Yellow Team
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {yellowTeam.map((a) => (
                    <li
                      key={a.userId}
                      onClick={() => toggleSwap(a.userId)}
                      className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                        selectedSwap.includes(a.userId) ? "bg-primary/10 ring-1 ring-primary" : "hover:bg-accent"
                      }`}
                    >
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={a.user.image ?? undefined} />
                        <AvatarFallback className="text-xs">{a.user.name?.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm">{a.user.name}</span>
                      {a.user.positions.length > 0 && (
                        <Badge variant="outline" className="text-xs ml-auto">{a.user.positions[0]}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          <div className="flex gap-3">
            <Button onClick={handleGenerate} variant="outline">Regenerate</Button>
            {match.status === "TEAMS_GENERATED" && (
              <Button onClick={handlePublish}>Publish Teams</Button>
            )}
          </div>
        </>
      )}

      {/* Score entry - available when teams are published */}
      {(match.status === "TEAMS_PUBLISHED" || match.status === "COMPLETED") && (
        <Card>
          <CardHeader>
            <CardTitle>Match Score</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-red-500" />
                <Label>Red</Label>
                <Input
                  type="number"
                  className="w-16"
                  value={redScore}
                  onChange={(e) => setRedScore(e.target.value)}
                  min="0"
                />
              </div>
              <span className="text-muted-foreground">-</span>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-yellow-400" />
                <Label>Yellow</Label>
                <Input
                  type="number"
                  className="w-16"
                  value={yellowScore}
                  onChange={(e) => setYellowScore(e.target.value)}
                  min="0"
                />
              </div>
              <Button onClick={handleScore}>Save Score</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
