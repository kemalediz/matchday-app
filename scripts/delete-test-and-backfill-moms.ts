/**
 * Cleanup + backfill:
 *   1. Delete the [TEST] Rating preview match — it was seeded to
 *      rehearse the rating UI and leaked into the leaderboard (giving
 *      Ali a ghost MoM and pumping several players to 7-8 averages off
 *      one synthetic vote each). Cascade removes its attendances +
 *      ratings + MoMVotes automatically.
 *   2. Backfill historical MoMs from the WhatsApp chat analysis the
 *      Sutton rebuild was based on. Each winner gets a synthetic Match
 *      row flagged `isHistorical: true` + a MoMVote row by Kemal
 *      (voterId = the admin) pointing at the winner. Historical matches
 *      are excluded from dashboards and the bot scheduler but the
 *      leaderboard's MoM count naturally picks them up.
 *
 * Source list taken from the `note` fields in scripts/rebuild-sutton.ts
 * where MoM dates are mentioned.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ORG_SLUG = "sutton-fc";
const KEMAL_EMAIL = "kemal.ediz@cressoft.io";

// Historical MoM wins, parsed from rebuild-sutton.ts notes.
// Co-MoM (Wasim + Mojib on 2026-02-03) → two entries, Mojib's offset
// by one minute to avoid dedupe against Wasim's synthetic match.
const MOMS: Array<{ name: string; date: string; note?: string }> = [
  { name: "Erdal",           date: "2024-11-19T20:30:00Z", note: "midfield scorer" },
  { name: "Zair",             date: "2025-11-14T20:30:00Z", note: "forward" },
  { name: "Elvin Azeri",      date: "2025-10-22T20:30:00Z" },
  { name: "Ali",              date: "2025-12-16T20:30:00Z" },
  { name: "Mojib",            date: "2025-12-16T20:31:00Z", note: "shares date with Ali (two Dec 16 wins)" },
  { name: "Ehtisham Ul Haq",  date: "2026-02-02T20:30:00Z" },
  { name: "Wasim",            date: "2026-02-03T20:30:00Z" },
  { name: "Mojib",            date: "2026-02-03T20:31:00Z", note: "co-MoM 3 Feb with Wasim" },
  { name: "Ersin Sevindik",   date: "2026-02-10T20:30:00Z", note: "GK, 7 votes" },
];

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error(`org not found: ${ORG_SLUG}`);

  const kemal = await db.user.findUnique({ where: { email: KEMAL_EMAIL } });
  if (!kemal) throw new Error(`Kemal not found: ${KEMAL_EMAIL}`);

  const activity = await db.activity.findFirst({
    where: { orgId: org.id, name: { contains: "7-a-side" }, isActive: true },
    include: { sport: { select: { playersPerTeam: true } } },
  });
  if (!activity) throw new Error("no active 7-a-side activity");

  // ─── 1. Delete the test match ─────────────────────────────────────
  const testMatches = await db.match.findMany({
    where: {
      activityId: activity.id,
      OR: [
        { activity: { name: { startsWith: "[TEST]" } } },
      ],
    },
  });
  // Also find any match with "[TEST]" activity or with a suspicious
  // date (2026-04-18 the seed date).
  const suspect = await db.match.findMany({
    where: { activityId: activity.id, date: new Date("2026-04-18T20:30:00Z") },
    include: { activity: { select: { name: true } } },
  });
  const allTestIds = new Set<string>([
    ...testMatches.map((m) => m.id),
    ...suspect.map((m) => m.id),
  ]);

  for (const id of allTestIds) {
    const m = await db.match.findUnique({
      where: { id },
      include: {
        _count: { select: { attendances: true, ratings: true, momVotes: true } },
      },
    });
    if (!m) continue;
    console.log(
      `🗑  deleting ${id}  date=${m.date.toISOString()}  att=${m._count.attendances} ratings=${m._count.ratings} moms=${m._count.momVotes}`,
    );
    await db.match.delete({ where: { id } });
  }
  if (allTestIds.size === 0) console.log("(no test matches found to delete)");

  // ─── 2. Backfill historical MoMs ──────────────────────────────────
  const allUsers = await db.user.findMany({
    where: { memberships: { some: { orgId: org.id } } },
    select: { id: true, name: true },
  });
  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const findUser = (wantName: string) => {
    const want = norm(wantName);
    const exact = allUsers.find((u) => u.name && norm(u.name) === want);
    if (exact) return exact;
    const firstMatch = allUsers.find((u) => {
      if (!u.name) return false;
      const first = norm(u.name).split(" ")[0];
      return first === want.split(" ")[0];
    });
    return firstMatch ?? null;
  };

  let created = 0;
  let skippedDup = 0;
  let skippedMissingUser = 0;

  for (const mom of MOMS) {
    const winner = findUser(mom.name);
    if (!winner) {
      console.log(`⚠️  skipping ${mom.name} — no matching User in org`);
      skippedMissingUser++;
      continue;
    }
    const date = new Date(mom.date);

    const existingMatch = await db.match.findFirst({
      where: {
        activityId: activity.id,
        date,
        isHistorical: true,
      },
      include: { momVotes: { where: { playerId: winner.id } } },
    });
    if (existingMatch && existingMatch.momVotes.length > 0) {
      console.log(`⏭  ${mom.name} @ ${mom.date} already backfilled`);
      skippedDup++;
      continue;
    }

    const match =
      existingMatch ??
      (await db.match.create({
        data: {
          activityId: activity.id,
          date,
          maxPlayers: activity.sport.playersPerTeam * 2,
          attendanceDeadline: new Date(date.getTime() - 5 * 60 * 60 * 1000),
          status: "COMPLETED",
          isHistorical: true,
          postMatchEndFlow: false, // never fire bot messages for historical matches
        },
      }));

    try {
      await db.moMVote.create({
        data: {
          matchId: match.id,
          voterId: kemal.id,
          playerId: winner.id,
        },
      });
      console.log(`✅ ${winner.name} MoM · ${mom.date}${mom.note ? ` (${mom.note})` : ""}`);
      created++;
    } catch (err) {
      console.error(`⚠️  ${mom.name} @ ${mom.date}: vote write failed`, err);
    }
  }

  console.log(
    `\nSummary: created ${created}, skipped-dup ${skippedDup}, skipped-missing ${skippedMissingUser}`,
  );

  // ─── 3. Leaderboard preview ───────────────────────────────────────
  const topByMoM = await db.moMVote.groupBy({
    by: ["playerId"],
    _count: { _all: true },
    orderBy: { _count: { playerId: "desc" } },
    take: 10,
  });
  console.log(`\nTop 10 MoM winners (after backfill):`);
  for (const r of topByMoM) {
    const u = allUsers.find((u) => u.id === r.playerId);
    console.log(`  ${r._count._all}  ${u?.name ?? r.playerId}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
