import { describe, it, expect } from "vitest";
import {
  groupUnresolved,
  UNKNOWN_SENDER_KEY,
  UNKNOWN_SENDER_LABEL,
  unresolvedKey,
} from "@/lib/unresolved-grouping";

const at = (iso: string) => new Date(iso);

describe("unresolvedKey", () => {
  it("normalises case and accents so one person is one row", () => {
    expect(unresolvedKey("Élnur")).toBe(unresolvedKey("elnur"));
  });

  it("gives every nameless message the SAME bucket", () => {
    // Before 2026-09-09 these were excluded from the queue entirely by an
    // `authorName: { not: null }` filter — the admin surface built to
    // catch unattributable messages could not show the most
    // unattributable ones of all.
    expect(unresolvedKey(null)).toBe(UNKNOWN_SENDER_KEY);
    expect(unresolvedKey("")).toBe(UNKNOWN_SENDER_KEY);
    expect(unresolvedKey("   ")).toBe(UNKNOWN_SENDER_KEY);
  });

  it("keeps a real name out of that bucket", () => {
    expect(unresolvedKey("Baki")).not.toBe(UNKNOWN_SENDER_KEY);
  });
});

describe("groupUnresolved", () => {
  const rows = [
    { authorName: "Shahrokh", intent: "out", body: "cant make it", createdAt: at("2026-09-09T10:00:00Z") },
    { authorName: "shahrokh", intent: "in", body: "back in", createdAt: at("2026-09-09T09:00:00Z") },
    { authorName: null, intent: "in", body: "im in", createdAt: at("2026-09-09T11:00:00Z") },
    { authorName: "", intent: "out", body: "out sorry", createdAt: at("2026-09-09T08:00:00Z") },
  ];

  it("collapses spellings of one pushname into one row", () => {
    const groups = groupUnresolved(rows);
    const s = groups.find((g) => g.pushname === "Shahrokh");
    expect(s?.count).toBe(2);
  });

  it("shows the nameless messages as one clearly-labelled row", () => {
    const groups = groupUnresolved(rows);
    const unknown = groups.find((g) => g.key === UNKNOWN_SENDER_KEY);
    expect(unknown).toBeDefined();
    expect(unknown!.count).toBe(2);
    expect(unknown!.pushname).toBe(UNKNOWN_SENDER_LABEL);
  });

  it("marks the nameless row as NOT linkable", () => {
    // There is no pushname to turn into a UserAlias, so offering the
    // "link to player" action would be offering something that cannot
    // work. The messages are still shown, which is the point.
    const groups = groupUnresolved(rows);
    expect(groups.find((g) => g.key === UNKNOWN_SENDER_KEY)!.linkable).toBe(false);
    expect(groups.find((g) => g.pushname === "Shahrokh")!.linkable).toBe(true);
  });

  it("orders by most recent activity", () => {
    expect(groupUnresolved(rows)[0].key).toBe(UNKNOWN_SENDER_KEY);
  });

  it("keeps at most four sample bodies per row", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      authorName: "Baki",
      intent: "in",
      body: `msg ${i}`,
      createdAt: at("2026-09-09T10:00:00Z"),
    }));
    expect(groupUnresolved(many)[0].sampleBodies.length).toBe(4);
  });

  it("survives a null body", () => {
    const groups = groupUnresolved([
      { authorName: "Baki", intent: null, body: null, createdAt: at("2026-09-09T10:00:00Z") },
    ]);
    expect(groups[0].lastBody).toBe("");
    expect(groups[0].lastIntent).toBe("?");
  });

  it("returns nothing for nothing", () => {
    expect(groupUnresolved([])).toEqual([]);
  });
});

describe("the distinct COUNT the admin badge shows", () => {
  it("counts the nameless bucket as exactly one, however many messages it holds", () => {
    // Twelve unattributable messages are one problem, not twelve. A badge
    // that says 12 gets ignored; a badge that says 1 gets clicked.
    const rows = Array.from({ length: 12 }, () => ({
      authorName: null,
      intent: "in",
      body: "in",
      createdAt: at("2026-09-09T10:00:00Z"),
    }));
    expect(groupUnresolved(rows).length).toBe(1);
  });
});
