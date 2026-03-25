"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generateTeams, swapPlayers, publishTeams } from "@/app/actions/teams";
import { updateMatchScore } from "@/app/actions/matches";
import { toast } from "sonner";
import { RefreshCw, Send, Save } from "lucide-react";

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

  if (loading) return <p className="text-muted-foreground text-lg">Loading...</p>;
  if (!match) return <p className="text-muted-foreground text-lg">Match not found</p>;

  const redTeam = match.teamAssignments.filter((a) => a.team === "RED");
  const yellowTeam = match.teamAssignments.filter((a) => a.team === "YELLOW");
  const hasTeams = match.teamAssignments.length > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h2>Team Management</h2>
        <Badge className="text-sm px-3 py-1">{match.status.replace(/_/g, " ")}</Badge>
      </div>

      {!hasTeams && (
        <Card className="shadow-sm">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-5 text-lg">No teams generated yet.</p>
            <Button onClick={handleGenerate} size="lg">Generate Teams</Button>
          </CardContent>
        </Card>
      )}

      {hasTeams && (
        <>
          {selectedSwap.length === 2 && (
            <div className="flex items-center gap-3 p-4 bg-accent rounded-xl border border-primary/20">
              <p className="text-[15px] flex-1 font-medium">Swap these two players?</p>
              <Button onClick={handleSwap}>Confirm Swap</Button>
              <Button variant="ghost" onClick={() => setSelectedSwap([])}>Cancel</Button>
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <Card className="border-2 border-red-200 dark:border-red-900/50 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2.5 text-lg">
                  <span className="h-4 w-4 rounded-full bg-red-500" /> Red Team
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {redTeam.map((a) => (
                    <li
                      key={a.userId}
                      onClick={() => toggleSwap(a.userId)}
                      className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                        selectedSwap.includes(a.userId) ? "bg-primary/10 ring-2 ring-primary shadow-sm" : "hover:bg-accent"
                      }`}
                    >
                      <Avatar className="h-8 w-8">
                        <AvatarImage src={a.user.image ?? undefined} />
                        <AvatarFallback className="text-xs bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300 font-semibold">{a.user.name?.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <span className="text-[15px] font-medium">{a.user.name}</span>
                      {a.user.positions.length > 0 && (
                        <Badge variant="outline" className="text-xs ml-auto">{a.user.positions[0]}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card className="border-2 border-yellow-200 dark:border-yellow-900/50 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2.5 text-lg">
                  <span className="h-4 w-4 rounded-full bg-yellow-400" /> Yellow Team
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {yellowTeam.map((a) => (
                    <li
                      key={a.userId}
                      onClick={() => toggleSwap(a.userId)}
                      className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                        selectedSwap.includes(a.userId) ? "bg-primary/10 ring-2 ring-primary shadow-sm" : "hover:bg-accent"
                      }`}
                    >
                      <Avatar className="h-8 w-8">
                        <AvatarImage src={a.user.image ?? undefined} />
                        <AvatarFallback className="text-xs bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300 font-semibold">{a.user.name?.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <span className="text-[15px] font-medium">{a.user.name}</span>
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
            <Button onClick={handleGenerate} variant="outline" size="lg">
              <RefreshCw className="h-4 w-4 mr-2" />
              Regenerate
            </Button>
            {match.status === "TEAMS_GENERATED" && (
              <Button onClick={handlePublish} size="lg">
                <Send className="h-4 w-4 mr-2" />
                Publish Teams
              </Button>
            )}
          </div>
        </>
      )}

      {/* Score entry */}
      {(match.status === "TEAMS_PUBLISHED" || match.status === "COMPLETED") && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl">Match Score</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-5">
              <div className="flex items-center gap-3">
                <span className="h-4 w-4 rounded-full bg-red-500" />
                <Label className="text-[15px] font-medium">Red</Label>
                <Input
                  type="number"
                  className="w-20 h-11 text-center text-lg font-bold"
                  value={redScore}
                  onChange={(e) => setRedScore(e.target.value)}
                  min="0"
                />
              </div>
              <span className="text-xl text-muted-foreground font-bold">-</span>
              <div className="flex items-center gap-3">
                <span className="h-4 w-4 rounded-full bg-yellow-400" />
                <Label className="text-[15px] font-medium">Yellow</Label>
                <Input
                  type="number"
                  className="w-20 h-11 text-center text-lg font-bold"
                  value={yellowScore}
                  onChange={(e) => setYellowScore(e.target.value)}
                  min="0"
                />
              </div>
              <Button onClick={handleScore} size="lg">
                <Save className="h-4 w-4 mr-2" />
                Save Score
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
