# Session handoff, 2026-09-08/09: eight bugs, and the layer underneath

Follows `SESSION-HANDOFF-2026-09-06.md` (the mega-prompt deletion). Method
notes that generalise are in `MDs/llm-pipeline-testing-playbook.md`.

**Headline: the mega-prompt was not what was breaking Kemal's messages.**
Retiring it fixed measurable things, but the failures he kept reporting had
four unrelated causes, three of them below the analyzer entirely. The
correction matters more than the fixes: for weeks the diagnosis was wrong,
and it was wrong because nobody looked at the message text as stored.

---

## What shipped

| PR | what |
|---|---|
| #57 | an admin may report another player OUT without tagging the bot |
| #58 | name an @-mention from the roster, never from a pushname |
| #59 | ask the tag gate per entry, so one refused clause stops eating the message |
| #60 | port the incident corpus off the deleted verdict seam, case by case |
| #61 | a swap moves a dropped player's slot to his replacement |
| #62 | a format switch moves the kickoff to the new activity's time |
| #63 | the roster post is demand-driven, not one per IN |
| #64 | get one signal off the Pi, and let the server notice silence |
| #65 | a fast path claims a CLAUSE, not a message |

---

## The four causes, and why each was mis-diagnosed

**1. `@`-mentions were not corrupted. They were correctly resolved to the
wrong name.** `getContactById(jid)` returns the mentioned person's
*self-chosen* WhatsApp profile name. WhatsApp shows each *reader* the name
from their own address book. When those differ the model receives a name
nobody in the club uses. `割::::.̸̢...` is David's own pushname, present
identically in 13 of his messages; `DÇ` is Shahrokh's. Across 35 pushnames
this org has produced, roughly **one mention in three** was named wrongly.
The club's own `UserAlias` table already knew the answer. Names now resolve
phone → alias → matcher; an unresolvable mention keeps `@<digits>` so the
engine refuses on an honest unknown instead of a fabrication.

Second reason this had to change: a pushname is written by the person being
mentioned, so any group member could inject text into the analyzer's input.

**2. The tag waiver was all-or-nothing per message.** #57 waived the tag for
an admin's third-party OUT; #59 found that one BENCH clause in the same
message poisoned the whole thing and discarded a clean drop beside it.
Fixed by evaluating per `registerFor` entry. That work also found PR #33's
recruit waiver standing in for the tag on the *whole* message, so an
untagged "bench Mojib, we need one more player" would have demoted him.

**3. The team swap required both players CONFIRMED.** So the commonest edit
in the club (someone drops, a replacement arrives) was refused. The
principle that licensed the fix: teams are only ever built from CONFIRMED
attendance (`team-generation.ts`, `actions/teams.ts`), so "holds a slot but
is not CONFIRMED" is a state the system cannot create. It is always a stale
sheet, so moving the slot is a repair, not an interpretation.

**4. `switchMatchFormat` never moved `match.date`.** Per-format times are
modelled and correctly configured (5-a-side 21:15, 7-a-side 21:30); the
switch moved `activityId` and `maxPlayers` and left the kickoff. Silently
wrong at every format switch since May: three completed Sutton matches
carry the old time. A manually-set kickoff is now preserved; the deadline,
which no admin can set, is always re-derived.

---

## The bug class, now six incidents and finally addressed

A fast path that matches part of a message claimed the **whole** message and
`continue`d, destroying every other instruction in it. Recruit (1 Sept),
guest-name-ask, the step-6 engine, the pasted roster, the bench clause, and
the swap. #65 makes a fast path claim the **clause** it recognises.

The property that makes it reviewable: `peelClause` applies the fast path's
own whole-body test first and returns null on a miss, so **the set of
messages each path owns is unchanged**. Only the residual is new.

Measured live, and the control is the interesting half:

```
clause peeled        → DROPPED Kemal                              5/5
whole body (control) → DROPPED Kemal + phantom CONFIRMED Raihan   5/5
```

Peeling nothing was not a safe alternative: the extractor reads
"swap Elvin with Raihan" as *registering* Raihan.

---

## The thing that actually matters: nothing was watching

The 2026-08-30 audit's headline was not the injected layer. It was that
every failure signal is a `console.error` on a Raspberry Pi nobody reads.
Two of its three top recommendations had never been built.

That is why the mention bug ran for months, the kickoff was wrong since May,
and the participant sweep has **never once run**. Every one was found by the
owner complaining.

#64 builds the missing path. Two findings worth keeping:

- **The audit's own design would not have worked.** It said to piggyback
  health data on the existing analyze POST. `smart-analysis.ts:544` returns
  *before* posting when the buffer is empty, and its comment records that
  this exact silence hid the August outage for three days. The flagship
  failure drops messages before the buffer, so every flush is empty and the
  piggyback would have been mute. Hence a dedicated endpoint plus an hourly
  cron watching for the heartbeat's **absence**, which is the half that
  catches a dead Pi.
- **The alert is email, deliberately.** A WhatsApp DM about a broken
  WhatsApp layer is undeliverable in the one case that matters.

First heartbeat, minutes after deploy, immediately reported what nobody had
been told for two months:

```
degraded: ["group-enumeration", "message-recovery", "participant-sync"]
```

---

## Corrections to earlier records

- **`MDs/analyzer-redesign` §10 step 7 part 1 shipped unwired.**
  `runAnswerBatch` and the step-7 flag readers had zero production callers,
  so `question` and `balancer` were documented as migrated while still being
  served by the mega-prompt. Grep for a caller; a flag is not evidence.
- **The corpus's 8 "spurious writes" never existed.** `gradeCase` classified
  by direction (`got > want`), so every *missed drop* was filed as its own
  opposite. All eight had `attendanceBefore === attendanceAfter`. The number
  was quoted in the README and the spec as evidence of a production defect.
  Now decided against `attendanceBefore`.
- **The corpus was 10 of 36, not "two cases failing".** After #60: 35 of 35,
  with 27 `harness` / 9 `new_right` / **0 `old_right`** adjudications: not
  one case where the new pipeline was worse. Vacuity was measured, not
  assumed: disabling the seam now fails 32 of 35 cases, where before only 3
  of 36 could fail at all.

---

## Open, honestly

- **The WhatsApp layer is unfixed, only monitored and worked around.**
  `getChats`, message recovery and participant sync are all degraded. The
  strategic answer is a protocol client (Baileys); the audit confirmed it is
  maintained but explicitly did **not** scope the port. Deferred until the
  alerts say whether it is urgent.
- **Four members have no name at all**, only a phone. A direct consequence
  of the sweep never running.
- **Five question shapes have no answer**: who has not paid, the score
  situation, stats, "what are our options", and an unresolvable third party.
  38 of 48 tagged questions answered, 0 accidental silences. A feature gap,
  not a bug. "Who has not paid" is the one worth building first.
- **A dormant org still generates fixtures.** `generate-matches` filters on
  `Activity.isActive` and never looks at the org, so Sutton Lads (churned
  June) has been producing weekly fixtures ever since. Fix in flight; the
  live question is what marks an org dormant, since `whatsappBotEnabled` is
  a mute switch and gating on it would stop fixtures for a merely-muted
  live club.
- **Shahrokh's alias is a guess.** He has never posted, so unlike David's
  there was nothing to corroborate `DÇ` against.

---

## Cross-repo hazard (belongs to MatchTime, affects HomeTenant)

`scripts/deploy-pi.sh:52` kills by the pattern
`sh -c node --env-file.*src/index.ts`. HomeTenant's `npm start` produces a
**byte-identical** command line. Its *service* runs node directly and
escapes by luck, but its documented re-pairing path does not. A MatchTime
deploy would kill a hand-started HomeTenant bot, and MatchTime's
single-instance assertion would count HomeTenant's process as its own.

Verified live: only the working directory distinguishes them.

```
1022   /home/davidediz/hometenant-bot/whatsapp-bot
42225  /home/davidediz/matchtime-bot/whatsapp-bot
```

Fix in flight. See `MDs/hometenant-whatsapp-layer-review-2026-09-09.md`.
