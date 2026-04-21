import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const m = await db.match.findFirst({
    where: { status: { in: ["UPCOMING","TEAMS_GENERATED","TEAMS_PUBLISHED"] } },
    include: {
      attendances: { include: { user: { select: { name: true } } } },
      activity: { select: { name: true } },
    },
  });
  if (!m) { console.log("no match"); return; }
  const c = m.attendances.filter(a => a.status === "CONFIRMED");
  const d = m.attendances.filter(a => a.status === "DROPPED");
  const b = m.attendances.filter(a => a.status === "BENCH");
  console.log(`${m.activity.name}  status=${m.status}  ${c.length}/${m.maxPlayers}`);
  console.log(`Confirmed: ${c.map(a => a.user.name).join(", ")}`);
  console.log(`Bench:     ${b.map(a => a.user.name).join(", ")}`);
  console.log(`Dropped:   ${d.map(a => a.user.name).join(", ")}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
