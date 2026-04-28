/**
 * One-off: register Enayem as a bench player for tonight's match.
 * He typed "Bench: Enayem" in the group at 17:19 BST — the LLM
 * classified that as `unclear` (legit; the format wasn't an IN
 * signal). Squad is locked at 14/14, so calling registerAttendance
 * will land him at bench position 2 (after Elnur). Teams unchanged.
 *
 * Bench-prompt order on a drop tonight: Elnur (1) → Enayem (2).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const enayem = await db.user.findFirst({
    where: { name: { contains: "Enayem", mode: "insensitive" } },
    select: { id: true, name: true, phoneNumber: true, email: true },
  });
  if (!enayem) {
    console.log("Enayem user not found. Aborting.");
    return;
  }
  console.log(`Found user: id=${enayem.id} name="${enayem.name}" phone=${enayem.phoneNumber}`);

  const m = await db.match.findFirst({
    where: { isHistorical: false, status: { not: "COMPLETED" } },
    orderBy: { date: "asc" },
    include: {
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        select: { userId: true, status: true, position: true },
      },
    },
  });
  if (!m) {
    console.log("No upcoming match. Aborting.");
    return;
  }

  const existing = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: m.id, userId: enayem.id } },
  });
  if (existing && (existing.status === "CONFIRMED" || existing.status === "BENCH")) {
    console.log(
      `Enayem already attending: status=${existing.status} position=${existing.position}. Nothing to do.`,
    );
    return;
  }

  const maxPos = Math.max(0, ...m.attendances.map((a) => a.position));
  const confirmedCount = m.attendances.filter((a) => a.status === "CONFIRMED").length;
  const targetStatus = confirmedCount < m.maxPlayers ? "CONFIRMED" : "BENCH";
  const benchCount = m.attendances.filter((a) => a.status === "BENCH").length;
  const slot = targetStatus === "CONFIRMED" ? confirmedCount + 1 : benchCount + 1;

  await db.attendance.upsert({
    where: { matchId_userId: { matchId: m.id, userId: enayem.id } },
    create: {
      matchId: m.id,
      userId: enayem.id,
      status: targetStatus,
      position: maxPos + 1,
      respondedAt: new Date(),
    },
    update: {
      status: targetStatus,
      position: maxPos + 1,
      respondedAt: new Date(),
    },
  });
  console.log(`Added Enayem as ${targetStatus}, slot ${slot} (DB position ${maxPos + 1}).`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
