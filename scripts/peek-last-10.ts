import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  console.log("=== Last 15 AnalyzedMessage rows ===\n");
  const recent = await db.analyzedMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
    select: {
      createdAt: true,
      authorPhone: true,
      authorUserId: true,
      handledBy: true,
      intent: true,
      action: true,
      confidence: true,
      reasoning: true,
      body: true,
      waMessageId: true,
    },
  });
  const userIds = [
    ...new Set(recent.map((r) => r.authorUserId).filter((x): x is string => !!x)),
  ];
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name ?? "?"]));
  for (const r of recent.reverse()) {
    const author =
      (r.authorUserId && nameById.get(r.authorUserId)) ?? r.authorPhone ?? "?";
    const ts = r.createdAt.toISOString().replace("T", " ").slice(0, 19);
    const body = (r.body ?? "").replace(/\n/g, " ").slice(0, 100);
    console.log(`${ts}  ${author.padEnd(18)} ${r.handledBy}/${r.intent ?? "-"} (conf=${r.confidence?.toFixed(2) ?? "-"})`);
    console.log(`  body: ${body}`);
    if (r.reasoning) console.log(`  reason: ${r.reasoning.slice(0, 200).replace(/\n/g, " ")}`);
    console.log();
  }

  console.log("\n=== Last 15 SentNotification rows ===\n");
  const sn = await db.sentNotification.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  for (const s of sn.reverse()) {
    console.log(`${s.createdAt.toISOString().slice(0, 19)}  ${s.kind.padEnd(20)} ${s.key}`);
  }

  console.log("\n=== Tonight's match TeamAssignments + status ===\n");
  const m = await db.match.findFirst({
    where: { isHistorical: false, status: { not: "COMPLETED" } },
    orderBy: { date: "asc" },
    include: {
      teamAssignments: { include: { user: { select: { name: true } } } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { name: true } } },
        orderBy: { position: "asc" },
      },
      benchConfirmations: { where: { resolvedAt: null } },
    },
  });
  if (m) {
    console.log(`status=${m.status}  date=${m.date.toISOString()}  confirmed=${m.attendances.length}  pendingBenchPrompts=${m.benchConfirmations.length}`);
    const red = m.teamAssignments.filter((t) => t.team === "RED").map((t) => t.user.name);
    const yellow = m.teamAssignments.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
    console.log(`Red (${red.length}): ${red.join(", ")}`);
    console.log(`Yellow (${yellow.length}): ${yellow.join(", ")}`);
    for (const bc of m.benchConfirmations) {
      const u = await db.user.findUnique({ where: { id: bc.userId }, select: { name: true } });
      console.log(`  pending bench prompt for ${u?.name ?? bc.userId} expires ${bc.expiresAt.toISOString()}`);
    }
  }

  console.log("\n=== Last 5 BotJob rows ===\n");
  const jobs = await db.botJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  for (const j of jobs.reverse()) {
    console.log(
      `${j.createdAt.toISOString().slice(0, 19)}  kind=${j.kind} sent=${j.sentAt?.toISOString().slice(0, 19) ?? "PENDING"}`,
    );
    console.log(`  ${(j.text ?? "").slice(0, 150).replace(/\n/g, " ")}`);
  }
}
main().catch(console.error).finally(() => process.exit(0));
