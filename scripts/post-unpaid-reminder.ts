import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
/** One-off: post the unpaid-reminder that got skipped today because the
 *  squad was full and the reminder was coupled to the squad chase. */
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const org = await db.organisation.findFirst({ where: { whatsappBotEnabled: true } });
  if (!org) throw new Error("no bot-enabled org");
  const match = await db.match.findFirst({
    where: { activity: { orgId: org.id }, status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
    include: {
      activity: { select: { orgId: true, org: { select: { paymentHolderId: true } } } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true, phoneNumber: true } } },
      },
    },
  });
  if (!match) throw new Error("no completed match");
  const payerId = match.activity.org.paymentHolderId ?? null;
  const confirmed = payerId ? match.attendances.filter((a) => a.userId !== payerId) : match.attendances;
  const paid = confirmed.filter((a) => a.paidAt != null);
  const unpaid = confirmed.filter((a) => a.paidAt == null);
  if (paid.length === 0 || unpaid.length === 0) {
    console.log(`Nothing to post — paid=${paid.length} unpaid=${unpaid.length}`);
    return;
  }
  const names = unpaid.map((a) => a.user.name).filter(Boolean).slice(0, 14).join(", ");
  const mentions = unpaid.map((a) => a.user.phoneNumber?.replace(/^\+/, "")).filter((p): p is string => !!p);
  const text =
    `💳 Reminder — *${unpaid.length}* still haven't paid for last week's match. ` +
    `Please *pay* asap 🙏\n\n${names}`;
  await db.botJob.create({ data: { orgId: org.id, kind: "group", text } });
  console.log(`Queued unpaid-reminder BotJob. text="${text.slice(0, 120)}..."`);
  console.log(`Mentions (${mentions.length}): ${mentions.join(" ")}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
