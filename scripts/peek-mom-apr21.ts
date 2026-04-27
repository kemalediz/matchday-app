import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  // Find Apr 21 2026 match.
  const matches = await db.match.findMany({
    where: { isHistorical: false, status: "COMPLETED" },
    include: { activity: { select: { name: true } } },
    orderBy: { date: "desc" },
    take: 5,
  });
  for (const m of matches) {
    console.log(`Match ${m.id}  ${m.activity.name}  ${m.date.toISOString()}  ${m.redScore}-${m.yellowScore}`);
  }
  console.log("");

  const aprMatch = matches.find((m) => m.date.toISOString().startsWith("2026-04-21"));
  if (!aprMatch) {
    console.log("No Apr 21 match found");
    return;
  }

  console.log(`\n=== MoM votes for ${aprMatch.id} (${aprMatch.activity.name}, ${aprMatch.date.toISOString()}) ===\n`);

  const votes = await db.moMVote.findMany({
    where: { matchId: aprMatch.id },
    include: {
      voter: { select: { name: true, email: true } },
      player: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const v of votes) {
    console.log(`  voter: ${v.voter.name} (${v.voter.email}) → MoM: ${v.player.name} (${v.player.email})  at ${v.createdAt.toISOString()}`);
  }
  console.log(`\nTotal: ${votes.length} votes\n`);

  // Group by player
  const groupBy = await db.moMVote.groupBy({
    by: ["playerId"],
    where: { matchId: aprMatch.id },
    _count: { playerId: true },
    orderBy: { _count: { playerId: "desc" } },
  });
  console.log("Vote tally:");
  for (const g of groupBy) {
    const u = await db.user.findUnique({ where: { id: g.playerId }, select: { name: true } });
    console.log(`  ${u?.name}: ${g._count.playerId}`);
  }

  // SentNotification rows for this match
  console.log("\n=== SentNotifications for this match ===");
  const sn = await db.sentNotification.findMany({
    where: { matchId: aprMatch.id },
    orderBy: { createdAt: "asc" },
  });
  for (const s of sn) {
    console.log(`  ${s.kind.padEnd(28)} key=${s.key.padEnd(50)} waMsg=${s.waMessageId ?? "-"}`);
  }

  // Confirmed attendances
  console.log("\n=== Confirmed attendances ===");
  const att = await db.attendance.findMany({
    where: { matchId: aprMatch.id, status: "CONFIRMED" },
    include: { user: { select: { name: true, phoneNumber: true } } },
    orderBy: { position: "asc" },
  });
  for (const a of att) {
    console.log(`  pos=${a.position} ${a.user.name?.padEnd(25)} phone=${a.user.phoneNumber}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
