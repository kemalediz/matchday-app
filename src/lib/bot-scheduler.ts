/**
 * Server-side brain for the WhatsApp bot. Computes every message the bot
 * should post right now for a given org, with stable idempotency keys so
 * nothing fires twice.
 *
 * The Pi bot polls `/api/whatsapp/due-posts?groupId=X` every ~5 minutes,
 * receives a list of instructions, executes each one, then ACKs with
 * `/api/whatsapp/ack` so we record a `SentNotification` row against the key.
 *
 * Adding a new notification kind = add a new block to `computeDuePosts()`.
 * Bot code doesn't change.
 *
 * All times assumed to be in UK local (Europe/London) because that's where
 * Sutton FC plays. Hour comparisons use a tiny helper that converts a UTC
 * Date to London wall-clock hour — DST-safe.
 */
import { db } from "./db";
import { buildMagicLinkUrl, signMagicLinkToken, MAGIC_LINK_TTL } from "./magic-link";
import { format } from "date-fns";

// ───────── Same-sport helpers for switch/cancel-format nudges ────────

/** Find the activity with the smallest playersPerTeam in the same sport
 *  family (e.g. "Football") and smaller than `currentPpt`. Used to offer
 *  a 7-a-side → 5-a-side switch when the squad is short. */
async function findSmallerSameSportActivity(
  orgId: string,
  currentSportId: string,
  currentPpt: number,
) {
  const currentSport = await db.sport.findUnique({
    where: { id: currentSportId },
    select: { name: true },
  });
  if (!currentSport) return null;
  const family = currentSport.name.split(" ")[0];
  const acts = await db.activity.findMany({
    where: { orgId },
    include: { sport: true },
  });
  return (
    acts
      .filter((a) => a.sport.name.split(" ")[0] === family && a.sport.playersPerTeam < currentPpt)
      .sort((a, b) => a.sport.playersPerTeam - b.sport.playersPerTeam)[0] ?? null
  );
}

/** Smallest `playersPerTeam` for any activity in this org with the same
 *  sport family as the current activity. Used to decide the cancellation
 *  threshold — e.g. if Football 5-a-side exists, the min viable roster is
 *  10; if only 7-a-side exists, it's 14. */
async function findSmallestSameSportPpt(
  orgId: string,
  currentSportId: string,
  currentPpt: number,
): Promise<number> {
  const currentSport = await db.sport.findUnique({
    where: { id: currentSportId },
    select: { name: true },
  });
  if (!currentSport) return currentPpt;
  const family = currentSport.name.split(" ")[0];
  const acts = await db.activity.findMany({
    where: { orgId },
    include: { sport: { select: { name: true, playersPerTeam: true } } },
  });
  const matching = acts.filter((a) => a.sport.name.split(" ")[0] === family);
  if (matching.length === 0) return currentPpt;
  return Math.min(...matching.map((a) => a.sport.playersPerTeam));
}

/** All OWNER + ADMIN members with a phone number on record. Used for
 *  day-before DM nudges so every admin gets notified. */
async function findOrgAdminsWithPhone(orgId: string) {
  const memberships = await db.membership.findMany({
    where: { orgId, role: { in: ["OWNER", "ADMIN"] } },
    include: { user: { select: { id: true, name: true, phoneNumber: true } } },
    orderBy: { role: "asc" }, // OWNER sorts before PLAYER; ADMIN in between
  });
  return memberships
    .map((m) => m.user)
    .filter((u): u is { id: string; name: string | null; phoneNumber: string } => !!u.phoneNumber);
}

// ────────────────────────────── Instructions ──────────────────────────────

export type DueInstruction =
  | {
      kind: "group-message";
      key: string;           // idempotency key
      text: string;
      matchId?: string;
    }
  | {
      kind: "group-poll";
      key: string;
      question: string;
      options: string[];
      multi?: boolean;
      matchId?: string;
    }
  | {
      kind: "dm";
      key: string;
      phone: string;         // E.164, no + prefix when the bot uses it as JID
      text: string;
      matchId?: string;
      targetUser?: string;
    }
  | {
      kind: "bench-prompt";
      key: string;
      phone: string;
      text: string;          // the posted group message (@mentions the user)
      matchId: string;
      userId: string;
      // Bot must ACK with the waMessageId so the reaction-watcher can find it.
    };

export interface DuePostsResult {
  instructions: DueInstruction[];
  waGroupId: string;
  orgId: string;
}

// ────────────────────────────── Time helpers ──────────────────────────────

/** Hour-of-day 0-23 in Europe/London, DST-safe. */
function londonHour(at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: false,
  }).formatToParts(at);
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(h, 10);
}

/** Date-only key for "daily X" idempotency (YYYY-MM-DD in London). */
function londonDateKey(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

/** One-time introductory message posted on the org's first active activity. */
function botIntroMessage(): string {
  return [
    `👋 Hi all — MatchDay bot is live for this group.`,
    ``,
    `Here's what I do:`,
    ``,
    `🗓  *Attendance* — Say "IN" / "OUT" here (or on the app) and I log you in/out. I react with 👍 to confirm — no extra messages from me.`,
    ``,
    `🗒  *Daily reminders* — Every day at 5pm while the squad isn't full, I'll repost the IN list so we all see how many we need.`,
    ``,
    `🔁  *Bench promotion* — If someone drops, I tag the first bencher and ask them to 👍 confirm. 2h window; if no answer, I move to the next.`,
    ``,
    `⚽  *Teams* — On match day morning I post the auto-balanced teams. Objections? Reply \`swap X Y\` — admin will apply it.`,
    ``,
    `🏆  *Ratings & MoM* — After each match, I DM everyone a rating link (no sign-up, just tap). Vote MoM in-app or in the poll I post — same count either way. MoM announced 5 days after the match.`,
    ``,
    `💳  *Payments* — I auto-post "paid?" polls right after each match.`,
    ``,
    `Questions? Ask @Kemal. Let's go.`,
  ].join("\n");
}

// ─────────────────────────── Main entry point ─────────────────────────────

export async function computeDuePosts(groupId: string): Promise<DuePostsResult | null> {
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
  });
  if (!org) return null;

  const now = new Date();
  const out: DueInstruction[] = [];

  // Pull every already-sent notification we might care about: those linked
  // to this org's matches, plus any org-wide notifications (matchId=null)
  // keyed by orgId.
  const sent = await db.sentNotification.findMany({
    where: {
      OR: [
        { match: { activity: { orgId: org.id } } },
        { key: { startsWith: `org-${org.id}:` } },
      ],
    },
    select: { key: true },
  });
  const sentKeys = new Set(sent.map((s) => s.key));

  // ── Org-level: one-time bot introduction ─────────────────────────────
  // Fires once per org, the first time the org has at least one active
  // activity AND the bot is enabled. Explains what MatchDay is and how
  // the flow works so group members aren't confused by bot posts.
  {
    const introKey = `org-${org.id}:bot-intro`;
    if (!sentKeys.has(introKey)) {
      const hasActiveActivity = await db.activity.count({
        where: { orgId: org.id, isActive: true },
      });
      if (hasActiveActivity > 0) {
        out.push({
          kind: "group-message",
          key: introKey,
          text: botIntroMessage(),
        });
      }
    }
  }

  // ── Ad-hoc admin-queued BotJobs (test DMs, one-off messages) ────────
  // Any unsent row is emitted as a matching instruction; idempotency key
  // is `botjob-${id}` so ACK marks sentAt via the existing flow + our
  // separate BotJob update below (see /api/whatsapp/ack).
  {
    const jobs = await db.botJob.findMany({
      where: { orgId: org.id, sentAt: null },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    for (const job of jobs) {
      const key = `botjob-${job.id}`;
      if (sentKeys.has(key)) continue;
      if (job.kind === "dm" && job.phone) {
        out.push({
          kind: "dm",
          key,
          phone: job.phone,
          text: job.text,
        });
      } else if (job.kind === "group") {
        out.push({
          kind: "group-message",
          key,
          text: job.text,
        });
      }
    }
  }

  // Load all matches we care about: upcoming + anything still within 5 days
  // of completion (MoM announcement window).
  const windowStart = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const matches = await getMatchesForScheduler(org.id, windowStart);

  for (const m of matches) {
    await computeForMatch(m, now, sentKeys, out);
  }

  return { instructions: out, waGroupId: groupId, orgId: org.id };
}

type MatchWithIncludes = Awaited<ReturnType<typeof getMatchesForScheduler>>[number];

async function getMatchesForScheduler(orgId: string, windowStart: Date) {
  return db.match.findMany({
    where: {
      activity: { orgId },
      OR: [
        { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
        { status: "COMPLETED", date: { gte: windowStart } },
      ],
    },
    include: {
      activity: { include: { sport: true } },
      attendances: { include: { user: { select: { id: true, name: true, phoneNumber: true } } } },
      teamAssignments: { include: { user: { select: { id: true, name: true } } } },
      benchConfirmations: { where: { resolvedAt: null } },
    },
    orderBy: { date: "asc" },
  });
}

// ───────────────────────────── Per-match compute ──────────────────────────

async function computeForMatch(
  m: MatchWithIncludes,
  now: Date,
  sentKeys: Set<string>,
  out: DueInstruction[],
) {
  const matchId = m.id;
  const activity = m.activity;
  const sport = activity.sport;
  const hoursUntilMatch = hoursBetween(now, m.date);
  const hoursSinceMatch = -hoursUntilMatch;

  // Cancelled matches never trigger anything further. Short-circuit.
  if (m.status === "CANCELLED") return;

  const confirmed = m.attendances
    .filter((a) => a.status === "CONFIRMED")
    .sort((a, b) => a.position - b.position);
  const bench = m.attendances
    .filter((a) => a.status === "BENCH")
    .sort((a, b) => a.position - b.position);
  const maxPlayers = m.maxPlayers;
  const need = Math.max(0, maxPlayers - confirmed.length);

  // ── 1. Announce the match ─────────────────────────────────────────────
  //     Fire as soon as the match exists (we create it ~7 days ahead; the
  //     announcement should just go out promptly).
  {
    const key = `${matchId}:announce-match`;
    if (!sentKeys.has(key) && m.status === "UPCOMING" && hoursUntilMatch > 24) {
      const dateStr = format(m.date, "EEEE d MMMM 'at' HH:mm");
      out.push({
        kind: "group-message",
        key,
        matchId,
        text: `📅 *${activity.name}* — *${dateStr}* at ${activity.venue}.\n\nSay *IN* to join. First ${maxPlayers} confirmed play.`,
      });
    }
  }

  // ── 2. Daily 17:00 "need Y more" if not full ─────────────────────────
  {
    const dayKey = londonDateKey(now);
    const key = `${matchId}:daily-in-list:${dayKey}`;
    const isEvening = londonHour(now) >= 17 && londonHour(now) < 18;
    const beforeDeadline = now < m.attendanceDeadline;
    if (
      !sentKeys.has(key) &&
      isEvening &&
      beforeDeadline &&
      need > 0 &&
      m.status === "UPCOMING"
    ) {
      const list = confirmed
        .map((a, i) => `${i + 1}. ${a.user.name ?? "(unnamed)"}`)
        .join("\n");
      out.push({
        kind: "group-message",
        key,
        matchId,
        text:
          `🗓 *${activity.name}* — need *${need} more*.\n\n` +
          (confirmed.length > 0 ? list : "_nobody yet_"),
      });
    }
  }

  // ── 3. Bench prompt for any unresolved PendingBenchConfirmation ──────
  for (const bc of m.benchConfirmations) {
    const key = `${matchId}:bench-prompt:${bc.userId}`;
    if (sentKeys.has(key)) continue;
    if (now > bc.expiresAt) continue; // expired — the /due-posts endpoint will sweep it elsewhere

    const user = m.attendances.find((a) => a.userId === bc.userId)?.user;
    if (!user?.phoneNumber) continue;

    out.push({
      kind: "bench-prompt",
      key,
      matchId,
      userId: bc.userId,
      phone: user.phoneNumber.replace(/^\+/, ""),
      text:
        `🎟 @${user.name ?? ""} a slot just opened for *${activity.name}* tonight. ` +
        `React 👍 to confirm, 👎 to pass. You've got 2h.`,
    });
  }

  // ── 4. Morning-of-match teams post ────────────────────────────────────
  {
    const key = `${matchId}:teams-morning`;
    const matchDateKey = londonDateKey(m.date);
    const todayKey = londonDateKey(now);
    const isMatchDay = todayKey === matchDateKey;
    const morning = londonHour(now) >= 8 && londonHour(now) < 11;
    if (
      !sentKeys.has(key) &&
      isMatchDay &&
      morning &&
      (m.status === "TEAMS_GENERATED" || m.status === "TEAMS_PUBLISHED") &&
      m.teamAssignments.length > 0
    ) {
      const [redLabel, yellowLabel] = sport.teamLabels as [string, string];
      const red = m.teamAssignments.filter((t) => t.team === "RED");
      const yellow = m.teamAssignments.filter((t) => t.team === "YELLOW");
      const listFor = (arr: typeof red) =>
        arr.map((t, i) => `${i + 1}. ${t.user.name ?? "(unnamed)"}`).join("\n");
      out.push({
        kind: "group-message",
        key,
        matchId,
        text:
          `⚽ *Teams for tonight*\n\n` +
          `*${redLabel}*:\n${listFor(red)}\n\n` +
          `*${yellowLabel}*:\n${listFor(yellow)}\n\n` +
          `Objections? Reply \`swap X Y\` — admin will confirm.`,
      });
    }
  }

  // ── 4b. Day-before DM nudges to the org OWNER ────────────────────────
  //       Two triggers, both on the day before the match in London time:
  //         10:00 — switch-format nudge if squad is short
  //         18:00 — cancel nudge if numbers are below min-viable
  //       Both produce DMs (not group messages). Admin clicks the link
  //       and confirms on the portal. If admin misses both, the match
  //       still plays out with whatever numbers we have — these are
  //       nudges, not gates.
  {
    const hour = londonHour(now);
    const isDayBefore = hoursUntilMatch >= 12 && hoursUntilMatch <= 36;

    // 10:00 — switch-to-smaller-format nudge
    //         One DM per admin so each has their own magic link. Idempotency
    //         is keyed per-admin (":userId" suffix) — first admin to act
    //         resolves the situation; other admins can ignore their DM.
    if (
      isDayBefore &&
      hour >= 10 &&
      hour < 11 &&
      m.status === "UPCOMING" &&
      confirmed.length < maxPlayers
    ) {
      const candidate = await findSmallerSameSportActivity(
        activity.orgId,
        activity.sportId,
        sport.playersPerTeam,
      );
      if (candidate) {
        const admins = await findOrgAdminsWithPhone(activity.orgId);
        for (const admin of admins) {
          const key = `${matchId}:switch-nudge:${admin.id}`;
          if (sentKeys.has(key)) continue;
          const token = signMagicLinkToken({
            userId: admin.id,
            purpose: "sign-in",
            ttlSeconds: MAGIC_LINK_TTL.signIn,
          });
          const signInUrl = buildMagicLinkUrl(token);
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: admin.id,
            phone: admin.phoneNumber.replace(/^\+/, ""),
            text:
              `⚠️ *Low numbers* — ${confirmed.length}/${maxPlayers} confirmed for *${activity.name}* tomorrow.\n\n` +
              `Switch to *${candidate.sport.name}* (${candidate.sport.playersPerTeam * 2} players) before the deadline?\n\n` +
              `Tap to open the admin panel (auto signs you in):\n${signInUrl}\n\n` +
              `Or navigate manually: /admin/matches/${matchId}/switch-format`,
          });
        }
      }
    }

    // 18:00 — cancel nudge if even the smallest format can't fill.
    //         Again one DM per admin.
    if (
      isDayBefore &&
      hour >= 18 &&
      hour < 19 &&
      m.status === "UPCOMING"
    ) {
      const smallestPpt = await findSmallestSameSportPpt(
        activity.orgId,
        activity.sportId,
        sport.playersPerTeam,
      );
      const minViable = smallestPpt * 2;
      if (confirmed.length < minViable) {
        const admins = await findOrgAdminsWithPhone(activity.orgId);
        for (const admin of admins) {
          const key = `${matchId}:cancel-nudge:${admin.id}`;
          if (sentKeys.has(key)) continue;
          const token = signMagicLinkToken({
            userId: admin.id,
            purpose: "sign-in",
            ttlSeconds: MAGIC_LINK_TTL.signIn,
          });
          const signInUrl = buildMagicLinkUrl(token);
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: admin.id,
            phone: admin.phoneNumber.replace(/^\+/, ""),
            text:
              `🚨 *Match in trouble* — only *${confirmed.length}* confirmed for *${activity.name}* tomorrow, below the minimum to play (${minViable}).\n\n` +
              `Cancel and refund the booking?\n\n` +
              `Tap to open the cancel page:\n${signInUrl}\n\n` +
              `Or navigate manually: /admin/matches/${matchId}/cancel`,
          });
        }
      }
    }
  }

  // ── 5. 2h before kickoff ──────────────────────────────────────────────
  {
    const key = `${matchId}:pre-kickoff`;
    if (
      !sentKeys.has(key) &&
      hoursUntilMatch <= 2 &&
      hoursUntilMatch > 0.5 &&
      (m.status === "TEAMS_PUBLISHED" || m.status === "TEAMS_GENERATED" || m.status === "UPCOMING")
    ) {
      out.push({
        kind: "group-message",
        key,
        matchId,
        text: `⏰ Tonight *${format(m.date, "HH:mm")}* at *${activity.venue}* · ${confirmed.length} confirmed. See you there.`,
      });
    }
  }

  // ── 5b. Ask for the score 1h after the match ends ────────────────────
  //       Fires whether status is already COMPLETED (auto-completed by
  //       cron) or still TEAMS_PUBLISHED. We rely on Match.maxPlayers and
  //       activity.matchDurationMins to compute the "ended" timestamp.
  {
    const key = `${matchId}:ask-score`;
    const endedAt = new Date(m.date.getTime() + activity.matchDurationMins * 60 * 1000);
    const askAt = new Date(endedAt.getTime() + 60 * 60 * 1000); // +1h
    const alreadyScored = m.redScore !== null && m.yellowScore !== null;
    if (
      !sentKeys.has(key) &&
      !alreadyScored &&
      now >= askAt &&
      now.getTime() < askAt.getTime() + 24 * 60 * 60 * 1000 // only within 24h window
    ) {
      out.push({
        kind: "group-message",
        key,
        matchId,
        text:
          `🏁 *${activity.name}* — what was the final score?\n\n` +
          `Reply with just the numbers, e.g. *7-3* (${sport.teamLabels?.[0] ?? "Red"} – ${sport.teamLabels?.[1] ?? "Yellow"}).`,
      });
    }
  }

  // ── 6. Match-end: payment poll + magic-link DMs + promo message ──────
  //       Gated by postMatchEndFlow. For the first match after launch
  //       we set this false because the rating UI is still being built.
  if (m.status === "COMPLETED" && m.postMatchEndFlow !== false) {
    // 6a. Payment poll
    {
      const key = `${matchId}:payment-poll`;
      if (!sentKeys.has(key)) {
        const [redLabel, yellowLabel] = sport.teamLabels as [string, string];
        out.push({
          kind: "group-poll",
          key,
          matchId,
          question: `💳 Payments for *${activity.name}* — tick when you've paid`,
          options: [redLabel, yellowLabel],
        });
      }
    }

    // 6b. Magic-link DM per confirmed player (initial send)
    for (const a of confirmed) {
      if (!a.user.phoneNumber) continue;
      const key = `${matchId}:rate-dm:${a.userId}`;
      if (sentKeys.has(key)) continue;
      const token = signMagicLinkToken({
        userId: a.userId,
        purpose: "rate-match",
        matchId,
        ttlSeconds: MAGIC_LINK_TTL.rateMatch,
      });
      out.push({
        kind: "dm",
        key,
        matchId,
        targetUser: a.userId,
        phone: a.user.phoneNumber.replace(/^\+/, ""),
        text:
          `🏆 *${activity.name}* — ${format(m.date, "EEE d MMM")}\n\n` +
          `Rate your teammates and pick ${sport.mvpLabel}. Takes ~1 minute.\n\n` +
          `Your personal link:\n${buildMagicLinkUrl(token)}\n\n` +
          `Link expires in 5 days.`,
      });
    }

    // 6c. Single group promo message once the DMs have been queued
    {
      const key = `${matchId}:rate-promo`;
      if (!sentKeys.has(key) && confirmed.some((a) => a.user.phoneNumber)) {
        out.push({
          kind: "group-message",
          key,
          matchId,
          text:
            `🎯 I've DM'd every player from tonight with a personal rating link. ` +
            `The more ratings we get, the better-balanced the teams get next week. ` +
            `Check your DMs from me 👇`,
        });
      }
    }

    // 6d. Daily 18:00 rating reminder DM for any confirmed player who hasn't
    //     voted yet (stops when they vote or after the 5-day window).
    {
      const hourNow = londonHour(now);
      const isReminderHour = hourNow >= 18 && hourNow < 19;
      const withinWindow = hoursSinceMatch <= 5 * 24;
      if (isReminderHour && withinWindow) {
        // Figure out who has already rated (MoMVote OR at least 1 Rating).
        const ratersMom = await db.moMVote.findMany({
          where: { matchId },
          select: { voterId: true },
        });
        const ratersRating = await db.rating.findMany({
          where: { matchId },
          select: { raterId: true },
          distinct: ["raterId"],
        });
        const rated = new Set<string>([
          ...ratersMom.map((r) => r.voterId),
          ...ratersRating.map((r) => r.raterId),
        ]);
        const dayKey = londonDateKey(now);
        for (const a of confirmed) {
          if (!a.user.phoneNumber) continue;
          if (rated.has(a.userId)) continue;
          const key = `${matchId}:rate-reminder:${a.userId}:${dayKey}`;
          if (sentKeys.has(key)) continue;
          // Also skip unless we've already sent the initial DM.
          const initialKey = `${matchId}:rate-dm:${a.userId}`;
          if (!sentKeys.has(initialKey)) continue;
          const token = signMagicLinkToken({
            userId: a.userId,
            purpose: "rate-match",
            matchId,
            ttlSeconds: MAGIC_LINK_TTL.rateMatch,
          });
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: a.userId,
            phone: a.user.phoneNumber.replace(/^\+/, ""),
            text:
              `👋 Quick nudge — you haven't rated *${activity.name}* yet.\n\n` +
              `Takes under a minute:\n${buildMagicLinkUrl(token)}`,
          });
        }
      }
    }

    // 6e. MoM announcement 5 days after match at 15:00 (London)
    {
      const key = `${matchId}:mom-announcement`;
      const fiveDaysLater = new Date(m.date.getTime() + 5 * 24 * 60 * 60 * 1000);
      const afterAnnouncementTime =
        now >= fiveDaysLater && londonHour(now) >= 15 && londonHour(now) < 16;
      if (!sentKeys.has(key) && afterAnnouncementTime) {
        const votes = await db.moMVote.groupBy({
          by: ["playerId"],
          where: { matchId },
          _count: { playerId: true },
          orderBy: { _count: { playerId: "desc" } },
          take: 3,
        });
        if (votes.length > 0) {
          const winner = await db.user.findUnique({
            where: { id: votes[0].playerId },
            select: { name: true },
          });
          const totalVotes = votes.reduce((sum, v) => sum + v._count.playerId, 0);
          out.push({
            kind: "group-message",
            key,
            matchId,
            text:
              `🏆 *${sport.mvpLabel} — ${activity.name}*\n\n` +
              `Congrats *${winner?.name ?? "—"}* ` +
              `(${votes[0]._count.playerId}/${totalVotes} votes) 🎉\n\n` +
              `Your trophy & drink awaits next match.`,
          });
        }
        // If 0 votes, skip silently.
      }
    }
  }
}

// ─────────────────────── Bench-confirmation sweeper ───────────────────────

/**
 * Move forward any PendingBenchConfirmation whose window has expired. For
 * each expired unresolved row, mark the user as DROPPED and create a new
 * PendingBenchConfirmation for the next bench player. Call this right at
 * the top of /due-posts so the resulting new prompt gets posted in the
 * same poll cycle.
 */
export async function sweepExpiredBenchConfirmations(orgId: string): Promise<void> {
  const now = new Date();
  const expired = await db.pendingBenchConfirmation.findMany({
    where: {
      resolvedAt: null,
      expiresAt: { lte: now },
      match: { activity: { orgId } },
    },
    include: {
      match: {
        include: {
          attendances: { orderBy: { position: "asc" } },
        },
      },
    },
  });

  for (const bc of expired) {
    await db.$transaction(async (tx) => {
      await tx.pendingBenchConfirmation.update({
        where: { id: bc.id },
        data: { resolvedAt: now, outcome: "expired" },
      });
      // Treat the silent bencher as dropped.
      await tx.attendance.update({
        where: { matchId_userId: { matchId: bc.matchId, userId: bc.userId } },
        data: { status: "DROPPED" },
      });

      // Look for the next BENCH player.
      const nextBench = await tx.attendance.findFirst({
        where: { matchId: bc.matchId, status: "BENCH" },
        orderBy: { position: "asc" },
      });
      if (!nextBench) return;

      await tx.pendingBenchConfirmation.create({
        data: {
          matchId: bc.matchId,
          userId: nextBench.userId,
          expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        },
      });
    });
  }
}

/**
 * Create a PendingBenchConfirmation when someone drops AND the match is
 * already full (status UPCOMING with confirmed === maxPlayers). Call this
 * from the dropout flow (lib/attendance.ts).
 */
export async function requestBenchConfirmationOnDrop(
  matchId: string,
): Promise<void> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      attendances: { orderBy: { position: "asc" } },
    },
  });
  if (!match) return;

  const firstBench = match.attendances.find((a) => a.status === "BENCH");
  if (!firstBench) return; // nobody on the bench — nothing to do

  // Don't double up if one already exists
  const existing = await db.pendingBenchConfirmation.findFirst({
    where: { matchId, resolvedAt: null, userId: firstBench.userId },
  });
  if (existing) return;

  await db.pendingBenchConfirmation.create({
    data: {
      matchId,
      userId: firstBench.userId,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  });
}
