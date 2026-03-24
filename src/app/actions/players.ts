"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { onboardingSchema } from "@/lib/validations";
import { Position } from "@/generated/prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function completeOnboarding(formData: { name: string; positions: string[] }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = onboardingSchema.parse(formData);

  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.name,
      positions: parsed.positions as Position[],
      onboarded: true,
    },
  });

  redirect("/");
}

export async function updateProfile(formData: { name: string; positions: string[] }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = onboardingSchema.parse(formData);

  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.name,
      positions: parsed.positions as Position[],
    },
  });

  revalidatePath("/profile");
}

export async function updatePlayerRole(userId: string, role: "ADMIN" | "PLAYER") {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (user?.role !== "ADMIN") throw new Error("Admin only");

  await db.user.update({
    where: { id: userId },
    data: { role },
  });

  revalidatePath("/admin/players");
}

export async function seedPlayerRating(userId: string, rating: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (user?.role !== "ADMIN") throw new Error("Admin only");

  if (rating < 1 || rating > 10) throw new Error("Rating must be between 1 and 10");

  await db.user.update({
    where: { id: userId },
    data: { seedRating: rating },
  });

  revalidatePath("/admin/players");
}
