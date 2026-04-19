/**
 * Queue a fresh magic-link DM to Kemal so he can test the rating page
 * through the new matchtime.ai domain. Picks the most recent COMPLETED
 * match he attended, signs a new `rate-match` token (5-day TTL), and
 * writes a BotJob so the Pi bot sends the DM on its next poll.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { buildMagicLinkUrl, signMagicLinkToken, MAGIC_LINK_TTL } from "../src/lib/magic-link.ts";
import { format } from "date-fns";

const KEMAL_EMAIL = "kemal.ediz@cressoft.io";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const kemal = await db.user.findUnique({
    where: { email: KEMAL_EMAIL },
    select: { id: true, name: true, phoneNumber: true },
  });
  if (!kemal) throw new Error("Kemal user not found");
  if (!kemal.phoneNumber) throw new Error("Kemal has no phone number");

  const attendance = await db.attendance.findFirst({
    where: {
      userId: kemal.id,
      status: "CONFIRMED",
      match: { status: "COMPLETED" },
    },
    orderBy: { match: { date: "desc" } },
    include: {
      match: {
        include: { activity: { include: { sport: true, org: true } } },
      },
    },
  });
  if (!attendance) throw new Error("Kemal hasn't played in any completed match");

  const { match } = attendance;
  const token = signMagicLinkToken({
    userId: kemal.id,
    purpose: "rate-match",
    matchId: match.id,
    ttlSeconds: MAGIC_LINK_TTL.rateMatch,
  });
  const url = buildMagicLinkUrl(token);

  const text = [
    `🧪 *MatchTime rating-page test*`,
    ``,
    `Tap the link below to sign in and land on the rating page for ` +
      `*${match.activity.name}* on ${format(match.date, "EEE d MMM")}.`,
    ``,
    url,
    ``,
    `Link is fresh (5-day TTL) and points at https://matchtime.ai — verify the ` +
      `page is responsive on mobile + desktop.`,
  ].join("\n");

  const job = await db.botJob.create({
    data: {
      orgId: match.activity.org.id,
      kind: "dm",
      phone: kemal.phoneNumber.replace(/^\+/, ""),
      text,
    },
  });

  console.log(`Queued BotJob ${job.id}`);
  console.log(`Match: ${match.activity.name} (${match.id})`);
  console.log(`URL:   ${url}`);
  console.log(`To:    ${kemal.name ?? kemal.phoneNumber}`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
