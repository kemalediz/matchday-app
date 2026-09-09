/**
 * APP SELF-IN GROUP-MEMBERSHIP GATE.
 *
 * Closes a loophole: a signed-in web user (matchtime.ai) could mark
 * THEMSELVES "in" on a match even if they were NOT part of the org's
 * WhatsApp group. Attendance is a group activity — self-IN from the app
 * must be reserved for real group members.
 *
 * This gate applies ONLY to the app's self-IN action (the `attendMatch`
 * server action → the "I'm in!" button). It does NOT touch:
 *   - the WhatsApp bot path (analyze route → registerAttendance),
 *   - guest-adds a member types from inside the WhatsApp group,
 *   - admin add-player from the dashboard,
 * all of which legitimately register people who may not (yet) be group
 * members and stay ungated.
 *
 * "LLM extracts, code decides" sibling: pure, DB-free logic. The caller
 * (attendMatch) fetches the Membership row for the match's org, the org's
 * sync freshness, and (only when needed) the fallback evidence, and feeds
 * the relevant fields in.
 *
 * ── WHY THERE IS A DEGRADED MODE (2026-08-31) ────────────────────────────
 *
 * The bot's startup participant sweep (`whatsapp-bot/src/index.ts` →
 * `/api/whatsapp/sync-participants` → `importParticipants`) has been
 * failing since 2026-07-07, because whatsapp-web.js's injected page code
 * is out of step with the live WhatsApp Web build (see
 * MDs/cold-audit-2026-08-31.md). The chat resolves, `chat.participants`
 * comes back empty, and nothing throws.
 *
 * While it is down nobody's sighting is refreshed, and a null sighting
 * stops meaning "you are not in the group" and starts meaning "I have not
 * been able to look". Nine real Sutton players, including regulars and
 * someone who joined the group yesterday, were being told to their face
 * that they were not in a group they were sitting in. The set grew every
 * week.
 *
 * The gate is not wrong. Treating a STALE signal as proof of absence is
 * wrong. So:
 *   - while the sweep is FRESH, nothing changes at all,
 *   - while it is STALE, a null sighting alone no longer denies; we look
 *     for positive evidence that this person really is in this club's
 *     group, and if we cannot find any we still deny, but we say something
 *     TRUE instead of an accusation.
 *
 * ── WHAT `lastSeenInGroupAt` MEANS NOW, AND WHY IT MOVED (2026-09-09) ────
 *
 * The paragraph above used to open "`Membership.lastSeenInGroupAt` has
 * exactly ONE writer". It has two.
 *
 *   1. the participant sweep, when it works;
 *   2. **an inbound group message from a resolved sender** — every
 *      message in the org's monitored group is first-hand proof that its
 *      author was in that group at that moment, and the analyze route
 *      already resolves the author of every one. That signal needs
 *      nothing from the broken injected layer, so it keeps working
 *      through exactly the outage that kills the sweep. See
 *      `src/lib/group-sighting.ts`.
 *
 * So the column now reads: **"the last time we had positive evidence,
 * from any source, that THIS PERSON was in the org's WhatsApp group."**
 * It is a monotone record of confirmed presence and NEVER evidence of
 * absence — which is not actually a change of character, only of
 * wording: no writer has ever set it back to null, so a non-null value
 * has always meant "has been confirmed at some point", and departure has
 * always been `leftAt`'s job. Adding a second source of the same kind of
 * proof therefore does not weaken what the gate concludes from it. It
 * changes only how many real players have one.
 *
 * ── THE TRAP, AND WHY THE FRESHNESS SIGNAL HAD TO BE SPLIT OFF ───────────
 *
 * `GroupSyncStatus.lastSyncAt` used to be computed as
 * `MAX(Membership.lastSeenInGroupAt)` across the org. That was exactly
 * right while the sweep was the only writer: the newest sighting anywhere
 * was, necessarily, the moment the last sweep ran.
 *
 * With messages as a second writer it stops being that, in the most
 * dangerous way available. ONE chatty player says "haha", his own
 * sighting is refreshed, the org's MAX goes fresh, and
 * `isGroupSyncStale` reports a HEALTHY sweep. It is not healthy; nothing
 * has read the roster since 07/07. Three things would then switch
 * themselves off silently and simultaneously:
 *
 *   - this degraded mode, so `degraded-plays-for-club` stops rescuing the
 *     never-swept, never-posting member whom a team-mate put in a squad —
 *     precisely the people it was built for, and precisely the people a
 *     message-based signal can never reach on its own;
 *   - the admin dashboard's banner (`groupSyncAdminWarning`), so the one
 *     person who could escalate stops being told;
 *   - the `sweep-stale` health alert in `lib/bot-health.ts`.
 *
 * The 2026-07-07 outage already ran EIGHT WEEKS before anyone noticed. A
 * change that makes the same outage invisible would be a worse bug than
 * the one it fixes.
 *
 * Hence two facts, two columns:
 *
 *   `Membership.lastSeenInGroupAt`        did we ever see THIS PERSON in
 *                                         the group. Sweep or their own
 *                                         message; both are proof.
 *   `Organisation.lastParticipantSweepAt` when a full roster READ last
 *                                         succeeded. Sweep only.
 *
 * ONLY the second can license the inference "we have never seen them,
 * therefore they are not in the group", because only a mechanism that
 * looks at EVERYONE can make an argument about who is missing. The first
 * can only ever add or refresh evidence about one person. Feed
 * `GroupSyncStatus.lastSyncAt` from the second and nothing else.
 */

/**
 * How old the most recent successful participant sweep may be before we
 * stop trusting `lastSeenInGroupAt` as evidence of ABSENCE.
 *
 * Ten days. The sweep runs on every bot `ready` event, so on every deploy,
 * reboot and WhatsApp Web reconnect — in practice several times a week.
 *
 *   - 7 days is too tight: a genuinely healthy bot that stays connected
 *     through a quiet week with no deploy would be declared broken.
 *   - 14 days is too loose: a fortnight of silent breakage is a fortnight
 *     of blocking every new joiner, and the 2026-07-07 outage ran for
 *     eight weeks before anyone noticed.
 *   - 10 days clears any plausible healthy quiet run (it is longer than a
 *     fortnightly deploy rhythm) while catching a real outage inside its
 *     second week, before the blocked set grows past a name or two.
 *
 * The two errors are not symmetric, which is why we lean towards calling
 * it stale: a false "stale" only opens a narrow, evidence-gated fallback,
 * whereas a false "fresh" tells real players a falsehood and locks them
 * out of the button.
 *
 * UNCHANGED by the 2026-09-09 split, and worth saying why: this number is
 * calibrated against how often the SWEEP runs, and the sweep still runs on
 * `ready` and nowhere else. Now that the clock it is measured against is
 * `Organisation.lastParticipantSweepAt` rather than the members'
 * sightings, chatter can no longer move it, so the calibration is if
 * anything more honest than it was.
 */
export const GROUP_SYNC_FRESHNESS_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GateMembership {
  /** Non-null once the user has left / been removed from the org's
   *  WhatsApp group. Strongest deny signal — someone who left the group
   *  cannot self-IN, regardless of role, and it is written by the
   *  `group_leave` event and by admins, so it is NOT affected by the
   *  participant sweep being down. */
  leftAt: Date | null;
  /** Last time we had positive evidence that this user was in the org's
   *  WhatsApp group — from the participant sweep, or from a message they
   *  posted in that group (2026-09-09). Monotone: no writer ever clears
   *  it. Null = never confirmed, which is only evidence of ABSENCE while
   *  the sweep is fresh; departure is `leftAt`'s job, never this. */
  lastSeenInGroupAt: Date | null;
  role: "OWNER" | "ADMIN" | "PLAYER";
}

/** Health of the org's participant sweep, derived from existing data. */
export interface GroupSyncStatus {
  /** `Organisation.lastParticipantSweepAt` — when a full READ of the
   *  group's participant list last succeeded. Null when no sweep has ever
   *  succeeded for this org.
   *
   *  MUST come from that column and nowhere else. It was
   *  MAX(`Membership.lastSeenInGroupAt`) until 2026-09-09; now that a
   *  group message refreshes the sender's sighting, that MAX measures
   *  CHATTER, and feeding it in here would report a dead sweep as
   *  healthy and silently disable everything below. See the header. */
  lastSyncAt: Date | null;
  now: Date;
}

/**
 * Positive evidence that this person really is in this club's WhatsApp
 * group. Only consulted while the sweep is stale — never on the healthy
 * path, so the original protection is untouched when the signal is good.
 *
 * Both signals are chosen because they can only have been produced by
 * somebody who was in the group:
 *
 *   - `authoredGroupMessages`: `AnalyzedMessage` rows for this org whose
 *     `authorUserId` is this user. The bot only ever analyses messages
 *     from the org's monitored group, and only a participant can post
 *     there. This is direct proof of presence.
 *
 *     STILL LOAD-BEARING after 2026-09-09, despite a message now
 *     refreshing `lastSeenInGroupAt` directly (which would short-circuit
 *     to `seen-in-group` long before this is consulted). It covers the
 *     BACKLOG: every `AnalyzedMessage` row written before that change
 *     produced no sighting, so for members who have posted in the past
 *     but not since, this count is the only trace left. Removing it
 *     would re-block people the moment they went quiet for a week.
 *
 *   - `clubAttendances`: `Attendance` rows on this org's matches. Every
 *     one of those was written by the bot reading an IN in the group, by
 *     an admin on the dashboard, or by a member's guest-add from inside
 *     the group. The app's own self-IN cannot be their origin, because
 *     that is the very path this gate stands in front of. So an
 *     attendance row means a member of the group put this person in a
 *     squad for this club.
 *
 * Deliberately NOT used: `provisionallyAddedAt`. It is set both when an
 * unknown sender posts in the group (good evidence) and when a name is
 * merely mentioned in a squad list (weak), and it is cleared the moment
 * an admin edits the player, so its absence means nothing either way.
 */
export interface GroupPresenceEvidence {
  /** AnalyzedMessage rows in the org's group authored by this user. */
  authoredGroupMessages: number;
  /** Attendance rows on this org's matches for this user. */
  clubAttendances: number;
}

export interface SelfMarkInContext {
  sync: GroupSyncStatus;
  evidence: GroupPresenceEvidence;
}

export type SelfMarkInReason =
  /** No Membership row for this org at all. */
  | "no-membership"
  /** Membership exists but `leftAt` is set. Always denies. */
  | "left-group"
  /** OWNER/ADMIN exemption: they manage the roster. */
  | "admin"
  /** The sweep confirmed them in the group. */
  | "seen-in-group"
  /** Sweep is stale; they have posted in the club's WhatsApp group. */
  | "degraded-posted-in-group"
  /** Sweep is stale; they have already been in a squad for this club. */
  | "degraded-plays-for-club"
  /** Sweep is fresh and it has never seen them. They are not in the group. */
  | "not-in-group"
  /** Sweep is stale and we found no evidence either way. */
  | "degraded-no-evidence";

export interface SelfMarkInDecision {
  allowed: boolean;
  reason: SelfMarkInReason;
  /** True when the participant sweep was stale AND that staleness is what
   *  the decision turned on. Callers log this so "the gate is running
   *  degraded" is never invisible. */
  degraded: boolean;
}

/** Whole days since the last successful sweep, or null while it is fresh.
 *  `Infinity` when no sweep has ever succeeded for this org. */
export function groupSyncStaleDays(sync: GroupSyncStatus): number | null {
  if (sync.lastSyncAt === null) return Infinity;
  const days = (sync.now.getTime() - sync.lastSyncAt.getTime()) / DAY_MS;
  return days > GROUP_SYNC_FRESHNESS_DAYS ? Math.floor(days) : null;
}

/**
 * Has the org's participant sweep gone quiet for longer than we are
 * willing to trust it?
 *
 * A never-synced org counts as stale, not as healthy: "no sweep has ever
 * succeeded here" carries even less information than "the last one was a
 * while ago", and reading it as healthy would deny every player in a
 * freshly onboarded club.
 */
export function isGroupSyncStale(sync: GroupSyncStatus): boolean {
  return groupSyncStaleDays(sync) !== null;
}

/** Context used when a caller supplies none: assume the sweep is healthy
 *  and there is no evidence, i.e. the strict pre-2026-08-31 behaviour.
 *  Callers that have not been taught about staleness must never fall into
 *  the relaxed path by accident. */
function strictContext(): SelfMarkInContext {
  const now = new Date();
  return {
    sync: { lastSyncAt: now, now },
    evidence: { authoredGroupMessages: 0, clubAttendances: 0 },
  };
}

/**
 * May this user mark THEMSELVES in from the app, and why?
 *
 * Order matters:
 *   1. No membership          → deny.
 *   2. `leftAt` set           → deny. Strongest signal, independent of the
 *                               sweep, and the admin exemption does NOT
 *                               override it.
 *   3. OWNER/ADMIN            → allow. They manage the roster.
 *   4. Seen in the group      → allow.
 *   5. Sweep fresh            → deny. The signal is good, so never seen
 *                               really does mean not in the group.
 *   6. Sweep stale + evidence → allow, flagged degraded.
 *   7. Sweep stale, no evidence → deny, flagged degraded, with an honest
 *                               message (see `selfMarkInDenialMessage`).
 */
export function decideSelfMarkIn(
  m: GateMembership | null,
  ctx: SelfMarkInContext = strictContext(),
): SelfMarkInDecision {
  if (!m) return { allowed: false, reason: "no-membership", degraded: false };

  // A member who left the WhatsApp group can never self-IN. `leftAt` is
  // written by the group_leave event and by admins, so it stays truthful
  // even while the participant sweep is down.
  if (m.leftAt !== null) return { allowed: false, reason: "left-group", degraded: false };

  // Admins/owners manage the roster; they don't need a group-sync sighting.
  if (m.role === "OWNER" || m.role === "ADMIN") {
    return { allowed: true, reason: "admin", degraded: false };
  }

  // A plain player confirmed by the sweep, whenever that sweep last ran.
  if (m.lastSeenInGroupAt !== null) {
    return { allowed: true, reason: "seen-in-group", degraded: false };
  }

  // Never seen. Whether that means anything depends entirely on whether
  // the sweep has been able to look.
  if (!isGroupSyncStale(ctx.sync)) {
    return { allowed: false, reason: "not-in-group", degraded: false };
  }

  if (ctx.evidence.authoredGroupMessages > 0) {
    return { allowed: true, reason: "degraded-posted-in-group", degraded: true };
  }
  if (ctx.evidence.clubAttendances > 0) {
    return { allowed: true, reason: "degraded-plays-for-club", degraded: true };
  }
  return { allowed: false, reason: "degraded-no-evidence", degraded: true };
}

/**
 * May this user mark THEMSELVES in from the app?
 *
 * Thin boolean wrapper over `decideSelfMarkIn` for call sites that do not
 * need the reason.
 */
export function canSelfMarkIn(m: GateMembership | null, ctx?: SelfMarkInContext): boolean {
  return decideSelfMarkIn(m, ctx).allowed;
}

/**
 * What we tell the player when the gate says no.
 *
 * The healthy-path wording is unchanged: when the sweep is working, "you
 * are not in the group" is a true statement and the fix really is to get
 * added.
 *
 * The degraded wording exists because the old line was a lie whenever the
 * sweep was down. It does not accuse the player of anything, it says why
 * we cannot confirm, and it points at replying IN in the group, which goes
 * through the bot's analyze path and works no matter what the participant
 * sweep is doing.
 */
export function selfMarkInDenialMessage(reason: SelfMarkInReason, clubName: string): string {
  if (reason === "degraded-no-evidence") {
    return (
      `We cannot confirm your place in the ${clubName} WhatsApp group right now, because ` +
      "MatchTime has not been able to read the group's member list for a while. Reply IN on " +
      "the group and we will put you straight down. Sorry for the extra step."
    );
  }
  return (
    `You need to be in the ${clubName} WhatsApp group to mark yourself in. ` +
    "Ask a member to add you in the group."
  );
}

/**
 * One line for the admin player list when the participant sweep has gone
 * quiet, so a degraded gate is visible to the person who can do something
 * about it. Null while the sweep is healthy.
 *
 * Paired with the `console.warn` the server action emits on every degraded
 * decision. Between them, "the gate is running degraded" is never silent.
 */
export function groupSyncAdminWarning(sync: GroupSyncStatus): string | null {
  const days = groupSyncStaleDays(sync);
  if (days === null) return null;
  const age =
    days === Infinity
      ? "MatchTime has never managed to read this group's member list"
      : `MatchTime last read this group's member list ${days} days ago`;
  return (
    `${age}, so it cannot tell who is currently in the WhatsApp group. Players who joined ` +
    "since then can only mark themselves in on the app if we already have them in a squad " +
    "or have seen them post in the group. Everyone else should reply IN in the group, which " +
    "always works. This is not something you can fix from here, and it is not fixed by " +
    "restarting: MatchTime is being blocked by a change on WhatsApp's side. It has been " +
    "reported and it does not affect anything else the bot does."
  );
}
