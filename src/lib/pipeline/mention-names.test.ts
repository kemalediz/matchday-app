/**
 * RED-first spec: an @-mention is named from the ORG ROSTER, or not at all.
 *
 * ── Why this module exists (measured, 2026-09-08) ────────────────────
 * The Pi used to resolve every @-mention through
 * `client.getContactById(jid)` and paste the contact's pushname straight
 * into the body the analyzer reads. That pushname is the mentioned
 * person's OWN, self-chosen WhatsApp profile name — not what the club
 * calls them, and not what WhatsApp showed the person who typed the
 * message (WhatsApp renders a mention from the READER's address book).
 *
 * Two real messages from the live Sutton FC group:
 *
 *   typed:  "@Shahrokh🐔 Sutton Football Club is out due to unforeseen …"
 *   stored: "@DÇ  is out due to unforeseen issue at work"      → noise
 *
 *   typed:  "@David David 67 and @~Najib out"
 *   stored: "@割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂ and @Najib out"    → David's drop lost
 *
 * Both drops were silently lost. `"割::::.̸̢̤̋…"` is not corruption: it
 * occurs 13 times as `AnalyzedMessage.authorName` for this org (it is
 * David's pushname) and an admin has ALREADY curated
 * `UserAlias["割::::.."] → David`. So the club's own database knew the
 * answer while the body said something no human would recognise.
 *
 * ── The rule ─────────────────────────────────────────────────────────
 * The name substituted into a message body comes from the roster, in
 * descending order of trust:
 *
 *   1. PHONE   — a "<digits>@c.us" mention IS the person's phone number.
 *                Unique key, no guessing.
 *   2. ALIAS   — `UserAlias`, admin-curated, keyed on the folded pushname.
 *   3. ROSTER  — `resolvePerson()`, the same ambiguity-bailing matcher the
 *                engine uses to turn a quoted name into a member.
 *
 * Anything else leaves the raw "@<digits>" token exactly as it arrived.
 * A raw token is refused downstream by `identity.ts`'s "raw digits are
 * never a name" rule — an honest unknown, which is what we want, instead
 * of a fabricated one.
 */
import { describe, it, expect } from "vitest";
import { resolveMentionNames } from "./mention-names";

const DAVID_PUSHNAME = "割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂";

const ROSTER = [
  { userId: "u-kemal", name: "Kemal", phone: "+447700900001" },
  { userId: "u-david", name: "David", phone: null },
  { userId: "u-najib", name: "Najib", phone: "+447700900321" },
  { userId: "u-shahrokh", name: "Shahrokh", phone: "+447700900777" },
  { userId: "u-mojib", name: "Mojib", phone: null },
  { userId: "u-ibrahim-s", name: "Ibrahim Sahin", phone: null },
  { userId: "u-ibrahim-k", name: "Ibrahim Kaya", phone: null },
];

const ALIASES = [{ alias: "割::::..", userId: "u-david" }];

const base = { roster: ROSTER, aliases: ALIASES };

describe("resolveMentionNames", () => {
  it("REGRESSION: the David drop — an alias recovers the roster name", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767322 and @447700900321 out",
      mentions: ["233452997767322@lid", "447700900321@c.us"],
      mentionNames: [{ jid: "233452997767322@lid", name: "割::::.." }],
    });
    expect(out.body).toBe("@David and @Najib out");
    expect(out.outcomes.map((o) => o.via)).toEqual(["alias", "phone"]);
  });

  it("REGRESSION: the Shahrokh drop — an unresolvable name leaves the raw token", () => {
    // "DÇ" is Shahrokh's pushname. It folds to "dc", matches no member and
    // has no alias, so nothing may be substituted. The old code pasted it.
    const out = resolveMentionNames({
      ...base,
      body: "@158055467598020 is out due to unforeseen issue at work",
      mentions: ["158055467598020@lid"],
      mentionNames: [{ jid: "158055467598020@lid", name: "DÇ" }],
    });
    expect(out.body).toBe("@158055467598020 is out due to unforeseen issue at work");
    expect(out.body).not.toContain("DÇ");
    expect(out.outcomes[0].member).toBeNull();
    expect(out.outcomes[0].via).toBeNull();
  });

  it("never substitutes a name with no letters, even with no roster match", () => {
    const out = resolveMentionNames({
      roster: ROSTER,
      aliases: [], // no curated alias this time
      body: "@233452997767322 out",
      mentions: ["233452997767322@lid"],
      mentionNames: [{ jid: "233452997767322@lid", name: DAVID_PUSHNAME }],
    });
    expect(out.body).toBe("@233452997767322 out");
    expect(out.body).not.toContain("割");
  });

  it("folds a RAW, unsanitised pushname to the alias key itself", () => {
    // Defence in depth: the Pi folds combining marks off before sending,
    // but the server must not depend on that — `normaliseName` is the same
    // function `UserAlias` rows were written with.
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767322 out",
      mentions: ["233452997767322@lid"],
      mentionNames: [{ jid: "233452997767322@lid", name: DAVID_PUSHNAME }],
    });
    expect(out.body).toBe("@David out");
    expect(out.outcomes[0].via).toBe("alias");
  });

  it("names a @c.us mention from its phone number, with no candidate name at all", () => {
    // The strongest path: the mention JID IS the phone. No contact lookup,
    // nothing the mentioned person controls, nothing to verify.
    const out = resolveMentionNames({
      ...base,
      body: "@447700900777 is out due to unforeseen issue at work",
      mentions: ["447700900777@c.us"],
    });
    expect(out.body).toBe("@Shahrokh is out due to unforeseen issue at work");
    expect(out.outcomes[0].via).toBe("phone");
  });

  it("names a mention from the roster when the pushname is a near-enough match", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767399 in",
      mentions: ["233452997767399@lid"],
      mentionNames: [{ jid: "233452997767399@lid", name: "Mojib Jalali" }],
    });
    expect(out.body).toBe("@Mojib in");
    expect(out.outcomes[0].via).toBe("roster");
  });

  it("handles an emoji pushname without corrupting the body", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767400 is out",
      mentions: ["233452997767400@lid"],
      mentionNames: [{ jid: "233452997767400@lid", name: "Shahrokh Sutton Football Club" }],
    });
    expect(out.body).toBe("@Shahrokh is out");
  });

  it("bails on ambiguity rather than guessing between two Ibrahims", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767401 out",
      mentions: ["233452997767401@lid"],
      mentionNames: [{ jid: "233452997767401@lid", name: "Ibrahim" }],
    });
    expect(out.body).toBe("@233452997767401 out");
    expect(out.outcomes[0].member).toBeNull();
  });

  it("resolves only the mentions it can, leaving the rest raw", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@158055467598020 and @447700900321 out, @233452997767322 in",
      mentions: ["158055467598020@lid", "447700900321@c.us", "233452997767322@lid"],
      mentionNames: [
        { jid: "158055467598020@lid", name: "DÇ" },
        { jid: "233452997767322@lid", name: "割::::.." },
      ],
    });
    expect(out.body).toBe("@158055467598020 and @Najib out, @David in");
  });

  it("does not rewrite a longer number that starts with a mention's digits", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@4477009003219 is a typo",
      mentions: ["447700900321@c.us"],
    });
    expect(out.body).toBe("@4477009003219 is a typo");
  });

  it("never lets a member name containing $ corrupt the replacement", () => {
    const out = resolveMentionNames({
      roster: [{ userId: "u-x", name: "A$AP", phone: "+447700900555" }],
      aliases: [],
      body: "@447700900555 in",
      mentions: ["447700900555@c.us"],
    });
    expect(out.body).toBe("@A$AP in");
  });

  it("refuses a raw-digit pushname as a lookup key", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767322 out",
      mentions: ["233452997767322@lid"],
      mentionNames: [{ jid: "233452997767322@lid", name: "447700900321" }],
    });
    expect(out.body).toBe("@233452997767322 out");
  });

  it("OLD PI: a body already rewritten with names and no mentionNames is untouched", () => {
    // Servers deploy before the Pi does. An old Pi sends a pre-substituted
    // body with no "@<digits>" left in it — this must be a no-op, not a
    // second pass that mangles it.
    const out = resolveMentionNames({
      ...base,
      body: "@Mojib Jalali and @Najib out",
      mentions: ["233452997767399@lid", "447700900321@c.us"],
    });
    expect(out.body).toBe("@Mojib Jalali and @Najib out");
  });

  it("is a no-op with no mentions, and total against rubbish input", () => {
    expect(resolveMentionNames({ ...base, body: "who's in?" }).body).toBe("who's in?");
    expect(
      resolveMentionNames({
        roster: [],
        body: undefined as unknown as string,
        mentions: ["", "@lid", "x"],
      }).body,
    ).toBe("");
  });
});
