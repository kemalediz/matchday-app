import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

/** Amir's 3 confirmed guests (Adam, Efat, Usama). Pattern not yet in
 *  the analyzer when the "Confirmed" reply landed (rule shipped
 *  afterwards). Register manually; future confirmations will flow
 *  through the LLM automatically. */
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
  for (const name of ["Adam", "Efat", "Usama"]) {
    const user = await db.user.create({
      data: {
        name,
        email: `provisional+${name.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@matchtime.local`,
        onboarded: false,
        isActive: true,
      },
    });
    await db.membership.create({
      data: { userId: user.id, orgId: org.id, role: "PLAYER", provisionallyAddedAt: new Date() },
    });
    const r = await registerAttendance(user.id, match.id);
    console.log(`Added ${name} → ${user.id}  status=${r.status}  pos=${r.position}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
