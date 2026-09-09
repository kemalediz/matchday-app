/**
 * A FAST PATH CLAIMS A CLAUSE, NOT A MESSAGE.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE BUG CLASS THIS MODULE EXISTS TO END
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `api/whatsapp/analyze/route.ts` is a long per-message loop of fast
 * paths. Each one used to do this:
 *
 *     fastPathHandledIds.add(m.waMessageId);   // peel the WHOLE message
 *     continue;                                // skip every guard below
 *
 * A message was claimed ENTIRELY by whichever fast path matched first,
 * and everything else in it was destroyed. SIX production incidents,
 * all the same shape:
 *
 *   1. 2026-09-01  the recruit regex claimed "Najib is out. We need one
 *                  more player" and threw the drop away. The owner was
 *                  told his squad was full moments after saying a player
 *                  was out.
 *   2. PR #29      the guest-name-ask branch discarded the sender's own
 *                  attendance. Caught in review.
 *   3. §10 step 6  an engine short-circuit would have bypassed PR #39's
 *                  pasted-roster clamp.
 *   4. 2026-09-06  a pasted list swallowed the sender's own drop; he
 *                  stayed CONFIRMED and his slot was never offered.
 *   5. 2026-09-08  a BENCH clause poisoned a whole message and took a
 *                  clean "David is OUT" down with it. Fixed PER ENTRY in
 *                  `interaction-contract.ts:registerForEntryRequiresTag`.
 *   6. 2026-09-08  "@Match Time swap Elvin with Raihan, and I'm out"
 *                  applied the swap and lost the sender's OUT.
 *
 * Incident 5's fix is the pattern, and this module is the same move one
 * layer up: **ask the question per CLAUSE, not per message**. There is no
 * longer a message-shaped answer for a fast path to over-apply.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE SAFETY PROPERTY: THIS OWNS NOT ONE MESSAGE MORE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `peelClause` REFUSES before it splits anything unless the predicate
 * matches the WHOLE body — the exact test the caller ran before this
 * module existed. So the set of messages a fast path owns is unchanged,
 * byte for byte. The only thing this adds is a `residual`: the clauses
 * the fast path did NOT recognise, handed back to the caller to send on
 * down the pipeline. A clause peel can never make a handled message
 * unhandled, and it can never make an unhandled message handled.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE BOUNDARIES, AND THE TWO THIS DELIBERATELY DOES NOT TAKE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A boundary is a newline, a sentence terminator, a semicolon, or a
 * comma FOLLOWED BY a coordinator ("…, and I'm out"). That is enough for
 * incident 6 verbatim and for incident 5's shape.
 *
 * NOT a bare "and". "swap the reds and yellows" and "dm me who's in and
 * who's out" are single requests; splitting them would break two shipped
 * features to fix a third. THE COST, stated rather than discovered
 * later: "swap A with B and I'm out", with no comma, is NOT split, so it
 * behaves exactly as it does today — the swap applies and the OUT is
 * lost. That is a narrower fix than the incident deserves and it is the
 * deliberate half, because the alternative direction of error is worse:
 *
 * NOT a bare comma either, for the same reason plus one of its own.
 * `parseSwapNames` reads "swap Nabeel, Adam" with the comma AS the
 * separator, and "my stats, I'm in the top 5 right?" is one thought
 * whose second half reads as a self-registration ONLY once it has been
 * torn off the first. Handing a fragment to the attendance extractor
 * with its context removed is how a WRONG write happens, and §13's trade
 * is explicit about which way to err: "a missed add is recoverable in
 * one message; a wrong registration on a paid match is not."
 */

/** What a fast path took, and what is left for the pipeline. */
export interface ClausePeel {
  /** The clause the fast path recognised. Pass THIS to the handler. */
  consumed: string;
  /** Everything else in the message, in order. `""` when the fast path
   *  legitimately owns the whole thing. */
  residual: string;
}

/**
 * Words that can OPEN a clause without carrying meaning into it. Stripped
 * from the front of every clause so the residual handed to the extractor
 * reads as its own sentence ("and I'm out" → "I'm out") rather than as a
 * fragment of one.
 */
const LEADING_COORDINATOR = /^(?:and|but|also|plus|then|so|&)\b[\s,]*/i;

/**
 * The boundary set. Read as an alternation of four things:
 *   - one or more newlines
 *   - the whitespace AFTER a sentence terminator (a lookbehind, so the
 *     terminator stays attached to the clause it ends, and so "5.5" in
 *     "we won 5.5 to 2" is never a boundary — the dot there is followed
 *     by a digit, not by whitespace)
 *   - a semicolon
 *   - a comma followed by a coordinator
 */
const BOUNDARY =
  /(?:\r?\n)+|(?<=[.!?…])\s+|\s*;\s*|\s*,\s+(?=(?:and|but|also|plus|then|so|&)\b)/i;

/**
 * Cut a message body into clauses. Terminal punctuation is PRESERVED on
 * the clause it ends — the text a clause peel hands onward should read
 * the way the sender wrote it, not the way a tokeniser left it.
 */
export function splitClauses(body: string): string[] {
  return (body ?? "")
    .split(BOUNDARY)
    .map((c) => (c ?? "").trim().replace(LEADING_COORDINATOR, "").trim())
    .filter((c) => c.length > 0);
}

/**
 * WHAT A FAST PATH MAY CLAIM.
 *
 * `matches` is the fast path's OWN whole-body test, unchanged — the
 * regex or parser it already ran. It is applied twice:
 *
 *   1. To the whole body FIRST. A `false` here returns null and the
 *      caller does exactly what it does today: nothing. This is the
 *      guarantee that ownership does not widen.
 *   2. To each clause, to find which one the fast path was reacting to.
 *      The FIRST match wins, and every other clause becomes the
 *      residual.
 *
 * When no single clause matches — the split broke the phrase the
 * predicate needed, as it does for "please swap Nabeel, Adam" — the
 * whole body is the consumed clause and the residual is empty. That is
 * today's behaviour, reached deliberately rather than by accident.
 */
export function peelClause(
  body: string,
  matches: (clause: string) => boolean,
): ClausePeel | null {
  const whole = (body ?? "").trim();
  if (!whole) return null;
  if (!matches(whole)) return null;

  const clauses = splitClauses(whole);
  if (clauses.length > 1) {
    const idx = clauses.findIndex(matches);
    if (idx >= 0) {
      const residual = clauses.filter((_, i) => i !== idx).join(" ").trim();
      if (residual) return { consumed: clauses[idx], residual };
    }
  }
  return { consumed: whole, residual: "" };
}

/**
 * TWO OWNERS WROTE. ONE SPEAKS.
 *
 * "MatchTime replies once or not at all" is the invariant the whole tail
 * of the analyze route protects, and clause peeling is the first thing
 * in this codebase that routinely produces TWO candidate sentences for
 * ONE message: the fast path's ack for the clause it took, and the
 * owner's ack for the residual. They are merged into a single outbound
 * message here rather than pushed as two results.
 *
 * This is `mergeRecruitReply`'s rule, generalised — that function solved
 * exactly this shape for the recruit blast on 2026-09-01 and now
 * delegates here so there is one implementation of "one send" rather
 * than two that can drift.
 *
 * Whitespace-only counts as silence; two identical lines collapse rather
 * than being said twice.
 */
export function mergeOneReply(
  first: string | null | undefined,
  second: string | null | undefined,
): string | null {
  const a = (first ?? "").trim();
  const b = (second ?? "").trim();
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  return `${a}\n\n${b}`;
}

/**
 * WHAT A FAST PATH DID TO THE CLAUSE IT TOOK — deferred, because the
 * message it came from is still in the batch and the pipeline has not
 * finished with it yet.
 *
 * Exactly the fields `claimFastPath` would have written straight to
 * `AnalyzedMessage` and `ActionForBot` if the fast path had owned the
 * whole message. Same shape as `pastedRosterReports` in the analyze
 * route, and for the same reason.
 */
export interface ClauseReport {
  handledBy: "fast-path" | "error";
  intent: string;
  action: string | null;
  reasoning: string;
  react: string | null;
  reply: string | null;
}

/** The slice of `ActionForBot` this module needs. Structural on purpose:
 *  the route's own type stays the route's business. */
export interface MergeableResult {
  waMessageId: string;
  handledBy: string;
  intent: string | null;
  react: string | null;
  reply: string | null;
}

/**
 * THE ROW AND THE WORDS THAT WERE DEFERRED, PUT BACK — into the ONE
 * result the pipeline produced for that message.
 *
 * Pure but for the injected `augment`, which is the route's
 * `augmentAnalysis` (the same function the recruit blast uses to add an
 * outcome to a row that already exists — `AnalyzedMessage.waMessageId`
 * is UNIQUE and a second create is silently swallowed, so appending is
 * the only way both halves survive).
 *
 * ── THE THREE RULES, AND WHY EACH ────────────────────────────────────
 *
 *   REPLY   merged, never appended as a second result. One send.
 *   REACT   the OWNER's wins when it has one. It describes the write
 *           that actually landed — and for a sender's own attendance it
 *           has already been reconciled against the final database row
 *           (the Zeeshan 2026-06-12 pass). The fast path's react only
 *           fills a hole.
 *   LABEL   overwritten only when the owner recorded NOTHING. A result
 *           left `ignored`/`noise` means the residual reached the end of
 *           the batch unclaimed, so the only thing that happened to this
 *           message is what the fast path did, and the admin log must
 *           say `team_swap` rather than `noise`. When an owner DID
 *           decide, its label stands and the fast path's outcome is
 *           appended to `action`/`reasoning` — the row then reads
 *           "out+team-swap", which is the truth.
 *
 * A missing result is logged, never invented: every message in the batch
 * gets exactly one result from the loop, so this cannot happen, and an
 * unreachable branch that silently drops a WRITE that already landed is
 * how a fix becomes the next incident.
 */
export async function applyClauseReports(args: {
  reports: Map<string, ClauseReport>;
  results: MergeableResult[];
  augment: (a: {
    waMessageId: string;
    action: string;
    reasoningSuffix: string;
    handledBy?: string;
    intent?: string;
  }) => Promise<void>;
}): Promise<void> {
  for (const [id, report] of args.reports) {
    const target = args.results.find((r) => r.waMessageId === id);
    if (!target) {
      console.error(
        `[analyze] clause report for ${id} found no result to merge into — ` +
          `the fast path's write LANDED and its words are being dropped`,
      );
      continue;
    }
    target.reply = mergeOneReply(target.reply, report.reply);
    target.react = target.react ?? report.react;
    const ownerSaidNothing =
      target.handledBy === "ignored" ||
      target.intent === "noise" ||
      target.intent === "unclear";
    if (ownerSaidNothing) {
      target.handledBy = report.handledBy;
      target.intent = report.intent;
    }
    await args.augment({
      waMessageId: id,
      action: report.action ?? "none",
      reasoningSuffix: report.reasoning,
      ...(ownerSaidNothing
        ? { handledBy: report.handledBy, intent: report.intent }
        : {}),
    });
  }
}
