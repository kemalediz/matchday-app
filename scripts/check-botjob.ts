import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const recent = await db.botJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  for (const j of recent) {
    const ageMin = Math.round((Date.now() - j.createdAt.getTime()) / 60000);
    const sentAgo = j.sentAt ? Math.round((Date.now() - j.sentAt.getTime()) / 60000) : null;
    console.log(
      `[${j.id}] kind=${j.kind} phone=${j.phone ?? "-"} created ${ageMin}m ago, sent ${sentAgo === null ? "NOT YET" : sentAgo + "m ago"}`,
    );
    if (!j.sentAt) console.log(`  text preview: ${j.text.slice(0, 80).replace(/\n/g, " ⏎ ")}`);
  }

  const sn = await db.sentNotification.findMany({
    where: { key: { startsWith: "botjob-" } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log(`\nRecent SentNotification for BotJobs:`);
  for (const s of sn) console.log(`  ${s.key} kind=${s.kind} at ${s.createdAt.toISOString()}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
