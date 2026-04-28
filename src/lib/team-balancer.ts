import { PlayerWithRating, TeamResult } from "@/types";

/**
 * Team balancing.
 *
 * Dispatched by `strategy`:
 *
 *  - "rating-only": pure snake draft on rating. Positions are ignored.
 *    Use for basketball 3v3, cricket (for now), any pickup with no fixed
 *    role per slot.
 *
 *  - "position-aware": snake draft + 1,000-iteration hill-climb that
 *    minimises both rating diff AND positional imbalance vs. a target
 *    composition (`composition: Record<string, number>` — e.g. football
 *    7-a-side is {GK:1, DEF:2, MID:2, FWD:2}). Generalised from the
 *    original football-only balancer so it works with any position
 *    labels a Sport defines.
 *
 *  - "role-quota" (not implemented): cricket-style quotas like
 *    "≥4 bowlers per team". Falls back to rating-only for now.
 */
export type BalancingStrategy = "position-aware" | "rating-only" | "role-quota";

export interface BalanceOptions {
  players: PlayerWithRating[];
  perTeam: number;
  strategy: BalancingStrategy;
  composition?: Record<string, number>; // per-team target, used by position-aware
  /** Optional: pin specific players to specific teams. Honoured even
   *  when it makes the balance worse — admin intent overrides the
   *  optimiser. Used by the LLM `generate teams, put me on Red`
   *  pathway and by the admin "swap X to RED" UI. Hill-climb skips
   *  swaps that would move a pinned player off their team. */
  pinnedToTeam?: Record<string, "RED" | "YELLOW">;
}

export function balanceTeams(opts: BalanceOptions): TeamResult {
  const { players, perTeam, strategy, composition, pinnedToTeam } = opts;

  if (players.length < perTeam * 2) {
    throw new Error(`Need at least ${perTeam * 2} players, got ${players.length}`);
  }

  if (strategy === "position-aware" && composition) {
    return balancePositionAware(players, perTeam, composition, pinnedToTeam ?? {});
  }
  // "rating-only" and (for now) "role-quota" fall through to rating-only.
  return balanceRatingOnly(players, perTeam, pinnedToTeam ?? {});
}

// ─────────────────────────── rating-only ───────────────────────────

function balanceRatingOnly(
  players: PlayerWithRating[],
  perTeam: number,
  pinnedToTeam: Record<string, "RED" | "YELLOW">,
): TeamResult {
  const selected = players.slice(0, perTeam * 2);

  const red: PlayerWithRating[] = [];
  const yellow: PlayerWithRating[] = [];

  // Step 1: place pinned players first, capped at perTeam per side.
  for (const p of selected) {
    if (pinnedToTeam[p.id] === "RED" && red.length < perTeam) red.push(p);
    else if (pinnedToTeam[p.id] === "YELLOW" && yellow.length < perTeam) yellow.push(p);
  }

  // Step 2: snake-draft remaining (rating-desc) into whichever team
  // currently has the lower total rating, respecting per-team capacity.
  const remaining = selected
    .filter((p) => !pinnedToTeam[p.id])
    .sort((a, b) => b.rating - a.rating);

  for (const player of remaining) {
    if (red.length >= perTeam) yellow.push(player);
    else if (yellow.length >= perTeam) red.push(player);
    else if (teamRating(red) <= teamRating(yellow)) red.push(player);
    else yellow.push(player);
  }

  return {
    red,
    yellow,
    ratingDiff: Math.abs(teamRating(red) - teamRating(yellow)),
  };
}

// ─────────────────────────── position-aware ───────────────────────────

function balancePositionAware(
  players: PlayerWithRating[],
  perTeam: number,
  composition: Record<string, number>,
  pinnedToTeam: Record<string, "RED" | "YELLOW">,
): TeamResult {
  const selected = players.slice(0, perTeam * 2);
  const positionKeys = Object.keys(composition);

  const red: PlayerWithRating[] = [];
  const yellow: PlayerWithRating[] = [];
  const redNeeds: Record<string, number> = { ...composition };
  const yellowNeeds: Record<string, number> = { ...composition };
  const assigned = new Map<string, string>();

  // Step 1: place pinned players first, picking each one's best
  // position from their pinned team's remaining needs.
  for (const p of selected) {
    const pin = pinnedToTeam[p.id];
    if (!pin) continue;
    if (pin === "RED" && red.length < perTeam) {
      red.push(p);
      const pos = pickPositionFor(p, redNeeds, positionKeys);
      assigned.set(p.id, pos);
      redNeeds[pos] = Math.max(0, (redNeeds[pos] ?? 0) - 1);
    } else if (pin === "YELLOW" && yellow.length < perTeam) {
      yellow.push(p);
      const pos = pickPositionFor(p, yellowNeeds, positionKeys);
      assigned.set(p.id, pos);
      yellowNeeds[pos] = Math.max(0, (yellowNeeds[pos] ?? 0) - 1);
    }
  }

  // Step 2: snake-draft remaining players by rating-desc.
  const sorted = selected
    .filter((p) => !pinnedToTeam[p.id])
    .sort((a, b) => b.rating - a.rating);

  for (const p of sorted) {
    let team: "red" | "yellow";
    if (red.length >= perTeam) team = "yellow";
    else if (yellow.length >= perTeam) team = "red";
    else if (teamRating(red) <= teamRating(yellow)) team = "red";
    else team = "yellow";

    const arr = team === "red" ? red : yellow;
    const needs = team === "red" ? redNeeds : yellowNeeds;
    arr.push(p);

    const pos = pickPositionFor(p, needs, positionKeys);
    assigned.set(p.id, pos);
    needs[pos] = Math.max(0, (needs[pos] ?? 0) - 1);
  }

  let bestCost = costFor(red, yellow, assigned, positionKeys);

  // Step 3: hill-climb. Skip any candidate swap that would move a
  // pinned player to the wrong side — admin intent overrides the
  // optimiser. If both arrays are entirely pinned, no swaps possible
  // (the loop noops).
  const isPinned = (p: PlayerWithRating) => pinnedToTeam[p.id] !== undefined;
  for (let i = 0; i < 1000; i++) {
    const ri = Math.floor(Math.random() * red.length);
    const yi = Math.floor(Math.random() * yellow.length);
    if (isPinned(red[ri]) || isPinned(yellow[yi])) continue;

    [red[ri], yellow[yi]] = [yellow[yi], red[ri]];

    const tentative = new Map<string, string>();
    const redNeedsT: Record<string, number> = { ...composition };
    const yellowNeedsT: Record<string, number> = { ...composition };
    for (const p of red) {
      const pos = pickPositionFor(p, redNeedsT, positionKeys);
      tentative.set(p.id, pos);
      redNeedsT[pos] = Math.max(0, (redNeedsT[pos] ?? 0) - 1);
    }
    for (const p of yellow) {
      const pos = pickPositionFor(p, yellowNeedsT, positionKeys);
      tentative.set(p.id, pos);
      yellowNeedsT[pos] = Math.max(0, (yellowNeedsT[pos] ?? 0) - 1);
    }

    const newCost = costFor(red, yellow, tentative, positionKeys);
    if (newCost < bestCost) {
      bestCost = newCost;
      for (const [id, pos] of tentative) assigned.set(id, pos);
    } else {
      [red[ri], yellow[yi]] = [yellow[yi], red[ri]];
    }
  }

  return {
    red,
    yellow,
    ratingDiff: Math.abs(teamRating(red) - teamRating(yellow)),
  };
}

function pickPositionFor(
  player: PlayerWithRating,
  teamNeeds: Record<string, number>,
  positionKeys: string[],
): string {
  for (const pos of player.positions) {
    if ((teamNeeds[pos] ?? 0) > 0) return pos;
  }
  const remaining = positionKeys
    .map((k) => [k, teamNeeds[k] ?? 0] as [string, number])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return remaining.length > 0 ? remaining[0][0] : positionKeys[0];
}

function costFor(
  red: PlayerWithRating[],
  yellow: PlayerWithRating[],
  assigned: Map<string, string>,
  positionKeys: string[],
): number {
  const redCounts: Record<string, number> = {};
  const yellowCounts: Record<string, number> = {};
  for (const k of positionKeys) {
    redCounts[k] = 0;
    yellowCounts[k] = 0;
  }
  for (const p of red) redCounts[assigned.get(p.id) ?? positionKeys[0]]++;
  for (const p of yellow) yellowCounts[assigned.get(p.id) ?? positionKeys[0]]++;

  let positionPenalty = 0;
  for (const k of positionKeys) {
    positionPenalty += Math.abs((redCounts[k] ?? 0) - (yellowCounts[k] ?? 0));
  }
  const ratingPenalty = Math.abs(teamRating(red) - teamRating(yellow));
  return ratingPenalty + 2.0 * positionPenalty;
}

function teamRating(team: PlayerWithRating[]): number {
  return team.reduce((sum, p) => sum + p.rating, 0);
}
