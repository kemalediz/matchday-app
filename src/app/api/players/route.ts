import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await getUserOrg(session.user.id);
  if (!membership) return NextResponse.json({ error: "No organisation" }, { status: 404 });

  // Primary active activity — used to surface positions in the list view.
  const primaryActivity = await db.activity.findFirst({
    where: { orgId: membership.orgId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const memberships = await db.membership.findMany({
    where: { orgId: membership.orgId },
    include: {
      user: {
        include: {
          _count: { select: { attendances: { where: { status: "CONFIRMED" } } } },
          activityPositions: primaryActivity
            ? { where: { activityId: primaryActivity.id } }
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
    _count: m.user._count,
  }));

  return NextResponse.json(players);
}
