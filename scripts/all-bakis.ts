import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const all = await db.user.findMany({ where: { name: { contains: "Baki", mode: "insensitive" } } });
  console.log("All users matching 'Baki':");
  for (const u of all) console.log(`  id=${u.id} name="${u.name}" phone=${u.phoneNumber} email=${u.email}`);
  console.log("\nAttendances on upcoming match where name contains 'Baki':");
  const m = await db.match.findFirst({ where: { status: { in: ["UPCOMING","TEAMS_GENERATED","TEAMS_PUBLISHED"] }, isHistorical: false }, orderBy: { date: "asc" } });
  if (!m) return;
  const atts = await db.attendance.findMany({ where: { matchId: m.id, user: { name: { contains: "Baki", mode: "insensitive" } } }, include: { user: true } });
  for (const a of atts) console.log(`  status=${a.status} pos=${a.position} userId=${a.userId} userName="${a.user.name}" createdAt=${a.createdAt.toISOString()}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
