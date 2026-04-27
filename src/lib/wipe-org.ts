/**
 * Permanently delete an organisation and everything attached to it.
 *
 * Order matters because the schema's foreign keys aren't all cascading:
 *   - Match → Activity has no onDelete cascade, so Match must be
 *     deleted before Activity.
 *   - Match → Attendance / TeamAssignment / Rating / MoMVote /
 *     SentNotification / PendingBenchConfirmation / RatingAdjustment
 *     ARE cascading, so deleting Match handles them automatically.
 *   - Activity → PlayerActivityPosition cascades.
 *   - Organisation → Membership / Activity / Sport cascade, but we
 *     delete them explicitly first to keep the order obvious.
 *   - BotJob and AnalyzedMessage are NOT linked by FK — query by orgId.
 *
 * Synthetic users (onboarding+*, provisional+*, wa-*) created during
 * the wizard or by the live-message provisioner are deleted iff they
 * have zero memberships left after the org is gone — never touch a
 * real OAuth/credentials user, even if they happen to be in only one
 * org.
 *
 * Wrapped in a single transaction so a partial failure rolls back.
 *
 * Used by:
 *   - scripts/wipe-org.ts (CLI, dry-run by default)
 *   - /admin/organisations delete button (server action, superadmin or
 *     org OWNER)
 */
import { db } from "./db";

export interface WipeOrgPlan {
  orgId: string;
  orgName: string;
  orgSlug: string;
  counts: {
    activities: number;
    matches: number;
    attendances: number;
    teamAssignments: number;
    ratings: number;
    momVotes: number;
    sentNotifications: number;
    benchConfirmations: number;
    ratingAdjustments: number;
    sports: number;
    memberships: number;
    botJobs: number;
    analyzedMessages: number;
    syntheticUsersToDelete: number;
  };
}

/** Compute a deletion plan without writing anything. Safe to call. */
export async function describeWipeOrg(orgId: string): Promise<WipeOrgPlan | null> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true },
  });
  if (!org) return null;

  const activities = await db.activity.findMany({
    where: { orgId },
    select: { id: true },
  });
  const activityIds = activities.map((a) => a.id);

  const matches = await db.match.findMany({
    where: { activityId: { in: activityIds } },
    select: { id: true },
  });
  const matchIds = matches.map((m) => m.id);

  const [
    attendances,
    teamAssignments,
    ratings,
    momVotes,
    sentNotifications,
    benchConfirmations,
    ratingAdjustments,
    sports,
    memberships,
    botJobs,
    analyzedMessages,
  ] = await Promise.all([
    db.attendance.count({ where: { matchId: { in: matchIds } } }),
    db.teamAssignment.count({ where: { matchId: { in: matchIds } } }),
    db.rating.count({ where: { matchId: { in: matchIds } } }),
    db.moMVote.count({ where: { matchId: { in: matchIds } } }),
    db.sentNotification.count({ where: { matchId: { in: matchIds } } }),
    db.pendingBenchConfirmation.count({ where: { matchId: { in: matchIds } } }),
    db.ratingAdjustment.count({ where: { matchId: { in: matchIds } } }),
    db.sport.count({ where: { orgId } }),
    db.membership.count({ where: { orgId } }),
    db.botJob.count({ where: { orgId } }),
    db.analyzedMessage.count({ where: { orgId } }),
  ]);

  // Estimate orphan synthetic users: users whose ONLY membership is in
  // this org and whose email matches the synthetic patterns.
  const memberUsers = await db.membership.findMany({
    where: { orgId },
    select: { userId: true, user: { select: { email: true } } },
  });
  let syntheticUsersToDelete = 0;
  for (const m of memberUsers) {
    const email = m.user.email ?? "";
    const isSynthetic =
      email.startsWith("onboarding+") ||
      email.startsWith("provisional+") ||
      email.startsWith("wa-");
    if (!isSynthetic) continue;
    const otherCount = await db.membership.count({
      where: { userId: m.userId, orgId: { not: orgId } },
    });
    if (otherCount === 0) syntheticUsersToDelete += 1;
  }

  return {
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    counts: {
      activities: activities.length,
      matches: matches.length,
      attendances,
      teamAssignments,
      ratings,
      momVotes,
      sentNotifications,
      benchConfirmations,
      ratingAdjustments,
      sports,
      memberships,
      botJobs,
      analyzedMessages,
      syntheticUsersToDelete,
    },
  };
}

/**
 * Actually wipe the org. Caller must have done their own authorisation
 * check first — this function does not gate on user identity.
 */
export async function wipeOrg(orgId: string): Promise<void> {
  await db.$transaction(
    async (tx) => {
      const activities = await tx.activity.findMany({
        where: { orgId },
        select: { id: true },
      });
      const activityIds = activities.map((a) => a.id);

      const matches = await tx.match.findMany({
        where: { activityId: { in: activityIds } },
        select: { id: true },
      });
      const matchIds = matches.map((m) => m.id);

      // Identify synthetic users to delete BEFORE removing memberships,
      // because afterwards the membership rows are gone.
      const memberUsers = await tx.membership.findMany({
        where: { orgId },
        select: { userId: true, user: { select: { email: true } } },
      });
      const orphanCandidates: string[] = [];
      for (const m of memberUsers) {
        const email = m.user.email ?? "";
        const isSynthetic =
          email.startsWith("onboarding+") ||
          email.startsWith("provisional+") ||
          email.startsWith("wa-");
        if (!isSynthetic) continue;
        const otherCount = await tx.membership.count({
          where: { userId: m.userId, orgId: { not: orgId } },
        });
        if (otherCount === 0) orphanCandidates.push(m.userId);
      }

      // Match cascades → attendances, teamAssignments, ratings,
      // momVotes, sentNotifications, benchConfirmations,
      // ratingAdjustments. So one deleteMany covers all of them.
      if (matchIds.length > 0) {
        await tx.match.deleteMany({ where: { id: { in: matchIds } } });
      }

      // Activity cascades → playerActivityPositions.
      if (activityIds.length > 0) {
        await tx.activity.deleteMany({ where: { orgId } });
      }

      await tx.botJob.deleteMany({ where: { orgId } });
      await tx.analyzedMessage.deleteMany({ where: { orgId } });
      await tx.sport.deleteMany({ where: { orgId } });

      // Organisation deletion cascades memberships.
      await tx.organisation.delete({ where: { id: orgId } });

      // Now safe to delete orphaned synthetic users.
      if (orphanCandidates.length > 0) {
        await tx.user.deleteMany({ where: { id: { in: orphanCandidates } } });
      }
    },
    { timeout: 60_000 },
  );
}
