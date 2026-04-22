import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const rows = await db.analyzedMessage.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
  });
  for (const r of rows) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(
      `[${t}]  handledBy=${r.handledBy}  intent=${r.intent ?? "-"}  action=${r.action ?? "-"}  conf=${r.confidence ?? "-"}  userId=${r.authorUserId ?? "null"}  phone=${r.authorPhone ?? "null"}`,
    );
    console.log(`   body: "${(r.body ?? "").slice(0, 120)}"`);
    console.log(`   reasoning: ${(r.reasoning ?? "").slice(0, 400)}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
