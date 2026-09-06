/**
 * ⚠️ NO PRODUCTION CALLER SINCE §10 STEP 8 (2026-09-06). READ THIS FIRST.
 *
 * This module rewrote a reply the MODEL had already written, after the
 * server discovered the database disagreed with it. `analyze/route.ts`
 * was its only caller and the call went with `executeVerdict`.
 *
 * The failure it corrected is now unrepresentable rather than merely
 * corrected. `pipeline/compose.ts` renders every utterance from the
 * PROJECTED state AFTER the engine has decided, so a reply announcing a
 * bench move can only exist if a bench move was proposed. §6.4 states
 * the property: "because the composer runs after the write and reads its
 * outcome, it is IMPOSSIBLE to tell a player they are in when the write
 * threw."
 *
 * It is KEPT rather than deleted, deliberately and for one reason: the
 * house rule it encodes — the bot never announces something the database
 * disagrees with — is still the rule, and this file plus its tests are
 * the clearest statement of it anywhere in the repo. It is pure, it
 * costs nothing, and `lib/attendance-write-outcome.ts` (which IS live,
 * on both the engine path and the DM path) is its sibling.
 *
 * If you are about to call this from new code, stop and ask why your
 * composer is writing a sentence before it knows what happened.
 *
 * ─────────────────────────────────────────────────────────────────────
 *
 * The reply for a BENCH-shaped verdict that landed as a CONFIRMED write.
 *
 * A standing-offer conditional ("I'll be the 14th if you're short") is
 * classified as registerAttendance:"BENCH", and the LLM composes its
 * reply from that: "Thanks Erdal, putting you on the bench. If we drop
 * below 14 you're first up." That text is written BEFORE the server
 * knows the squad state. Since 2026-08-31 registerAttendance refuses to
 * create a bench row while slots are open (see lib/attendance.ts,
 * BenchIntent) and confirms the player instead, so that reply would tell
 * them the opposite of what happened.
 *
 * Same house rule as lib/attendance-write-outcome.ts: the bot never
 * announces something the database disagrees with.
 */

/** First whitespace-separated token, or null when we have no usable name. */
function firstName(name: string | null): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

export function buildBenchUpgradeReply(args: {
  /** Display name of the player we just confirmed. */
  name: string | null;
  /** CONFIRMED count AFTER the write. */
  confirmedCount: number;
  maxPlayers: number;
}): string {
  const { confirmedCount, maxPlayers } = args;
  const who = firstName(args.name);
  const thanks = who ? `Thanks ${who} 🙌` : "Thanks 🙌";
  const count = `${confirmedCount}/${maxPlayers}`;

  // Their confirm took the last slot: don't imply there's still room.
  if (confirmedCount >= maxPlayers) {
    return `${thanks} You're in the squad, and that's us full at ${count}.`;
  }
  return `${thanks} We've got space, so you're straight in the squad: ${count}.`;
}
