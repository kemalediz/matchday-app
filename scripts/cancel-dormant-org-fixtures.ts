/**
 * One-off cleanup: retire the fixtures a DORMANT club was given while
 * `/api/cron/generate-matches` was still generating for it.
 *
 * Context: until 2026-09-09 the weekly cron asked only whether the
 * ACTIVITY was active, never whether the club still existed, so Sutton
 * Lads — churned 2026-06-18, MatchTime removed from the group after an
 * incident, data deliberately retained — kept collecting weekly Thursday
 * fixtures. One for Thu 10 Sept 2026 turned up in a status report. The
 * cron is fixed; these are the rows it already left behind.
 *
 * ── CANCEL, not DELETE ───────────────────────────────────────────────
 *
 * This script sets `status = 'CANCELLED'`. It deletes nothing, and the
 * choice is deliberate:
 *
 *  - "Data retained" was the call made for this org. Deleting a Match
 *    CASCADES to ten tables — Attendance, Rating, MoMVote,
 *    TeamAssignment, RatingAdjustment, PaymentCredit,
 *    SentNotification, TentativeAvailability, PendingBenchConfirmation,
 *    BenchSlotOffer — so a delete would quietly destroy exactly the
 *    history somebody chose to keep.
 *  - CANCELLED is already the status every scheduler trigger and the
 *    match-completion sweep gate on, so cancelling is what actually
 *    stops these rows doing anything.
 *  - It is reversible. /admin/block-bookings has a bulk restore, and
 *    `reactivateOrganisation` brings the club itself back.
 *
 * ── What it touches ──────────────────────────────────────────────────
 *
 * Only FUTURE matches (kickoff after now) of orgs with `dormantAt` set,
 * that are not already CANCELLED or COMPLETED and are not historical
 * backfill anchors. Past matches are history and are left exactly as
 * they are.
 *
 * SILENT: no BotJob, no group message, no DM. The group these fixtures
 * belonged to no longer has MatchTime in it, and announcing a
 * cancellation to a club that churned three months ago would be worse
 * than the ghost fixture.
 *
 * ── Running it ───────────────────────────────────────────────────────
 *
 *   npx tsx scripts/cancel-dormant-org-fixtures.ts            # dry run
 *   npx tsx scripts/cancel-dormant-org-fixtures.ts --apply    # writes
 *
 * Dry run by default. It prints every match it would touch, with its
 * attendance count, so you can see what you are cancelling first. If no
 * org has been marked dormant yet, it finds nothing and says so — mark
 * the org first (/admin/organisations → "Mark dormant").
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { formatLondon } from "../src/lib/london-time.ts";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const now = new Date();

  const dormantOrgs = await db.organisation.findMany({
    where: { dormantAt: { not: null } },
    select: { id: true, name: true, slug: true, dormantAt: true },
    orderBy: { name: "asc" },
  });

  console.log(`${apply ? "APPLYING" : "DRY RUN"} — ${dormantOrgs.length} dormant org(s)\n`);
  if (dormantOrgs.length === 0) {
    console.log(
      "Nothing to do. No organisation has `dormantAt` set — mark the club\n" +
        "dormant first at /admin/organisations, then re-run this.",
    );
    await db.$disconnect();
    return;
  }

  let wouldCancel = 0;
  let cancelled = 0;

  for (const org of dormantOrgs) {
    console.log(
      `── ${org.name} (${org.slug}) — dormant since ${formatLondon(org.dormantAt!, "d MMM yyyy")}`,
    );

    const matches = await db.match.findMany({
      where: {
        activity: { orgId: org.id },
        date: { gt: now },
        status: { notIn: ["CANCELLED", "COMPLETED"] },
        isHistorical: false,
      },
      select: {
        id: true,
        date: true,
        status: true,
        activity: { select: { name: true, isActive: true } },
        _count: { select: { attendances: true, teamAssignments: true } },
      },
      orderBy: { date: "asc" },
    });

    if (matches.length === 0) {
      console.log("   no future fixtures — nothing to do\n");
      continue;
    }

    for (const m of matches) {
      console.log(
        `   ${formatLondon(m.date, "EEE d MMM yyyy HH:mm zzz")}  ${m.status.padEnd(16)} ` +
          `${m.activity.name} (activity isActive=${m.activity.isActive}) ` +
          `— ${m._count.attendances} attendance row(s), ${m._count.teamAssignments} team row(s)`,
      );
      console.log(`      id ${m.id}`);
      wouldCancel++;
    }

    if (apply) {
      // One updateMany, no BotJob — see the SILENT note in the header.
      const res = await db.match.updateMany({
        where: { id: { in: matches.map((m: { id: string }) => m.id) } },
        data: { status: "CANCELLED" },
      });
      cancelled += res.count;
      console.log(`   ✅ cancelled ${res.count}\n`);
    } else {
      console.log(`   would cancel ${matches.length}\n`);
    }
  }

  console.log(
    apply
      ? `Done — ${cancelled} fixture(s) cancelled. Nothing was deleted.`
      : `Dry run — ${wouldCancel} fixture(s) would be cancelled. Re-run with --apply to write.`,
  );

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
