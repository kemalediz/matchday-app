import { db } from "@/lib/db";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { NextResponse } from "next/server";

function verifyApiKey(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  return apiKey === process.env.WHATSAPP_API_KEY;
}

export async function POST(request: Request) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { phoneNumber, action, groupId } = body as {
    phoneNumber: string;
    action: "IN" | "OUT";
    groupId?: string;
  };

  if (!phoneNumber || !action) {
    return NextResponse.json({ error: "phoneNumber and action required" }, { status: 400 });
  }

  // Normalize phone number to E.164
  const normalized = phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`;

  // Find user by phone number
  const user = await db.user.findUnique({
    where: { phoneNumber: normalized },
  });

  if (!user) {
    return NextResponse.json({
      error: "unknown_player",
      message: `No player found with phone number ${normalized}. Ask them to add their phone number in the MatchDay app.`,
    }, { status: 404 });
  }

  // Find the org by groupId or user's first org
  let orgId: string | undefined;
  if (groupId) {
    const org = await db.organisation.findFirst({
      where: { whatsappGroupId: groupId },
    });
    if (org) orgId = org.id;
  }

  if (!orgId) {
    const membership = await db.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    orgId = membership?.orgId;
  }

  if (!orgId) {
    return NextResponse.json({ error: "No organisation found" }, { status: 404 });
  }

  // Must have a live (non-left) membership in this org to register. If
  // they left the WhatsApp group we've marked their Membership.leftAt;
  // `group_join` will null it out when they're re-added. Until then we
  // silently drop their IN/OUT — treat them like an unknown player so
  // the bot stays quiet and admins can decide.
  const activeMembership = await db.membership.findUnique({
    where: { userId_orgId: { userId: user.id, orgId } },
    select: { leftAt: true },
  });
  if (!activeMembership || activeMembership.leftAt !== null) {
    return NextResponse.json(
      {
        error: "unknown_player",
        message: `Phone ${normalized} is no longer a member of this org.`,
      },
      { status: 404 },
    );
  }

  // Find the next upcoming match for this org
  const now = new Date();
  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: now },
    },
    include: { activity: true },
    orderBy: { date: "asc" },
  });

  if (!nextMatch) {
    return NextResponse.json({
      error: "no_match",
      message: "No upcoming match found or the deadline has passed.",
    }, { status: 404 });
  }

  try {
    if (action === "IN") {
      const result = await registerAttendance(user.id, nextMatch.id);
      return NextResponse.json({
        success: true,
        player: user.name,
        match: nextMatch.activity.name,
        matchDate: nextMatch.date,
        status: result.status,
        confirmed: result.confirmedCount,
        max: result.maxPlayers,
      });
    } else {
      await cancelAttendance(user.id, nextMatch.id);
      const confirmedCount = await db.attendance.count({
        where: { matchId: nextMatch.id, status: "CONFIRMED" },
      });
      return NextResponse.json({
        success: true,
        player: user.name,
        match: nextMatch.activity.name,
        status: "DROPPED",
        confirmed: confirmedCount,
        max: nextMatch.maxPlayers,
      });
    }
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : "Failed",
    }, { status: 400 });
  }
}
