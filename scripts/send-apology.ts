import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({ where: { whatsappBotEnabled: true } });
  if (!org) throw new Error("no bot-enabled org");

  const text =
    `🙏 Quick correction on the 5pm post:\n\n` +
    `• The match is on *Tuesday 28 April at 21:30*, not tonight — apologies for the confusion.\n` +
    `• The &quot;14 haven't paid&quot; line was wrong too. A small tracking change I just rolled out made MatchTime reset the paid-count because it couldn't see historical poll votes. If you ticked Red/Yellow in the payment poll last week, you *are* paid — no need to do anything.\n\n` +
    `Both fixed now. Thanks for bearing with me 🙌`;

  // Replace the HTML entity back to a real apostrophe before queueing.
  const clean = text.replace(/&quot;/g, '"');

  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group", text: clean },
  });
  console.log(`Queued apology BotJob ${job.id} for org ${org.id}`);
  console.log("\n--- Message ---");
  console.log(clean);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
