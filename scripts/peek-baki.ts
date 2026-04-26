import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const baki = await db.user.findFirst({
    where: { name: { contains: "Baki", mode: "insensitive" } },
    select: { id: true, name: true, phoneNumber: true, email: true },
  });
  console.log("Baki user:", baki);
  if (!baki) return;
  const memberships = await db.membership.findMany({
    where: { userId: baki.id },
    include: { org: { select: { name: true } } },
  });
  console.log("\nBaki memberships:");
  for (const m of memberships) {
    console.log(`  org=${m.org.name} role=${m.role} leftAt=${m.leftAt} provAt=${m.provisionallyAddedAt}`);
  }
  const recent = await db.analyzedMessage.findMany({
    where: { authorUserId: baki.id, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log("\nRecent analyzed messages from Baki:");
  for (const r of recent) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`  [${t}] intent=${r.intent} action=${r.action} body="${(r.body ?? "").slice(0, 80)}"`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
