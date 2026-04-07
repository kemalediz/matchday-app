"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updatePlayerRole, seedPlayerRating } from "@/app/actions/players";
import { toast } from "sonner";

interface Player {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  positions: string[];
  seedRating: number | null;
  isActive: boolean;
  _count: { attendances: number };
}

export default function PlayersPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/org/settings")
      .then((r) => r.json())
      .then((data) => setOrgId(data.id));
    loadPlayers();
  }, []);

  async function loadPlayers() {
    const res = await fetch("/api/players");
    if (res.ok) setPlayers(await res.json());
    setLoading(false);
  }

  async function handleRoleChange(userId: string, role: string) {
    if (!orgId) return;
    try {
      await updatePlayerRole(userId, orgId, role as "ADMIN" | "PLAYER");
      toast.success("Role updated");
      loadPlayers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleSeedRating(userId: string, rating: string) {
    const num = parseFloat(rating);
    if (isNaN(num) || num < 1 || num > 10) return;
    if (!orgId) return;
    try {
      await seedPlayerRating(userId, orgId, num);
      toast.success("Rating updated");
      loadPlayers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (loading) return <p className="text-muted-foreground text-lg">Loading...</p>;

  return (
    <div className="space-y-8">
      <h2>Players ({players.length})</h2>

      <div className="space-y-3">
        {players.map((player) => (
          <Card key={player.id} className="shadow-sm">
            <CardContent className="py-4 flex items-center gap-4">
              <Avatar className="h-10 w-10">
                <AvatarImage src={player.image ?? undefined} />
                <AvatarFallback className="bg-primary/10 text-primary font-semibold">{player.name?.charAt(0) ?? "?"}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold truncate">{player.name ?? player.email}</p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-0.5">
                  {player.positions.map((pos) => (
                    <Badge key={pos} variant="outline" className="text-xs">{pos}</Badge>
                  ))}
                  <span>{player._count.attendances} matches</span>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <Input
                  type="number"
                  className="w-20 h-10"
                  placeholder="Seed"
                  defaultValue={player.seedRating ?? ""}
                  min={1}
                  max={10}
                  step={0.5}
                  onBlur={(e) => e.target.value && handleSeedRating(player.id, e.target.value)}
                />
                <Select value={player.role} onValueChange={(v) => v && handleRoleChange(player.id, v)}>
                  <SelectTrigger className="w-28 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PLAYER">Player</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
