"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { completeOnboarding } from "@/app/actions/players";
import { POSITION_LABELS } from "@/lib/constants";

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

export default function OnboardingPage() {
  const { data: session } = useSession();
  const [name, setName] = useState(session?.user?.name ?? "");
  const [selectedPositions, setSelectedPositions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function togglePosition(pos: string) {
    setSelectedPositions((prev) =>
      prev.includes(pos) ? prev.filter((p) => p !== pos) : [...prev, pos]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("Please enter your name");
      return;
    }
    if (selectedPositions.length === 0) {
      setError("Select at least one position");
      return;
    }

    setLoading(true);
    try {
      await completeOnboarding({ name: name.trim(), positions: selectedPositions });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-6">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-2">
          <CardTitle className="text-2xl">Welcome to MatchDay!</CardTitle>
          <CardDescription className="text-base">Set up your player profile to get started</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-[15px]">Your Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                className="h-11 text-[15px]"
              />
            </div>

            <div className="space-y-3">
              <Label className="text-[15px]">Preferred Positions</Label>
              <p className="text-sm text-muted-foreground">Select all positions you can play</p>
              <div className="flex flex-wrap gap-3">
                {POSITIONS.map((pos) => (
                  <Badge
                    key={pos}
                    variant={selectedPositions.includes(pos) ? "default" : "outline"}
                    className="cursor-pointer text-sm px-4 py-2 hover:bg-primary/10 transition-colors"
                    onClick={() => togglePosition(pos)}
                  >
                    {POSITION_LABELS[pos]}
                  </Badge>
                ))}
              </div>
            </div>

            {error && <p className="text-sm text-destructive font-medium">{error}</p>}

            <Button type="submit" className="w-full text-base py-5" size="lg" disabled={loading}>
              {loading ? "Saving..." : "Complete Setup"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
