import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

/**
 * Amir (Sutton FC member) said his two friends Faris and Shaz can play
 * the Apr 28 match. MatchTime's LLM couldn't act on the vague "two of
 * my guys" message (correctly) but then missed the follow-up where
 * Amir posted a modified roster with the two names. Registering them
 * manually while we ship a conversational clarification loop.
 */
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({ where: { whatsappBotEnabled: true } });
  if (!org) throw new Error("no bot-enabled org");

  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      isHistorical: false,
    },
    orderBy: { date: "asc" },
  });
  if (!match) throw new Error("no upcoming match");

  for (const name of ["Faris", "Shaz"]) {
    // Provisional — admin can fill phone / seed rating later.
    const user = await db.user.create({
      data: {
        name,
        email: `provisional+${name.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@matchtime.local`,
        onboarded: false,
        isActive: true,
      },
    });
    await db.membership.create({
      data: {
        userId: user.id,
        orgId: org.id,
        role: "PLAYER",
        provisionallyAddedAt: new Date(),
      },
    });
    const r = await registerAttendance(user.id, match.id);
    console.log(`Added ${name} → ${user.id}, status=${r.status} pos=${r.position}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
