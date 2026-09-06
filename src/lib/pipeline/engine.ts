/**
 * STAGE 3 — THE DECISION ENGINE.
 *
 * `(facts, squad state, actor, org features) → decisions`. Pure: no I/O,
 * no model, no clock (the caller injects `now`). This is where the 36%
 * of the 18,315-token prompt that §3.2 categorises as **B** — "a
 * decision that should be deterministic code" — goes to live, and it is
 * exhaustively unit tested in `__tests__/engine.test.ts`, one describe
 * block per incident.
 *
 * WHAT IT MUST NEVER DO
 * ---------------------
 *   • trust a fact. §11.3: structured output guarantees SHAPE, never
 *     SEMANTICS. Every field is treated as untrusted and the engine
 *     asserts its own invariants (capacity, authorisation, identity,
 *     ordering) on top.
 *   • lose a message. Exactly one `MessageOutcome` per input id, always
 *     — §3.2 S1's incident (Ibrahim and Baki silently omitted) as a
 *     post-condition rather than a 272-token prompt banner.
 *   • fail quietly. Anything that cannot be decided produces a
 *     `Degradation`, because four seatbelts were found dead on
 *     2026-08-31, all silent, all with comments claiming they worked.
 *   • write copy. It emits `SpeechIntent`s; the composer renders them
 *     from the PROJECTED state, so no number the bot says can be wrong.
 *
 * WHAT IT REUSES RATHER THAN REIMPLEMENTS (§13 "what must not change")
 * -------------------------------------------------------------------
 *   interaction-contract.ts   the tag gate, unchanged in meaning
 *   promote-authorization.ts  admin-or-self-replace for bench promotion
 *   guest-name-ask.ts         placeholder names + the four ask gates
 *   format-switch.ts          the arithmetic the model got wrong
 * The engine is built OUT of the pure core, not beside it.
 */
import {
  actionRequiresTag,
  type GateRegisterForEntry,
  type GateVerdict,
} from "../interaction-contract";
import {
  isPromoteFromBenchAuthorized,
  type PromoteRegisterEntry,
} from "../promote-authorization";
import { shouldAskForGuestName } from "../guest-name-ask";
import { RECRUIT_COMMAND_IMPLIES_ADDRESSED } from "../recruit-request";
import { RECRUIT_LOOKBACK_MAX, resolveLookbackMatches } from "../recruit-lookback";
import { resolveReminderPhrase } from "../reminder-time";
import { resolvePerson } from "./identity";
import type {
  AttendanceFacts,
  AttendanceRow,
  Claim,
  Degradation,
  EngineInput,
  EngineMessage,
  EngineResult,
  Member,
  MessageOutcome,
  ProposedWrite,
  SpeechIntent,
  SquadState,
} from "./types";

/** §3.2 S37. Applied PER FACT now, not as a blanket verdict-level gate. */
const CONFIDENCE_FLOOR = 0.7;

/** Scores are clamped, never trusted (§9 "value clamps" — survives). */
const MAX_SCORE = 99;

/**
 * The shipped reminder window, reproduced from `route.ts:3938-3947`.
 *
 * A 60-second grace so "remind me in a minute" is not lost to the round
 * trip, and a 60-day ceiling because anything further out "is almost
 * certainly a parse error, not a real request".
 */
const REMINDER_PAST_GRACE_MS = 60_000;
const REMINDER_MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * First-person references in a payment credit's covered list.
 *
 * A CLOSED list, matched exactly, and never handed to `identity.ts` —
 * which is right to refuse to match "me" against a roster of names. The
 * shipped path does the same substitution at `route.ts:3846-3850`.
 */
const SELF_REFS = new Set(["me", "myself", "i", "my self"]);

interface Working {
  rows: Map<string, AttendanceRow>;
  roster: Member[];
  offers: SquadState["openOffers"];
  teams: SquadState["teams"];
  completed: SquadState["completedMatch"];
  nextPosition: number;
}

function cloneWorking(state: SquadState): Working {
  const rows = new Map<string, AttendanceRow>();
  for (const r of state.rows) rows.set(r.userId, { ...r });
  return {
    rows,
    roster: state.roster.map((m) => ({ ...m })),
    offers: state.openOffers.map((o) => ({ ...o })),
    teams: state.teams.map((t) => ({ ...t })),
    completed: state.completedMatch ? { ...state.completedMatch } : null,
    nextPosition: state.rows.reduce((max, r) => Math.max(max, r.position), 0) + 1,
  };
}

function confirmedCount(w: Working): number {
  let n = 0;
  for (const r of w.rows.values()) if (r.status === "CONFIRMED") n++;
  return n;
}

function benchUserIds(w: Working): string[] {
  return [...w.rows.entries()]
    .filter(([, r]) => r.status === "BENCH")
    .sort((a, b) => a[1].position - b[1].position)
    .map(([id]) => id);
}

function nameOf(w: Working, userId: string): string {
  return w.roster.find((m) => m.userId === userId)?.name ?? "(unknown)";
}

/** A resolved claim: the fact plus who it is actually about. */
interface Target {
  claim: Claim;
  userId: string | null;
  name: string;
  /** True when the person had to be created to satisfy this claim. */
  provisional: boolean;
}

export function decide(input: EngineInput): EngineResult {
  const { state, messages } = input;
  const w = cloneWorking(state);
  const outcomes: MessageOutcome[] = [];
  const writes: ProposedWrite[] = [];
  const speech: SpeechIntent[] = [];
  const degradations: Degradation[] = [];
  /** Did anything change the squad? Drives the single status post. */
  let squadChanged = false;
  /** Question speech that the squad post would subsume (§3.2 S36). */
  const deferredSquadQuestions: SpeechIntent[] = [];

  // ── S35 · state collapse ─────────────────────────────────────────────
  // Only an author's LATEST self-attendance message writes. Computed up
  // front so the superseded message still gets an outcome (it must never
  // simply disappear) with a reason saying why it did nothing.
  //
  // "LATEST" MEANS LATEST THAT WOULD ACTUALLY WRITE. The first cut
  // recorded the last message CONTAINING a self claim, so any later
  // claim the engine then declines — contingent, past, hypothetical,
  // below the confidence floor — silently killed the earlier real one.
  // "out" followed by "in if I finish work early" left the player
  // CONFIRMED and said nothing: a phantom player in a paid squad, and
  // "message understood, action silently not taken" (§9).
  const lastSelfIndexByAuthor = new Map<string, number>();
  messages.forEach((m, i) => {
    if (!m.senderUserId) return;
    if (m.facts.kind !== "attendance") return;
    if (!m.facts.claims.some((c) => c.subject === "sender" && wouldWrite(c))) return;
    lastSelfIndexByAuthor.set(m.senderUserId, i);
  });

  messages.forEach((m, index) => {
    const out: MessageOutcome = {
      messageId: m.id,
      route: m.route,
      disposition: "noop",
      reasons: [],
      writes: [],
      react: null,
    };
    outcomes.push(out);

    const degrade = (detail: string, stage: Degradation["stage"] = "engine") => {
      degradations.push({ stage, messageId: m.id, detail });
      out.disposition = "degraded";
      out.reasons.push(`degraded: ${detail}`);
    };

    const emit = (write: ProposedWrite) => {
      writes.push(write);
      out.writes.push(write);
      out.disposition = "acted";
    };

    // A stage above already failed for this message. Say so; never let
    // it look like a decision was taken.
    if (m.degraded) {
      degrade(m.degraded, "extractor");
      return;
    }

    // ── Route `none` ───────────────────────────────────────────────────
    if (m.route === "none") {
      if (m.facts.kind === "attendance" && m.facts.claims.length > 0) {
        // §11.2 two-stage disagreement: the router said banter and the
        // extractor found a claim. Fail closed, but LOUDLY — this is the
        // regression detector the current architecture never had.
        degrade(
          `two-stage disagreement: routed \`none\` but the extractor returned ` +
            `${m.facts.claims.length} claim(s)`,
        );
        return;
      }
      out.reasons.push("route=none (banter)");
      return;
    }

    switch (m.facts.kind) {
      case "attendance":
        handleAttendance(m, m.facts, index);
        break;
      case "question":
        handleQuestion(m);
        break;
      case "teams":
        handleTeams(m);
        break;
      case "score":
        handleScore(m);
        break;
      case "admin":
        handleAdmin(m);
        break;
      case "none":
        out.reasons.push(`route=${m.route} but no facts were extracted`);
        break;
    }

    // ── the handlers ───────────────────────────────────────────────────

    function handleAttendance(msg: EngineMessage, facts: AttendanceFacts, i: number) {
      if (!state.features.attendance) {
        out.reasons.push("org does not track attendance");
        return;
      }

      // A bare "Confirmed" answering MatchTime's own pending list. The
      // bot's last post is a KNOWN OBJECT, so this is a lookup, not an
      // inference (§3.2 S25, 2026-04-24 Amir, 7453daa).
      let claims = facts.claims;
      let fromAffirmation = false;
      if (claims.length === 0 && facts.affirmation === "yes") {
        const pending = parsePendingSet(state.lastBotPost);
        if (pending.length === 0) {
          out.reasons.push("short confirmation with no pending set in the bot's last post");
          return;
        }
        claims = pending.map((name) => ({
          subject: "other" as const,
          personRef: name,
          personNamed: true,
          polarity: "in" as const,
          contingent: false,
          conditionOn: "none" as const,
          tense: "present" as const,
          // The bot ASKED these names to confirm and one of them just
          // said yes. That is a decision by construction; it is not the
          // model's reading of anything.
          basis: "decision" as const,
          reported: true,
          confidence: 0.95,
        }));
        fromAffirmation = true;
        out.reasons.push(`short confirmation resolved to ${pending.length} pending name(s)`);
      }

      // Side requests are facts in their own right and must survive
      // alongside the claims. Today's incident was a fast path claiming
      // a two-intent message and throwing half of it away.
      for (const sr of facts.sideRequests) out.reasons.push(`side-request:${sr}`);

      if (claims.length === 0) {
        if (facts.sideRequests.includes("chase")) {
          // §3.2 S30 + the 2026-05-28 Kemal incident: "@all we need more
          // players pls" is a nudge. It must never drop the asker, which
          // is exactly what the `strongDrop` regex over the model's
          // prose did two days after it shipped.
          out.reasons.push("chase nudge: no attendance change");
          return;
        }
        out.reasons.push("no claims extracted");
        return;
      }

      // ── The interaction contract, unchanged in meaning (§13) ─────────
      //
      // Including PR #33's one deliberate widening, reused rather than
      // re-decided: an ADMIN's recruit command is a direct instruction
      // to MatchTime, so the rest of that same message is addressed to
      // it too. That is what the 2026-09-01 incident turned on — the bot
      // acted on the recruit half of an untagged message and treated the
      // drop in the sentence before it as overheard banter. Both
      // pipelines now read the same constant, so flipping
      // RECRUIT_COMMAND_IMPLIES_ADDRESSED reverts both together.
      const senderIsAdmin =
        !!msg.senderUserId && !!w.roster.find((m2) => m2.userId === msg.senderUserId)?.isAdmin;
      const addressedByRecruit =
        RECRUIT_COMMAND_IMPLIES_ADDRESSED &&
        senderIsAdmin &&
        facts.sideRequests.includes("recruit");
      const gate = toGateVerdict(claims, facts);
      if (actionRequiresTag(gate) && !msg.tagged && !addressedByRecruit) {
        out.reasons.push("requires an @Match Time tag (interaction contract)");
        return;
      }
      if (addressedByRecruit && !msg.tagged) {
        out.reasons.push(
          "untagged, but an admin's recruit command addresses MatchTime (PR #33)",
        );
      }

      if (!state.matchId) {
        degrade("no active registration match (blocked or none upcoming)", "state");
        return;
      }

      // ── Resolve every claim to a person BEFORE deciding anything ─────
      //
      // ORDER MATTERS, and it is a DECISION, so the engine owns it: a
      // replacement frees the slot before it fills it. Found by the
      // first live corpus sweep — "@Izzet is replacing @Elnur" against a
      // 14/14 squad put Izzet on the BENCH (processed first, no room)
      // and then dropped Elnur, leaving 13 confirmed and a bench beside
      // an empty slot. OUT first, always.
      //
      // …but ONLY across distinct people. Applied to two claims about the
      // same person it reversed a self-correction: "I'm in tonight.
      // Actually no, scrap that, I'm out" sorted to [out, in] and
      // registered someone who had just said they were out. So each
      // person is collapsed to their LAST claim first (textual order is
      // the correction), and only then are the survivors ordered
      // OUT-first. That also guarantees at most one attendance write per
      // person per message.
      const byTarget = new Map<string, Claim>();
      for (const c of claims) {
        const key = c.subject === "sender" ? "@self" : c.personRef.trim().toLowerCase();
        byTarget.set(key, c);
      }
      const ordered = [...byTarget.values()].sort(
        (a, b) => (a.polarity === "out" ? 0 : 1) - (b.polarity === "out" ? 0 : 1),
      );
      const targets: Target[] = [];
      const guestAsks: Claim[] = [];
      for (const c of ordered) {
        if (c.confidence < CONFIDENCE_FLOOR) {
          out.reasons.push(
            `claim about "${c.personRef || "sender"}" below the confidence floor ` +
              `(${c.confidence} < ${CONFIDENCE_FLOOR})`,
          );
          continue;
        }
        if (c.tense === "past" || c.tense === "hypothetical") {
          out.reasons.push(`claim is ${c.tense}, never a registration`);
          continue;
        }

        if (c.subject === "sender") {
          if (!msg.senderUserId) {
            // §9 "unresolved-sender nudge" — SURVIVES. "Message
            // understood, action silently not taken" is this product's
            // signature failure.
            degrade("sender could not be resolved to a member; no write attempted");
            continue;
          }
          // Superseded only by a LATER message that would itself write,
          // and only for a claim that would otherwise have written. A
          // claim the engine is going to decline anyway keeps its own
          // honest reason ("contingent", "past") rather than being
          // reported as superseded by something that did nothing.
          const lastIdx = lastSelfIndexByAuthor.get(msg.senderUserId);
          if (wouldWrite(c) && lastIdx !== undefined && lastIdx !== i) {
            out.reasons.push("superseded by a later message from the same author");
            continue;
          }
          targets.push({
            claim: c,
            userId: msg.senderUserId,
            name: msg.senderName ?? nameOf(w, msg.senderUserId),
            provisional: false,
          });
          continue;
        }

        // Third party. A relationship is not a name — and the engine
        // says so itself rather than trusting `personNamed` (§11.3).
        const resolution = resolvePerson(c.personRef, w.roster);

        // …and the same distrust runs the OTHER way. `personNamed` is
        // the model's reading of the TEXT; whether a reference
        // identifies a SQUAD MEMBER is the roster's business, and only
        // code has the roster. The first live corpus sweep had the
        // extractor call "habibi" an endearment rather than a name 3
        // times out of 3, which blocked a drop the message plainly
        // makes. A reference that uniquely resolves to a member has
        // named someone, whatever the model thinks — and it can only get
        // here after identity.ts has already refused relationships,
        // quantities, indefinites and raw digits.
        let personNamed = c.personNamed;
        if (!personNamed && resolution.kind === "resolved") {
          personNamed = true;
          out.reasons.push(
            `"${c.personRef}" was reported unnamed but resolves to a squad member ` +
              `(${resolution.member.name}); treating it as named`,
          );
        }

        if (!personNamed || resolution.kind === "not-a-person") {
          if (c.polarity === "in") {
            guestAsks.push(c);
            out.reasons.push(`unnamed third party ("${c.personRef}") cannot register anyone`);
          } else {
            out.reasons.push(
              `unnamed third party ("${c.personRef}") cannot be dropped or benched`,
            );
          }
          if (resolution.kind === "not-a-person" && personNamed) {
            degrade(`extractor said personNamed but ${resolution.why}`);
          }
          continue;
        }
        if (resolution.kind === "ambiguous") {
          degrade(
            `ambiguous name "${c.personRef}": ${resolution.candidates
              .map((m2) => m2.name)
              .join(", ")}`,
          );
          continue;
        }
        if (resolution.kind === "unknown") {
          if (c.polarity !== "in") {
            out.reasons.push(`"${c.personRef}" is not a member; nothing to drop or bench`);
            continue;
          }
          if (!msg.senderUserId) {
            degrade(`unknown guest "${c.personRef}" offered by an unresolved sender`);
            continue;
          }
          targets.push({
            claim: c,
            userId: null,
            name: resolution.name,
            provisional: true,
          });
          continue;
        }
        targets.push({
          claim: c,
          userId: resolution.member.userId,
          name: resolution.member.name,
          provisional: false,
        });
      }

      // ── The guest name ask (a QUESTION, never a write) ───────────────
      if (guestAsks.length > 0) {
        const decision = shouldAskForGuestName({
          body: msg.body,
          tagged: msg.tagged,
          senderKnown: !!msg.senderUserId,
          attendanceOn: state.features.attendance,
          hasActiveMatch: !!state.matchId,
          confirmedCount: confirmedCount(w),
          maxPlayers: state.maxPlayers,
          alreadyAsked: !!msg.senderUserId && state.guestAskedUserIds.includes(msg.senderUserId),
        });
        out.reasons.push(`guest-name-ask: ${decision.reason}`);
        if (decision.ask) {
          speech.push({
            kind: "guest_name_ask",
            messageId: msg.id,
            askerName: msg.senderName,
            body: msg.body,
          });
          out.disposition = out.disposition === "degraded" ? "degraded" : "acted";
        }
      }

      if (targets.length === 0) return;

      // ── Authorisation for the privileged moves ──────────────────────
      const promoteEntries: PromoteRegisterEntry[] = targets.map((t) => ({
        userId: t.userId,
        action: polarityToAction(t.claim.polarity),
      }));
      const promoteAuthorized = isPromoteFromBenchAuthorized({
        senderUserId: msg.senderUserId,
        senderIsAdmin,
        entries: promoteEntries,
      });

      for (const t of targets) {
        const c = t.claim;
        const self = c.subject === "sender";

        // ── Availability is not a commitment ──────────────────────────
        //
        // The last adjudicated spurious write left open by PR #44, found
        // by the §10 step 6 replay sweep and adjudicated `old_right`:
        //
        //   2026-06-20, Abid Kazmi, 241.5h (ten days) to kickoff, squad
        //   0/14, answering Kemal's chase — "I will be back Tuesday
        //   week". The engine registered him CONFIRMED. Production
        //   labelled it out/OUT and the incumbent wrote nothing; only
        //   the engine put him in the squad.
        //
        // It was a SCHEMA gap, not a bad decision: `tense` said "future"
        // and `contingent` said false, which is exactly what "I'm in for
        // next Tuesday" says. `basis` is the missing field (see
        // `ClaimBasis`), and this is the only place that reads it.
        //
        // ASYMMETRIC, and the asymmetry is the point. A squad place goes
        // to someone who asked for one, and reporting that you will be
        // in the country is not asking — being ABLE to play is necessary
        // and never sufficient. Being UNABLE to play settles it on its
        // own, so an availability OUT still frees the slot; a place
        // nobody can use is a place the club loses, and refusing that
        // direction too would trade one spurious write for a class of
        // missed ones.
        if (c.basis === "availability" && c.polarity !== "out") {
          out.reasons.push(
            `availability statement about ${t.name}, not a commitment to play: no write`,
          );
          continue;
        }

        // ── Contingency (§3.2 S11, S12, S15) ──────────────────────────
        if (c.contingent) {
          if (c.polarity === "out") {
            // 2026-06-09, Erdal: "If u can make happy to drop" dropped
            // him immediately, the replacement never confirmed, and the
            // squad sat at 13 for a paid match. A contingent OUT HOLDS.
            // No literal "if" is required to reach this branch, which is
            // what route.ts:3095 got wrong.
            out.reasons.push(`contingent drop for ${t.name}: holding, no write`);
            continue;
          }
          if (!self) {
            // A CONTINGENT CLAIM ABOUT SOMEONE ELSE NEVER REGISTERS THEM.
            //
            // Found by the §10 step 6 replay sweep, adjudicated
            // `old_right`, and it is the dangerous direction:
            //
            //   2026-06-11, Omar Yusuf, 7.3h to kickoff, squad 10/14 —
            //   "Also, if David would like to join, I'd be happy for him
            //   to take my spot". The engine registered DAVID, who had
            //   not spoken, and left Omar in: the squad grew to 11
            //   instead of the swap Omar actually offered. Production
            //   labelled it `conditional_in` and wrote nothing.
            //
            // The standing-offer rule (§3.2 S15 flavour (a)) is about
            // the SENDER — "consider me as the 14th whenever you have
            // 13" — and its corpus case is
            // `PR26-self-standing-offer-registers-the-sender`. Nothing
            // in the archive wants a contingent claim about a third
            // party to register anyone, and `conditionOn` has no value
            // for "the condition is about that third party's own
            // willingness", so such a claim landed in the standing-offer
            // branch by default. It now holds instead.
            //
            // This also makes A5's protection STRUCTURAL rather than
            // dependent on the extractor's `personNamed`: "my brother
            // can play if needed" is refused twice over.
            out.reasons.push(
              `contingent claim about ${t.name} (not the sender): holding, no write`,
            );
            continue;
          }
          if (c.conditionOn === "self") {
            // Personal uncertainty ("in if my back holds up"). Record
            // nothing; the tentative follow-up path chases later.
            out.reasons.push(`tentative (personal uncertainty) for ${t.name}: no write`);
            continue;
          }
          // conditionOn "squad" or "none", and the SENDER's own claim: a
          // standing offer. §3.2 S15(a) is the rule behind incident A5
          // and its outcome is the OPPOSITE of (b): the person is
          // registered now, and capacity below decides whether that is a
          // slot or the bench.
          out.reasons.push(`standing offer for ${t.name}: registering`);
        }

        // ── Third-party drops and demotes ─────────────────────────────
        if (!self && (c.polarity === "out" || c.polarity === "bench")) {
          if (c.polarity === "bench" && !senderIsAdmin) {
            // §3.2 S8 frames the demote as an ADMIN op, and taking a
            // confirmed slot off someone who never consented is roster
            // surgery. A tag alone is not enough.
            out.reasons.push(`only an admin may bench ${t.name}`);
            continue;
          }
          const refusal = banterRefusal(msg, t, messages, senderIsAdmin);
          if (refusal) {
            out.reasons.push(refusal);
            continue;
          }
        }

        // ── Bench-slot offers (§3.2 S13, and NOBODY is ever dropped) ──
        const existing = t.userId ? w.rows.get(t.userId) : undefined;
        // An offer's audience is the bench AS IT WAS when the offer
        // opened, and an EMPTY audience is offered to nobody rather than
        // to everyone. An offer can outlive its bench (everyone on it
        // gets confirmed), and the everyone-reading meant the next
        // person to say IN silently consumed a slot that was never
        // theirs — the first bencher to answer would then find the offer
        // gone. Fail closed.
        const openOffer =
          t.userId !== null
            ? w.offers.find((o) => o.offeredToUserIds.includes(t.userId as string))
            : undefined;
        // `existing` is a live reference into the working state and
        // applyClaim mutates it, so the BEFORE status has to be read
        // now. (Caught by the S13b unit test the moment the claim rule
        // started depending on it.)
        const statusBefore = existing?.status;
        if (
          existing?.status === "BENCH" &&
          c.polarity === "in" &&
          openOffer &&
          !self &&
          !promoteAuthorized
        ) {
          // A third party nominating a bench player does not claim the
          // slot for them. The offer stays open, first-claim-wins.
          out.reasons.push(
            `${t.name} was nominated by someone else; a bench slot is claimed by its holder`,
          );
          continue;
        }

        const write = applyClaim({
          w,
          state,
          target: t,
          self,
          promoteAuthorized,
          messageId: msg.id,
        });
        if (!write) {
          // A bench player answering an open offer when the slot has
          // already gone gets an ANSWER, not silence. That is the
          // 2026-05-19 Karahan shape: the bencher does what they were
          // asked and machinery ignores them.
          if (statusBefore === "BENCH" && c.polarity === "in" && openOffer && self) {
            speech.push({ kind: "bench_claim_too_late", messageId: msg.id, userId: t.userId! });
            out.disposition = out.disposition === "degraded" ? "degraded" : "acted";
          }
          out.reasons.push(`no change for ${t.name}`);
          continue;
        }
        emit(write);
        squadChanged = true;
        out.react = out.react ?? reactFor(write.status, self);

        // A player who was DROPPED and is back closes the offer that
        // was opened for THEIR slot: it isn't vacant any more, so asking
        // the bench to step into it makes no sense. `attendance.ts`
        // auto-resolves exactly this (Sutton 2026-05-26: Baki was
        // re-confirmed and the stale offer kept firing bench prompts on
        // top of the squad-locked message).
        if (statusBefore === "DROPPED" && t.userId && write.status !== "DROPPED") {
          const stale = w.offers.filter((o) => o.replacingUserId === t.userId);
          w.offers = w.offers.filter((o) => o.replacingUserId !== t.userId);
          for (const o of stale) {
            emit({
              kind: "resolve_bench_offer",
              offerId: o.id,
              claimedByUserId: t.userId,
              sourceMessageId: msg.id,
              reason: `${t.name} is back, so the slot they vacated is no longer open`,
            });
          }
        }

        // Claiming an open offer resolves it — but only when the
        // claimant actually came off the bench for it. A brand-new
        // registration is an ordinary IN, not a claim.
        if (write.status === "CONFIRMED" && openOffer && t.userId && statusBefore === "BENCH") {
          w.offers = w.offers.filter((o) => o.id !== openOffer.id);
          emit({
            kind: "resolve_bench_offer",
            offerId: openOffer.id,
            claimedByUserId: t.userId,
            sourceMessageId: msg.id,
            reason: `${t.name} took the open slot`,
          });
        }

        // A drop with a bench behind it opens ONE offer to the WHOLE
        // bench. Nobody is dropped; first claim wins; daytime gating and
        // the copy live in bench-offer-copy.ts (§13 "preserve exactly").
        if (write.status === "DROPPED" && t.userId) {
          const bench = benchUserIds(w);
          const alreadyOpen = w.offers.some((o) => o.replacingUserId === t.userId);
          if (bench.length > 0 && !alreadyOpen) {
            const offer = {
              id: `proposed-offer-${t.userId}`,
              replacingUserId: t.userId,
              offeredToUserIds: bench,
            };
            w.offers.push(offer);
            emit({
              kind: "open_bench_offer",
              replacingUserId: t.userId,
              offeredToUserIds: bench,
              sourceMessageId: msg.id,
              reason: `${t.name} dropped out with ${bench.length} on the bench`,
            });
            speech.push({
              kind: "bench_offer_open",
              messageId: msg.id,
              replacingName: t.name,
            });
          }
        }
      }

      // A resolved confirmation is a conversational turn and deserves an
      // answer even when every write turned out to be idempotent. Found
      // by the first live corpus sweep: "Confirmed" resolved the pending
      // set correctly, both names were ALREADY down, so nothing changed
      // and the bot said nothing at all. "Message understood, action
      // silently not taken" is this product's signature failure (§9) and
      // it applies just as much to an action that was already true.
      if (fromAffirmation && out.writes.length === 0 && targets.length > 0) {
        speech.push({
          kind: "pending_confirmed_ack",
          messageId: msg.id,
          userIds: targets.map((t) => t.userId).filter((id): id is string => !!id),
        });
        out.disposition = out.disposition === "degraded" ? "degraded" : "acted";
      }

      // A recruit request alongside a drop opens the same offer path; if
      // no bench exists there is nothing to open, and the chase is the
      // scheduler's job. Either way it is RECORDED, never swallowed.
      if (facts.sideRequests.includes("recruit") && out.writes.length === 0) {
        out.reasons.push("recruit request with no accompanying attendance change");
      }
    }

    function handleQuestion(msg: EngineMessage) {
      const facts = msg.facts;
      if (facts.kind !== "question") return;
      if (actionRequiresTag({ intent: "question", registerAttendance: null, registerFor: null }) && !msg.tagged) {
        out.reasons.push("question requires an @Match Time tag (interaction contract)");
        return;
      }
      out.disposition = "acted";
      switch (facts.topic) {
        case "squad":
          // "who's in / list the players" wants NAMES. Until 2026-09-06
          // this shared `answer_count` with the topic below and got
          // "We're 6/14 for Tue 21:30, need 8 more 🙏" — the right
          // answer to a different question. Deferred for the same reason
          // `count` is: when the batch also changed the squad, the
          // batch's own squad post IS this answer, and two rosters one
          // line apart is the 2026-06-12 Sutton Lads shape (S36).
          deferredSquadQuestions.push({ kind: "answer_squad", messageId: msg.id });
          out.reasons.push("roster question answered from the database");
          break;
        case "count":
          // §3.2 S24: the engine compares the stated number to the DB.
          // Deferred so it collapses into the single squad post when the
          // batch also changed the squad (S36).
          deferredSquadQuestions.push({
            kind: "answer_count",
            messageId: msg.id,
            statedCount: facts.statedCount,
          });
          out.reasons.push(
            facts.statedCount === null
              ? "squad-state question answered from the database"
              : `stated ${facts.statedCount}, database says ${confirmedCount(w)}`,
          );
          break;
        case "fixture":
          // Kickoff and venue, straight off the state. NOT deferred:
          // "what time is kickoff" is not a claim about the squad, so a
          // squad post in the same batch neither answers it nor
          // contradicts it.
          speech.push({ kind: "answer_fixture", messageId: msg.id });
          out.reasons.push("fixture question answered from the match");
          break;
        case "bench":
          speech.push({ kind: "answer_bench", messageId: msg.id });
          break;
        case "person_status": {
          const ref = facts.personRef ?? "";
          const r = resolvePerson(ref, w.roster);
          speech.push({
            kind: "answer_person_status",
            messageId: msg.id,
            personRef: ref,
            userId: r.kind === "resolved" ? r.member.userId : null,
          });
          if (r.kind !== "resolved") out.reasons.push(`asked about "${ref}", who is not a member`);
          break;
        }
        case "phones":
          speech.push({ kind: "answer_phones", messageId: msg.id });
          break;
        case "stats":
          if (!state.features.statsQa) {
            out.reasons.push("stats Q&A is off for this org");
            out.disposition = "noop";
            break;
          }
          speech.push({ kind: "answer_stats", messageId: msg.id });
          break;
        case "options":
          speech.push({ kind: "answer_options", messageId: msg.id });
          break;
        default:
          // The `question` route is the least designed part of the
          // proposal (§14.3) and this is where that shows. Saying so is
          // the point: a silent shrug is the failure mode this design
          // exists to remove.
          degrade(`no deterministic answer for question topic "${facts.topic}"`);
      }
    }

    function handleTeams(msg: EngineMessage) {
      const facts = msg.facts;
      if (facts.kind !== "teams") return;
      if (!msg.tagged) {
        out.reasons.push("team ops require an @Match Time tag (interaction contract)");
        return;
      }
      if (facts.action === "show") {
        // 2026-06-18 (c408649): "show the teams again" re-ran the
        // balancer and destroyed an admin's manual swap. Showing is a
        // READ. There is no branch here that can write.
        //
        // ⚠️ TERMINAL BRANCH. Both arms below `return`, so nothing later
        // in `handleTeams` runs for a `show`. The only thing after them
        // is the `degrade()` for generate/rename/swap, which must NOT
        // fire here — showing is the one team action this path owns.
        if (w.teams.length === 0) {
          // The 2026-09-06 sweep: `formatTeamsPost` over two empty lists
          // composed "⚽ *Teams for tonight* … *Red*:\n\n\n*Yellow*:
          // \n\n\n" and sent it. An empty team sheet is worse than no
          // answer, and the shipped path already has the right one
          // (`route.ts:3711-3714`) — including its refusal to
          // auto-generate, which is why this stays a read.
          speech.push({ kind: "teams_not_generated", messageId: msg.id });
          out.disposition = "acted";
          out.reasons.push("asked to show teams that have not been generated yet");
          return;
        }
        speech.push({ kind: "teams_post", messageId: msg.id });
        out.disposition = "acted";
        out.reasons.push("re-posting the existing teams; the balancer is not re-run");
        return;
      }

      // ── `generate` — §10 STEP 8 ────────────────────────────────────
      //
      // The club's most-used command: 23 "generate the teams" in 120
      // days on Sutton FC, more than every question shape put together.
      // Deleting the mega-prompt without an owner for it would take the
      // feature with it, which is why it is here rather than degrading
      // alongside `rename` and `swap`.
      //
      // WHAT THIS BRANCH DECIDES, AND WHAT IT DOES NOT:
      //
      //   • It resolves NAMES — who to force-confirm, who to pin — and
      //     nothing else. The line-ups are `team-balancer.ts`'s, the
      //     target match is the runner's, and the post is
      //     `generateTeamsForMatch`'s.
      //   • It requires the @Match Time tag (checked above for the whole
      //     handler): `generate_teams_request` is in `ACTIONY_INTENTS`.
      //   • It does NOT require an admin, because the shipped path does
      //     not (`route.ts:3552`) — any tagged member may ask. An admin
      //     gate here would be a regression dressed as caution.
      //   • It does NOT touch `w`. The force-include is applied by
      //     `team-ops-engine.ts` in its own transaction, so modelling it
      //     in the projection would flip `squadChanged` and make the
      //     composer emit a batch-level squad post BESIDE the team post —
      //     two posts for one message, §3.2 S36 exactly. The cost is
      //     that `nextState` under-reports a force-include; the runner
      //     composes the team post from the balancer's own output and
      //     never from `nextState`, so nothing reads the stale half.
      if (facts.action === "generate") {
        const senderFirstRef = msg.senderName?.trim().split(/\s+/)[0] ?? null;
        /** "me" / "myself" / "I" → the sender, from a CLOSED list. The
         *  shipped path rebinds these the same way
         *  (`route.ts:3637-3641`); `identity.ts` correctly refuses to
         *  match "me" against a roster, so the mapping happens here and
         *  never by asking a model who "me" is. */
        const deSelf = (ref: string): string =>
          SELF_REFS.has(ref.trim().toLowerCase()) && senderFirstRef ? senderFirstRef : ref;

        /** Members with ANY attendance row on the match. The shipped
         *  force-include matches against exactly this set
         *  (`route.ts:3570-3574`) — a BENCH or DROPPED player is the
         *  whole point of the feature, so CONFIRMED-only would break it. */
        const attending = w.roster.filter((mem) => w.rows.has(mem.userId));

        const forceInclude: Array<{ userId: string; name: string; ref: string }> = [];
        const unmatchedIncludes: string[] = [];
        for (const rawRef of facts.includeRefs) {
          const r = resolvePerson(deSelf(rawRef), attending);
          if (r.kind !== "resolved") {
            // Reported to the group as "couldn't find … — ignored",
            // never dropped in silence. STRICTER than the shipped path,
            // which takes the first fuzzy hit: `resolvePerson` refuses
            // an ambiguous first name rather than force-confirming
            // whichever of two Amirs happened to sort first.
            unmatchedIncludes.push(rawRef);
            out.reasons.push(`include "${rawRef}" did not resolve to one member (${r.kind})`);
            continue;
          }
          if (forceInclude.some((f) => f.userId === r.member.userId)) continue;
          forceInclude.push({ userId: r.member.userId, name: r.member.name, ref: rawRef });
        }

        // Pins resolve against the squad AS IT WILL BE — CONFIRMED rows
        // plus anyone this same message force-includes. The shipped path
        // re-reads the roster after the flips for exactly this reason
        // and calls it "the (now possibly updated) roster"
        // (`route.ts:3630`).
        const forcedIds = new Set(forceInclude.map((f) => f.userId));
        const pinnable = w.roster.filter(
          (mem) => forcedIds.has(mem.userId) || w.rows.get(mem.userId)?.status === "CONFIRMED",
        );

        const pinned: Array<{ userId: string; name: string; team: "RED" | "YELLOW" }> = [];
        const unmatchedPins: string[] = [];
        const pin = (rawRef: string, team: "RED" | "YELLOW") => {
          const r = resolvePerson(deSelf(rawRef), pinnable);
          if (r.kind !== "resolved") {
            unmatchedPins.push(rawRef);
            out.reasons.push(`pin "${rawRef}" did not resolve to one confirmed player (${r.kind})`);
            return;
          }
          // First pin wins. Two instructions about one player contradict
          // each other and the balancer can honour only one; taking the
          // earlier is at least the one the message said first.
          if (pinned.some((p) => p.userId === r.member.userId)) return;
          pinned.push({ userId: r.member.userId, name: r.member.name, team });
        };

        for (const s of facts.swaps) pin(s.personRef, s.team);

        // ── PAIRINGS: "put me and David on the same team" ─────────────
        //
        // THE HONEST BIT. `generateTeamsForMatch` takes `pinnedToTeam` —
        // an ABSOLUTE colour per player — and has no notion of
        // "together". So a pairing is honoured by pinning the whole
        // group to ONE side, and WHICH side is arbitrary: it inherits
        // the colour of any member the message already pinned by name,
        // and otherwise falls to RED. Red and Yellow carry no meaning of
        // their own (the labels are per-match display names), so the
        // constraint the message actually expressed — these people
        // together — is preserved exactly, and the only thing invented
        // is a colour that means nothing.
        //
        // The shipped path has the SAME limitation and resolves it
        // worse: the mega-prompt had to pick the colour itself, so a
        // pairing arrived as two model-authored `teamOverrides`.
        //
        // `team-balancer.ts:63-66` caps pins at `perTeam` per side and
        // lets the overflow fall back into the ordinary pool, so an
        // over-large pairing degrades into a partial constraint rather
        // than an impossible match. No cap is re-implemented here.
        for (const group of facts.pairings) {
          const resolved: Array<{ userId: string; name: string }> = [];
          for (const rawRef of group) {
            const r = resolvePerson(deSelf(rawRef), pinnable);
            if (r.kind !== "resolved") {
              unmatchedPins.push(rawRef);
              out.reasons.push(
                `pairing member "${rawRef}" did not resolve to one confirmed player (${r.kind})`,
              );
              continue;
            }
            resolved.push({ userId: r.member.userId, name: r.member.name });
          }
          if (resolved.length < 2) {
            // One resolved name is not a pairing, and pinning them alone
            // would impose a colour the message never asked for.
            if (resolved.length === 1) {
              out.reasons.push(
                `pairing "${group.join(" + ")}" resolved only ${resolved[0].name}; a group of ` +
                  `one constrains nothing, so no pin was made`,
              );
            }
            continue;
          }
          const already = resolved
            .map((r) => pinned.find((p) => p.userId === r.userId)?.team)
            .find((t): t is "RED" | "YELLOW" => t !== undefined);
          const team = already ?? "RED";
          for (const r of resolved) {
            if (pinned.some((p) => p.userId === r.userId)) continue;
            pinned.push({ userId: r.userId, name: r.name, team });
          }
          out.reasons.push(
            `pairing ${resolved.map((r) => r.name).join(" + ")} honoured by pinning the group ` +
              `to ${team} (the colour is arbitrary; the balancer has no "together" constraint)`,
          );
        }

        emit({
          kind: "generate_teams",
          forceInclude,
          unmatchedIncludes,
          pinned,
          unmatchedPins,
          // Only when the message SUPPLIED both names. "come up with fun
          // team names" supplies none, and the extractor is told not to
          // invent any — `team-ops-engine-batch.ts` records what that
          // loses relative to the mega-prompt.
          teamNames: facts.teamNames,
          sourceMessageId: msg.id,
          reason: "team generation requested",
        });
        // NO SPEECH INTENT, deliberately. The group post is
        // `generateTeamsForMatch`'s `groupPost` — the real balancer
        // output, with the real names and the real ratings — and the
        // composer cannot produce it from `SquadState`, because the
        // line-ups do not exist until the write has run.
        // `team-ops-engine.ts` composes it from what LANDED: the same
        // shape the payment ack uses, for the same reason (§3.2 S7 — the
        // words must match the action).
        return;
      }

      // ── `rename` AND `swap`: NEITHER IS OWNED, each for its own
      //    reason ─────────────────────────────────────────────────────
      //
      //   • `swap` HAS AN OWNER ALREADY. `route.ts`'s
      //     `handleTeamSwapIfApplicable` / `handleColorSwapIfApplicable`
      //     is a deterministic pre-peel that runs on the RAW BODY with no
      //     verdict at all, so it survives the mega-prompt's deletion
      //     untouched. Owning it here would put two deciders on one
      //     message, which is the failure this file is organised to
      //     prevent.
      //   • `rename` IS NOT A GENERATE. Mapping it onto
      //     generate-with-names would re-run the balancer over line-ups
      //     an admin may have hand-swapped — 2026-06-18 (`c408649`), the
      //     incident that split `show` from `generate` in the first
      //     place. Renaming WITHOUT reshuffling is a `Match.teamLabels`
      //     write this path does not model. Losing a rename costs one
      //     message; the alternative costs the teams.
      degrade(
        `team action "${facts.action}" has no owner in the pipeline` +
          (facts.action === "swap"
            ? `; route.ts's deterministic swap pre-peel owns it on the raw body`
            : `; renaming without reshuffling is not modelled, and generating instead ` +
              `would re-run the balancer over an admin's manual swap (c408649)`),
      );
    }

    function handleScore(msg: EngineMessage) {
      const facts = msg.facts;
      if (facts.kind !== "score") return;
      const completed = w.completed;
      if (!completed) {
        out.reasons.push("no completed match to record a score against");
        return;
      }
      const senderIsAdmin =
        !!msg.senderUserId && !!w.roster.find((m2) => m2.userId === msg.senderUserId)?.isAdmin;
      const played = !!msg.senderUserId && completed.participantUserIds.includes(msg.senderUserId);
      // ── AN UNRESOLVED SENDER IS PERMITTED, AND THAT IS DELIBERATE ───
      //
      // Restored from the shipped path (`route.ts:3457-3462`, in its own
      // words): *"If we CAN'T resolve them (e.g. WhatsApp hid the phone
      // via @lid and the pushname didn't match any player) → still write
      // the score, because the message came from the monitored org's
      // group chat and losing the score entirely is a worse failure mode
      // than occasionally trusting a wrong number. Admin can correct via
      // the dashboard."*
      //
      // This is NOT a hole in the §9 authorisation seatbelt, which
      // survives untouched one line below: a RESOLVED member who neither
      // played nor is an admin is still refused. The distinction is
      // between "we know who this is and they may not" and "WhatsApp did
      // not tell us who this is" — and since the @lid change, the second
      // is a routine condition in a real group rather than an exotic
      // one, which is why the shipped path is written this way.
      //
      // The blast radius is bounded on all sides: the message must be in
      // the org's own monitored group, the target must be a match that
      // has already been played, and `handleScore` refuses to overwrite
      // a result that is already recorded — so the worst case is one
      // wrong number on one match, correctable in the dashboard, against
      // the certainty of losing every score reported from an @lid.
      const senderUnresolved = !msg.senderUserId;
      if (senderUnresolved) {
        out.reasons.push(
          "score from an unresolved sender: accepted, because losing the score entirely " +
            "is a worse failure mode (route.ts:3457-3462)",
        );
      } else if (!senderIsAdmin && !played) {
        // §9 authorisation — survives untouched. Nothing about the
        // model's competence changes who may report a result.
        out.reasons.push("score reported by someone who neither played nor is an admin");
        return;
      }
      if (completed.redScore !== null || completed.yellowScore !== null) {
        // The shipped path only ever looks for an UNSCORED completed
        // match (`route.ts` filters on redScore/yellowScore null). Without
        // that, any later message the router calls `score` rewrites a
        // settled result — and in step 6 it would re-run the Elo deltas.
        out.reasons.push(
          `the last completed match already recorded ` +
            `${completed.redScore}-${completed.yellowScore}; not overwriting it`,
        );
        return;
      }
      const red = clampScore(facts.first);
      const yellow = clampScore(facts.second);
      if (red === null || yellow === null) {
        degrade(`score out of range: ${facts.first}-${facts.second}`);
        return;
      }
      completed.redScore = red;
      completed.yellowScore = yellow;
      emit({
        kind: "score",
        matchId: completed.id,
        red,
        yellow,
        sourceMessageId: msg.id,
        reason: senderUnresolved
          ? "final result reported from the org's own group by an unresolved sender"
          : "final result reported by a participant or admin",
      });
      // The match moves to COMPLETED as part of applying this write
      // (`route.ts:3510-3517`), so the projection has to move too or a
      // second `score` message in the same batch would see an
      // unfinished match and try again.
      completed.status = "COMPLETED";
      speech.push({ kind: "score_ack", messageId: msg.id, red, yellow });
      out.react = "👍";
    }

    function handleAdmin(msg: EngineMessage) {
      const facts = msg.facts;
      if (facts.kind !== "admin") return;
      const senderIsAdmin =
        !!msg.senderUserId && !!w.roster.find((m2) => m2.userId === msg.senderUserId)?.isAdmin;

      if (facts.action === "bulk_payment") {
        if (!msg.tagged) {
          out.reasons.push("payment credit requires an @Match Time tag");
          return;
        }
        if (!state.features.paymentTracking) {
          out.reasons.push("payment tracking is off for this org");
          return;
        }
        if (!senderIsAdmin) {
          // Real money, live on Sutton FC. The chase math must not be
          // corruptible by any member who can type.
          out.reasons.push("only an admin may credit a payment");
          return;
        }
        const payer = resolvePerson(facts.payerRef ?? "", w.roster);
        if (payer.kind !== "resolved") {
          degrade(`payment credit names "${facts.payerRef}", who does not resolve to a member`);
          return;
        }
        const count = Math.floor(facts.count ?? 0);
        if (count <= 0) {
          degrade("payment credit with no usable player count");
          return;
        }
        // Real money on a real club. §6.4's claim is that numbers are
        // never model-authored so they cannot be wrong; THIS one is
        // model-authored, so a figure that cannot be true is refused and
        // said out loud rather than quietly clamped and then announced.
        if (count > state.maxPlayers) {
          degrade(
            `payment credit for ${count} players exceeds the format's ${state.maxPlayers}; refusing`,
          );
          return;
        }
        const refs = facts.coveredRefs ?? [];
        const covered: string[] = [];
        for (const ref of refs) {
          // "Amir paid for me and Adam". The shipped path maps the
          // first-person refs onto the SENDER (`route.ts:3846-3850`);
          // `identity.ts` correctly refuses to match "me" against a
          // roster, so the mapping is done here, from a closed list, and
          // never by asking a model who "me" is.
          if (SELF_REFS.has(ref.trim().toLowerCase())) {
            if (msg.senderUserId) {
              covered.push(msg.senderUserId);
              continue;
            }
            out.reasons.push(`covered name "${ref}" is the sender, who is unresolved`);
            continue;
          }
          const r = resolvePerson(ref, w.roster);
          if (r.kind === "resolved") covered.push(r.member.userId);
          else out.reasons.push(`covered name "${ref}" did not resolve`);
        }
        // ── NAMED, BUT NOBODY RESOLVED ─────────────────────────────────
        //
        // A shipped defect, not reproduced. `route.ts:3841-3886` takes
        // the named branch on `coveredNames.length > 0`, stamps nothing
        // when none of them match, creates no `PaymentCredit` — and then
        // replies "credited *Amir* with 4 payments" anyway. The group is
        // told a payment landed and the chase math never saw it.
        //
        // The alternative — falling through to the aggregate branch — is
        // worse: it would credit a NUMBER for people the message named
        // and nobody could identify. So the message goes back to the
        // analyzer, which is the one direction that cannot invent money.
        if (refs.length > 0 && covered.length === 0) {
          degrade(
            `payment credit names ${refs.length} player(s) (${refs.join(", ")}) and none of them ` +
              `resolve to a member; refusing rather than crediting a count nobody checked`,
          );
          return;
        }
        emit({
          kind: "payment_credit",
          payerUserId: payer.member.userId,
          payerName: payer.member.name,
          count,
          coveredUserIds: covered,
          // From the FACTS, never from `covered.length`: the two differ
          // exactly when some names resolved and some did not, and that
          // is the case the apply layer must still treat as named.
          namedCovered: refs.length > 0,
          sourceMessageId: msg.id,
          reason: "admin-credited bulk payment",
        });
        speech.push({
          kind: "payment_ack",
          messageId: msg.id,
          payerName: payer.member.name,
          count,
        });
        return;
      }

      if (facts.action === "reminder") {
        if (!msg.tagged) {
          out.reasons.push("reminder request requires an @Match Time tag");
          return;
        }
        if (!state.features.reminders) {
          // The per-org gate `route.ts:3113-3121` maps `reminder_request`
          // onto, reproduced rather than left to the caller: a
          // MoM-and-ratings-only org gets total silence, not a queued DM.
          out.reasons.push("reminders are off for this org");
          return;
        }
        if (!msg.senderUserId) {
          degrade("reminder requested by an unresolved sender; nowhere to send it");
          return;
        }
        const sender = w.roster.find((m2) => m2.userId === msg.senderUserId);
        if (!sender?.hasPhone) {
          // `route.ts:3968-3974` answers this in the group rather than
          // swallowing it ("I don't have your number on file yet"). The
          // engine has no copy for that, and inventing a second wording
          // for a shipped sentence is how two bots start disagreeing —
          // so the message degrades and `admin-ops-engine-batch.ts`
          // hands it back to the analyzer, which still says it.
          degrade("reminder requested by a member with no phone number on file");
          return;
        }
        const phrase = (facts.phrase ?? "").trim();
        if (!phrase) {
          degrade("reminder request with no time phrase");
          return;
        }
        // §3.2 S22: the extractor returns the PHRASE and `date-fns-tz`
        // resolves it. Neither the model nor this file does calendar
        // arithmetic — `resolveReminderPhrase` is a pure function of
        // (phrase, now) and refuses anything it is not sure about.
        const when = resolveReminderPhrase(phrase, input.now);
        if (!when.ok) {
          degrade(`reminder time could not be resolved: ${when.reason}`);
          return;
        }
        // The shipped window, reproduced exactly (`route.ts:3941-3947`):
        // in the future with a 60-second grace, and inside 60 days.
        // Anything outside it "is almost certainly a parse error, not a
        // real request. Stay silent rather than fire a wrong-day DM."
        const deltaMs = when.at.getTime() - input.now.getTime();
        if (deltaMs <= -REMINDER_PAST_GRACE_MS || deltaMs > REMINDER_MAX_AHEAD_MS) {
          degrade(
            `reminder resolves to ${when.at.toISOString()}, outside the 60-day window; refusing`,
          );
          return;
        }
        emit({
          kind: "reminder",
          userId: msg.senderUserId,
          phrase,
          sendAt: when.at,
          whenLabel: when.whenLabel,
          // The message itself when the extractor named nothing. A nudge
          // whose body is empty is worse than a nudge that quotes the
          // request back, and neither is a decision.
          note: (facts.note ?? "").trim() || msg.body.trim(),
          sourceMessageId: msg.id,
          reason: "reminder requested",
        });
        speech.push({
          kind: "reminder_ack",
          messageId: msg.id,
          phrase,
          whenLabel: when.whenLabel,
        });
        return;
      }

      if (facts.action === "recruit") {
        // ── WHO MAY ASK. Not when it runs — see `recruit_blast`. ───────
        //
        // Admin-only, exactly as `route.ts:1548-1557` gates it, and NO
        // tag required: PR #33's `RECRUIT_COMMAND_IMPLIES_ADDRESSED`
        // says an admin's recruit command is itself a direct instruction
        // to MatchTime. Both pipelines read that same constant so
        // flipping it reverts both together.
        if (!senderIsAdmin) {
          out.reasons.push("only an admin may send a recruit blast");
          return;
        }
        if (!msg.tagged && !RECRUIT_COMMAND_IMPLIES_ADDRESSED) {
          out.reasons.push("recruit blast requires an @Match Time tag");
          return;
        }
        // "the last 5 matches" is a fact about the TEXT. The number the
        // model reports is untrusted and clamped to [1, 12] here, by
        // `recruit.ts`'s own clamp, because the ceiling exists for a
        // reason that has nothing to do with language: the bot runs on
        // an unofficial WhatsApp client and a mass DM risks the account
        // ban that takes the whole product down.
        const asked = facts.lookbackMatches;
        const lookback =
          typeof asked === "number" && Number.isFinite(asked) && asked > 0
            ? resolveLookbackMatches(asked)
            : null;
        if (lookback !== null && lookback !== Math.floor(asked as number)) {
          out.reasons.push(
            `recruit lookback ${asked} clamped to ${lookback} (max ${RECRUIT_LOOKBACK_MAX})`,
          );
        }
        emit({
          kind: "recruit_blast",
          lookbackMatches: lookback,
          sourceMessageId: msg.id,
          reason: "admin asked for a recruit blast",
        });
        return;
      }

      degrade(`admin action "${facts.action}" has no deterministic handler`);
    }
  });

  // ── Speech assembly (§3.2 S36 · one authoritative post per batch) ────
  if (squadChanged) {
    speech.push({ kind: "squad_status", messageId: null });
    for (const q of deferredSquadQuestions) {
      // The count question is answered BY that post. Four contradictory
      // posts in one batch is the 2026-06-12 Sutton Lads incident.
      void q;
    }
  } else {
    speech.push(...deferredSquadQuestions);
  }

  assertCoverage(messages, outcomes);

  return {
    outcomes,
    writes,
    nextState: {
      ...state,
      rows: [...w.rows.values()].sort((a, b) => a.position - b.position),
      roster: w.roster,
      openOffers: w.offers,
      teams: w.teams,
      completedMatch: w.completed,
    },
    speech,
    degradations,
  };
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Would this claim, on its own, ever produce a write?
 *
 * Only the vetoes that need no state: the confidence floor, tense, the
 * availability hold and the two contingency holds. Used by the state
 * collapse so a claim the engine is going to decline cannot supersede an
 * earlier one it would have acted on. Kept beside the rules it mirrors —
 * if one moves, this has to move with it, and the collapse tests are
 * what say so.
 */
function wouldWrite(c: Claim): boolean {
  if (c.confidence < CONFIDENCE_FLOOR) return false;
  if (c.tense === "past" || c.tense === "hypothetical") return false;
  if (c.basis === "availability" && c.polarity !== "out") return false;
  if (c.contingent && c.polarity === "out") return false;
  if (c.contingent && c.conditionOn === "self") return false;
  return true;
}

function polarityToAction(p: Claim["polarity"]): "IN" | "OUT" | "BENCH" {
  return p === "in" ? "IN" : p === "out" ? "OUT" : "BENCH";
}

/**
 * Build the shape `interaction-contract.ts` already understands, so the
 * tag gate is REUSED rather than reimplemented. §13: "The interaction
 * contract … moves into the engine unchanged in meaning."
 */
export function toGateVerdict(claims: Claim[], facts: AttendanceFacts): GateVerdict {
  const selfClaim = claims.find((c) => c.subject === "sender");
  const others: GateRegisterForEntry[] = claims
    .filter((c) => c.subject === "other")
    .map((c) => ({ name: c.personRef, action: polarityToAction(c.polarity) }));

  let intent: string;
  if (selfClaim) {
    if (selfClaim.contingent) intent = "conditional_in";
    else if (selfClaim.polarity === "out")
      intent = facts.sideRequests.includes("recruit") ? "replacement_request" : "out";
    else intent = "in";
  } else {
    intent = "in";
  }

  return {
    intent,
    registerAttendance: selfClaim ? polarityToAction(selfClaim.polarity) : null,
    registerFor: others.length > 0 ? others : null,
  };
}

/**
 * §3.2 S25 — MatchTime's own last post is a known object, so the names
 * it listed as pending can be read back out of it deterministically.
 * Anchored on the literal copy the bot composes; anything else returns
 * nothing rather than guessing.
 */
export function parsePendingSet(lastBotPost: string | null): string[] {
  if (!lastBotPost) return [];
  const m = /waiting for confirmation:\s*([^.\n]+)/i.exec(lastBotPost);
  if (!m) return [];
  return m[1]
    .split(/,| and /i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/**
 * §9 "the banter-drop guard — SURVIVES". The prototype in §6.2 proves it
 * is needed: the extractor CORRECTLY reports that "Zeeshan is out 😂😂"
 * contains an OUT claim, because the text does. Deciding it is banter
 * needs corroboration the extractor cannot see, and the engine can.
 *
 * Two refusals, both narrow:
 *   1. the target is speaking in this same window and says the opposite;
 *   2. a non-admin drops someone else amid laughing emoji.
 * An admin's uncontested instruction is always honoured — that is the
 * control case, and losing it would be its own incident.
 */
function banterRefusal(
  msg: EngineMessage,
  target: Target,
  batch: EngineMessage[],
  senderIsAdmin: boolean,
): string | null {
  if (!target.userId) return null;
  const contradicts = batch.some(
    (other) =>
      other.id !== msg.id &&
      other.senderUserId === target.userId &&
      other.facts.kind === "attendance" &&
      other.facts.claims.some((c) => c.subject === "sender" && c.polarity === "in"),
  );
  if (contradicts) {
    return `${target.name} contradicts this in the same window; refusing the drop (corroboration)`;
  }
  if (!senderIsAdmin && /😂|🤣|lol\b/i.test(msg.body)) {
    return `banter markers in a non-admin drop of ${target.name}; refusing without corroboration`;
  }
  return null;
}

function clampScore(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  if (v < 0 || v > MAX_SCORE) return null;
  return v;
}

function reactFor(status: AttendanceRow["status"], self: boolean): string {
  if (!self) return "👍";
  if (status === "CONFIRMED") return "✅";
  if (status === "BENCH") return "🪑";
  return "👋";
}

/**
 * CAPACITY AND THE BENCH INVARIANT — the arithmetic the model got
 * catastrophically wrong, done here instead.
 *
 * A BENCH row means exactly one of two things (PR #27, 2026-08-31):
 * the squad is FULL, or a human EXPLICITLY asked for the bench. It must
 * never mean "a classifier inferred it", because a bench alongside four
 * empty slots is not a state the product can render honestly.
 */
function applyClaim(args: {
  w: Working;
  state: SquadState;
  target: Target;
  self: boolean;
  promoteAuthorized: boolean;
  messageId: string;
}): (ProposedWrite & { kind: "attendance" }) | null {
  const { w, state, target, self, promoteAuthorized, messageId } = args;
  const polarity = target.claim.polarity;

  // Provision a named guest the org has never seen. Only ever for an
  // ADD, only ever for something that survived the identity checks.
  let userId = target.userId;
  if (userId === null) {
    if (polarity !== "in") return null;
    userId = `new:${target.name}`;
    w.roster.push({ userId, name: target.name, isAdmin: false, hasPhone: false });
  }

  const existing = w.rows.get(userId);

  if (polarity === "out") {
    if (!existing || existing.status === "DROPPED") return null; // nothing to drop
    existing.status = "DROPPED";
    return {
      kind: "attendance",
      userId,
      name: target.name,
      status: "DROPPED",
      explicitBench: false,
      promote: false,
      sourceMessageId: messageId,
      reason: self ? "player dropped themselves" : "dropped by an authorised instruction",
    };
  }

  // A model-supplied `bench` is only EXPLICIT when nobody attached a
  // condition to it. `route.ts:2412-2417` makes exactly this
  // distinction on the shipped path: a conditional_in's BENCH is
  // "inferred", because nobody said the word "bench" — the classifier
  // decided a standing offer was functionally one, and that is only
  // sound when the squad is full. Treating it as explicit regenerates
  // the 2026-08-31 incident: a bench row rendered beside four empty
  // slots.
  const explicitBench = polarity === "bench" && !target.claim.contingent;
  const confirmed = confirmedCount(w);
  const squadHasRoom = confirmed < state.maxPlayers;

  if (existing && (existing.status === "CONFIRMED" || existing.status === "BENCH")) {
    const wantsDowngrade = explicitBench && existing.status === "CONFIRMED";
    const wantsPromotion =
      existing.status === "BENCH" && !explicitBench && squadHasRoom && (self || promoteAuthorized);
    if (!wantsDowngrade && !wantsPromotion) return null; // idempotent
    existing.status = wantsDowngrade ? "BENCH" : "CONFIRMED";
    return {
      kind: "attendance",
      userId,
      name: target.name,
      status: existing.status,
      explicitBench: wantsDowngrade,
      promote: wantsPromotion,
      sourceMessageId: messageId,
      reason: wantsDowngrade
        ? "explicit bench request"
        : "promoted from the bench into an open slot",
    };
  }

  const status = explicitBench || !squadHasRoom ? "BENCH" : "CONFIRMED";
  const position = existing ? existing.position : w.nextPosition++;
  w.rows.set(userId, { userId, status, position });
  return {
    kind: "attendance",
    userId,
    name: target.name,
    status,
    explicitBench,
    promote: false,
    sourceMessageId: messageId,
    reason: explicitBench
      ? "explicit bench request"
      : status === "BENCH"
        ? `squad full at ${confirmed}/${state.maxPlayers}`
        : `slot ${confirmed + 1} of ${state.maxPlayers}`,
  };
}

/**
 * §3.2 S1's incident as a post-condition. On 2026-05-25 two clear drop
 * messages were omitted from the verdict array entirely and the bot
 * silently no-op'd both; the prompt grew a 272-token VERDICT COVERAGE
 * banner. Here it is an assertion, and it throws rather than warns —
 * a coverage hole is a bug in this file, not a bad model day.
 */
export function assertCoverage(messages: EngineMessage[], outcomes: MessageOutcome[]): void {
  if (messages.length !== outcomes.length) {
    throw new Error(
      `pipeline coverage violation: ${messages.length} messages produced ` +
        `${outcomes.length} outcomes`,
    );
  }
  for (const m of messages) {
    if (!outcomes.some((o) => o.messageId === m.id)) {
      throw new Error(`pipeline coverage violation: no outcome for message ${m.id}`);
    }
  }
}
