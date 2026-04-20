/**
 * Smart WhatsApp message analysis — the LLM "catch-up" for anything the
 * regex fast-path in the bot didn't handle.
 *
 * Philosophy:
 *  - Regex still runs first on the bot (instant IN/OUT/score + emoji react).
 *  - Messages the regex ignores come here: "replace me, ankle sore",
 *    "if my back holds up I'm in", "do we have enough for tomorrow?".
 *  - We give Claude squad context (match, confirmed, bench) + recent
 *    history + the message itself, and ask for a structured intent.
 *  - Return an `AnalysisResult` the bot (via the API route) can execute:
 *    register IN/OUT, react with an emoji, reply to the group, or
 *    do nothing.
 *
 * Low-confidence (< 0.7) results are downgraded to "unclear" and acted
 * on only with a stay-silent default — don't want the bot guessing at
 * people's intent.
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
  /** The message being analysed. */
  message: {
    body: string;
    authorPhone: string;
    authorName: string | null;
    authorUserId: string | null;
    waMessageId: string;
    timestamp: Date;
  };
  /** Last ~10 messages in the group for context (newest last). */
  history: Array<{
    authorName: string | null;
    body: string;
    timestamp: Date;
  }>;
}

const SYSTEM_PROMPT = `You are MatchTime, a WhatsApp bot that helps manage weekly amateur football matches. Players in a group chat say things like "IN" or "I'll play" to register, and "out" or "can't make it" to drop. A regex fast-path already handles those obvious cases. Your job is to understand the *nuanced* messages the regex missed — apologies, conditional commitments, replacement requests, and questions about the squad.

You respond with JSON only, no markdown fences, no prose. Your output is executed by the bot directly.

Output schema:
{
  "intent": "in" | "out" | "replacement_request" | "conditional_in" | "question" | "noise" | "unclear",
  "confidence": number between 0 and 1,
  "react": emoji string or null,
  "reply": string or null (1-2 short sentences, WhatsApp tone, only when helpful),
  "registerAttendance": "IN" | "OUT" | null,
  "reasoning": short internal explanation (not shown to users)
}

Intent rules:
- "in": Clearly joining the match ("I'm in tonight", "playing", "will be there").
  → registerAttendance: "IN", react: "👍"
- "out": Dropping out without asking for help ("can't make it", "out tonight", "ankle sore, sorry", "work running late").
  → registerAttendance: "OUT", react: "👋"
- "replacement_request": Dropping + asking someone to cover ("anyone willing to replace me?", "can someone take my spot?").
  → registerAttendance: "OUT", react: "👋", reply: a short note asking the group for a cover (e.g. "Sorry to hear — can anyone step in for <name>?")
- "conditional_in": Maybe joining depending on something ("in if my back holds up", "probably, will confirm later").
  → registerAttendance: null, react: "🤔", reply: null. Do not register attendance — admin will chase.
- "question": Asking about squad state, numbers, venue, or timing.
  → registerAttendance: null, react: null, reply: a brief accurate answer using the provided Match/Squad context.
- "noise": Social chat, memes, photos, links, jokes, tangential discussion.
  → Everything null. Do nothing.
- "unclear": Can't tell. Everything null. The bot will stay silent.

Confidence: be honest. If you're under 0.7, downgrade to "unclear". Better silent than wrong.

Reply tone: WhatsApp casual, no corporate fluff, no emojis unless one adds meaning. Match the group's energy. When answering a squad question give precise numbers — e.g. "We're 14/14 ✅ — full squad", or "Need 2 more".

Never make up facts. If the question needs information not in the provided context, set reply to null.`;

export async function analyzeMessage(input: AnalysisInput): Promise<AnalysisResult> {
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: input.groupId },
    select: { id: true, name: true },
  });
  if (!org) {
    return {
      intent: "noise",
      confidence: 0,
      react: null,
      reply: null,
      registerAttendance: null,
      reasoning: "Unknown group — analyser declined.",
    };
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

  const confirmed = match?.attendances.filter((a) => a.status === "CONFIRMED") ?? [];
  const bench = match?.attendances.filter((a) => a.status === "BENCH") ?? [];
  const dropped = match?.attendances.filter((a) => a.status === "DROPPED") ?? [];
  const need = match ? Math.max(0, match.maxPlayers - confirmed.length) : 0;

  const matchBlock = match
    ? [
        `Activity: ${match.activity.name}`,
        `Date: ${match.date.toISOString()}`,
        `Venue: ${match.activity.venue}`,
        `Status: ${match.status}`,
        `Confirmed: ${confirmed.length}/${match.maxPlayers}${need > 0 ? ` (need ${need} more)` : " ✅ full squad"}`,
        `Bench: ${bench.length}`,
        ``,
        `Confirmed list:`,
        ...confirmed.map((a, i) => `  ${i + 1}. ${a.user.name ?? "(unnamed)"}`),
        bench.length ? `\nBench list:` : ``,
        ...bench.map((a, i) => `  ${i + 1}. ${a.user.name ?? "(unnamed)"}`),
        dropped.length ? `\nDropped: ${dropped.map((a) => a.user.name ?? "(unnamed)").join(", ")}` : ``,
      ]
        .filter(Boolean)
        .join("\n")
    : "No upcoming match within the attendance window.";

  const historyBlock = input.history.length
    ? input.history
        .slice(-10)
        .map((h) => `  [${h.timestamp.toISOString().slice(11, 16)}] ${h.authorName ?? "?"}: ${h.body.slice(0, 300)}`)
        .join("\n")
    : "  (no recent context)";

  const userPrompt = [
    `## Organisation`,
    org.name,
    ``,
    `## Current Match`,
    matchBlock,
    ``,
    `## Recent group chat (last messages, oldest first)`,
    historyBlock,
    ``,
    `## Message to analyse`,
    `From: ${input.message.authorName ?? input.message.authorPhone}`,
    `Timestamp: ${input.message.timestamp.toISOString()}`,
    `Body: ${JSON.stringify(input.message.body.slice(0, 800))}`,
    ``,
    `Return the JSON now.`,
  ].join("\n");

  const anthropic = getAnthropic();
  if (!anthropic) {
    return {
      intent: "unclear",
      confidence: 0,
      react: null,
      reply: null,
      registerAttendance: null,
      reasoning: "ANTHROPIC_API_KEY not set — analyser offline.",
    };
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      // Split the prompt so Claude can cache the stable system + match
      // context across calls within a 5-minute window — cuts per-call
      // cost ~90% once warm.
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) {
      return {
        intent: "unclear",
        confidence: 0,
        react: null,
        reply: null,
        registerAttendance: null,
        reasoning: "No text in Claude response.",
      };
    }

    const parsed = safeParseJson(textBlock.text);
    if (!parsed) {
      return {
        intent: "unclear",
        confidence: 0,
        react: null,
        reply: null,
        registerAttendance: null,
        reasoning: `Unparseable JSON: ${textBlock.text.slice(0, 200)}`,
      };
    }

    return normaliseResult(parsed);
  } catch (err) {
    console.error("[analyzer] Claude call failed:", err);
    return {
      intent: "unclear",
      confidence: 0,
      react: null,
      reply: null,
      registerAttendance: null,
      reasoning: `Claude API error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function safeParseJson(text: string): Record<string, unknown> | null {
  // Strip any accidental markdown fences.
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

function normaliseResult(raw: Record<string, unknown>): AnalysisResult {
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

  const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0;

  const react = typeof raw.react === "string" && raw.react.trim().length > 0 ? raw.react.trim() : null;
  const reply = typeof raw.reply === "string" && raw.reply.trim().length > 0 ? raw.reply.trim() : null;
  const registerAttendance =
    raw.registerAttendance === "IN" || raw.registerAttendance === "OUT" ? raw.registerAttendance : null;
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";

  // Downgrade low-confidence verdicts to "unclear" and wipe actions so
  // the bot stays silent. Better quiet than wrong.
  if (confidence < 0.7 && intent !== "noise") {
    return {
      intent: "unclear",
      confidence,
      react: null,
      reply: null,
      registerAttendance: null,
      reasoning: `[low-confidence downgrade] ${reasoning}`,
    };
  }

  return { intent, confidence, react, reply, registerAttendance, reasoning };
}
