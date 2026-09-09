import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { unresolvedKey } from "@/lib/unresolved-grouping";
import { NextResponse } from "next/server";

/**
 * Distinct count of unresolved attendance-relevant senders in the last 21
 * days, for the admin subnav badge (#1 — make silent drops impossible to
 * miss). Cheap: one indexed query + in-memory distinct.
 *
 * NAMELESS SENDERS ARE INCLUDED since 2026-09-09. This query carried
 * `authorName: { not: null }`, which meant the badge for "messages nobody
 * could be attributed to" could not see the messages with no attribution
 * at all (2026-08-30 audit, §3). They share one key, so a batch of them
 * adds one to the badge rather than a wall of noise.
 */

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ count: 0 });
  const membership = await getUserOrg(session.user.id);
  if (!membership) return NextResponse.json({ count: 0 });
  if (!(await isOrgAdmin(session.user.id, membership.orgId))) {
    return NextResponse.json({ count: 0 });
  }
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
  const rows = await db.analyzedMessage.findMany({
    where: {
      orgId: membership.orgId,
      authorUserId: null,
      intent: { in: ["in", "out", "replacement_request"] },
      createdAt: { gte: since },
    },
    select: { authorName: true },
  });
  // Attendance writes that THREW count too: the player was told the
  // truth in the group, but a human still has to see the fault.
  const failed = await db.analyzedMessage.count({
    where: {
      orgId: membership.orgId,
      handledBy: "error",
      action: { startsWith: "attendance-failed" },
      createdAt: { gte: since },
    },
  });
  const count = new Set(rows.map((r) => unresolvedKey(r.authorName))).size + failed;
  return NextResponse.json({ count });
}
