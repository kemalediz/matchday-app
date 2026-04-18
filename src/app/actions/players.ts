"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { onboardingSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { normalisePhone } from "@/lib/phone";
import { Position } from "@/generated/prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function completeOnboarding(formData: { name: string; phoneNumber?: string; positions: string[] }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = onboardingSchema.parse(formData);

  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.name,
      phoneNumber: parsed.phoneNumber || null,
      positions: parsed.positions as Position[],
      onboarded: true,
    },
  });

  redirect("/");
}

export async function updateProfile(formData: { name: string; phoneNumber?: string; positions: string[] }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = onboardingSchema.parse(formData);

  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.name,
      phoneNumber: parsed.phoneNumber || null,
      positions: parsed.positions as Position[],
    },
  });

  revalidatePath("/profile");
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

export async function updatePlayerPhone(userId: string, orgId: string, phone: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  // Verify the target user is actually a member of this org (stops cross-org writes).
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  if (!membership) throw new Error("Player is not a member of this organisation");

  const normalised = normalisePhone(phone);

  try {
    await db.user.update({
      where: { id: userId },
      data: { phoneNumber: normalised },
    });
  } catch (err: unknown) {
    // Prisma P2002 = unique constraint (phoneNumber is @unique)
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      throw new Error(`Phone number ${normalised} is already assigned to another player`);
    }
    throw err;
  }

  revalidatePath("/admin/players");
  revalidatePath("/admin/players/phones");
  return { phoneNumber: normalised };
}
