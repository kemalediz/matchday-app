"use server";

import { auth } from "@/lib/auth";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { revalidatePath } from "next/cache";

export async function attendMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await registerAttendance(session.user.id, matchId);

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  revalidatePath("/");
}

export async function dropFromMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await cancelAttendance(session.user.id, matchId);

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  revalidatePath("/");
}
