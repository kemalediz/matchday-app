# Session handoff, 2026-09-06: the mega-prompt is gone

**Headline: `SYSTEM_PROMPT` and `analyzeBatch` are deleted (`8dc64fb`,
§10 step 8 of `analyzer-redesign-2026-08-31.md`). Every message now goes
router → extractor → engine → composer. There is no fallback, because
there is nothing left to fall back to.**

Method notes worth reusing in other projects are split out into
`MDs/llm-pipeline-testing-playbook.md` (Kemal wants HomeTenant to read
it).

---

## What shipped today

| PR | what |
|---|---|
| #47 | scheduled posts never stamp themselves with the send time |
| #48 | chase copy reads as English; the availability boundary stops being a coin flip |
| #49 | never announce a match that already has a squad |
| #50 | the 17:00 update warns the group when the match is at risk |
| #51 | `question` and `balancer` answer the roster, the fixture and an empty team sheet |
| #52 | `score` and `admin_ops` engine owners |
| #53 | **delete the mega-prompt** |

Two further fixes were in flight at the end of the session: recruit-blast
determinism, and the Playwright suite.

---

## The three defects that were not what they looked like

**1. "Quick 5pm update" at 20:06.** The chase prompt handed the model a
worked example containing a wall-clock time and it copied it. Fixed by
banning a send-time stamp outright while explicitly preserving the
kickoff time, which three chase types require.

**2. "we're 8 short for on Tue 8 Sept 21:30's 7-a-side".** Blamed on the
model. It was not the model. `Intl.DateTimeFormat("en-GB", {weekday, day,
month, hour, minute})` renders `"Tue 8 Sept, 21:30"`; the code stripped
the comma and then did `.split(" at ")[0]` looking for a separator that
had never existed, so every "day label" in the file silently carried the
kickoff time. A word-level `replace(/\btonight\b/, "on Tue 8 Sept")` then
produced "for on ... 's". **The roster header had been wrong in every
post for months** (`*Playing Tue 8 Sept 21:30:*`) and nobody had noticed,
because it looks almost right.

**3. Step 7 part 1 was dead code.** `runAnswerBatch`,
`enabledStepSevenRoutes`, `stepSevenNeedsRouter` and
`routesHeaderOverride` had **zero production callers**. `question` and
`balancer` had been documented as migrated and were still being served by
the mega-prompt, and `QUESTION_ENGINE_ENABLED` had been an inert switch
in Vercel the whole time. Found by grepping for callers, not by reading
the code.

---

## What deleting the prompt cost

Measured on live production state, tagged questions, real model:

```
ANSWERED     38 of 48
HANDED BACK  10 of 48   nobody answers these: no group reply, operator is DM'd
SILENT        0 of 48
```

Five real question shapes now go unanswered that the prompt used to
handle: who has not paid, the score situation, player stats, "what are
our options", and a third party that cannot be resolved to one member.

**Zero accidental silences** was the acceptance bar and it was met. The
trade is deliberate: the bot lost range and gained predictability.

Squad-place non-determinism, the thing that started the rebuild, went
from **3.8%** to **0.0%**.

---

## Operational facts that changed

- **The revert is `git revert`.** `ROUTER_GATE_ENABLED` and
  `ATTENDANCE_ENGINE_ENABLED` were deleted from the code: a switch whose
  off position is "nobody handles attendance" is not a revert. Stale
  values may still sit in Vercel and are inert.
- **The four step-7 flags default ON unless explicitly set to 0.** The
  set is built by removing from every route rather than adding, so a
  future route added without a flag is live rather than silently
  unowned.
- **"Fail open" changed meaning.** It used to mean "the analyzer decides
  this message". It now means silence plus an operator DM to admins, on a
  one-hour dedupe. Two fail-open paths that carried real traffic were
  given deterministic owners instead: a bench-prompt answer and a pasted
  roster, both peeled before the router runs.
- **`unsure` now has an owner** (the attendance engine takes four routes,
  not three), because the thing it used to fall back to no longer exists.

---

## Known open items

- **Playwright: 40 failed, 82 did not run.** Tests coupled to the deleted
  verdict stub seam. Being rewritten. See the playbook for the lesson.
- **Recruit blast is non-deterministic on an untagged command.**
  "message everyone from the last 50 games" fired in 2 of 3 runs. The
  lookback clamp works (50 becomes 12), so blast size is bounded, but a
  coin flip on a 20-person mass DM from an unofficial WhatsApp client is
  the wrong place for a wobble. Being fixed. **Tag the command** until it
  lands.
- **Two corpus cases fail**: a third-party name ("habibi") that no
  version ever handled, and a stats question that now goes silent.
- **Operator notes fire for messages MatchTime correctly ignored.**
  Kemal's call on 2026-09-06 is to KEEP this for now, as visibility into
  where coverage ends. The narrowing, when wanted: exactly three routes
  require a tag (`question`, `balancer`, `admin_ops`); everything else
  always pages. Recommendation was severity-based deferral, not quiet
  hours, and only once volume justifies it.
- `e2e/helpers/isolation.test.ts` failed once under full-suite
  parallelism and passed standalone every time since. Unconfirmed whether
  pre-existing.

---

## Live state at end of session

- MatchTime **unmuted**, Sutton FC.
- Next match **Tue 8 Sept 21:30**, Goals North Cheam, **12/14**.
- Six of those twelve were backfilled by hand
  (`scripts/backfill-mute-gap-2026-09-06.ts`): they said IN while the bot
  was muted, and **the Pi records message lengths but never bodies**, so
  the text was unrecoverable and the names came from Kemal. Worth
  remembering as a real limit on what a mute costs you.
- `paymentTrackingEnabled=false` on Sutton, so the bulk-credit path is a
  no-op there. `paymentCollectionEnabled` and `stripeChargesEnabled` are
  true: real money, untouched by this work.
