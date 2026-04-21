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
  reasoning: string;
}

export interface AnalysisBatchInput {
  groupId: string;
  messages: BatchInputMessage[];
  history: BatchInputHistory[];
}

const SYSTEM_PROMPT = `You are MatchTime, a WhatsApp bot that helps manage a weekly amateur football match. Players in a group chat say things like "IN" or "I'll play" to register, and "out" / "can't make it" to drop. A regex fast-path already handles those obvious cases. Your job is to classify the *nuanced* messages the regex missed — apologies, conditional commitments, replacement requests, questions about the squad, and social noise.

You respond with JSON only — no markdown fences, no prose. Your output is executed by the bot directly.

You will receive a BATCH of messages. Return a verdict for each one, keyed by its waMessageId. Messages are listed oldest-first.

Output schema:
{
  "verdicts": [
    {
      "waMessageId": "<string>",
      "intent": "in" | "out" | "replacement_request" | "conditional_in" | "question" | "noise" | "unclear",
      "confidence": 0..1,
      "react": "<emoji>" | null,
      "reply": "<text>" | null,
      "registerAttendance": "IN" | "OUT" | null,
      "reasoning": "<short internal explanation>"
    }
  ]
}

Intent rules:
- "in": Clearly joining the match. react: "👍". registerAttendance: "IN".
- "out": Dropping without asking for cover. react: "👋". registerAttendance: "OUT".
- "replacement_request": Dropping AND asking for a replacement. react: "👋", registerAttendance: "OUT", reply: short note asking the group to step in (personalise with the author's first name — e.g. "Sorry to hear, <name> — can anyone step in?"). Keep it 1 sentence.
- "conditional_in": Tentative commitment ("in if my back holds up"). react: "🤔". registerAttendance: null (do NOT auto-register — admin will chase). reply: null.
- "question": Asking about squad numbers, venue, timing, or match state. registerAttendance: null. react: null. reply: a short, accurate answer grounded in the provided match context — e.g. "We're 13/14 ✅ — need 1 more", or "Tomorrow 21:30 at <venue>". Use null reply if the answer isn't in context.
- "noise": Social chat, jokes, recipe pranks, photos, links, tangential banter. Everything null.
- "unclear": You genuinely can't tell. Everything null — bot stays silent.

State collapse: if the SAME author has multiple messages in this batch, treat the LATEST one as their authoritative state. Emit verdicts for all their messages, but only the latest gets attendance side-effects; earlier ones in the same batch should have registerAttendance=null (react/reply can still happen).

De-duplicate replies: if several players ask the same squad question in this batch, emit a reply on at most ONE verdict — set reply: null on the others.

Confidence: be honest. If below 0.7 for anything non-noise, downgrade to "unclear" with everything null. Better silent than wrong.

Reply tone: WhatsApp casual, one-line, no corporate fluff. Never invent facts — if the question needs info outside the context, set reply: null.`;

function buildMatchContextBlock(args: {
  orgName: string;
  match: {
    activity: { name: string; venue: string };
    date: Date;
    status: string;
    maxPlayers: number;
    attendances: Array<{ status: string; user: { id: string; name: string | null } }>;
  } | null;
}): string {
  if (!args.match) {
    return `## Organisation\n${args.orgName}\n\n## Current Match\nNo upcoming match within the attendance window.`;
  }
  const m = args.match;
  const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = m.attendances.filter((a) => a.status === "BENCH");
  const dropped = m.attendances.filter((a) => a.status === "DROPPED");
  const need = Math.max(0, m.maxPlayers - confirmed.length);
  const lines = [
    `## Organisation`,
    args.orgName,
    ``,
    `## Current Match`,
    `Activity: ${m.activity.name}`,
    `Date: ${m.date.toISOString()}`,
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
      activity: { select: { name: true, venue: true } },
      attendances: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });

  const matchContext = buildMatchContextBlock({ orgName: org.name, match });

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
      max_tokens: 100 + 150 * input.messages.length,
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
      reasoning: `[low-confidence downgrade] ${reasoning}`,
    };
  }

  return { waMessageId, intent, confidence, react, reply, registerAttendance, reasoning };
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
    reasoning: v.reasoning,
  };
}
