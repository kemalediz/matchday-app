# Testing an LLM pipeline: a playbook

**Written 2026-09-06, from the MatchTime analyzer rebuild. Deliberately
project-agnostic: it is meant to be read by other Cressoft projects
(HomeTenant first) and applied there.**

MatchTime replaced a single 19,850-token classifier prompt with a
router → extractor → engine → composer pipeline, then deleted the old
prompt. Two testing techniques did nearly all the useful work, and one
testing mistake cost a suite of 40 browser tests. Both generalise.

---

## 1. The live dry run

### What it is

A script that runs the **real** pipeline against **real production
state**, with the **real model**, and writes **nothing**.

MatchTime's is `scripts/dryrun-pipeline.ts`. It loads the live squad from
the database read-only, feeds in a table of scripted messages, and prints
what the system *would* do: which route each message took, which facts
were extracted, which writes it would make, and what it would say.

```
ONLY=C1,K1     run only these case ids
REPEAT=15      run each case N times, report STABLE / UNSTABLE
FACTS=1        print the extracted fields on every run
CHASES=1       compose the scheduled outbound messages instead
QUESTIONS=1    run the tagged-question table
```

### Why it beats a test suite for this class of change

A unit test asserts the verdict you assumed. A dry run shows you the
verdict the model actually produces, against data that actually exists.
Kemal's reaction on being shown one: *"this is very good way of testing
if prompts are working."*

Two production defects were found this way that no test in the repo
caught, including one that had been shipping in match-day copy for
months.

### The rules that make it work

**Zero writes, structurally, not by promise.** The only database call is
the read-only state loader. No `create`, `update`, `upsert` or `delete`
anywhere in the file. State changes are projected in memory and thrown
away. Say this at the top of the file and keep it true: the script is
pointed at a customer's live data.

**Repeat, always.** A single run proves nothing about a probabilistic
system. One phrase in MatchTime's suite ("I'm free Tuesday if you need
me") wrote an unwanted record in 3 of 12 runs. At `REPEAT=1` it looked
perfect. Report counts, "0 of 15", never "it works".

**Print the intermediate fields, not just the outcome.** The unstable
case above was diagnosed in one run of `FACTS=1`: a single extracted
field, `basis`, was flipping between two values, and two downstream rules
pointed opposite ways from it. Without that field printed it was
indistinguishable from "the model is flaky".

**Put an `expect` string on every case.** Not asserted, printed. It makes
the output readable by someone who did not write the table, and it forces
you to state the intent before you see the answer.

**Encode real incidents as cases.** MatchTime's table carries the exact
message that caused each production incident, with the state staged to
match. The most valuable single case replays a customer-facing failure
and proves it now behaves.

**Watch your own staging.** Two of the first cases silently tested
nothing: the message named a player who was not actually in the staged
squad, so "no action" looked like a pass. If a case cannot fail, it is
not a case.

### What it does not replace

It exercises decisions, not the apply layer: the transaction, the
ordering, the constraint. Those need their own tests. Be explicit in the
file header about which half you are grading.

---

## 2. Stub the inputs, never the decision

### The mistake, concretely

MatchTime's browser suite drove the server through a **verdict stub**: a
file mapping message id to "the verdict the model would have emitted".
Tests set a verdict, then asserted what the system did with it.

When the architecture changed, the thing that emitted verdicts was
deleted. **40 specs failed and 82 never ran**, not because the product
broke but because the tests were coupled to a component that no longer
existed. The stub file is still written and nothing reads it.

### Why it happened

The stub expressed a **decision** ("register this person"). Decisions are
the part of the system most likely to move. When the redesign split
"understand the message" from "decide what to do", the decision moved out
of the model and into deterministic code, and every test that had stubbed
a decision was stubbing a thing that had ceased to exist. There was no
successor field to migrate them to.

### The rule

**Stub what enters the system, not what it concludes.**

MatchTime's replacements stub routes (`MT_TEST_ROUTER_STUB_FILE`) and
extracted facts (`MT_TEST_EXTRACTOR_STUB_FILE`). Both are *inputs*: what
the model perceived. The decision is then made by real code and asserted.

Tests written this way get strictly better after a redesign, because they
now pin the decision rather than assume it. Tests written the other way
have to be rewritten or thrown away.

### Applying it

- If a stub can express "and therefore do X", it is stubbing a decision.
  Move it one layer earlier.
- One stub seam per real boundary. Do not overload one environment
  variable with two meanings: MatchTime's verdict-stub flag was *also*
  the DM privacy-test flag, so the dead seam could not simply be deleted.
- When a seam dies, migrate the assertions rather than deleting the
  specs. Ask what each was really asserting. Most are asserting the
  decision, and those are worth keeping.

---

## 3. Two habits worth copying

**Measure before you fix, and say the number.** Every fix in this rebuild
started from a count: "3 of 12 runs", "12 of 12 routed correctly, 5 of 12
answered", "40 failed, 82 did not run". Several fixes changed direction
once measured, including one where the stated hypothesis (the model is
getting it wrong) was flatly untrue: the bug was two lines of string
handling, no model involved.

**Grep for a caller before believing a feature is live.** Two routes in
this project were built, tested, flagged and documented as migrated, and
were never wired in. Their entry point had zero production callers for
weeks, and their feature flags were inert switches. A flag existing is not
evidence that anything reads it.

---

## Files worth reading in this repo

| file | why |
|---|---|
| `scripts/dryrun-pipeline.ts` | the harness, with its rules in the header |
| `e2e/helpers/stub.ts` | the dead seam, and what replaced it, written up in place |
| `e2e/corpus/README.md` | incident corpus: cases with known-correct answers |
| `MDs/analyzer-redesign-2026-08-31.md` | the plan the rebuild followed |
