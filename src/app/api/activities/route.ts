import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const activities = await db.activity.findMany({
    orderBy: { dayOfWeek: "asc" },
  });

  return NextResponse.json(activities);
}
