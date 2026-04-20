/**
 * Smart-analysis glue: takes a WhatsApp message (or batch of them) the
 * regex didn't handle, calls the server-side analyzer, and executes the
 * returned actions on the WhatsApp session (react, reply).
 *
 * Three entry points:
 *   - `analyzeSingleMessage`: inline call from the `message` event
 *      handler when the regex fast-path doesn't match.
 *   - `catchUpScan`:          fetch last N messages from a group and
 *      feed anything the server hasn't seen through the LLM. Called
 *      on startup + every scheduler tick.
 *   - `recordHistory`:        appends to an in-memory rolling buffer
 *      that the single-message path uses for context.
 */
import type { Client, Message } from "whatsapp-web.js";
import {
  postAnalyze,
  type AnalyzeInboundHistory,
  type AnalyzeInboundMessage,
  type AnalyzeResult,
} from "./api.js";

const HISTORY_PER_GROUP = 15;
const CATCH_UP_LIMIT = 50;
const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000; // never analyse messages older than a day

/** Per-group rolling history buffer, newest last. In-memory; reset on bot restart. */
const historyByGroup = new Map<string, AnalyzeInboundHistory[]>();

export function recordHistory(groupId: string, entry: AnalyzeInboundHistory) {
  const arr = historyByGroup.get(groupId) ?? [];
  arr.push(entry);
  if (arr.length > HISTORY_PER_GROUP) arr.shift();
  historyByGroup.set(groupId, arr);
}

function getHistory(groupId: string): AnalyzeInboundHistory[] {
  return historyByGroup.get(groupId) ?? [];
}

function phoneFromAuthor(authorId: string | undefined, fromId: string): string | null {
  const id = authorId ?? fromId;
  if (!id.endsWith("@c.us")) return null;
  return id.replace("@c.us", "").replace(/^\+/, "");
}

export async function analyzeSingleMessage(client: Client, msg: Message): Promise<void> {
  if (!msg.from.endsWith("@g.us")) return;
  const phone = phoneFromAuthor(msg.author, msg.from);
  if (!phone) return;

  const waMessageId = msg.id._serialized;
  const contact = await msg.getContact().catch(() => null);
  const authorName = contact?.pushname ?? contact?.name ?? null;

  const inbound: AnalyzeInboundMessage = {
    waMessageId,
    body: msg.body ?? "",
    authorPhone: phone,
    authorName,
    timestamp: new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
  };

  const history = getHistory(msg.from);

  let results: AnalyzeResult[] = [];
  try {
    results = await postAnalyze({
      groupId: msg.from,
      messages: [inbound],
      history,
    });
  } catch (err) {
    console.error("[smart] analyze post failed:", err);
    return;
  }

  const verdict = results[0];
  if (!verdict) return;

  await executeActions(client, msg, verdict);
}

async function executeActions(client: Client, msg: Message, verdict: AnalyzeResult) {
  if (verdict.handledBy === "deduped") return;

  if (verdict.react) {
    try {
      await msg.react(verdict.react);
    } catch (err) {
      console.error("[smart] react failed:", err);
    }
  }

  if (verdict.reply) {
    try {
      const chat = await client.getChatById(msg.from);
      await chat.sendMessage(verdict.reply);
    } catch (err) {
      console.error("[smart] reply failed:", err);
    }
  }

  if (verdict.intent && verdict.intent !== "noise") {
    console.log(
      `[smart] ${msg.id._serialized} intent=${verdict.intent} react=${verdict.react ?? "-"} reply=${
        verdict.reply ? "yes" : "no"
      } :: ${(verdict.reasoning ?? "").slice(0, 140)}`,
    );
  }
}

/**
 * Periodic catch-up: fetch the tail of group history, ask the server
 * which messages it hasn't analysed yet (via waMessageId dedupe), and
 * run Claude on them. Safe to call repeatedly — the server dedupes.
 */
export async function catchUpScan(client: Client, groupId: string, limit = CATCH_UP_LIMIT) {
  let msgs: Message[] = [];
  try {
    const chat = await client.getChatById(groupId);
    msgs = await chat.fetchMessages({ limit });
  } catch (err) {
    console.error(`[smart] catchUpScan fetch failed for ${groupId}:`, err);
    return;
  }
  if (msgs.length === 0) return;

  const now = Date.now();
  const eligible = msgs.filter((m) => {
    if (!m || !m.id?._serialized) return false;
    if (m.fromMe) return false; // skip the bot's own messages
    if (m.isStatus) return false;
    if (!m.from?.endsWith("@g.us")) return false;
    const tsMs = (m.timestamp ?? 0) * 1000;
    if (now - tsMs > MAX_MESSAGE_AGE_MS) return false;
    if (!m.body || m.body.trim().length === 0) return false;
    return true;
  });

  const inbound: AnalyzeInboundMessage[] = [];
  for (const m of eligible) {
    const phone = phoneFromAuthor(m.author, m.from);
    if (!phone) continue;
    const contact = await m.getContact().catch(() => null);
    const authorName = contact?.pushname ?? contact?.name ?? null;
    inbound.push({
      waMessageId: m.id._serialized,
      body: m.body,
      authorPhone: phone,
      authorName,
      timestamp: new Date((m.timestamp ?? now / 1000) * 1000).toISOString(),
    });
  }
  if (inbound.length === 0) return;

  // Order oldest-first so Claude sees history coherently if multiple
  // messages need analysis in one batch.
  inbound.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));

  // Use the older-before-newer messages as each others' history context.
  const history: AnalyzeInboundHistory[] = inbound.slice(-HISTORY_PER_GROUP).map((m) => ({
    authorName: m.authorName,
    body: m.body,
    timestamp: m.timestamp,
  }));

  let results: AnalyzeResult[] = [];
  try {
    results = await postAnalyze({ groupId, messages: inbound, history });
  } catch (err) {
    console.error("[smart] catchUp analyze post failed:", err);
    return;
  }

  const actedOn = results.filter((r) => r.handledBy !== "deduped").length;
  if (actedOn > 0) {
    console.log(`[smart] catchUp: ${actedOn}/${results.length} messages processed for ${groupId}`);
  }

  // Execute actions on the WhatsApp side (react + reply).
  for (const r of results) {
    if (r.handledBy === "deduped" || r.handledBy === "error") continue;
    if (!r.react && !r.reply) continue;

    const target = msgs.find((m) => m.id?._serialized === r.waMessageId);
    if (!target) continue;

    if (r.react) {
      try {
        await target.react(r.react);
      } catch (err) {
        console.error("[smart] catchUp react failed:", err);
      }
    }
    if (r.reply) {
      try {
        const chat = await client.getChatById(groupId);
        await chat.sendMessage(r.reply);
      } catch (err) {
        console.error("[smart] catchUp reply failed:", err);
      }
    }
  }
}

export async function catchUpAllGroups(client: Client, groupIds: string[], limit = CATCH_UP_LIMIT) {
  for (const g of groupIds) {
    await catchUpScan(client, g, limit);
  }
}
