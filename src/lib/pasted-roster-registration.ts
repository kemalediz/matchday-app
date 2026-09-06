/**
 * Pasted roster → registration decision, with NO model in the loop.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * §10 step 8 of MDs/analyzer-redesign-2026-08-31.md deletes the
 * 19,850-token `SYSTEM_PROMPT` / `analyzeBatch`. The shipped
 * pasted-roster handling lives in `api/whatsapp/analyze/route.ts`
 * (~1330-1455) and is plumbed entirely through `verdict.registerFor` —
 * a field that is about to stop existing. Without a home, a message
 * shape with two SOLVED deterministic rules would be lost with the
 * prompt that never solved it.
 *
 * `lib/attendance-engine-batch.ts` deliberately refuses to
 * own a pasted roster, and says exactly why: "the engine has no
 * equivalent, and a fourteen-line roster routed `other_att` is fourteen
 * third-party IN claims it would happily apply." That refusal is only
 * safe while SOMETHING still applies the two rules. This module is that
 * something.
 *
 * ── The key observation: `reconcilePastedRoster` was never model-fed ──
 * Read route.ts:1400-1420 closely. On the of-record branch the route
 * takes the model's `registerFor`, THROWS AWAY every entry the pasted
 * list mentions, and replaces them with `reconciled.additions` —
 * computed arithmetically from the confirmed squad. The model's reading
 * of the list is discarded in full. The rule was always deterministic;
 * it was merely wearing the model's output as a delivery van.
 *
 * PR #35's self-replay sweep is why: three of its four write-level
 * disagreements were one pasted roster registering a DIFFERENT SUBSET on
 * each run (2026-06-07: `Nabeel` one time, `Adam, Amir, Ehtisham,
 * Martin` the next, same message, same world). Arithmetic cannot do
 * that.
 *
 * ── What is LOST versus the shipped path: the `offList` residue ───────
 * Name it plainly. route.ts:1405-1407 keeps the model's `registerFor`
 * entries that the pasted list does NOT mention:
 *
 *     const offList = (verdict.registerFor ?? []).filter(
 *       (e) => !rosterMentions(pastedRoster, e.name),
 *     );
 *
 * That is prose travelling alongside a paste — "here's the list, also
 * adding Kieran". With no model there is no `registerFor`, so there is
 * no `offList`, so **Kieran is no longer registered off a paste**. A
 * message that is BOTH a fourteen-line roster AND a sentence naming
 * somebody not in it now registers only the arithmetic additions.
 *
 * That is the conservative direction, and it is the direction §13
 * requires: *"a missed add is recoverable in one message; a wrong
 * registration on a paid match is not."* Kieran's mate re-sends "add
 * Kieran" on its own line and the ordinary add path — which is not
 * roster-shaped and never was — handles it. Nobody is wrongly given a
 * slot, and nobody is wrongly denied one for longer than one message.
 *
 * (The other half of the shipped behaviour, `clampRosterDerivedWrites`,
 * needs no replacement at all: with no model there are no list-derived
 * writes to clamp. A not-of-record paste registers nobody because
 * nothing here proposes anybody — the clamp's outcome, reached by
 * construction instead of by subtraction. `lib/pasted-roster.ts` keeps
 * the clamp for any caller that still has a verdict to clamp.)
 *
 * ── Interaction contract ──────────────────────────────────────────────
 * An of-record paste is a forward of MatchTime's OWN roster post, so it
 * carries no tag and needs none: `actionRequiresTag` in
 * lib/interaction-contract.ts already exempts an IN-only third-party
 * add. The sender's own appended name is pure self-attendance, which is
 * the other tag-free class. Nothing here can produce an OUT or a BENCH,
 * so the tagged classes are structurally out of reach.
 *
 * Pure by construction: no Prisma, no clock, no I/O. The caller supplies
 * the confirmed squad in Match Context order (the same list the group
 * sees in the roster post) and the names the sender is known by.
 */
import {
  parsePastedRoster,
  reconcilePastedRoster,
  sameName,
  type RosterReconciliation,
} from "./pasted-roster";

export interface PastedRosterDecision {
  /**
   *  - `of_record`     the paste restates the confirmed squad in Match
   *                    Context order with names appended — a forward of
   *                    our own roster post (S26, `4cbdd05`). The one
   *                    pasted shape a registration can be read out of
   *                    without guessing.
   *  - `not_of_record` list-shaped, but it is somebody's own list: the
   *                    group's ritual order, a list against an empty
   *                    squad, a list shorter than the squad. Registers
   *                    NOBODY.
   *  - `not_a_roster`  not list-shaped at all. This module has no
   *                    opinion; the ordinary paths own the message.
   */
  kind: "of_record" | "not_of_record" | "not_a_roster";
  /** Names to register IN, computed arithmetically from the squad.
   *  Empty unless `of_record`. Includes `senderAddition` when the sender
   *  appended themselves — the caller does the split. */
  additions: string[];
  /** Set when one of `additions` is the SENDER's own name. That is
   *  self-attendance and belongs on the sender's own row
   *  (`registerAttendance: "IN"`), never in a third-party add list —
   *  the author never belongs in `registerFor` (route.ts:1407-1414). */
  senderAddition: string | null;
  /** Why, for the operator note / console warning. Mirrors
   *  `RosterReconciliation["reason"]`. */
  reason: RosterReconciliation["reason"];
}

export interface PastedRosterRegistrationInput {
  body: string;
  /** The registration match's CONFIRMED squad, in Match Context order —
   *  the order MatchTime's own roster post prints, which is what an
   *  of-record paste is a forward of. If the paste was about some other
   *  match the prefix simply will not match, and the failure direction
   *  is "register nobody", never "register the wrong squad". */
  confirmedNames: string[];
  /** Every name this sender is known by — member record, WhatsApp
   *  pushname. Nulls are tolerated and skipped. */
  senderNames: Array<string | null>;
}

const NOTHING = (reason: RosterReconciliation["reason"]): PastedRosterDecision => ({
  kind: reason === "not-a-roster" ? "not_a_roster" : "not_of_record",
  additions: [],
  senderAddition: null,
  reason,
});

/**
 * Decide, deterministically, who a pasted roster registers.
 *
 * Two rules, in this order, both already shipped and both already
 * proved:
 *
 * 1. RECONCILE (`reconcilePastedRoster`). If the paste restates the
 *    confirmed squad in Match Context order, the slots BEYOND the squad
 *    are new, and "which lines are new" is arithmetic. The additions are
 *    computed from the squad, so two runs of the same message cannot
 *    produce two different squads.
 *
 * 2. OTHERWISE, NOBODY. Every other list — the group's own ritual order,
 *    a list against an empty squad, a list shorter than the squad —
 *    registers no one. Reading those needs the PREVIOUS list to diff
 *    against, which this path does not have.
 *    `lib/squad-from-list.ts` does keep that state, does the diff and
 *    the sender attribution, and runs behind the `featureSquadFromList`
 *    org flag. A group that maintains its squad by re-pasting should
 *    have it switched on.
 */
export function decidePastedRosterRegistration(
  args: PastedRosterRegistrationInput,
): PastedRosterDecision {
  const roster = parsePastedRoster(args.body);
  if (!roster) return NOTHING("not-a-roster");

  const reconciled = reconcilePastedRoster(roster, args.confirmedNames);
  if (!reconciled.ofRecord) return NOTHING(reconciled.reason);

  //  The sender appended their OWN name. `sameName` is the same
  //  (deliberately non-fuzzy) rule `rosterMentions` uses: exact on the
  //  folded name, or an equal first name of at least two characters, so
  //  a single initial can never sweep up a slot.
  const senderAddition =
    reconciled.additions.find((n) => args.senderNames.some((s) => sameName(n, s))) ??
    null;

  return {
    kind: "of_record",
    additions: reconciled.additions,
    senderAddition,
    reason: reconciled.reason,
  };
}
