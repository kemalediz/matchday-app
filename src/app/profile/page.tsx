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
import { Calendar, Star, Trophy, TrendingUp, Pencil } from "lucide-react";

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
      setProfile((prev) => prev ? { ...prev, name, positions: selectedPositions } : prev);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (!profile || !stats) return <p className="mx-auto max-w-4xl px-6 py-10 text-muted-foreground text-lg">Loading...</p>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 space-y-8">
      <Card className="shadow-sm">
        <CardContent className="py-8 flex items-start gap-6">
          <Avatar className="h-20 w-20 ring-4 ring-primary/10">
            <AvatarImage src={profile.image ?? undefined} />
            <AvatarFallback className="text-2xl bg-primary/10 text-primary font-bold">{profile.name?.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            {editing ? (
              <div className="space-y-4">
                <div>
                  <Label className="text-[15px]">Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="h-11 text-[15px] mt-1" />
                </div>
                <div>
                  <Label className="text-[15px]">Positions</Label>
                  <div className="flex gap-2 mt-2">
                    {POSITIONS.map((pos) => (
                      <Badge
                        key={pos}
                        variant={selectedPositions.includes(pos) ? "default" : "outline"}
                        className="cursor-pointer text-sm px-3 py-1.5 hover:bg-primary/10 transition-colors"
                        onClick={() => togglePosition(pos)}
                      >
                        {POSITION_LABELS[pos]}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex gap-3">
                  <Button onClick={handleSave}>Save Changes</Button>
                  <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-2xl sm:text-3xl">{profile.name}</h1>
                    <p className="text-muted-foreground mt-1">{profile.email}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                    Edit
                  </Button>
                </div>
                <div className="flex items-center gap-2 mt-3">
                  {profile.positions.map((pos) => (
                    <Badge key={pos} variant="secondary" className="text-sm px-3 py-1">{pos}</Badge>
                  ))}
                </div>
              </>
            )}
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
