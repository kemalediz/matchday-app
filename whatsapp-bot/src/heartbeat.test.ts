import { describe, it, expect } from "vitest";
import {
  buildHeartbeat,
  emptyCounters,
  isUnattributable,
  type BotCounters,
} from "./heartbeat.js";

describe("isUnattributable", () => {
  it("is true when there is neither a phone nor a name", () => {
    // The exact hole the 2026-08-30 audit found: an @lid sender whose
    // contact lookup died. The server can resolve nobody, no attendance is
    // written, and it returns HTTP 200 while doing it.
    expect(isUnattributable("", null)).toBe(true);
    expect(isUnattributable("", "")).toBe(true);
    expect(isUnattributable("", "   ")).toBe(true);
  });

  it("is false when a phone survived", () => {
    expect(isUnattributable("447700900123", null)).toBe(false);
  });

  it("is false when a name survived", () => {
    // A name alone is enough: the server resolves by pushname, alias and
    // fuzzy first-token match, and can auto-provision from one.
    expect(isUnattributable("", "Baki")).toBe(false);
  });

  it("counts a bare numeric pushname as unattributable", () => {
    // "158055467598020" is an @lid rendered as digits. It is never a name,
    // it can never match a roster entry, and the server refuses to print
    // it as one. Treating it as an identity would hide the failure.
    expect(isUnattributable("", "158055467598020")).toBe(true);
  });
});

describe("buildHeartbeat", () => {
  const counters: BotCounters = { ...emptyCounters(), seen: 12, buffered: 10, notGroup: 2 };

  it("carries the group, the counters and the process start", () => {
    const started = new Date("2026-09-09T08:00:00.000Z");
    const hb = buildHeartbeat({
      groupId: "123@g.us",
      counters,
      processStartedAt: started,
      degradedCapabilities: [],
    });
    expect(hb.groupId).toBe("123@g.us");
    expect(hb.counters.seen).toBe(12);
    expect(hb.processStartedAt).toBe(started.toISOString());
  });

  it("sends a COPY of the counters, so a later increment cannot mutate a queued payload", () => {
    const live = { ...emptyCounters(), seen: 1 };
    const hb = buildHeartbeat({
      groupId: "g@g.us",
      counters: live,
      processStartedAt: new Date(),
      degradedCapabilities: [],
    });
    live.seen = 999;
    expect(hb.counters.seen).toBe(1);
  });

  it("de-duplicates the degraded capabilities", () => {
    // The participant sweep runs once per org and logs per org, so the
    // same capability arrives repeatedly. The alert wants the SET.
    const hb = buildHeartbeat({
      groupId: "g@g.us",
      counters,
      processStartedAt: new Date(),
      degradedCapabilities: ["participant-sync", "participant-sync", "message-recovery"],
    });
    expect(hb.degradedCapabilities).toEqual(["participant-sync", "message-recovery"]);
  });

  it("survives a null process start", () => {
    const hb = buildHeartbeat({
      groupId: "g@g.us",
      counters,
      processStartedAt: null,
      degradedCapabilities: [],
    });
    expect(hb.processStartedAt).toBeNull();
  });
});

describe("emptyCounters", () => {
  it("starts every counter at zero", () => {
    for (const [, v] of Object.entries(emptyCounters())) expect(v).toBe(0);
  });

  it("returns a fresh object each time", () => {
    const a = emptyCounters();
    a.seen = 5;
    expect(emptyCounters().seen).toBe(0);
  });
});
