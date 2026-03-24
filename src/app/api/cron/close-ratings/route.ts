import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // This endpoint is a no-op for now since rating windows are checked at request time.
  // It can be extended to send notifications, compute final averages, etc.

  return NextResponse.json({ ok: true });
}
