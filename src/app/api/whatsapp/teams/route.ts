import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { format } from "date-fns";

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get("groupId");

  if (!groupId) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId },
  });

  if (!org) {
    return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
  }

  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["TEAMS_PUBLISHED", "COMPLETED"] },
    },
    include: {
      activity: true,
      teamAssignments: {
        include: { user: { select: { name: true, positions: true } } },
      },
    },
    orderBy: { date: "desc" },
  });

  if (!match || match.teamAssignments.length === 0) {
    return NextResponse.json({ teams: null, message: "No teams published yet" });
  }

  const red = match.teamAssignments
    .filter((a) => a.team === "RED")
    .map((a) => ({ name: a.user.name, position: a.user.positions[0] }));
  const yellow = match.teamAssignments
    .filter((a) => a.team === "YELLOW")
    .map((a) => ({ name: a.user.name, position: a.user.positions[0] }));

  return NextResponse.json({
    match: {
      name: match.activity.name,
      date: format(match.date, "EEEE d MMMM 'at' HH:mm"),
    },
    teams: { red, yellow },
  });
}
