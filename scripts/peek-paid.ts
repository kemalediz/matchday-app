import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  console.log("=== Last completed match attendance + paidAt ===");
  const m = await db.match.findFirst({
    where: { status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
    include: {
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { name: true, phoneNumber: true } } },
        orderBy: { position: "asc" },
      },
      activity: true,
    },
  });
  if (!m) { console.log("no completed match"); return; }
  console.log(`${m.activity.name} ${m.date.toLocaleString("en-GB", { timeZone: "Europe/London" })} id=${m.id}`);
  for (const a of m.attendances) {
    console.log(`  pos=${a.position} ${a.user.name}  phone=${a.user.phoneNumber ?? "null"}  paidAt=${a.paidAt ?? "null"}`);
  }

  console.log("\n=== SentNotifications with :payment-poll key for this match ===");
  const sent = await db.sentNotification.findMany({
    where: { matchId: m.id },
  });
  for (const s of sent) {
    console.log(`  kind=${s.kind} key=${s.key} waMessageId=${s.waMessageId ?? "null"}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
