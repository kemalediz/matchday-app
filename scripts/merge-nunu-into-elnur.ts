/**
 * One-off: merge the current "Nunu" provisional ghost into the real
 * Elnur Mammadov record AND save "nunu" as a UserAlias for Elnur in
 * the Sutton org. After this runs, the next time Elnur posts from his
 * @lid pushname "Nunu", the resolver finds him via alias instead of
 * provisioning a new ghost.
 *
 * Mirrors mergePlayers's transactional logic but inline — Kemal's
 * been clicking Merge by hand each week, this clears the backlog.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const elnur = await db.user.findFirst({
    where: { name: "Elnur Mammadov" },
    select: { id: true, name: true, phoneNumber: true },
  });
  const nunu = await db.user.findFirst({
    where: {
      name: "Nunu",
      memberships: { some: { provisionallyAddedAt: { not: null } } },
    },
    select: { id: true, name: true, email: true, memberships: { select: { orgId: true } } },
  });
  if (!elnur || !nunu) {
    console.log("Couldn't locate both users:", { elnur: !!elnur, nunu: !!nunu });
    return;
  }
  const orgId = nunu.memberships[0]?.orgId;
  if (!orgId) {
    console.log("Nunu has no membership — nothing to do");
    return;
  }
  console.log(`Merging ${nunu.name} (id=${nunu.id}) into ${elnur.name} (id=${elnur.id}) in org ${orgId}`);

  const aliasNorm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const aliases = new Set<string>();
  if (nunu.name) {
    const k = aliasNorm(nunu.name);
    if (k.length >= 2) aliases.add(k);
  }
  if (nunu.email) {
    const m = nunu.email.match(/^provisional\+([a-z0-9-]+)-[a-z0-9]+@/i);
    if (m) {
      const k = aliasNorm(m[1].replace(/-/g, " "));
      if (k.length >= 2) aliases.add(k);
    }
  }
  console.log(`Aliases to save: ${[...aliases].join(", ")}`);

  await db.$transaction(async (tx) => {
    // Re-attribute attendance / ratings / momVotes / teamAssignments /
    // analyzedMessages — same conflict-handling rules as mergePlayers.
    const ATT_RANK = { CONFIRMED: 3, BENCH: 2, DROPPED: 1 } as const;
    const dropAtts = await tx.attendance.findMany({ where: { userId: nunu.id } });
    for (const a of dropAtts) {
      const existing = await tx.attendance.findUnique({
        where: { matchId_userId: { matchId: a.matchId, userId: elnur.id } },
      });
      if (!existing) {
        await tx.attendance.update({ where: { id: a.id }, data: { userId: elnur.id } });
      } else {
        const dropRank = ATT_RANK[a.status as keyof typeof ATT_RANK] ?? 0;
        const keepRank = ATT_RANK[existing.status as keyof typeof ATT_RANK] ?? 0;
        if (dropRank > keepRank) {
          await tx.attendance.update({
            where: { id: existing.id },
            data: { status: a.status, position: a.position, paidAt: a.paidAt ?? existing.paidAt },
          });
        }
        await tx.attendance.delete({ where: { id: a.id } });
      }
    }

    const dropGiven = await tx.rating.findMany({ where: { raterId: nunu.id } });
    for (const r of dropGiven) {
      const exists = await tx.rating.findUnique({
        where: {
          matchId_raterId_playerId: {
            matchId: r.matchId,
            raterId: elnur.id,
            playerId: r.playerId,
          },
        },
      });
      if (exists) await tx.rating.delete({ where: { id: r.id } });
      else await tx.rating.update({ where: { id: r.id }, data: { raterId: elnur.id } });
    }
    await tx.rating.updateMany({ where: { playerId: nunu.id }, data: { playerId: elnur.id } });

    const dropMom = await tx.moMVote.findMany({ where: { voterId: nunu.id } });
    for (const v of dropMom) {
      const exists = await tx.moMVote.findUnique({
        where: { matchId_voterId: { matchId: v.matchId, voterId: elnur.id } },
      });
      if (exists) await tx.moMVote.delete({ where: { id: v.id } });
      else await tx.moMVote.update({ where: { id: v.id }, data: { voterId: elnur.id } });
    }
    await tx.moMVote.updateMany({ where: { playerId: nunu.id }, data: { playerId: elnur.id } });

    const dropTeams = await tx.teamAssignment.findMany({ where: { userId: nunu.id } });
    for (const ta of dropTeams) {
      const exists = await tx.teamAssignment.findFirst({
        where: { matchId: ta.matchId, userId: elnur.id },
      });
      if (exists) await tx.teamAssignment.delete({ where: { id: ta.id } });
      else await tx.teamAssignment.update({ where: { id: ta.id }, data: { userId: elnur.id } });
    }

    const dropPositions = await tx.playerActivityPosition.findMany({ where: { userId: nunu.id } });
    for (const pp of dropPositions) {
      const exists = await tx.playerActivityPosition.findUnique({
        where: { userId_activityId: { userId: elnur.id, activityId: pp.activityId } },
      });
      if (exists) await tx.playerActivityPosition.delete({ where: { id: pp.id } });
      else await tx.playerActivityPosition.update({ where: { id: pp.id }, data: { userId: elnur.id } });
    }

    await tx.analyzedMessage.updateMany({
      where: { authorUserId: nunu.id },
      data: { authorUserId: elnur.id },
    });

    // Save aliases.
    for (const alias of aliases) {
      await tx.userAlias.upsert({
        where: { orgId_alias: { orgId, alias } },
        create: { orgId, userId: elnur.id, alias, source: "merge" },
        update: { userId: elnur.id, source: "merge" },
      });
    }

    // Free up the unique fields, then delete drop user.
    await tx.user.update({
      where: { id: nunu.id },
      data: { phoneNumber: null, email: `merged-${nunu.id}-${Date.now()}@matchtime.local` },
    });
    await tx.membership.deleteMany({ where: { userId: nunu.id } });
    await tx.user.delete({ where: { id: nunu.id } });
  });

  console.log(`Done. Aliases saved for Elnur in this org: ${[...aliases].join(", ")}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
