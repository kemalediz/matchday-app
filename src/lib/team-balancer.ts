import { Position } from "@/generated/prisma/client";
import { PlayerWithRating, TeamResult } from "@/types";

interface TeamComposition {
  GK: number;
  DEF: number;
  MID: number;
  FWD: number;
}

function getTargetComposition(perTeam: number): TeamComposition {
  if (perTeam === 5) return { GK: 1, DEF: 1, MID: 2, FWD: 1 };
  return { GK: 1, DEF: 2, MID: 2, FWD: 2 }; // 7-a-side
}

function assignPosition(player: PlayerWithRating, teamNeeds: TeamComposition): Position {
  // Assign the first preferred position the team still needs
  for (const pos of player.positions) {
    if (teamNeeds[pos] > 0) return pos;
  }
  // Fallback: assign to highest-need position
  const sorted = (Object.entries(teamNeeds) as [Position, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : "MID";
}

function teamRating(team: PlayerWithRating[]): number {
  return team.reduce((sum, p) => sum + p.rating, 0);
}

function positionCounts(team: PlayerWithRating[], allPositions: Map<string, Position>): Record<Position, number> {
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of team) {
    const pos = allPositions.get(p.id) ?? "MID";
    counts[pos]++;
  }
  return counts;
}

function positionImbalancePenalty(
  red: PlayerWithRating[],
  yellow: PlayerWithRating[],
  positions: Map<string, Position>
): number {
  const redCounts = positionCounts(red, positions);
  const yellowCounts = positionCounts(yellow, positions);
  let penalty = 0;
  for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
    penalty += Math.abs(redCounts[pos] - yellowCounts[pos]);
  }
  return penalty;
}

function cost(
  red: PlayerWithRating[],
  yellow: PlayerWithRating[],
  positions: Map<string, Position>
): number {
  return (
    Math.abs(teamRating(red) - teamRating(yellow)) +
    2.0 * positionImbalancePenalty(red, yellow, positions)
  );
}

export function balanceTeams(players: PlayerWithRating[], perTeam: number): TeamResult {
  if (players.length < perTeam * 2) {
    throw new Error(`Need at least ${perTeam * 2} players, got ${players.length}`);
  }

  const selected = players.slice(0, perTeam * 2);
  const target = getTargetComposition(perTeam);

  // Track assigned positions per player
  const assignedPositions = new Map<string, Position>();

  // Sort by rating descending for snake draft
  const sorted = [...selected].sort((a, b) => b.rating - a.rating);

  const red: PlayerWithRating[] = [];
  const yellow: PlayerWithRating[] = [];
  const redNeeds = { ...target };
  const yellowNeeds = { ...target };

  // Snake draft: assign each player to the team with lower total rating
  for (const player of sorted) {
    const redTotal = teamRating(red);
    const yellowTotal = teamRating(yellow);

    let chosenTeam: "red" | "yellow";
    if (red.length >= perTeam) {
      chosenTeam = "yellow";
    } else if (yellow.length >= perTeam) {
      chosenTeam = "red";
    } else if (redTotal <= yellowTotal) {
      chosenTeam = "red";
    } else {
      chosenTeam = "yellow";
    }

    const team = chosenTeam === "red" ? red : yellow;
    const needs = chosenTeam === "red" ? redNeeds : yellowNeeds;
    team.push(player);

    const pos = assignPosition(player, needs);
    assignedPositions.set(player.id, pos);
    needs[pos] = Math.max(0, needs[pos] - 1);
  }

  // Hill-climbing: random swaps to minimize cost
  let bestCost = cost(red, yellow, assignedPositions);

  for (let i = 0; i < 1000; i++) {
    const ri = Math.floor(Math.random() * red.length);
    const yi = Math.floor(Math.random() * yellow.length);

    // Swap
    [red[ri], yellow[yi]] = [yellow[yi], red[ri]];

    // Recompute positions after swap
    const tempPositions = new Map(assignedPositions);
    const redNeedsTemp = { ...target };
    const yellowNeedsTemp = { ...target };

    for (const p of red) {
      const pos = assignPosition(p, redNeedsTemp);
      tempPositions.set(p.id, pos);
      redNeedsTemp[pos] = Math.max(0, redNeedsTemp[pos] - 1);
    }
    for (const p of yellow) {
      const pos = assignPosition(p, yellowNeedsTemp);
      tempPositions.set(p.id, pos);
      yellowNeedsTemp[pos] = Math.max(0, yellowNeedsTemp[pos] - 1);
    }

    const newCost = cost(red, yellow, tempPositions);

    if (newCost < bestCost) {
      bestCost = newCost;
      // Accept swap, update positions
      for (const [id, pos] of tempPositions) {
        assignedPositions.set(id, pos);
      }
    } else {
      // Revert swap
      [red[ri], yellow[yi]] = [yellow[yi], red[ri]];
    }
  }

  return {
    red,
    yellow,
    ratingDiff: Math.abs(teamRating(red) - teamRating(yellow)),
  };
}
