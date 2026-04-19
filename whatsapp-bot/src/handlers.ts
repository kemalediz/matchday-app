import { postAttendance, postScore } from "./api.js";
import { unknownPlayerMessage, errorMessage } from "./messages.js";

/**
 * Score extractor — matches plain "7-3", "7:3", "7 - 3", "7 3" (with
 * optional surrounding words). We accept values 0-99 each side.
 */
const SCORE_RE = /(?:^|\s)(\d{1,2})\s*[-:–—]\s*(\d{1,2})(?=\s|$)/;

export function extractScore(text: string): { red: number; yellow: number } | null {
  const m = text.match(SCORE_RE);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > 99 || b > 99) return null;
  return { red: a, yellow: b };
}

/**
 * IN/OUT detection — wider than a strict exact-match so real chat messages
 * get picked up.
 *
 * "in", "IN", "i'm in", "im in", "I am in", "count me in", "I will play",
 * "yes", "👍", "✅", "✔️", "IN 👍", "in guys", "In mate!"
 * are all treated as IN.
 *
 * Counter: "out", "OUT", "i'm out", "im out", "can't make it",
 * "cant make it", "not playing", "drop", "count me out", "no", "👎", "❌"
 * are OUT.
 *
 * To avoid false positives from substring matches (e.g. "joined",
 * "invited", "going IN on Arsenal"), the extract() function requires:
 *   - Word-boundary matches for English words
 *   - The whole message is ≤40 chars OR starts with the keyword
 * Anything more nuanced → return null → bot stays quiet.
 */
const IN_WORDS = [
  /\bin\b/i,
  /\bi[' ]?m in\b/i,
  /\bi am in\b/i,
  /\bcount me in\b/i,
  /\bi will play\b/i,
  /\bi'?ll play\b/i,
  /\bplaying\b/i,
  /\byes\b/i,
];
const OUT_WORDS = [
  /\bout\b/i,
  /\bi[' ]?m out\b/i,
  /\bi am out\b/i,
  /\bcan[' ]?t make it\b/i,
  /\bnot playing\b/i,
  /\bcount me out\b/i,
  /\bdrop\b/i,
  /\bno\b/i,
];
const IN_EMOJIS = ["👍", "✅", "✔️", "🙋‍♂️", "🙋‍♀️", "🙋"];
const OUT_EMOJIS = ["👎", "❌", "🚫"];

function hasEmoji(text: string, set: string[]): boolean {
  return set.some((e) => text.includes(e));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function extract(text: string): "IN" | "OUT" | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const inEmoji = hasEmoji(trimmed, IN_EMOJIS);
  const outEmoji = hasEmoji(trimmed, OUT_EMOJIS);
  const inWord = matchesAny(trimmed, IN_WORDS);
  const outWord = matchesAny(trimmed, OUT_WORDS);

  const isIn = inEmoji || inWord;
  const isOut = outEmoji || outWord;

  if (isIn && isOut) return null; // ambiguous — don't guess
  if (isIn) return "IN";
  if (isOut) return "OUT";
  return null;
}

interface Message {
  body: string;
  from: string;           // group JID: xxx@g.us
  author?: string;        // participant in group: 447xxx@c.us
  reply: (text: string) => Promise<void>;
  react?: (emoji: string) => Promise<void>;
}

let monitoredGroups = new Set<string>();

export function setMonitoredGroups(groupIds: string[]) {
  monitoredGroups = new Set(groupIds);
}

export async function handleMessage(msg: Message) {
  if (!msg.from.endsWith("@g.us")) return;
  if (!monitoredGroups.has(msg.from)) return;

  const authorId = msg.author || msg.from;
  const phone = "+" + authorId.replace("@c.us", "");

  // 1) Score submission? E.g. "7-3", "Final 5:4".
  //    Only try this if the message is short and explicitly looks like a
  //    score (avoids accidentally interpreting dates or phone-number
  //    digits as scores).
  const trimmed = msg.body.trim();
  if (trimmed.length <= 32) {
    const scoreOnly = /^\s*\d{1,2}\s*[-:–—]\s*\d{1,2}\s*$/.test(trimmed);
    if (scoreOnly) {
      const parsed = extractScore(trimmed);
      if (parsed) {
        try {
          const result = await postScore({
            fromPhone: phone,
            redScore: parsed.red,
            yellowScore: parsed.yellow,
            groupId: msg.from,
          });
          if (result.ok) {
            if (msg.react) await msg.react("👍");
            return;
          }
          // Known-failure cases — post a short reply.
          if (result.error === "no_match") return; // silent; the prompt is stale
          if (result.error === "forbidden") {
            await msg.reply("Only players from that match or an admin can record the score.");
            return;
          }
          if (result.error === "unknown_player") {
            await msg.reply(unknownPlayerMessage(phone));
            return;
          }
        } catch (err) {
          console.error("Failed to post score:", err);
        }
        return;
      }
    }
  }

  // 2) Attendance — IN / OUT detection.
  const action = extract(msg.body);
  if (!action) return;

  try {
    const result = await postAttendance(phone, action, msg.from);

    if (result.error === "unknown_player") {
      await msg.reply(unknownPlayerMessage(phone));
      return;
    }

    if (result.error) {
      await msg.reply(result.message || result.error);
      return;
    }

    // Silent success — just react with 👍 instead of replying. Keeps the
    // group chat quiet. The user sees the reaction on their own message.
    if (msg.react) {
      await msg.react(action === "IN" ? "👍" : "👋");
    }
  } catch (err) {
    console.error("Error handling message:", err);
    await msg.reply(errorMessage());
  }
}
