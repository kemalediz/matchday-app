import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);
  const m = await db.match.findFirst({
    where: { isHistorical: false, status: { not: "COMPLETED" } },
    orderBy: { date: "asc" },
    include: {
      activity: { include: { sport: true } },
      attendances: { include: { user: { select: { name: true } } }, orderBy: { position: "asc" } },
      teamAssignments: { include: { user: { select: { name: true } } } },
    },
  });
  if (!m) return console.log("no upcoming match");
  console.log(`Match ${m.id}  date=${m.date.toISOString()}  status=${m.status}`);
  console.log(`Confirmed: ${m.attendances.filter((a) => a.status === "CONFIRMED").length}/${m.maxPlayers}, Bench: ${m.attendances.filter((a) => a.status === "BENCH").length}, TeamAssignments: ${m.teamAssignments.length}`);
  if (m.teamAssignments.length > 0) {
    const red = m.teamAssignments.filter((t) => t.team === "RED").map((t) => t.user.name);
    const yellow = m.teamAssignments.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
    console.log(`Red (${red.length}): ${red.join(", ")}`);
    console.log(`Yellow (${yellow.length}): ${yellow.join(", ")}`);
  }
}
main().catch(console.error).finally(() => process.exit(0));
