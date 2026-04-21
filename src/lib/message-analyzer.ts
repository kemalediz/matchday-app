/**
 * Smart WhatsApp message analysis — the LLM pass that handles
 * anything the regex fast-path can't classify.
 *
 * Pipeline:
 *   - Regex fast-path (on the bot) still runs first and handles
 *     instant IN/OUT/score reactions without ever hitting this code.
 *   - Anything it can't classify (drops with excuses, conditional
 *     joins, squad questions, social chatter) lands here.
 *
 * Batching:
 *   - Messages accumulate in a per-group in-memory buffer on the bot.
 *   - Every ~10 min (or immediately on urgency — match within 1h),
 *     the bot flushes the buffer as a single batch to
 *     /api/whatsapp/analyze, which calls this function once.
 *   - One Claude call returns verdicts for every message in the batch;
 *     the bot executes them.
 *
 * Caching:
 *   - System prompt + match/squad/org context live in cache blocks
 *     with a 1-hour TTL. The match context is re-written only when
 *     attendance or match state actually changes; otherwise every
 *     batch reuses the cached prefix.
 *   - Only the recent-chat-history block + the current batch of
 *     messages are fresh tokens per call.
 */
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";

const MODEL = "claude-haiku-4-5";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

export type AnalysisIntent =
  | "in"
  | "out"
  | "replacement_request"
  | "conditional_in"
  | "question"
  | "score"
  | "noise"
  | "unclear";

export interface BatchInputMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  authorUserId: string | null;
  timestamp: Date;
}

export interface BatchInputHistory {
  authorName: string | null;
  body: string;
  timestamp: Date;
}

export interface AnalysisVerdict {
  waMessageId: string;
  intent: AnalysisIntent;
  confidence: number;
  react: string | null;
  reply: string | null;
  registerAttendance: "IN" | "OUT" | null;
  /** Populated when intent = "score". `scoreRed` + `scoreYellow` correspond
   *  to the two team labels of the match's sport (usually Red/Yellow). */
  scoreRed: number | null;
  scoreYellow: number | null;
  reasoning: string;
}

export interface AnalysisBatchInput {
  groupId: string;
  messages: BatchInputMessage[];
  history: BatchInputHistory[];
}

const SYSTEM_PROMPT = `You are MatchTime, a WhatsApp bot that helps run a weekly amateur match (typically football). You watch a group chat and classify every message. The bot executes your output directly, so be precise.

You respond with JSON only — no markdown fences, no prose. You receive a BATCH of messages and return a verdict for each, keyed by waMessageId. Messages are oldest-first.

Output schema:
{
  "verdicts": [
    {
      "waMessageId": "<string>",
      "intent": "in" | "out" | "replacement_request" | "conditional_in" | "question" | "score" | "noise" | "unclear",
      "confidence": 0..1,
      "react": "<emoji>" | null,
      "reply": "<text>" | null,
      "registerAttendance": "IN" | "OUT" | null,
      "scoreRed": <number> | null,
      "scoreYellow": <number> | null,
      "reasoning": "<short internal explanation>"
    }
  ]
}

Intent rules:
- "in": Clearly joining the match ("IN", "I'm in", "count me in", "I'll play", "yes playing").
  → registerAttendance: "IN". react: "👍" (the bot may override with a slot-number emoji 1️⃣–🔟 / 🪑 / ⚽ — that's fine).
- "out": Dropping out without asking for cover ("OUT", "can't make it", "not playing tonight", "sorry guys, work").
  → registerAttendance: "OUT". react: "👋".
- "replacement_request": Player asks the group to find cover because they're unwell, running late, or otherwise compromised. Two flavours:
  (a) Definite drop ("I'm out, ankle sore, can anyone step in?"). registerAttendance: "OUT". react: "👋".
  (b) Tentative ("anyone else who can replace me too? If not I'll still join", "feeling unwell, will play if nobody steps in"). registerAttendance: null (do NOT flip — they're still committed as a backstop). react: "🤔".
  Reply format depends on how short the squad actually is (see SHORT-SQUAD RESPONSE below).
- "conditional_in": Tentative commitment ("in if my back holds up", "probably, will confirm later", "maybe").
  → registerAttendance: null (do NOT register; admin will chase). react: "🤔". reply: null.
- "question": Asking about squad numbers, venue, kickoff time, who's in, match state ("do we have enough?", "where tonight?", "who's playing?").
  → registerAttendance: null. react: null. reply: a short accurate answer grounded in the Match Context block (e.g. "We're 13/14 ✅ — need 1 more", "Tonight 21:30 at <venue>"). If the answer isn't in context, reply: null.
- "score": A final match result like "7-3", "Final 5:2", "we won 4-2" posted after the game.
  → Populate scoreRed + scoreYellow with the two numbers. Order: if the message explicitly names the team labels, align accordingly; otherwise emit the numbers in the order they appear in the message. react: "👍". registerAttendance: null.
- "noise": Social chat, jokes, memes, photos, links, tangential banter, off-topic questions (recipe links, memes, sports trivia).
  → Everything null.
- "unclear": Genuinely can't tell. Everything null — bot stays silent.

CHASE behaviour (important):
- When someone drops (intent "out" or "replacement_request") AND the resulting squad is short (confirmed < maxPlayers per the Match Context), you should nudge the group.
- If someone in the batch stepped in to cover (intent "in" after a recent drop), you've got it covered — do NOT emit another chase reply.
- Don't chase on every single "out" — only when the squad actually goes below full after that drop.
- Use the SHORT-SQUAD RESPONSE format below for the reply.

SQUAD-STATE REPLY SHAPE (mandatory roster block):
Every reply that concerns attendance state — "replacement_request", an "out" that leaves the squad short, a "question" about numbers or who's playing — must END with a numbered roster so everyone in the group can see the state at a glance. Roster rules:

- Length: exactly maxPlayers rows (e.g. 14 rows for 7-a-side).
- Fill rows 1..confirmedCount with names from the Match Context Confirmed list, in the order they appear there. Do NOT re-order, do NOT invent names, do NOT shorten ("Ehtisham Ul Haq" can become "Ehtisham" for brevity but no further).
- Any row above confirmedCount is an OPEN slot — render it as 🥁 (a single drum — keeps it tidy).
- If a player is in the Dropped list AND their most recent message in the provided history said they'll still play if nobody steps in (e.g. "but if no one comes I'll still join", "feeling rough, will play as fallback"), mention them in a separate *Tentative:* line UNDER the roster. Format: "Tentative: <Name> (will play if nobody steps in)". Never put them in a numbered slot — those slots are for definitely-confirmed players only.
- If nobody is tentative, omit the Tentative line.

Above the roster, vary the lead depending on how short we are:
- Short by 1: one sentence, e.g. "Sorry to hear, Ibrahim — can anyone step in?"
- Short by 2+ OR multiple drops in the Dropped list: a richer lead — name who can't make it (from the Dropped list + any new drop in this batch, with stated reasons only, no invention), then the count ("We're 12/14 — need 2 more"), then the FORMAT SWITCH suggestion on its own line IF the conditions hold.
- Questions about state ("who's playing?", "do we have enough?"): open with the count, then the roster.

Formatting rules:
- WhatsApp-friendly markdown: *bold* with single asterisks, newlines as real line breaks, no code fences.
- Blank line between the lead and the roster.
- One or two emoji total — no soup.
- Header the roster with "*Playing tonight:*" or "*Squad:*" so it's scannable.

Example (12/14, Ibrahim + Ehtisham dropped, Ehtisham tentative):
"Ibrahim (ankle) and Ehtisham (not 100%) are out — we're 12/14, need 2 more. Anyone free? 🙏

*Playing tonight:*
1. Elvin
2. Mustafa
3. Idris
4. Sait
5. Kemal
6. Elnur
7. Najib
8. Wasim
9. Aydın
10. Mauricio
11. Ersin
12. Habib
13. 🥁
14. 🥁

Tentative: Ehtisham (will play if nobody steps in)"

FORMAT SWITCH (important):
- The Match Context block may list "Alternative formats available for this sport" (e.g. Football 5-a-side = 10 players when the current match is 7-a-side = 14). When it does, you can propose switching to a smaller format in your reply — but only when ALL of these are true:
  1. Confirmed squad is BELOW maxPlayers (we're short).
  2. Kickoff is within ~24 hours (see "X.Xh until kickoff" in the context).
  3. Confirmed count is >= the smaller format's total players (we'd actually fill the smaller format).
- When you propose it, keep it to one sentence on top of (or instead of) the chase, and mention that the extra players go to the bench — NOT dropped. Example: "We're 12/14 for 7-a-side — still need 2. If we don't find them, we could switch to 5-a-side (10 players) and Mauricio + Aydın go on the bench. Admins can toggle via the portal."
- Use the ACTUAL player names from the Confirmed list for who'd go to the bench — take the last N confirmed (where N = confirmed - smallerFormatTotal). Never invent names.
- Don't suggest a switch more than once per batch (dedupe reply across verdicts).
- Never execute the switch yourself. This is just a recommendation — admins toggle it via /admin.

State collapse (when SAME author has multiple messages in the batch):
- Only the LATEST message gets the attendance side-effect. Earlier messages from the same author get registerAttendance: null (react/reply can still happen for those).
- Example: "IN if back holds up" at 18:00 → "actually OUT" at 18:03 in the same batch → verdict for 18:00 is conditional_in with no attendance; verdict for 18:03 is out with registerAttendance: OUT.

De-duplicate replies: if multiple people ask the same squad question in this batch, reply on at most ONE verdict. Set reply: null on the others.

Confidence: be honest. If below 0.7 for anything except "noise", downgrade the verdict to "unclear" with everything null. Better silent than wrong.

Reply tone: WhatsApp casual, no corporate fluff. Match the group's energy. Most replies are one short line; use the multi-line SHORT-SQUAD RESPONSE format ONLY when the squad is short by 2+ or there are multiple people in the Dropped list. Never invent facts — if the answer needs info outside the Match Context block, reply: null.`;

function buildMatchContextBlock(args: {
  orgName: string;
  match: {
    activity: { name: string; venue: string };
    date: Date;
    status: string;
    maxPlayers: number;
    attendances: Array<{ status: string; user: { id: string; name: string | null } }>;
  } | null;
  /** Alternative formats for the current sport family (same org, smaller
   *  playersPerTeam). Empty array when nothing smaller exists. */
  alternatives?: Array<{ sportName: string; totalPlayers: number }>;
}): string {
  if (!args.match) {
    return `## Organisation\n${args.orgName}\n\n## Current Match\nNo upcoming match within the attendance window.`;
  }
  const m = args.match;
  const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = m.attendances.filter((a) => a.status === "BENCH");
  const dropped = m.attendances.filter((a) => a.status === "DROPPED");
  const need = Math.max(0, m.maxPlayers - confirmed.length);
  const hoursToKickoff = (m.date.getTime() - Date.now()) / (1000 * 60 * 60);
  const kickoffHint =
    hoursToKickoff > 0
      ? `${hoursToKickoff.toFixed(1)}h until kickoff`
      : `${Math.abs(hoursToKickoff).toFixed(1)}h since kickoff`;
  const lines = [
    `## Organisation`,
    args.orgName,
    ``,
    `## Current Match`,
    `Activity: ${m.activity.name}`,
    `Date: ${m.date.toISOString()}  (${kickoffHint})`,
    `Venue: ${m.activity.venue}`,
    `Status: ${m.status}`,
    `Confirmed: ${confirmed.length}/${m.maxPlayers}${need > 0 ? ` (need ${need} more)` : " ✅ full squad"}`,
    `Bench: ${bench.length}`,
    ``,
    `Confirmed list:`,
    ...confirmed.map((a, i) => `  ${i + 1}. ${a.user.name ?? "(unnamed)"}`),
  ];
  if (bench.length) {
    lines.push("", "Bench list:");
    bench.forEach((a, i) => lines.push(`  ${i + 1}. ${a.user.name ?? "(unnamed)"}`));
  }
  if (dropped.length) {
    lines.push("", `Dropped: ${dropped.map((a) => a.user.name ?? "(unnamed)").join(", ")}`);
  }
  if (args.alternatives && args.alternatives.length > 0) {
    lines.push("", "Alternative formats available for this sport:");
    for (const a of args.alternatives) {
      lines.push(`  - ${a.sportName} (${a.totalPlayers} players total)`);
    }
    lines.push(
      "Admins can toggle via the portal; a switch converts everyone " +
        "above the new cap from confirmed to bench, keeping their order.",
    );
  }
  return lines.join("\n");
}

export async function analyzeBatch(input: AnalysisBatchInput): Promise<AnalysisVerdict[]> {
  if (input.messages.length === 0) return [];

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: input.groupId },
    select: { id: true, name: true },
  });
  if (!org) {
    return input.messages.map((m) => offlineVerdict(m.waMessageId, "Unknown group"));
  }

  // Load the next upcoming match for context.
  const now = new Date();
  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: now },
    },
    include: {
      activity: {
        select: {
          name: true,
          venue: true,
          sport: { select: { name: true, playersPerTeam: true } },
        },
      },
      attendances: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });

  // Load alternative formats the admin has actually set up for this
  // org — only ACTIVE Activity rows count. Sport "family" is the first
  // word of the sport name (e.g. "Football 7-a-side" and "Football
  // 5-a-side" share family "Football"). If the admin hasn't configured
  // a smaller-format Activity, the LLM gets no alternatives and is
  // told to stay silent on the switch option.
  const alternatives: Array<{ sportName: string; totalPlayers: number }> = [];
  if (match) {
    const family = match.activity.sport.name.split(" ")[0];
    const currentPpt = match.activity.sport.playersPerTeam;
    const siblingActivities = await db.activity.findMany({
      where: { orgId: org.id, isActive: true },
      include: { sport: { select: { name: true, playersPerTeam: true } } },
    });
    const seen = new Set<string>();
    for (const a of siblingActivities) {
      if (a.sport.name.split(" ")[0] !== family) continue;
      if (a.sport.playersPerTeam >= currentPpt) continue;
      if (seen.has(a.sport.name)) continue;
      seen.add(a.sport.name);
      alternatives.push({
        sportName: a.sport.name,
        totalPlayers: a.sport.playersPerTeam * 2,
      });
    }
    alternatives.sort((x, y) => y.totalPlayers - x.totalPlayers);
  }

  const matchContext = buildMatchContextBlock({
    orgName: org.name,
    match,
    alternatives,
  });

  const historyBlock = input.history.length
    ? input.history
        .slice(-10)
        .map(
          (h) =>
            `  [${h.timestamp.toISOString().slice(11, 16)}] ${h.authorName ?? "?"}: ${h.body.slice(0, 300)}`,
        )
        .join("\n")
    : "  (no recent context)";

  const messagesBlock = input.messages
    .map((m) => {
      return [
        `- waMessageId: ${m.waMessageId}`,
        `  from: ${m.authorName ?? m.authorPhone ?? "?"}`,
        `  timestamp: ${m.timestamp.toISOString()}`,
        `  body: ${JSON.stringify(m.body.slice(0, 800))}`,
      ].join("\n");
    })
    .join("\n");

  const freshBlock = [
    `## Recent chat history (last messages, oldest first)`,
    historyBlock,
    ``,
    `## Messages to classify (batch)`,
    messagesBlock,
    ``,
    `Return JSON with a verdict for every waMessageId above.`,
  ].join("\n");

  const anthropic = getAnthropic();
  if (!anthropic) {
    return input.messages.map((m) => offlineVerdict(m.waMessageId, "ANTHROPIC_API_KEY not set"));
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      // Generous ceiling so a rich multi-line reply (e.g. lineup with
      // 14 players) can fit alongside the JSON schema.
      max_tokens: 400 + 250 * input.messages.length,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          // 1-hour cache — the system prompt never changes, so we pay
          // the higher 2× write cost once and read cheaply from then on.
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: matchContext,
              // Match/squad context only changes when attendance changes;
              // same 1-hour cache. On DB writes the cache keyed on the
              // content hash naturally invalidates and rebuilds.
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
            {
              type: "text",
              text: freshBlock,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (!textBlock) {
      return input.messages.map((m) => offlineVerdict(m.waMessageId, "No text in Claude response"));
    }
    return normaliseBatch(textBlock.text, input.messages);
  } catch (err) {
    console.error("[analyzer] Claude call failed:", err);
    const reason = `Claude API error: ${err instanceof Error ? err.message : String(err)}`;
    return input.messages.map((m) => offlineVerdict(m.waMessageId, reason));
  }
}

function offlineVerdict(waMessageId: string, reason: string): AnalysisVerdict {
  return {
    waMessageId,
    intent: "unclear",
    confidence: 0,
    react: null,
    reply: null,
    registerAttendance: null,
    scoreRed: null,
    scoreYellow: null,
    reasoning: reason,
  };
}

function safeParseJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const v = JSON.parse(cleaned);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normaliseBatch(text: string, messages: BatchInputMessage[]): AnalysisVerdict[] {
  const parsed = safeParseJson(text);
  const verdictsRaw = Array.isArray((parsed as { verdicts?: unknown })?.verdicts)
    ? ((parsed as { verdicts: unknown[] }).verdicts as unknown[])
    : [];

  const byId = new Map<string, AnalysisVerdict>();
  for (const v of verdictsRaw) {
    if (typeof v !== "object" || v === null) continue;
    const obj = v as Record<string, unknown>;
    const waMessageId = typeof obj.waMessageId === "string" ? obj.waMessageId : null;
    if (!waMessageId) continue;
    byId.set(waMessageId, normaliseVerdict(waMessageId, obj));
  }

  return messages.map((m) => {
    const verdict = byId.get(m.waMessageId);
    if (verdict) return verdict;
    // Claude didn't emit a verdict for this message — treat as unclear
    // so we still record it as handled (no re-analysis later).
    return offlineVerdict(m.waMessageId, "Claude emitted no verdict for this id");
  });
}

function normaliseVerdict(waMessageId: string, raw: Record<string, unknown>): AnalysisVerdict {
  const VALID_INTENTS: AnalysisIntent[] = [
    "in",
    "out",
    "replacement_request",
    "conditional_in",
    "question",
    "score",
    "noise",
    "unclear",
  ];
  const intent = VALID_INTENTS.includes(raw.intent as AnalysisIntent)
    ? (raw.intent as AnalysisIntent)
    : "unclear";

  const confidence =
    typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  const react =
    typeof raw.react === "string" && raw.react.trim().length > 0 ? raw.react.trim() : null;
  const reply =
    typeof raw.reply === "string" && raw.reply.trim().length > 0 ? raw.reply.trim() : null;
  const registerAttendance =
    raw.registerAttendance === "IN" || raw.registerAttendance === "OUT"
      ? raw.registerAttendance
      : null;
  const scoreRed =
    typeof raw.scoreRed === "number" && Number.isFinite(raw.scoreRed) && raw.scoreRed >= 0
      ? Math.min(99, Math.round(raw.scoreRed))
      : null;
  const scoreYellow =
    typeof raw.scoreYellow === "number" && Number.isFinite(raw.scoreYellow) && raw.scoreYellow >= 0
      ? Math.min(99, Math.round(raw.scoreYellow))
      : null;
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";

  // Low-confidence downgrade: wipe all actions so the bot stays silent.
  if (confidence < 0.7 && intent !== "noise") {
    return {
      waMessageId,
      intent: "unclear",
      confidence,
      react: null,
      reply: null,
      registerAttendance: null,
      scoreRed: null,
      scoreYellow: null,
      reasoning: `[low-confidence downgrade] ${reasoning}`,
    };
  }

  return {
    waMessageId,
    intent,
    confidence,
    react,
    reply,
    registerAttendance,
    scoreRed,
    scoreYellow,
    reasoning,
  };
}

// ─── Back-compat shim ─────────────────────────────────────────────────
// Legacy single-message API used by early scripts and as a fallback. Now
// implemented as a batch of size 1 so all paths route through the same
// analyzer.

export interface AnalysisResult {
  intent: AnalysisIntent;
  confidence: number;
  react: string | null;
  reply: string | null;
  registerAttendance: "IN" | "OUT" | null;
  scoreRed: number | null;
  scoreYellow: number | null;
  reasoning: string;
}

export interface AnalysisInput {
  groupId: string;
  message: {
    body: string;
    authorPhone: string;
    authorName: string | null;
    authorUserId: string | null;
    waMessageId: string;
    timestamp: Date;
  };
  history: BatchInputHistory[];
}

export async function analyzeMessage(input: AnalysisInput): Promise<AnalysisResult> {
  const verdicts = await analyzeBatch({
    groupId: input.groupId,
    history: input.history,
    messages: [
      {
        waMessageId: input.message.waMessageId,
        body: input.message.body,
        authorPhone: input.message.authorPhone,
        authorName: input.message.authorName,
        authorUserId: input.message.authorUserId,
        timestamp: input.message.timestamp,
      },
    ],
  });
  const v = verdicts[0];
  return {
    intent: v.intent,
    confidence: v.confidence,
    react: v.react,
    reply: v.reply,
    registerAttendance: v.registerAttendance,
    scoreRed: v.scoreRed,
    scoreYellow: v.scoreYellow,
    reasoning: v.reasoning,
  };
}
