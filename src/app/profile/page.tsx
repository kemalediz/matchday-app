"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { updateProfile } from "@/app/actions/players";
import { POSITION_LABELS } from "@/lib/constants";
import { toast } from "sonner";

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

export default function ProfilePage() {
  const { data: session } = useSession();
  const [profile, setProfile] = useState<{
    name: string;
    email: string;
    image: string | null;
    positions: string[];
    role: string;
  } | null>(null);
  const [stats, setStats] = useState<{
    matchesPlayed: number;
    avgRating: number | null;
    momCount: number;
    attendanceRate: number;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [selectedPositions, setSelectedPositions] = useState<string[]>([]);

  useEffect(() => {
    if (!session?.user?.id) return;
    fetch(`/api/players/${session.user.id}`)
      .then((r) => r.json())
      .then((data) => {
        setProfile(data.player);
        setStats(data.stats);
        setName(data.player.name);
        setSelectedPositions(data.player.positions);
      });
  }, [session?.user?.id]);

  function togglePosition(pos: string) {
    setSelectedPositions((prev) =>
      prev.includes(pos) ? prev.filter((p) => p !== pos) : [...prev, pos]
    );
  }

  async function handleSave() {
    try {
      await updateProfile({ name, positions: selectedPositions });
      toast.success("Profile updated!");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (!profile || !stats) return <p className="mx-auto max-w-3xl px-4 py-8 text-muted-foreground">Loading...</p>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <Card>
        <CardContent className="py-6 flex items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarImage src={profile.image ?? undefined} />
            <AvatarFallback className="text-xl">{profile.name?.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            {editing ? (
              <div className="space-y-3">
                <div>
                  <Label>Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <Label>Positions</Label>
                  <div className="flex gap-2 mt-1">
                    {POSITIONS.map((pos) => (
                      <Badge
                        key={pos}
                        variant={selectedPositions.includes(pos) ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() => togglePosition(pos)}
                      >
                        {POSITION_LABELS[pos]}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSave}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <>
                <h2 className="text-xl font-bold">{profile.name}</h2>
                <p className="text-sm text-muted-foreground">{profile.email}</p>
                <div className="flex items-center gap-2 mt-1">
                  {profile.positions.map((pos) => (
                    <Badge key={pos} variant="secondary">{pos}</Badge>
                  ))}
                  {profile.role === "ADMIN" && <Badge variant="destructive">Admin</Badge>}
                </div>
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setEditing(true)}>
                  Edit Profile
                </Button>
              </>
            )}
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
