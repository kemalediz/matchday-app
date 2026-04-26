import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const mja = await db.user.findFirst({
    where: { name: { contains: "MJA", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!mja) { console.log("no MJA user"); return; }
  console.log(`MJA user: ${mja.id} (${mja.name})\n`);
  const msgs = await db.analyzedMessage.findMany({
    where: { authorUserId: mja.id },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  console.log(`Messages from MJA (most recent first, ${msgs.length} total):`);
  for (const m of msgs) {
    const t = m.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    const body = (m.body ?? "").slice(0, 250).replace(/\n/g, " ⏎ ");
    console.log(`\n[${t}] intent=${m.intent} action=${m.action ?? "-"} conf=${m.confidence ?? "-"}`);
    console.log(`  body: "${body}"`);
    if (m.reasoning) console.log(`  reasoning: ${m.reasoning.slice(0, 200)}`);
  }
  // Also check messages with the pushname carrier — even if not linked
  // to any User by id, the @lid identifier could surface in body or
  // reasoning of other people's messages.
  console.log(`\n\nMessages mentioning "MJA" or "swthree" anywhere:`);
  const mentioned = await db.analyzedMessage.findMany({
    where: { OR: [{ body: { contains: "MJA", mode: "insensitive" } }, { body: { contains: "swthree", mode: "insensitive" } }] },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const m of mentioned) {
    const t = m.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`  [${t}] author=${m.authorUserId ?? "null"} body="${(m.body ?? "").slice(0, 150).replace(/\n/g, " ⏎ ")}"`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
