/**
 * Queue a DM to Kemal with a rate-match magic link pointing at the most
 * recent test match. Mirrors the DM that the scheduler will auto-send
 * after every real match with postMatchEndFlow=true.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { signMagicLinkToken, buildMagicLinkUrl, MAGIC_LINK_TTL } from "../src/lib/magic-link.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findUnique({ where: { slug: "sutton-fc" } });
  const kemal = await db.user.findUnique({ where: { email: "kemal.ediz@cressoft.io" } });
  if (!org || !kemal) throw new Error("org/user not found");
  if (!kemal.phoneNumber) throw new Error("kemal has no phone number");

  const match = await db.match.findFirst({
    where: { activityId: "test-rating-preview" },
    orderBy: { createdAt: "desc" },
  });
  if (!match) throw new Error("Run scripts/create-test-match.ts first");

  const token = signMagicLinkToken({
    userId: kemal.id,
    purpose: "rate-match",
    matchId: match.id,
    ttlSeconds: MAGIC_LINK_TTL.rateMatch,
  });
  const link = buildMagicLinkUrl(token);

  const text = [
    `🏆 *[TEST] Rating preview* — Tuesday test match`,
    ``,
    `Rate your teammates and pick Man of the Match. Takes ~1 minute.`,
    ``,
    link,
    ``,
    `(This is a dry run — won't affect the real Tuesday match.)`,
  ].join("\n");

  const job = await db.botJob.create({
    data: {
      orgId: org.id,
      kind: "dm",
      phone: kemal.phoneNumber.replace(/^\+/, ""),
      text,
    },
  });
  console.log(`Queued BotJob ${job.id}`);
  console.log(`Link: ${link}`);
  console.log(`Bot will deliver on next scheduler tick (up to 5 min).`);

  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
