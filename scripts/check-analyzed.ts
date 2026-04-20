/**
 * Peek at what the smart-analysis pipeline has processed so far. Useful
 * to sanity-check Phase 3 is actually running in prod.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const count = await db.analyzedMessage.count();
  console.log(`Total analysed messages: ${count}\n`);

  const byHandler = await db.analyzedMessage.groupBy({
    by: ["handledBy"],
    _count: { _all: true },
  });
  console.log("by handledBy:");
  for (const row of byHandler) {
    console.log(`  ${row.handledBy}: ${row._count._all}`);
  }

  console.log("\nLast 15 rows:");
  const recent = await db.analyzedMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  for (const r of recent) {
    const preview = (r.body ?? "").slice(0, 60).replace(/\n/g, " ");
    console.log(
      `  [${r.createdAt.toISOString().slice(11, 19)}] ${r.handledBy.padEnd(10)} ` +
        `intent=${(r.intent ?? "-").padEnd(20)} ` +
        `conf=${r.confidence ?? "-"}  "${preview}"`,
    );
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
