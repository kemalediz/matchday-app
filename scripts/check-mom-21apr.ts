import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const match = await db.match.findFirst({
    where: {
      date: {
        gte: new Date("2026-04-21T00:00:00Z"),
        lt: new Date("2026-04-22T00:00:00Z"),
      },
    },
  });
  if (!match) {
    console.log("no match");
    await db.$disconnect();
    return;
  }
  console.log(`match ${match.id} ${match.date.toISOString()}`);

  const sent = await db.sentNotification.findMany({
    where: { matchId: match.id },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nSentNotification rows for this match (${sent.length}):`);
  for (const s of sent) {
    console.log(`  [${s.createdAt.toISOString()}] kind=${s.kind} key=${s.key} target=${s.targetUser ?? "-"} waMsg=${s.waMessageId ?? "-"}`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
