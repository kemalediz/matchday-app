import { postAttendance, postScore } from "./api.js";
import { unknownPlayerMessage, errorMessage } from "./messages.js";

/**
 * Map a confirmed-squad slot number (1-indexed) to a keycap emoji. Slots
 * 1-9 use Unicode keycap sequences, 10 uses the 🔟 emoji. For 11+ we
 * fall back to a ⚽ — WhatsApp reactions only support a single emoji,
 * and keycap sequences stop at 10, so there's no clean native way to
 * show "13" as one reaction.
 */
const KEYCAP: Record<number, string> = {
  1: "1️⃣",
  2: "2️⃣",
  3: "3️⃣",
  4: "4️⃣",
  5: "5️⃣",
  6: "6️⃣",
  7: "7️⃣",
  8: "8️⃣",
  9: "9️⃣",
  10: "🔟",
};

function slotEmoji(status: "CONFIRMED" | "BENCH", slot: number): string {
  if (status === "BENCH") return "🪑"; // seat = bench
  return KEYCAP[slot] ?? "⚽"; // confirmed, in the squad
}

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
  /** WhatsApp "pushname" of the sender — their self-set profile name.
   *  Used to seed a brand-new auto-enrolled User row so unknown senders
   *  arrive on the attendance list with a real display name instead of
   *  "(unnamed)". Optional because some wweb.js events don't expose it. */
  authorName?: string;
  reply: (text: string) => Promise<void>;
  react?: (emoji: string) => Promise<void>;
}

let monitoredGroups = new Set<string>();

export function setMonitoredGroups(groupIds: string[]) {
  monitoredGroups = new Set(groupIds);
}

export function isMonitoredGroup(groupId: string): boolean {
  return monitoredGroups.has(groupId);
}

export async function handleMessage(msg: Message) {
  if (!msg.from.endsWith("@g.us")) return;
  if (!monitoredGroups.has(msg.from)) return;

  const authorId = msg.author || msg.from;

  // WhatsApp now sends participant ids in two formats depending on
  // privacy settings: the classic `<phone>@c.us` and the newer
  // `<opaque>@lid` (Linked ID). `@lid` ids are NOT phone numbers —
  // they're opaque identifiers that hide the user's real phone. We
  // can't map them to our User.phoneNumber lookup, so bail silently.
  if (!authorId.endsWith("@c.us")) return;

  const phone = "+" + authorId.replace("@c.us", "");

  // 1) Score submission? E.g. "7-3", "Final 5:4".
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
          if (result.error === "no_match") return;
          if (result.error === "forbidden") {
            await msg.reply("Only players from that match or an admin can record the score.");
            return;
          }
          if (result.error === "unknown_player") return; // silent
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
    const result = await postAttendance(phone, action, msg.from, msg.authorName);

    // OUT from an unknown phone still silently drops; we don't enrol
    // someone whose first action is to leave.
    if (result.error === "unknown_player") {
      console.log(`unknown_player ${phone} — silent drop`);
      return;
    }

    if (result.error) {
      console.log(`attendance error ${phone}: ${result.error}`);
      return;
    }

    if (msg.react) {
      if (action === "IN") {
        const status: "CONFIRMED" | "BENCH" =
          result.status === "BENCH" ? "BENCH" : "CONFIRMED";
        const slot = typeof result.slot === "number" ? result.slot : 0;
        await msg.react(slotEmoji(status, slot));
      } else {
        await msg.react("👋");
      }
    }
  } catch (err) {
    console.error("Error handling message:", err);
    // Quiet on unexpected errors too.
  }
}
