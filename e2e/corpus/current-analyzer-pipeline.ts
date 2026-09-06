/**
 * Pipeline #1 — the shipped `/api/whatsapp/analyze` route, whatever is
 * behind it.
 *
 * Builds the case's world with the existing sim harness (`e2e/sim/
 * group.ts`), posts the messages through the REAL `/api/whatsapp/analyze`
 * route, and reads the world back out of the database.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CLASS NAME IS HISTORICAL, AND `stub` MODE IS UNPORTED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * "current-analyzer" meant the 19,850-token mega-prompt. §10 step 8
 * (2026-09-06) deleted it. The class is deliberately NOT renamed: its
 * name is in `baseline.stub.json`, in every report under `.e2e/corpus/`
 * and in every scoreboard anyone has quoted, and a rename would make
 * those unreadable for a change that alters nothing about what it does.
 * What it does is unchanged and always was the honest description —
 * post to the real route, read the database back.
 *
 * WHAT IS BROKEN, and it is not this file: each case's `stub` block is a
 * `CorpusStubVerdict`, and there is nothing left that reads a verdict.
 * `verdict:` is deleted from `group.ts` along with the seam, so this
 * adapter no longer forwards anything in `stub` mode and every stubbed
 * case runs against a server that routes nothing, owns nothing and says
 * nothing.
 *
 * ── WHY THIS PR DID NOT PORT IT, WHEN IT PORTED EVERYTHING ELSE ──────
 *
 * Twenty-one spec files moved from `verdict:` to `route` + `facts`
 * mechanically, because each one asserts what the SERVER does and the
 * facts behind it are a re-statement of the same message. The corpus
 * cannot be moved the same way, and the reason is `stubKind`:
 *
 *   • A `corrected` stub says "what a correct model emits". It ports:
 *     write the facts the text really carries and the case still asks
 *     "does the server execute a correct reading correctly?"
 *   • A `historical` stub says "the verdict the model ACTUALLY EMITTED
 *     during the incident", and asks "does today's SERVER catch it?".
 *     THERE IS NO HISTORICAL EQUIVALENT. The router and the extractors
 *     did not exist on 2026-05-08; no run of them was recorded, and
 *     inventing one and labelling it `historical` would be exactly what
 *     `README.md`'s rule 1 forbids — "Never invent a case and present it
 *     as a real incident."
 *
 * Eleven of the thirty-six stubbed cases are `historical`. Porting them
 * means DECIDING what a historical stub means once the component that
 * erred is deleted, and the honest answers are all changes to what the
 * corpus asserts: re-label them `corrected` (they stop asking whether
 * the server catches a bad reading), mark them `liveOnly` with a
 * reason (the count of CI-covered cases drops from 36 to 25), or write
 * facts that are wrong on purpose (which tests the extractor, not the
 * server, and is the "grading your own answer key" trap).
 *
 * That is a decision about the corpus's contract, not a test migration,
 * and `README.md` says three times that a corpus expectation is never
 * weakened to make a suite green. So `npm run test:corpus` is LEFT
 * FAILING, loudly, against the recorded baseline — 34 pass / 2 fail — and
 * the failure is the tracking issue.
 *
 * LIVE mode is unaffected and always was — it never used the seam. The
 * live sweeps are the corpus's real evidence and they still run.
 *
 * HISTORY IS MANDATORY. `group.ts` forwards the "Recent chat history"
 * block the Pi sends on every production call. PR #26 discovered the sim
 * was omitting it, which meant every live-LLM test written before it ran
 * against a prompt production never uses — Amir's bug reproduced only
 * 2/5 WITH history. Every case's `history` is forwarded on every turn,
 * and later turns also see the earlier turns and MatchTime's own replies.
 */
import { SimGroup, type SimHistoryEntry } from "../sim/group";
import type { CorpusCase, CorpusMessage, CorpusObservation } from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";
// The world builder and the read-back helpers moved to ./world when the
// SECOND pipeline arrived (§10 step 2). Both pipelines must be judged
// against a world built by the same code, or a divergence in the builder
// would read as a divergence in the pipelines.
import { buildCorpusWorld, readMembers, readRows, readScore, readTeams } from "./world";

export class CurrentAnalyzerPipeline implements CorpusPipeline {
  readonly name: string = "current-analyzer";

  supports(c: CorpusCase, mode: CorpusMode): boolean {
    if (mode === "live") return true;
    // A stubbed run needs the case to say what the model emits, so cases
    // without stubs are live-only by design.
    //
    // KEPT AS-IS AFTER §10 STEP 8, deliberately. Returning `false` here
    // would turn 36 failing cases into 36 skipped ones, which the
    // baseline compare reports as 36 regressions either way — and a
    // skip hides the observation while a failure prints it. See the
    // header: the stub blocks need porting from verdicts to routes +
    // facts, and until they are, this mode is honestly broken rather
    // than quietly absent.
    return c.messages.some((m) => m.stub !== undefined);
  }

  // `mode` is part of the `CorpusPipeline` contract and is read by every
  // other implementation; this one stopped branching on it when `stub`
  // mode lost its seam (see the header). Kept in the signature, renamed,
  // so the interface is still obviously satisfied.
  async run(ctx: PipelineContext, c: CorpusCase, mode: CorpusMode): Promise<CorpusObservation> {
    void mode;
    const grp = await this.buildWorld(ctx, c);

    const attendanceBefore = await this.rows(grp);
    const memberNamesBefore = await this.members(grp);
    const teamsBefore = await this.teams(grp);

    const spoken: string[] = [];
    const dms: Array<{ to: string | null; text: string }> = [];
    const reacts: Array<string | null> = [];

    // Messages are grouped into turns; each turn is one analyze batch,
    // exactly as the Pi's buffer flushes.
    const turns = new Map<number, CorpusMessage[]>();
    for (const m of c.messages) {
      const t = m.turn ?? 0;
      if (!turns.has(t)) turns.set(t, []);
      turns.get(t)!.push(m);
    }

    const history: SimHistoryEntry[] = (c.history ?? []).map((h) => ({
      authorName: h.author,
      body: h.body,
    }));

    for (const turn of [...turns.keys()].sort((a, b) => a - b)) {
      const items = turns.get(turn)!;
      const batch = await grp.postBatch(
        items.map((m) => ({
          ...(typeof m.from === "string" ? { player: m.from } : { author: m.from }),
          body: m.body,
          botMentioned: m.tag ?? false,
          // NOTHING IS FORWARDED IN `stub` MODE. `m.stub` is a
          // `CorpusStubVerdict` and the seam that read one is deleted;
          // see this file's header for why it was not translated into
          // routes + facts here. Every message therefore arrives
          // unrouted, which `gate.ts` falls back to `unsure`, and with no
          // facts behind it nothing is written and nothing is said.
        })),
        { history: [...history] },
      );

      for (const r of batch.results) {
        reacts.push(r.react ?? null);
        if (r.reply) spoken.push(r.reply);
      }
      spoken.push(...batch.groupPosts);
      dms.push(...batch.dms.map((d) => ({ to: d.phone, text: d.text })));

      // Carry this turn forward as history for the next one.
      for (const m of items) {
        history.push({
          authorName: typeof m.from === "string" ? grp.player(m.from).name : m.from.name,
          body: m.body,
        });
      }
      for (const r of batch.results) {
        if (r.reply) history.push({ authorName: "MatchTime", body: r.reply });
      }
      for (const post of batch.groupPosts) history.push({ authorName: "MatchTime", body: post });
    }

    return {
      attendanceBefore,
      attendanceAfter: await this.rows(grp),
      memberNamesBefore,
      memberNamesAfter: await this.members(grp),
      spoken,
      dms,
      reacts,
      benchOffersOpen: (await grp.openOffers()).length,
      teamsBefore,
      teamsAfter: await this.teams(grp),
      scoreAfter: await this.score(grp),
      notes: { orgId: grp.orgId, matchId: grp.matchId },
    };
  }

  private async buildWorld(ctx: PipelineContext, c: CorpusCase): Promise<SimGroup> {
    return buildCorpusWorld(ctx, c);
  }

  private rows = readRows;
  private members = readMembers;
  private teams = readTeams;
  private score = readScore;
}
