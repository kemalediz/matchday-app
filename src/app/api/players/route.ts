import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await getUserOrg(session.user.id);
  if (!membership) return NextResponse.json({ error: "No organisation" }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const activityIdParam = searchParams.get("activityId");
  const includeFormer = searchParams.get("includeFormer") === "1";

  // If admin passed a specific activityId, scope positions to THAT activity.
  // Otherwise fall back to the org's primary active activity.
  let targetActivityId: string | null = activityIdParam;
  if (!targetActivityId) {
    const primaryActivity = await db.activity.findFirst({
      where: { orgId: membership.orgId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    targetActivityId = primaryActivity?.id ?? null;
  } else {
    // Validate the requested activity belongs to the user's org (prevents
    // cross-org sniffing).
    const activity = await db.activity.findFirst({
      where: { id: targetActivityId, orgId: membership.orgId },
      select: { id: true },
    });
    if (!activity) targetActivityId = null;
  }

  const memberships = await db.membership.findMany({
    where: {
      orgId: membership.orgId,
      ...(includeFormer ? {} : { leftAt: null }),
    },
    include: {
      user: {
        include: {
          _count: { select: { attendances: { where: { status: "CONFIRMED" } } } },
          activityPositions: targetActivityId
            ? { where: { activityId: targetActivityId } }
            : false,
        },
      },
    },
    orderBy: { user: { name: "asc" } },
  });

  const players = memberships.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
    phoneNumber: m.user.phoneNumber,
    role: m.role,
    positions: m.user.activityPositions?.[0]?.positions ?? [],
    seedRating: m.user.seedRating,
    isActive: m.user.isActive,
    leftAt: m.leftAt ? m.leftAt.toISOString() : null,
    _count: m.user._count,
  }));

  return NextResponse.json({ players, activityId: targetActivityId });
}
