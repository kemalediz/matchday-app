"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { onboardingSchema, playerPositionsSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { normalisePhone } from "@/lib/phone";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function completeOnboarding(formData: { name: string; phoneNumber?: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = onboardingSchema.parse(formData);

  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.name,
      phoneNumber: parsed.phoneNumber || null,
      onboarded: true,
    },
  });

  redirect("/");
}

export async function updateProfile(formData: { name: string; phoneNumber?: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = onboardingSchema.parse(formData);

  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.name,
      phoneNumber: parsed.phoneNumber || null,
    },
  });

  revalidatePath("/profile");
}

/**
 * Set the signed-in user's positions for a specific activity. A row is
 * created on first call per (user, activity).
 */
export async function setMyPositions(formData: { activityId: string; positions: string[] }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = playerPositionsSchema.parse(formData);

  // Verify the user is a member of the org owning this activity.
  const activity = await db.activity.findUnique({
    where: { id: parsed.activityId },
    select: { orgId: true, sport: { select: { positions: true } } },
  });
  if (!activity) throw new Error("Activity not found");
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId: activity.orgId } },
  });
  if (!membership) throw new Error("Not a member of this organisation");

  // Validate picks against the activity's sport's position list.
  const valid = new Set(activity.sport.positions);
  const cleaned = parsed.positions.filter((p) => valid.has(p));
  if (cleaned.length === 0) throw new Error("No valid positions picked");

  await db.playerActivityPosition.upsert({
    where: { userId_activityId: { userId: session.user.id, activityId: parsed.activityId } },
    create: { userId: session.user.id, activityId: parsed.activityId, positions: cleaned },
    update: { positions: cleaned },
  });

  revalidatePath("/profile");
  revalidatePath(`/matches`);
  return { positions: cleaned };
}

/**
 * Admin: set a player's positions for a specific activity in this org.
 *
 * Under the hood we propagate the positions to EVERY activity in the same
 * org that shares the same sport. Rationale: "I play goalkeeper when I
 * play football here" is a property of (player, org, sport), not
 * (player, activity). If you set GK on Tuesday 7-a-side, Tuesday 5-a-side
 * gets it too because it's the same sport. You can still diverge by
 * passing different positions for a different-sport activity.
 */
export async function setPlayerPositions(
  userId: string,
  activityId: string,
  positions: string[],
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: { orgId: true, sportId: true, sport: { select: { positions: true } } },
  });
  if (!activity) throw new Error("Activity not found");

  await requireOrgAdmin(session.user.id, activity.orgId);

  const targetMembership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId: activity.orgId } },
  });
  if (!targetMembership) throw new Error("Player is not a member of this organisation");

  const valid = new Set(activity.sport.positions);
  const cleaned = positions.filter((p) => valid.has(p));
  if (cleaned.length === 0) throw new Error("No valid positions picked");

  // Find every activity in this org with the same sport — positions apply
  // to all of them, not just the one the admin clicked on.
  const sameSportActivities = await db.activity.findMany({
    where: { orgId: activity.orgId, sportId: activity.sportId },
    select: { id: true },
  });

  await db.$transaction(
    sameSportActivities.map((a) =>
      db.playerActivityPosition.upsert({
        where: { userId_activityId: { userId, activityId: a.id } },
        create: { userId, activityId: a.id, positions: cleaned },
        update: { positions: cleaned },
      }),
    ),
  );

  revalidatePath("/admin/players");
  revalidatePath("/admin/players/positions");
  return { positions: cleaned };
}

export async function updatePlayerRole(userId: string, orgId: string, role: "ADMIN" | "PLAYER") {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  await db.membership.update({
    where: { userId_orgId: { userId, orgId } },
    data: { role },
  });

  revalidatePath("/admin/players");
}

export async function seedPlayerRating(userId: string, orgId: string, rating: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  if (rating < 1 || rating > 10) throw new Error("Rating must be between 1 and 10");

  await db.user.update({
    where: { id: userId },
    data: { seedRating: rating },
  });

  revalidatePath("/admin/players");
}

/**
 * Admin: confirm that an auto-provisioned player is real. Clears the
 * provisionallyAddedAt flag so the "NEW" badge disappears. Does not
 * touch anything else — phone/positions/rating are edited via the
 * usual inputs on the same row.
 */
export async function confirmProvisionalPlayer(userId: string, orgId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  await db.membership.update({
    where: { userId_orgId: { userId, orgId } },
    data: { provisionallyAddedAt: null },
  });

  revalidatePath("/admin/players");
  revalidatePath("/admin");
}

/**
 * Admin: remove a player who was auto-provisioned but shouldn't have
 * been (e.g. non-playing group member). Sets leftAt, preserving any
 * attendance/rating history.
 */
export async function removeProvisionalPlayer(userId: string, orgId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  await db.membership.update({
    where: { userId_orgId: { userId, orgId } },
    data: { leftAt: new Date(), provisionallyAddedAt: null },
  });

  revalidatePath("/admin/players");
  revalidatePath("/admin");
}

export async function updatePlayerPhone(userId: string, orgId: string, phone: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  if (!membership) throw new Error("Player is not a member of this organisation");

  const normalised = normalisePhone(phone);

  try {
    await db.user.update({ where: { id: userId }, data: { phoneNumber: normalised } });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      throw new Error(`Phone number ${normalised} is already assigned to another player`);
    }
    throw err;
  }

  revalidatePath("/admin/players");
  revalidatePath("/admin/players/phones");
  return { phoneNumber: normalised };
}
