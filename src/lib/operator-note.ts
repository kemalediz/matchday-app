/**
 * §10 STEP 8 — WHAT REPLACES "FALL BACK TO THE ANALYZER".
 *
 * Every runner in the pipeline shipped with the same failure table, and
 * every row of it ended the same way:
 *
 *   • the route's flag is off                 → the analyzer decides it
 *   • the message is untagged                 → the analyzer decides it
 *   • the extractor call threw                → the analyzer decides it
 *   • the shape is one no composer can answer → the analyzer decides it
 *   • the engine threw                        → the analyzer decides it
 *
 * That table was honest — "which is today's behaviour and therefore
 * cannot be a regression" — for exactly as long as the analyzer existed.
 * Step 8 deletes `analyzeBatch` and the 19,850-token `SYSTEM_PROMPT`, so
 * every one of those arrows now points at nothing, and "fails open"
 * quietly becomes "goes silent".
 *
 * This module is the thing the arrows point at instead.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT IS AN OPERATOR SURFACE, NOT A SECOND DECIDER
 * ─────────────────────────────────────────────────────────────────────
 *
 * It does not classify, reply, react or write. It decides one thing:
 * whether a message nobody owned is worth a human being told about, and
 * it composes the sentence that tells them. §11.5 accepted the
 * behavioural loss this creates in advance — "a router with nine routes
 * and an engine with explicit rules will do nothing instead… the club
 * will experience it as 'the bot got dumber' before they experience it
 * as 'the bot stopped being wrong'" — and the only thing that makes that
 * loss survivable is that somebody can SEE it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE RULE IS A ROUTE TEST, NEVER A CONTENT TEST
 * ─────────────────────────────────────────────────────────────────────
 *
 * Two failures are in tension and both are real:
 *
 *   • §9 names "message understood, action silently not taken" this
 *     product's SIGNATURE failure. Baki's drop went unnoticed for
 *     thirteen days for want of any signal at all.
 *   • 69.3% of real traffic is banter (measured over 1,723 production
 *     messages, PR #35). An admin DM per unowned message would fire on
 *     all of it, and a nagging operator surface is an ignored one —
 *     which is the same silence with extra steps.
 *
 * So: a message the router called `none` is never noted, and a message
 * it routed to something actionable that nobody then acted on always is.
 * That reads a ROUTE and not a sentence, which keeps this module on the
 * right side of the line `gate.ts` draws between a classifier (decides
 * what a message means, wrong in both directions) and a seatbelt
 * (decides only whether a human looks, wrong in one).
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT DOES *NOT* REACH HERE, AND WHY EACH ONE IS RIGHT
 * ─────────────────────────────────────────────────────────────────────
 *
 * The caller filters these out before composing, and each is a decision
 * rather than an omission:
 *
 *   • A message a DETERMINISTIC path handled — the stats link, the stats
 *     blast, group→DM Q&A, rating progress, help, the colour swap, the
 *     team swap, a bench-prompt answer, a pasted roster. Nothing failed;
 *     it simply was not the pipeline's business.
 *   • A message an owner OWNED and decided nothing should happen about.
 *     That is a decision with a reason and it already gets an
 *     `AnalyzedMessage` row — §11.2's own mitigation, "log the route
 *     alongside the extracted facts, so triage is one query". Paging an
 *     admin because the engine correctly concluded that a joke was a
 *     joke is the nagging above.
 *   • A message the ORG's features exclude — attendance off, team
 *     balancing off, reminders off. That is not a failure; it is the
 *     club saying do not do this. A note there pages a human because the
 *     system is working.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT INHERITS THE PARTIAL-RESPONSE NET RATHER THAN ADDING A SECOND ONE
 * ─────────────────────────────────────────────────────────────────────
 *
 * §9 lists "the partial-response admin DM" (`route.ts:648-720`) among
 * the twenty-two seatbelts that SURVIVE, with one instruction: "Keep,
 * but fix the mechanism: today it prefix-matches free-text `reasoning`;
 * under the new design it matches a typed error, which is what it always
 * wanted to be."
 *
 * This is that fix. The old net selected messages by string-matching six
 * prefixes against `verdict.reasoning`, a field written by the model —
 * the same "that is not an interface, it is a hope" pattern §1 objects
 * to. The new one selects on a typed fact: an id that reached the end of
 * the batch with no owner. Same DM, same 1-hour dedupe, same audience;
 * the input stopped being prose.
 */
import type { Route } from "./pipeline/types";

/**
 * The substring the 1-hour dedupe query matches on.
 *
 * The old net searched `BotJob.text` for the literal `"LLM dropped"`,
 * which coupled the dedupe to a sentence somebody could reword. This is
 * the same trick with the coupling made explicit: the note is REQUIRED
 * to contain this string (asserted in `__tests__/operator-note.test.ts`),
 * so rewording the copy cannot silently turn one DM per hour into one
 * DM per batch.
 */
export const OPERATOR_NOTE_MARKER = "routed to an action but nothing handled";

/** A message that reached the end of the batch with nobody owning it. */
export interface UnownedMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  /** The router's answer. `undefined` means the router never mentioned
   *  this id at all, which is a coverage hole rather than a decision. */
  route: Route | undefined;
}

export interface OperatorNoteInput {
  /** Named in the DM so an admin of two clubs knows which group to open. */
  orgName: string;
  /** Every fresh message no owner and no deterministic path claimed. */
  messages: UnownedMessage[];
  /** Every runner's degradation lines, verbatim. Each already carries
   *  the message id it is about, so they are matched by substring
   *  rather than by a parallel structure that could drift out of step. */
  degradations: string[];
}

export interface OperatorNote {
  /** Ids the caller should record as unowned. Never truncated — the
   *  cap below applies only to the DM's text. */
  noteIds: string[];
  /** The DM body, or null when there is nothing to say. */
  text: string | null;
  /** Stable per set-of-ids, so the caller can suppress a repeat without
   *  string-matching the body the way the old net did. */
  dedupeKey: string | null;
}

/**
 * The one route that is never worth a human's attention.
 *
 * Deliberately a single-element check rather than an allowlist of the
 * routes that ARE noted: a route added later must default to being
 * SEEN. A new route silently joining the "not worth mentioning" bucket
 * is precisely the S1 coverage hole this whole file is about.
 */
function worthNoting(route: Route | undefined): boolean {
  return route !== "none";
}

/** How many messages the DM spells out before it summarises the rest.
 *  A batch that fails wholesale must not send a wall of text nobody
 *  reads — the cap is the difference between a signal and a flood. */
const MAX_LISTED = 6;
const MAX_BODY_CHARS = 90;

function clip(s: string, n: number): string {
  const one = (s || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * Find the degradation line a runner wrote about this message, if any.
 *
 * Substring on the id rather than a structured lookup, because the
 * runners format their own lines and each shape ("`answer-batch:
 * degraded — <id>: …`", "`[extractor <id>] …`") already embeds it. A
 * parallel map would be a second place for the id to be wrong.
 */
function reasonFor(id: string, degradations: string[]): string | null {
  const hit = degradations.find((d) => d.includes(id));
  if (!hit) return null;
  // Strip the id and the runner's own prefix: the admin does not need
  // a WhatsApp message id, they need the sentence after it.
  const after = hit.slice(hit.indexOf(id) + id.length).replace(/^[:\s—-]+/, "");
  return clip(after.length > 0 ? after : hit, 120);
}

export function composeOperatorNote(input: OperatorNoteInput): OperatorNote {
  const noted = input.messages.filter((m) => worthNoting(m.route));
  if (noted.length === 0) return { noteIds: [], text: null, dedupeKey: null };

  const n = noted.length;
  const lines = noted.slice(0, MAX_LISTED).map((m) => {
    const who = m.authorName ?? "?";
    const why = reasonFor(m.waMessageId, input.degradations);
    const routeLabel = m.route ?? "no route";
    return `• "${clip(m.body, MAX_BODY_CHARS)}" by ${who} [${routeLabel}]${why ? ` — ${why}` : ""}`;
  });
  if (n > MAX_LISTED) lines.push(`• …and ${n - MAX_LISTED} more`);

  const text =
    `⚠️ MatchTime: ${n} message${n === 1 ? "" : "s"} in the latest batch for *${input.orgName}* ` +
    `${OPERATOR_NOTE_MARKER} ${n === 1 ? "it" : "them"}:\n\n` +
    lines.join("\n") +
    `\n\nMatchTime didn't respond to ${n === 1 ? "it" : "them"}. ` +
    `Check the group and act manually if any were attendance changes.`;

  return {
    noteIds: noted.map((m) => m.waMessageId),
    text,
    dedupeKey: noted
      .map((m) => m.waMessageId)
      .sort()
      .join(","),
  };
}
