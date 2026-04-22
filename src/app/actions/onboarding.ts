"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseWhatsAppChat, type ParsedChat } from "@/lib/whatsapp-parser";
import { SPORT_PRESETS, findPreset } from "@/lib/sport-presets";
import { setCurrentOrgId } from "@/lib/org";
import { normalisePhone } from "@/lib/phone";
import { analyzeForOnboarding, type OnboardingAnalysis } from "@/lib/onboarding-analyzer";
import { revalidatePath } from "next/cache";

/**
 * Server-side counterpart for the onboarding wizard (/onboarding).
 *
 * All actions require an authenticated session but DO NOT require an
 * existing org — this is how a new admin gets one in the first place.
 *
 * Safety: this file never touches existing Organisations, Activities,
 * Users or Memberships belonging to other orgs. Everything is additive.
 */

export interface ParsedChatSummary {
  groupName: string | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  totalMessages: number;
  authors: Array<{
    name: string;
    phone: string | null;
    messageCount: number;
    firstSeen: string;
    lastSeen: string;
  }>;
}

/**
 * Step 1. Parse an uploaded chat export and return a summary the UI can
 * render. We intentionally don't persist anything at this point — the
 * admin might scrap and re-upload. Expensive LLM analysis happens in a
 * separate action once the admin confirms the player list.
 */
export async function parseChatUpload(fileText: string): Promise<ParsedChatSummary> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  // Cap at ~5MB of text to protect the server; typical 2-year chat for a
  // 14-person group is <2MB.
  const MAX = 5 * 1024 * 1024;
  if (fileText.length > MAX) {
    throw new Error(`Chat export too large (${Math.round(fileText.length / 1024 / 1024)}MB). Max 5MB.`);
  }

  const parsed = parseWhatsAppChat(fileText, { recentMessageLimit: 1 });
  return summariseForClient(parsed);
}

function summariseForClient(parsed: ParsedChat): ParsedChatSummary {
  return {
    groupName: parsed.groupName,
    firstMessageAt: parsed.firstMessageAt?.toISOString() ?? null,
    lastMessageAt: parsed.lastMessageAt?.toISOString() ?? null,
    totalMessages: parsed.totalMessages,
    authors: parsed.authors.map((a) => ({
      name: a.name,
      phone: a.phone,
      messageCount: a.messageCount,
      firstSeen: a.firstSeen.toISOString(),
      lastSeen: a.lastSeen.toISOString(),
    })),
  };
}

export interface WizardSubmission {
  orgName: string;
  players: Array<{
    name: string;
    phone?: string;
    /** Optional seed rating 1-10 the admin sets manually at wizard time.
     *  LLM-powered suggestions arrive in a later slice. */
    seedRating?: number;
  }>;
  activity: {
    sportKey: string;
    name: string;
    dayOfWeek: number; // 0-6 (0 = Sunday)
    time: string; // HH:MM, 24h
    venue: string;
    matchDurationMins: number;
  };
}

export interface WizardResult {
  orgId: string;
  slug: string;
  playersCreated: number;
  playersLinkedExisting: number;
}

/**
 * Step 5. Final commit: create Organisation, seed Sports, create Activity,
 * create Users (+ link to this org as Memberships), set the owner.
 *
 * Transactional so a partial failure doesn't leave a half-built org
 * behind. On conflicting slug the admin gets a clear error and can pick
 * a new name.
 */
export async function createOrgFromWizard(data: WizardSubmission): Promise<WizardResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const userId = session.user.id;

  // Validate inputs cheaply up-front.
  if (!data.orgName || data.orgName.trim().length < 2) {
    throw new Error("Organisation name is required");
  }
  const preset = findPreset(data.activity.sportKey);
  if (!preset) throw new Error("Pick a sport");
  if (data.players.length === 0) {
    throw new Error("Add at least one player");
  }
  if (!/^\d{2}:\d{2}$/.test(data.activity.time)) {
    throw new Error("Time must be HH:MM");
  }

  const slug = slugify(data.orgName);
  const conflict = await db.organisation.findUnique({ where: { slug } });
  if (conflict) {
    throw new Error(`"${slug}" is already taken. Pick a different organisation name.`);
  }

  // Pre-resolve phone numbers to existing users so we don't create dupes.
  const normalisedPlayers = data.players.map((p) => ({
    name: p.name.trim(),
    phone: p.phone ? normalisePhone(p.phone) : null,
    seedRating: p.seedRating ?? null,
  }));

  const existingByPhone = new Map<string, { id: string; name: string | null }>();
  const phonesToLookup = normalisedPlayers
    .map((p) => p.phone)
    .filter((p): p is string => !!p);
  if (phonesToLookup.length > 0) {
    const found = await db.user.findMany({
      where: { phoneNumber: { in: phonesToLookup } },
      select: { id: true, name: true, phoneNumber: true },
    });
    for (const u of found) {
      if (u.phoneNumber) existingByPhone.set(u.phoneNumber, { id: u.id, name: u.name });
    }
  }

  let playersCreated = 0;
  let playersLinkedExisting = 0;

  const result = await db.$transaction(
    async (tx) => {
      // 1. Org + owner membership.
      const org = await tx.organisation.create({
        data: {
          name: data.orgName.trim(),
          slug,
          memberships: {
            create: { userId, role: "OWNER" },
          },
        },
      });

      // 2. Sport row from preset.
      const sport = await tx.sport.create({
        data: {
          orgId: org.id,
          name: preset.name,
          preset: preset.key,
          playersPerTeam: preset.playersPerTeam,
          positions: [...preset.positions],
          teamLabels: [...preset.teamLabels],
          mvpLabel: preset.mvpLabel,
          balancingStrategy: preset.balancingStrategy,
          positionComposition: preset.positionComposition
            ? (preset.positionComposition as Record<string, number>)
            : undefined,
        },
      });

      // 3. Activity.
      await tx.activity.create({
        data: {
          orgId: org.id,
          sportId: sport.id,
          name: data.activity.name.trim() || preset.name,
          dayOfWeek: data.activity.dayOfWeek,
          time: data.activity.time,
          venue: data.activity.venue.trim() || "TBD",
          matchDurationMins: data.activity.matchDurationMins || 60,
          // Leave deadline/rating window defaults to their schema values.
        },
      });

      // 4. Players → Users + Memberships. Reuse existing phone-matched
      //    users if we found any, otherwise create synthetic entries the
      //    player can claim later.
      for (const p of normalisedPlayers) {
        if (!p.name) continue;

        let player = p.phone ? existingByPhone.get(p.phone) : undefined;
        if (!player) {
          const emailSlug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "player";
          const user = await tx.user.create({
            data: {
              name: p.name,
              email: `onboarding+${emailSlug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@matchtime.local`,
              phoneNumber: p.phone,
              seedRating: p.seedRating ?? undefined,
              onboarded: false,
              isActive: true,
            },
          });
          player = { id: user.id, name: user.name };
          playersCreated += 1;
        } else {
          // Existing user — nudge their seed rating only if blank.
          if (p.seedRating != null) {
            await tx.user.updateMany({
              where: { id: player.id, seedRating: null },
              data: { seedRating: p.seedRating },
            });
          }
          playersLinkedExisting += 1;
        }

        // Skip if the current admin's userId shows up as a player too —
        // they already have an OWNER membership. Avoid creating a second
        // PLAYER row for the same (user, org) pair (the @@unique would
        // throw).
        if (player.id === userId) continue;

        await tx.membership.upsert({
          where: { userId_orgId: { userId: player.id, orgId: org.id } },
          create: { userId: player.id, orgId: org.id, role: "PLAYER" },
          update: {},
        });
      }

      return { orgId: org.id, slug: org.slug };
    },
    { timeout: 30_000 },
  );

  await setCurrentOrgId(result.orgId);
  revalidatePath("/");
  return { ...result, playersCreated, playersLinkedExisting };
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/** Presets exposed to the client for the activity-picker step. */
export async function listSportPresets() {
  return SPORT_PRESETS.map((p) => ({
    key: p.key,
    name: p.name,
    playersPerTeam: p.playersPerTeam,
  }));
}

/**
 * Step 3. Optional LLM analysis — reads the chat text (client sends the
 * same file contents back) and returns per-player position + seed rating
 * suggestions with evidence, plus a best-guess schedule.
 *
 * Isolated from the main flow: if this fails, the wizard still works
 * with the manual defaults. Nothing is persisted yet.
 */
export async function analyzeOnboardingChat(
  fileText: string,
  sportKey: string,
  candidateNames: string[],
): Promise<OnboardingAnalysis | null> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (fileText.length > 5 * 1024 * 1024) {
    throw new Error("Chat export too large");
  }
  const preset = findPreset(sportKey);
  if (!preset) throw new Error("Unknown sport");

  const parsed = parseWhatsAppChat(fileText, { recentMessageLimit: 15_000 });
  return analyzeForOnboarding({
    parsed,
    sportName: preset.name,
    validPositions: [...preset.positions],
    candidateNames,
  });
}
