import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({ where: { whatsappBotEnabled: true } });
  if (!org) throw new Error("no bot-enabled org");

  // Create Karahan as a real user + member (not provisional — admin is
  // explicitly confirming him, so he shouldn't carry the NEW badge).
  const user = await db.user.create({
    data: {
      name: "Karahan Ozturk",
      email: `karahan+${Date.now().toString(36)}@matchtime.local`,
      onboarded: false,
      isActive: true,
    },
  });
  await db.membership.create({
    data: { userId: user.id, orgId: org.id, role: "PLAYER" },
  });
  console.log(`Created user ${user.id} (${user.name}) + membership in ${org.id}`);

  const match = await db.match.findFirst({
    where: { activity: { orgId: org.id }, status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] }, isHistorical: false },
    orderBy: { date: "asc" },
  });
  if (!match) throw new Error("no upcoming match");
  const result = await registerAttendance(user.id, match.id);
  console.log(`Registered Karahan for ${match.id}: status=${result.status} pos=${result.position}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
