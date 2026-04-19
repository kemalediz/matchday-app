/**
 * Manual catch-up: Ersin and habib said IN in the Sutton WhatsApp group
 * between bot restarts (Ersin at 20:20, habib at 20:25) but the bot
 * didn't acknowledge them — Ersin was caught by a restart, habib has no
 * User row yet.
 *
 * What this does:
 *   1. Ensures a User row exists for habib (+44 7404 111243) as a
 *      placeholder the admin can rename later. Creates a Membership as
 *      PLAYER on the Sutton org.
 *   2. Registers Attendance (status = CONFIRMED or BENCH depending on
 *      capacity) for BOTH Ersin and habib against the next UPCOMING
 *      match.
 *   3. Clears the existing SentNotification for today's `daily-in-list`
 *      so the bot reposts the up-to-date list on its next tick.
 *   4. Queues a one-off BotJob group message announcing the corrected
 *      list right now — no need to wait for the 17:00 post.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ERSIN_PHONE = "+447827237536";
const HABIB_PHONE = "+447404111243";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findFirst({
    where: { slug: "sutton-fc" },
    select: { id: true, name: true },
  });
  if (!org) throw new Error("No Sutton org");

  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: { activity: true },
  });
  if (!nextMatch) throw new Error("No upcoming match");
  console.log(`Match: ${nextMatch.activity.name} ${nextMatch.id}\n`);

  // 1. Ensure User for habib.
  let habib = await db.user.findUnique({ where: { phoneNumber: HABIB_PHONE } });
  if (!habib) {
    habib = await db.user.create({
      data: {
        name: "Habib",
        email: `wa-${HABIB_PHONE.replace(/^\+/, "")}@placeholder.matchtime`,
        phoneNumber: HABIB_PHONE,
        onboarded: false,
        isActive: true,
      },
    });
    console.log(`Created User Habib ${habib.id}`);
  } else {
    console.log(`Habib already exists: ${habib.name ?? "(no name)"} ${habib.id}`);
  }

  // Ensure Membership for Sutton.
  const existingMembership = await db.membership.findUnique({
    where: { userId_orgId: { userId: habib.id, orgId: org.id } },
  });
  if (!existingMembership) {
    await db.membership.create({
      data: { userId: habib.id, orgId: org.id, role: "PLAYER" },
    });
    console.log("Created Membership for Habib");
  } else if (existingMembership.leftAt) {
    await db.membership.update({
      where: { id: existingMembership.id },
      data: { leftAt: null },
    });
    console.log("Reactivated Habib's Membership");
  }

  // Ersin already has User + Membership.
  const ersin = await db.user.findUnique({ where: { phoneNumber: ERSIN_PHONE } });
  if (!ersin) throw new Error("Ersin missing — expected him to exist");
  console.log(`Ersin: ${ersin.name} ${ersin.id}`);

  // 2. Register both as attendance.
  for (const user of [ersin, habib]) {
    const existingAtt = await db.attendance.findUnique({
      where: { matchId_userId: { matchId: nextMatch.id, userId: user.id } },
    });
    if (existingAtt && existingAtt.status !== "DROPPED") {
      console.log(`Attendance for ${user.name} already ${existingAtt.status}, skipping`);
      continue;
    }

    const confirmedCount = await db.attendance.count({
      where: { matchId: nextMatch.id, status: "CONFIRMED" },
    });
    const maxPos = await db.attendance.aggregate({
      where: { matchId: nextMatch.id },
      _max: { position: true },
    });
    const nextPosition = (maxPos._max.position ?? 0) + 1;
    const status = confirmedCount < nextMatch.maxPlayers ? "CONFIRMED" : "BENCH";

    await db.attendance.upsert({
      where: { matchId_userId: { matchId: nextMatch.id, userId: user.id } },
      create: { matchId: nextMatch.id, userId: user.id, status, position: nextPosition },
      update: { status, position: nextPosition, respondedAt: new Date() },
    });
    console.log(`  Registered ${user.name} → ${status} pos=${nextPosition}`);
  }

  // 3. Clear today's daily-in-list so the bot reposts later if still under.
  const londonDateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const deleted = await db.sentNotification.deleteMany({
    where: { key: `${nextMatch.id}:daily-in-list:${londonDateKey}` },
  });
  console.log(`\nCleared ${deleted.count} daily-in-list entries for ${londonDateKey}`);

  // 4. Queue a one-off updated list RIGHT NOW.
  const confirmed = await db.attendance.findMany({
    where: { matchId: nextMatch.id, status: "CONFIRMED" },
    include: { user: { select: { name: true } } },
    orderBy: { position: "asc" },
  });
  const bench = await db.attendance.findMany({
    where: { matchId: nextMatch.id, status: "BENCH" },
    include: { user: { select: { name: true } } },
    orderBy: { position: "asc" },
  });
  const need = Math.max(0, nextMatch.maxPlayers - confirmed.length);

  const confirmedList = confirmed
    .map((a, i) => `${i + 1}. ${a.user.name ?? "(unnamed)"}`)
    .join("\n");
  const benchList = bench
    .map((a, i) => `${i + 1}. ${a.user.name ?? "(unnamed)"}`)
    .join("\n");

  let text: string;
  if (need > 0) {
    text =
      `🗓 *${nextMatch.activity.name}* — need *${need} more*.\n\n` +
      (confirmed.length > 0 ? confirmedList : "_nobody yet_");
  } else {
    text =
      `🗓 *${nextMatch.activity.name}* — *full squad* (${confirmed.length}/${nextMatch.maxPlayers}) ✅\n\n` +
      `*Confirmed:*\n${confirmedList}` +
      (bench.length > 0 ? `\n\n*Bench:*\n${benchList}` : "");
  }

  await db.botJob.create({
    data: {
      orgId: org.id,
      kind: "group",
      text,
    },
  });
  console.log(`\nQueued group BotJob — bot will post on next 5-min tick.\n---\n${text}`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
