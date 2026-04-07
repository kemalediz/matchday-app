import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgs = await db.organisation.findMany({
    where: {
      whatsappBotEnabled: true,
      whatsappGroupId: { not: null },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      whatsappGroupId: true,
    },
  });

  return NextResponse.json({ orgs });
}
