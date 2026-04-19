/**
 * One-off: figure out why Ersin (+44 7827 237536) and habib
 * (+44 7404 111243) said IN in the Sutton WhatsApp group but the bot
 * never acknowledged them.
 *
 * Prints:
 *  - whether a User row exists for each phone
 *  - whether a Membership exists for (user, Sutton org) and its leftAt
 *  - whether an Attendance exists for the next UPCOMING match
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const PHONES = ["+447827237536", "+447404111243"];

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findFirst({
    where: { slug: "sutton-fc" },
    select: { id: true, name: true },
  });
  if (!org) {
    console.log("No Sutton org found");
    process.exit(1);
  }
  console.log(`Org: ${org.name} (${org.id})\n`);

  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: { activity: true, attendances: { include: { user: { select: { name: true, phoneNumber: true } } } } },
  });
  if (!nextMatch) {
    console.log("No upcoming match");
    process.exit(1);
  }
  console.log(`Next match: ${nextMatch.activity.name} on ${nextMatch.date.toISOString()} (${nextMatch.id})`);
  console.log(`Current attendance: ${nextMatch.attendances.length}`);
  for (const a of nextMatch.attendances) {
    console.log(`  ${a.status} pos=${a.position} ${a.user.name ?? "(unnamed)"} ${a.user.phoneNumber ?? ""}`);
  }
  console.log();

  for (const phone of PHONES) {
    console.log(`=== ${phone} ===`);
    const user = await db.user.findUnique({ where: { phoneNumber: phone } });
    if (!user) {
      console.log("  ❌ no User row");
      continue;
    }
    console.log(`  ✅ User: ${user.name ?? "(no name)"} ${user.email} id=${user.id}`);

    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
    });
    if (!membership) {
      console.log("  ❌ no Membership for Sutton");
    } else {
      console.log(
        `  ${membership.leftAt ? "⚠️" : "✅"} Membership role=${membership.role} leftAt=${membership.leftAt ?? "null"}`,
      );
    }

    const att = await db.attendance.findUnique({
      where: { matchId_userId: { matchId: nextMatch.id, userId: user.id } },
    });
    if (!att) {
      console.log("  ❌ no Attendance for next match");
    } else {
      console.log(`  ✅ Attendance: ${att.status} pos=${att.position}`);
    }
    console.log();
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
