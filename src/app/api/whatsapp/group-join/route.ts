/**
 * Bot-forwarded WhatsApp `group_join` event. Auto-onboards new WhatsApp
 * group members into the matching org so admins don't have to add every
 * phone by hand at /admin/players/phones.
 *
 * Flow (per recipient phone in the payload):
 *   1. Find org by `whatsappGroupId`. 404 if the group isn't bot-enabled.
 *   2. Normalise phone to E.164. Silently ignore anything that doesn't
 *      parse — @lid recipients, weird numbers, etc.
 *   3. Upsert a `User` row keyed by phone. Brand-new users are created
 *      with `name=null`; admin fills it in later via the portal.
 *   4. Upsert a `Membership` as PLAYER. If one already existed with
 *      `leftAt` set, clear it (a left member has rejoined).
 *   5. Queue a `BotJob` DM to every org admin ONLY on state change —
 *      brand-new user or rejoin after leaving. Already-active members
 *      don't spam admins.
 *
 * Accepts `{ groupId, phones: string[] }` so a single event carrying
 * several added recipients gets one round-trip.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { findOrgAdminsWithPhone } from "@/lib/org";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { groupId, phones } = (body ?? {}) as {
    groupId?: string;
    phones?: string[];
  };

  if (!groupId || !Array.isArray(phones) || phones.length === 0) {
    return NextResponse.json(
      { error: "groupId and non-empty phones[] required" },
      { status: 400 },
    );
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
    select: { id: true, name: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-or-disabled-group" });
  }

  const admins = await findOrgAdminsWithPhone(org.id);

  type Result = {
    phone: string;
    created: boolean;
    rejoined: boolean;
    alreadyActive: boolean;
    skipped?: string;
    userId?: string;
    name?: string | null;
  };
  const results: Result[] = [];

  for (const raw of phones) {
    const normalised = normalisePhone(raw);
    if (!normalised) {
      results.push({ phone: raw, created: false, rejoined: false, alreadyActive: false, skipped: "bad-phone" });
      continue;
    }

    // Step 3: find or create the user.
    let user = await db.user.findUnique({
      where: { phoneNumber: normalised },
      select: { id: true, name: true, email: true },
    });
    let created = false;
    if (!user) {
      // `email` is required + unique on User. Placeholder unique value the
      // admin can overwrite when they fill in name/email. Using the phone
      // guarantees uniqueness and makes the source obvious in the DB.
      const placeholderEmail = `wa-${normalised.replace(/^\+/, "")}@placeholder.matchtime`;
      user = await db.user.create({
        data: {
          name: null,
          email: placeholderEmail,
          phoneNumber: normalised,
          onboarded: false,
          isActive: true,
        },
        select: { id: true, name: true, email: true },
      });
      created = true;
    }

    // Step 4: upsert membership.
    const existing = await db.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      select: { id: true, leftAt: true, role: true },
    });
    let rejoined = false;
    let alreadyActive = false;
    if (!existing) {
      await db.membership.create({
        data: { userId: user.id, orgId: org.id, role: "PLAYER" },
      });
    } else if (existing.leftAt) {
      await db.membership.update({
        where: { id: existing.id },
        data: { leftAt: null },
      });
      rejoined = true;
    } else {
      alreadyActive = true;
    }

    // Step 5: queue admin DM only on state change.
    if (!alreadyActive && admins.length > 0) {
      const displayName = user.name?.trim() || normalised;
      const lines = created
        ? [
            `🆕 New player joined *${org.name}* on WhatsApp.`,
            ``,
            `Phone: ${normalised}`,
            `I've added them as a placeholder player — please set their name:`,
            `/admin/players/phones`,
          ]
        : [
            `🔁 *${displayName}* rejoined *${org.name}*'s WhatsApp group.`,
            ``,
            `Their membership has been re-activated. No further action needed.`,
          ];
      const text = lines.join("\n");

      for (const admin of admins) {
        // Same-person admin getting DM'd about themselves would be silly.
        if (admin.id === user.id) continue;
        await db.botJob.create({
          data: {
            orgId: org.id,
            kind: "dm",
            phone: admin.phoneNumber.replace(/^\+/, ""),
            text,
          },
        });
      }
    }

    results.push({
      phone: normalised,
      created,
      rejoined,
      alreadyActive,
      userId: user.id,
      name: user.name,
    });
  }

  return NextResponse.json({ ok: true, orgId: org.id, results });
}
