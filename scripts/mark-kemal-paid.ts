import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const kemal = await db.user.findFirst({ where: { name: "Kemal" }, select: { id: true } });
  if (!kemal) throw new Error("no kemal");
  const match = await db.match.findFirst({
    where: { status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
  });
  if (!match) throw new Error("no match");
  const att = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: match.id, userId: kemal.id } },
    select: { id: true, paidAt: true },
  });
  console.log("Kemal attendance:", att);
  if (att && att.paidAt == null) {
    await db.attendance.update({ where: { id: att.id }, data: { paidAt: new Date() } });
    console.log("Marked Kemal as paid.");
  } else {
    console.log("Already paid or no attendance.");
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
