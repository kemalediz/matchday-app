import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

/** Lists recent messages that classified as noise/unclear but look like
 *  they might deserve a second look given the new prompt rules. */
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const rows = await db.analyzedMessage.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 20 * 60 * 60 * 1000) },
      intent: { in: ["noise", "unclear"] },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`[${t}] ${r.waMessageId}`);
    console.log(`   intent=${r.intent} body: "${(r.body ?? "").slice(0, 150).replace(/\n/g, " ⏎ ")}"`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
