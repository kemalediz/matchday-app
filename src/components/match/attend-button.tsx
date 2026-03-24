"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { attendMatch, dropFromMatch } from "@/app/actions/attendance";
import { toast } from "sonner";

interface AttendButtonProps {
  matchId: string;
  currentStatus: "CONFIRMED" | "BENCH" | "DROPPED" | null;
  isPastDeadline: boolean;
}

export function AttendButton({ matchId, currentStatus, isPastDeadline }: AttendButtonProps) {
  const [loading, setLoading] = useState(false);

  const isAttending = currentStatus === "CONFIRMED" || currentStatus === "BENCH";

  async function handleAttend() {
    setLoading(true);
    try {
      await attendMatch(matchId);
      toast.success("You're in!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sign up");
    } finally {
      setLoading(false);
    }
  }

  async function handleDrop() {
    setLoading(true);
    try {
      await dropFromMatch(matchId);
      toast.success("You've dropped out");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to drop out");
    } finally {
      setLoading(false);
    }
  }

  if (isPastDeadline) {
    return (
      <Button disabled variant="outline" size="lg">
        Deadline passed
      </Button>
    );
  }

  if (isAttending) {
    return (
      <Button onClick={handleDrop} disabled={loading} variant="destructive" size="lg">
        {loading ? "Dropping..." : "Drop Out"}
      </Button>
    );
  }

  return (
    <Button onClick={handleAttend} disabled={loading} size="lg">
      {loading ? "Signing up..." : "I'm In!"}
    </Button>
  );
}
