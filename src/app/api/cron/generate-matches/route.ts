import { db } from "@/lib/db";
import { FORMAT_CONFIG } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const activities = await db.activity.findMany({ where: { isActive: true } });
  let created = 0;

  for (const activity of activities) {
    // Find next occurrence of this day of week
    const now = new Date();
    const currentDay = now.getDay();
    let daysUntil = activity.dayOfWeek - currentDay;
    if (daysUntil <= 0) daysUntil += 7;

    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + daysUntil);
    const [hours, minutes] = activity.time.split(":").map(Number);
    matchDate.setHours(hours, minutes, 0, 0);

    // Check if match already exists
    const startOfDay = new Date(matchDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(matchDate);
    endOfDay.setHours(23, 59, 59, 999);

    const existing = await db.match.findFirst({
      where: { activityId: activity.id, date: { gte: startOfDay, lte: endOfDay } },
    });

    if (!existing) {
      const deadline = new Date(matchDate.getTime() - activity.deadlineHours * 60 * 60 * 1000);
      const config = FORMAT_CONFIG[activity.format];

      await db.match.create({
        data: {
          activityId: activity.id,
          date: matchDate,
          format: activity.format,
          maxPlayers: config.maxPlayers,
          attendanceDeadline: deadline,
        },
      });
      created++;
    }
  }

  return NextResponse.json({ created });
}
