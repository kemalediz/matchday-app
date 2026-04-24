import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  console.log("=== Analyzed messages from last 18 hours ===");
  const rows = await db.analyzedMessage.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 18 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`[${t}] ${r.handledBy} intent=${r.intent} action=${r.action} conf=${r.confidence} userId=${r.authorUserId ?? "null"} phone=${r.authorPhone ?? "null"}`);
    console.log(`   body: "${(r.body ?? "").slice(0, 250).replace(/\n/g, " ⏎ ")}"`);
    if (r.reasoning) console.log(`   reasoning: ${r.reasoning.slice(0, 350)}`);
  }

  console.log("\n=== Amir in users ===");
  const amir = await db.user.findMany({
    where: { name: { contains: "Amir", mode: "insensitive" } },
    select: { id: true, name: true, phoneNumber: true },
  });
  console.log(amir);

  console.log("\n=== Faris / Shaz in users ===");
  const other = await db.user.findMany({
    where: { OR: [{ name: { contains: "Faris", mode: "insensitive" } }, { name: { contains: "Shaz", mode: "insensitive" } }] },
    select: { id: true, name: true, phoneNumber: true },
  });
  console.log(other);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
