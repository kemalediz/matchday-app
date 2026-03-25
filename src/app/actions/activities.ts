"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { activitySchema } from "@/lib/validations";
import { FORMAT_CONFIG, ADMIN_EMAIL } from "@/lib/constants";
import { revalidatePath } from "next/cache";

export async function createActivity(formData: {
  name: string;
  dayOfWeek: number;
  time: string;
  venue: string;
  format: "FIVE_A_SIDE" | "SEVEN_A_SIDE";
  deadlineHours?: number;
  ratingWindowHours?: number;
}) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

  const parsed = activitySchema.parse(formData);

  await db.activity.create({ data: parsed });

  revalidatePath("/admin/activities");
}

export async function updateActivity(
  activityId: string,
  formData: {
    name?: string;
    dayOfWeek?: number;
    time?: string;
    venue?: string;
    format?: "FIVE_A_SIDE" | "SEVEN_A_SIDE";
    deadlineHours?: number;
    ratingWindowHours?: number;
    isActive?: boolean;
  }
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

  await db.activity.update({
    where: { id: activityId },
    data: formData,
  });

  revalidatePath("/admin/activities");
}

export async function deleteActivity(activityId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

  await db.activity.update({
    where: { id: activityId },
    data: { isActive: false },
  });

  revalidatePath("/admin/activities");
}

export async function generateMatchesForActivity(activityId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

  const activity = await db.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw new Error("Activity not found");

  // Find next occurrence of this day of week
  const now = new Date();
  const currentDay = now.getDay();
  let daysUntil = activity.dayOfWeek - currentDay;
  if (daysUntil <= 0) daysUntil += 7;

  const matchDate = new Date(now);
  matchDate.setDate(now.getDate() + daysUntil);
  const [hours, minutes] = activity.time.split(":").map(Number);
  matchDate.setHours(hours, minutes, 0, 0);

  // Check if match already exists for this date
  const startOfDay = new Date(matchDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(matchDate);
  endOfDay.setHours(23, 59, 59, 999);

  const existing = await db.match.findFirst({
    where: {
      activityId,
      date: { gte: startOfDay, lte: endOfDay },
    },
  });

  if (existing) throw new Error("Match already exists for this date");

  const deadline = new Date(matchDate.getTime() - activity.deadlineHours * 60 * 60 * 1000);
  const config = FORMAT_CONFIG[activity.format];

  await db.match.create({
    data: {
      activityId,
      date: matchDate,
      format: activity.format,
      maxPlayers: config.maxPlayers,
      attendanceDeadline: deadline,
    },
  });

  revalidatePath("/matches");
  revalidatePath("/admin/activities");
  revalidatePath("/");
}
