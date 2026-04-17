"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { attendMatch, dropFromMatch } from "@/app/actions/attendance";
import { toast } from "sonner";
import { Check, X, Clock } from "lucide-react";

interface AttendButtonProps {
  matchId: string;
  currentStatus: "CONFIRMED" | "BENCH" | "DROPPED" | null;
  isPastDeadline: boolean;
}

export function AttendButton({ matchId, currentStatus, isPastDeadline }: AttendButtonProps) {
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isAttending = currentStatus === "CONFIRMED" || currentStatus === "BENCH";

  async function handleAttend() {
    setLoading(true);
    try {
      await attendMatch(matchId);
      toast.success("You're in! See you at the match 🎉");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sign up");
    } finally {
      setLoading(false);
    }
  }

  async function handleDrop() {
    setLoading(true);
    setConfirmOpen(false);
    try {
      await dropFromMatch(matchId);
      toast.success("You've dropped out. We'll miss you!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to drop out");
    } finally {
      setLoading(false);
    }
  }

  if (isPastDeadline) {
    return (
      <Button disabled variant="outline" size="lg">
        <Clock className="h-4 w-4 mr-2" />
        Deadline passed
      </Button>
    );
  }

  if (isAttending) {
    return (
      <>
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={loading}
          variant="destructive"
          size="lg"
          className="active:scale-95 transition-transform"
        >
          <X className="h-4 w-4 mr-2" />
          {loading ? "Dropping..." : "Drop Out"}
        </Button>
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Drop out of this match?</DialogTitle>
              <DialogDescription>
                You&apos;ll be removed from the player list. If you were confirmed, the first player on the bench will take your spot.
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-3 justify-end mt-4">
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDrop} disabled={loading}>
                Yes, drop out
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <Button
      onClick={handleAttend}
      disabled={loading}
      size="lg"
      className="active:scale-95 transition-transform shadow-sm"
    >
      <Check className="h-4 w-4 mr-2" />
      {loading ? "Signing up..." : "I'm In!"}
    </Button>
  );
}
