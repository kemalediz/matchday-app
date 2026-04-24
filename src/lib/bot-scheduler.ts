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
import { findOrgAdminsWithPhone } from "./org";
import { formatLondon } from "./london-time";
import { composeChaseText, type ChaseKind } from "./message-analyzer";

// All user-facing times in bot-posted messages are Europe/London wall
// clock. Wrap date-fns-tz in a short helper so this file reads cleanly.
function format(d: Date, pattern: string): string {
  return formatLondon(d, pattern);
}

// ───────── Same-sport helpers for switch/cancel-format nudges ────────

/** Find the activity with the smallest playersPerTeam in the same sport
 *  family (e.g. "Football") and smaller than `currentPpt`. Used to offer
 *  a 7-a-side → 5-a-side switch when the squad is short. `isActive` is
 *  not a gate — admins call the venue (Goals etc.) to rebook and flip
 *  the match in the app whenever they want; this helper just surfaces
 *  what's configured for the org. */
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

// ────────────────────────────── Instructions ──────────────────────────────

export type DueInstruction =
  | {
      kind: "group-message";
      key: string;           // idempotency key
      text: string;
      matchId?: string;
      /** Optional — phone numbers (no +) to tag as real WhatsApp mentions. */
      mentions?: string[];
    }
  | {
      kind: "group-poll";
      key: string;
      question: string;
      options: string[];
      multi?: boolean;
      matchId?: string;
    }
  // Note: `group-message` + `dm` accept an optional `mentions` array of
  // phone numbers (without +). When present, the bot passes them as
  // whatsapp-web.js mentions so @-prefixed phone numbers in the text
  // become real tagged mentions (notification + clickable). The bot
  // released before this field exists just ignores the extra field
  // — the text renders as plain @-prefixed names.
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

/**
 * Copy for the daily 17:00 rating-reminder DM. Varies tone by day so five
 * nudges in a row don't all read the same. Each message:
 *   - Opens warmly (first name if we have it).
 *   - Names the match so they remember which one.
 *   - Reminds them why ratings matter (better-balanced teams next week).
 *   - Signs off with the personal magic link.
 * Never guilty or whiny — the goal is to make it feel like a teammate
 * tapping them on the shoulder, not a debt collector.
 */
function buildReminderText(args: {
  dayNum: number;
  playerName: string | null;
  activityName: string;
  mvpLabel: string;
  url: string;
}): string {
  const { dayNum, playerName, activityName, mvpLabel, url } = args;
  const first = playerName?.split(/\s+/)[0] ?? "mate";
  const sig = `\n${url}`;
  switch (dayNum) {
    case 1:
      return (
        `Hey ${first} 👋 — hope last night's *${activityName}* was a good one.\n\n` +
        `When you have a sec, tap here to rate your teammates and pick ${mvpLabel}. ` +
        `The more of us vote, the better the teams balance next week 🙌${sig}`
      );
    case 2:
      return (
        `${first}, friendly nudge 🙂 — still waiting on your ratings for *${activityName}*.\n\n` +
        `Literally 30 seconds, promise. Helps everyone get fairer teams next week ⚽${sig}`
      );
    case 3:
      return (
        `Halfway through the rating window, ${first} ⏳\n\n` +
        `Your vote for *${activityName}* actually moves ratings a lot when half the squad has voted ` +
        `and you haven't. Quick tap:${sig}`
      );
    case 4:
      return (
        `${first} — two days left to rate *${activityName}* and lock in ${mvpLabel} 🏆\n\n` +
        `30 seconds, then you're done:${sig}`
      );
    default: // day 5 — last chance
      return (
        `Last call ${first} 🔔 — the rating window for *${activityName}* closes tomorrow.\n\n` +
        `Drop a rating + ${mvpLabel} pick before it shuts. Your voice counts:${sig}`
      );
  }
}

/**
 * Compose a short "don't forget to pay" paragraph for the daily 17:00
 * chase. Returns null when there's nothing honest to report:
 *   - no recent completed match
 *   - everyone ticked the payment poll (nothing to nag about)
 *   - NOBODY has ticked yet — could mean nobody paid, but more likely
 *     means the poll fired before our paid-tracking was live, or the
 *     votes failed to ACK back to the server. In that case "N unpaid"
 *     is false precision. Wait for the first real payment event to
 *     arrive before chasing.
 */
async function buildUnpaidTail(
  activityId: string,
): Promise<{ text: string; mentions: string[] } | null> {
  const lastCompleted = await db.match.findFirst({
    where: { activityId, status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
    include: {
      activity: {
        select: {
          orgId: true,
          org: { select: { paymentHolderId: true } },
        },
      },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true, phoneNumber: true } } },
      },
    },
  });
  if (!lastCompleted) return null;

  // Exclude the payment holder — they're the one collecting fees from
  // others, including them in the unpaid chase would be embarrassing.
  // If the org hasn't set one (null), we don't exclude anyone and let
  // the admin configure it in /admin/settings or during onboarding.
  const payerId = lastCompleted.activity.org.paymentHolderId ?? null;

  const confirmed = payerId
    ? lastCompleted.attendances.filter((a) => a.userId !== payerId)
    : lastCompleted.attendances;
  const paid = confirmed.filter((a) => a.paidAt != null);
  const unpaid = confirmed.filter((a) => a.paidAt == null);
  // Don't chase when we have no signal — false precision is worse than silence.
  if (paid.length === 0) return null;
  if (unpaid.length === 0) return null;

  // Plain names in text; no @-tags. Until the Pi bot is redeployed with
  // mention support, @<phone> would surface as raw digits in the chat
  // which is worse UX than a readable name. We still return a mentions
  // array though — once the bot passes it through, we can add a richer
  // tagged variant here.
  const names = unpaid
    .map((a) => a.user.name)
    .filter(Boolean)
    .slice(0, 14)
    .join(", ");
  const more = unpaid.length > 14 ? ` (+${unpaid.length - 14} more)` : "";
  const mentions: string[] = unpaid
    .map((a) => a.user.phoneNumber?.replace(/^\+/, ""))
    .filter((p): p is string => !!p);
  const text =
    `💳 Also — *${unpaid.length}* still haven't paid for last week's match. ` +
    `Please *pay* asap 🙏\n\n${names}${more}`;
  return { text, mentions };
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
    `👋 Hi all — MatchTime bot is live for this group.`,
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
  // activity AND the bot is enabled. Explains what MatchTime is and how
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

  // ── Provisional-member review DM for admins ─────────────────────────
  // When the analyzer auto-creates Memberships for unknown group senders
  // (see api/whatsapp/analyze/route.ts createProvisionalByName), admins
  // need to review them — set phone, position, seed rating, or remove if
  // not a player. DM each admin once per day while there are unresolved
  // provisional members pending. Idempotency key includes the date and
  // the admin ID so tomorrow's DM fires fresh.
  {
    const provisional = await db.membership.findMany({
      where: { orgId: org.id, provisionallyAddedAt: { not: null }, leftAt: null },
      include: { user: { select: { name: true } } },
      orderBy: { provisionallyAddedAt: "desc" },
      take: 10,
    });
    if (provisional.length > 0) {
      const admins = await findOrgAdminsWithPhone(org.id);
      const todayKey = formatLondon(now, "yyyy-MM-dd");
      for (const admin of admins) {
        const key = `org-${org.id}:provisional-review:${admin.id}:${todayKey}`;
        if (sentKeys.has(key)) continue;
        const token = signMagicLinkToken({
          userId: admin.id,
          purpose: "sign-in",
          nextPath: "/admin/players",
          ttlSeconds: MAGIC_LINK_TTL.signIn,
        });
        const signInUrl = buildMagicLinkUrl(token);
        const names = provisional
          .map((p) => p.user.name)
          .filter(Boolean)
          .slice(0, 5)
          .join(", ");
        const more = provisional.length > 5 ? ` (+${provisional.length - 5} more)` : "";
        out.push({
          kind: "dm",
          key,
          targetUser: admin.id,
          phone: admin.phoneNumber.replace(/^\+/, ""),
          text:
            `✨ *New players to review* — ${provisional.length} ${provisional.length === 1 ? "person was" : "people were"} auto-added after posting in the group:\n\n` +
            `${names}${more}\n\n` +
            `Tap to review and set phone/position/rating, or remove:\n${signInUrl}\n\n` +
            `Or navigate manually: /admin/players`,
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
    await computeForMatch(m, now, sentKeys, out, groupId);
  }

  return { instructions: out, waGroupId: groupId, orgId: org.id };
}

type MatchWithIncludes = Awaited<ReturnType<typeof getMatchesForScheduler>>[number];

async function getMatchesForScheduler(orgId: string, windowStart: Date) {
  return db.match.findMany({
    where: {
      activity: { orgId },
      isHistorical: false,
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
  groupId: string,
) {
  /**
   * LLM compose with a static fallback. If Claude is unavailable
   * (missing API key, network hiccup, rate-limited, etc.) we fall
   * back to whatever static text the call site provided — so the
   * chase always fires with *something*, just less rich.
   */
  async function composeOrFallback(
    kind: ChaseKind,
    staticFallback: () => string,
  ): Promise<string> {
    try {
      const llm = await composeChaseText({ groupId, kind });
      if (llm && llm.trim().length > 0) return llm;
    } catch (err) {
      console.error(`[scheduler] compose ${kind} failed:`, err);
    }
    return staticFallback();
  }
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
  //     Two separate posts now, same 17:00 slot but independent gates:
  //       2a. Squad chase — only fires when need > 0. Appends the unpaid
  //           tail for continuity (one post, two pieces of info).
  //       2b. Standalone unpaid reminder — fires when the squad IS full,
  //           so players with outstanding fees still get chased. Without
  //           this the reminder was silently coupled to squad shortage.
  {
    const dayKey = londonDateKey(now);
    const isEvening = londonHour(now) >= 17 && londonHour(now) < 18;
    const beforeDeadline = now < m.attendanceDeadline;
    const chaseKey = `${matchId}:daily-in-list:${dayKey}`;
    const unpaidOnlyKey = `${matchId}:unpaid-reminder:${dayKey}`;
    const unpaidTail = isEvening ? await buildUnpaidTail(activity.id) : null;

    if (
      !sentKeys.has(chaseKey) &&
      isEvening &&
      beforeDeadline &&
      need > 0 &&
      m.status === "UPCOMING"
    ) {
      const text = await composeOrFallback("daily-in-list", () => {
        const list = confirmed
          .map((a, i) => `${i + 1}. ${a.user.name ?? "(unnamed)"}`)
          .join("\n");
        return (
          `🗓 *${activity.name}* — need *${need} more*.\n\n` +
          (confirmed.length > 0 ? list : "_nobody yet_")
        );
      });
      const combined = unpaidTail ? `${text}\n\n${unpaidTail.text}` : text;
      out.push({
        kind: "group-message",
        key: chaseKey,
        matchId,
        text: combined,
        mentions: unpaidTail?.mentions,
      });
    } else if (
      // Squad's full (or chase already ran) — still chase unpaid folks.
      !sentKeys.has(unpaidOnlyKey) &&
      isEvening &&
      unpaidTail
    ) {
      out.push({
        kind: "group-message",
        key: unpaidOnlyKey,
        matchId,
        text: unpaidTail.text,
        mentions: unpaidTail.mentions,
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

  // ── 4. Teams post ────────────────────────────────────────────────────
  //     The old match-day-morning teams post was removed on 2026-04-21.
  //     Teams are now generated + posted on demand when someone in the
  //     group asks ("@M Time generate teams"). The LLM classifies the
  //     request as `generate_teams_request` and the analyze route runs
  //     the balancer and posts the lineup. This removes the 8-11am time
  //     gate so admins can trigger whenever it's right for the day.

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

  // ── 4c. Replacement chase cadence ─────────────────────────────────────
  //       When the squad is short and kickoff is approaching, post a
  //       fresh chase message at two more points so the "step in?"
  //       ask doesn't go stale. Each chase has its own idempotency key.
  //       Chases run on UPCOMING matches only; once the squad is full
  //       again they naturally stop firing.
  {
    const short = confirmed.length < maxPlayers;
    const need = maxPlayers - confirmed.length;
    const inLive = m.status === "UPCOMING" || m.status === "TEAMS_GENERATED" || m.status === "TEAMS_PUBLISHED";

    // Chase A: morning of match day, 8-9am London.
    {
      const dayKey = londonDateKey(now);
      const matchDayKey = londonDateKey(m.date);
      const isMatchDay = dayKey === matchDayKey;
      const hour = londonHour(now);
      const inMorningWindow = hour >= 8 && hour < 9;
      const key = `${matchId}:chase-match-day-morning:${dayKey}`;
      if (
        !sentKeys.has(key) &&
        short &&
        inLive &&
        isMatchDay &&
        inMorningWindow
      ) {
        const text = await composeOrFallback(
          "match-day-morning",
          () =>
            `☀️ Morning all — still *${need} short* for tonight's *${activity.name}*. Any takers? 👀`,
        );
        out.push({ kind: "group-message", key, matchId, text });
      }
    }

    // Chase B: 3-4h before kickoff.
    {
      const key = `${matchId}:chase-pre-kickoff`;
      if (
        !sentKeys.has(key) &&
        short &&
        inLive &&
        hoursUntilMatch <= 4 &&
        hoursUntilMatch >= 3
      ) {
        const text = await composeOrFallback(
          "chase-pre-kickoff",
          () =>
            `⏳ Still *${need} short* for *${activity.name}* at ${format(m.date, "HH:mm")}. Anyone free tonight?`,
        );
        out.push({ kind: "group-message", key, matchId, text });
      }
    }
  }

  // ── 5. 2h before kickoff: squad-short last-chance plea ONLY ──────────
  //       When squad is FULL we used to post a "see you there" — removed
  //       on 2026-04-21 because it duplicated info everyone already knew
  //       and added noise. Now this block ONLY fires when we're still
  //       short 2h before kickoff, as a last call.
  {
    const key = `${matchId}:pre-kickoff`;
    const need = maxPlayers - confirmed.length;
    if (
      !sentKeys.has(key) &&
      need > 0 &&
      hoursUntilMatch <= 2 &&
      hoursUntilMatch > 0.5 &&
      (m.status === "TEAMS_PUBLISHED" || m.status === "TEAMS_GENERATED" || m.status === "UPCOMING")
    ) {
      const base = `⏰ Tonight *${format(m.date, "HH:mm")}* at *${activity.venue}* · ${confirmed.length}/${maxPlayers}`;
      const text = await composeOrFallback(
        "pre-kickoff-short",
        () => `${base} — *still need ${need}*, last chance to jump in. 🙏`,
      );
      out.push({ kind: "group-message", key, matchId, text });
    }
  }

  // ── 5a. Football gear reminder ────────────────────────────────────────
  //       Football-only. 2h before kickoff, post a one-off reminder to
  //       bring goalie gloves + a ball so nobody shows up empty-handed.
  //       Detection: we match on the sport name starting with "football"
  //       so this covers 5-a-side, 7-a-side, 11-a-side etc. — but not
  //       Basketball / other sports.
  {
    const key = `${matchId}:football-gear-reminder`;
    const isFootball = sport.name.trim().toLowerCase().startsWith("football");
    if (
      !sentKeys.has(key) &&
      isFootball &&
      hoursUntilMatch <= 2 &&
      hoursUntilMatch >= 1.5 &&
      (m.status === "UPCOMING" || m.status === "TEAMS_GENERATED" || m.status === "TEAMS_PUBLISHED")
    ) {
      out.push({
        kind: "group-message",
        key,
        matchId,
        text:
          `⚽ *${format(m.date, "HH:mm")} at ${activity.venue}* — see you there!\n\n` +
          `Quick reminder: if you've got them, please bring your *goalie gloves*, a *ball*, and *spare bibs*.`,
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
          `🏁 *${activity.name}* — hope it was a good one. What was the final score? ` +
          `I'll use it to update everyone's rating for next week.`,
      });
    }
  }

  // ── 6a. Payment poll — fires as soon as the match ENDS (kickoff +
  //        duration), regardless of whether the score is recorded yet.
  //        Players pay right after the final whistle on the pitch, so
  //        the poll needs to be waiting in the group by the time they
  //        check their phones — not hours later when the score trickles
  //        in. Gated by postMatchEndFlow so first-match-after-launch
  //        can opt out while things stabilise.
  if (m.postMatchEndFlow !== false) {
    const endedAt = new Date(m.date.getTime() + activity.matchDurationMins * 60 * 1000);
    const key = `${matchId}:payment-poll`;
    if (
      !sentKeys.has(key) &&
      now >= endedAt &&
      (m.status === "UPCOMING" ||
        m.status === "TEAMS_GENERATED" ||
        m.status === "TEAMS_PUBLISHED" ||
        m.status === "COMPLETED")
    ) {
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

  // ── 6b/c/d/e below are gated on COMPLETED because they concern the
  //    outcome of the match (rating DMs, MoM announcement). Payment
  //    above is gated on *ended*, which is earlier.
  if (m.status === "COMPLETED" && m.postMatchEndFlow !== false) {

    // 6b + 6c. Rating DMs + group promo — HOLD until 08:00–09:00 London
    //          the morning AFTER match day. Previously these fired the
    //          moment the match flipped to COMPLETED, which for a
    //          21:30 kickoff meant midnight DMs — players asleep, worst
    //          possible time to ask for a rating. Now we wait for a
    //          civilised hour the next morning. Idempotency keys unchanged
    //          so this is a one-time shift, not a retroactive resend.
    {
      const matchDayKey = londonDateKey(m.date);
      const todayKey = londonDateKey(now);
      const hourNow = londonHour(now);
      const isMorningAfter =
        todayKey !== matchDayKey &&
        hoursSinceMatch >= 6 &&
        hoursSinceMatch <= 36 &&
        hourNow >= 8 &&
        hourNow < 9;

      if (isMorningAfter) {
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

        const promoKey = `${matchId}:rate-promo`;
        if (!sentKeys.has(promoKey) && confirmed.some((a) => a.user.phoneNumber)) {
          out.push({
            kind: "group-message",
            key: promoKey,
            matchId,
            text:
              `🎯 Morning all — just DM'd every player from last night's *${activity.name}* ` +
              `a personal rating link. The more ratings we get, the better-balanced the ` +
              `teams get next week. Check your DMs from me 👇`,
          });
        }
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
          // Vary tone by day so repeats don't feel like spam.
          const dayNum = Math.min(5, Math.max(1, Math.ceil(hoursSinceMatch / 24)));
          const text = buildReminderText({
            dayNum,
            playerName: a.user.name,
            activityName: activity.name,
            mvpLabel: sport.mvpLabel,
            url: buildMagicLinkUrl(token),
          });
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: a.userId,
            phone: a.user.phoneNumber.replace(/^\+/, ""),
            text,
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
