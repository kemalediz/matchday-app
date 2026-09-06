/**
 * Pipeline #1 — the shipped `/api/whatsapp/analyze` route, whatever is
 * behind it.
 *
 * Builds the case's world with the existing sim harness (`e2e/sim/
 * group.ts`), posts the messages through the REAL `/api/whatsapp/analyze`
 * route, and reads the world back out of the database.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CLASS NAME IS NOW HISTORICAL, AND SO IS `supports(c, "stub")`
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
 * WHAT IS BROKEN, and it is not this file: in `stub` mode it forwards
 * each case's `stub` block as a `verdict:` to `group.ts`, and since step
 * 8 nothing reads a verdict. Every stubbed case therefore runs against a
 * server that routes nothing, owns nothing and says nothing, and scores
 * whatever a silent bot scores. `e2e/corpus/README.md` carries the
 * warning and the shape of the port (verdicts → routes + facts). It is
 * left failing rather than re-baselined: re-recording would enshrine
 * silence as the correct answer to 36 real incidents.
 *
 * LIVE mode is unaffected and always was — it never used the seam.
 *
 * HISTORY IS MANDATORY. `group.ts` forwards the "Recent chat history"
 * block the Pi sends on every production call. PR #26 discovered the sim
 * was omitting it, which meant every live-LLM test written before it ran
 * against a prompt production never uses — Amir's bug reproduced only
 * 2/5 WITH history. Every case's `history` is forwarded on every turn,
 * and later turns also see the earlier turns and MatchTime's own replies.
 */
import { SimGroup, type SimHistoryEntry, type StubVerdict } from "../sim/group";
import type { CorpusCase, CorpusMessage, CorpusObservation } from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";
// The world builder and the read-back helpers moved to ./world when the
// SECOND pipeline arrived (§10 step 2). Both pipelines must be judged
// against a world built by the same code, or a divergence in the builder
// would read as a divergence in the pipelines.
import { buildCorpusWorld, readMembers, readRows, readScore, readTeams } from "./world";

export class CurrentAnalyzerPipeline implements CorpusPipeline {
  readonly name: string = "current-analyzer";

  /**
   * ⚠️ INERT since §10 step 8 (2026-09-06). It set the test-only
   * `x-mt-attendance-engine` header; that header and its flag were
   * deleted from `src/lib/pipeline/gate.ts`, because the "off" arm it
   * selected reverted to `analyzeBatch` and there is no `analyzeBatch`.
   * `AttendanceEnginePipeline` (#3) sets it to `true` and is therefore
   * now the same pipeline as this one — see that file's header.
   *
   * Kept so #3 still compiles and its name stays quotable in old
   * reports. `undefined` is still the default and still means "send no
   * header", which is now what every value means.
   */
  protected readonly attendanceEngine: boolean | undefined = undefined;

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

  async run(ctx: PipelineContext, c: CorpusCase, mode: CorpusMode): Promise<CorpusObservation> {
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
          ...(mode === "stub" && m.stub ? { verdict: m.stub as StubVerdict } : {}),
        })),
        {
          history: [...history],
          ...(this.attendanceEngine !== undefined
            ? { attendanceEngine: this.attendanceEngine }
            : {}),
        },
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
