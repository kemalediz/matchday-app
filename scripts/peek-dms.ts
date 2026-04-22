import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  console.log("=== SentNotifications with 'provisional' in key ===");
  const sent = await db.sentNotification.findMany({
    where: { key: { contains: "provisional" } },
    orderBy: { createdAt: "desc" },
  });
  for (const s of sent) {
    console.log(`[${s.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" })}] ${s.key}`);
  }

  console.log("\n=== All provisional memberships (incl. left) ===");
  const provs = await db.membership.findMany({
    where: { provisionallyAddedAt: { not: null } },
    include: { user: { select: { name: true } } },
  });
  for (const p of provs) {
    console.log(`  ${p.user.name} provAt=${p.provisionallyAddedAt} leftAt=${p.leftAt}`);
  }

  console.log("\n=== Admins with phone ===");
  const admins = await db.membership.findMany({
    where: { role: { in: ["OWNER", "ADMIN"] }, leftAt: null, user: { phoneNumber: { not: null } } },
    include: { user: { select: { name: true, phoneNumber: true } } },
  });
  for (const a of admins) console.log(`  ${a.user.name} ${a.user.phoneNumber} role=${a.role}`);

  console.log("\n=== Recent BotJobs (DMs the bot was asked to send) ===");
  const jobs = await db.botJob.findMany({
    where: { kind: "dm", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  for (const j of jobs) {
    console.log(`[${j.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" })}] phone=${j.phone} sentAt=${j.sentAt ?? "null"}`);
    console.log(`   ${j.text.slice(0, 100)}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
