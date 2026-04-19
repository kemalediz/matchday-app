/**
 * Lightweight Elo for pickup sport matches.
 *
 * Each player has a `matchRating` (starts at 1000). After every match with
 * a known score we update it as follows:
 *
 *   expectedProb = 1 / (1 + 10^((oppTeamAvg - myTeamAvg) / 400))
 *   actual       = 1 (won) | 0 (lost) | 0.5 (draw)
 *   K            = 32 * (1 + |scoreDiff| / 5)   ← bigger scoreDiff → bigger update
 *   newRating    = oldRating + K * (actual - expectedProb)
 *
 * Small margins → small nudge. Blowouts → big nudge. Over time, players
 * who consistently win against stronger teams climb; players who lose
 * against weaker teams drop. Self-calibrating, no tuning required.
 */

export interface PlayerEloInput {
  userId: string;
  team: "RED" | "YELLOW";
  matchRating: number;
}

export interface EloDelta {
  userId: string;
  before: number;
  after: number;
  delta: number;
}

/**
 * Compute new matchRating for every player involved in a match. Pure
 * function — caller persists the results.
 */
export function computeEloDeltas(
  players: PlayerEloInput[],
  redScore: number,
  yellowScore: number,
): EloDelta[] {
  const red = players.filter((p) => p.team === "RED");
  const yellow = players.filter((p) => p.team === "YELLOW");
  if (red.length === 0 || yellow.length === 0) return [];

  const redAvg = avg(red.map((p) => p.matchRating));
  const yellowAvg = avg(yellow.map((p) => p.matchRating));

  const redExpected = 1 / (1 + Math.pow(10, (yellowAvg - redAvg) / 400));
  const yellowExpected = 1 - redExpected;

  const actual = actualScore(redScore, yellowScore);
  const k = kFactor(redScore, yellowScore);

  return players.map((p) => {
    const expected = p.team === "RED" ? redExpected : yellowExpected;
    const actualForMe = p.team === "RED" ? actual : 1 - actual;
    const delta = Math.round(k * (actualForMe - expected));
    return {
      userId: p.userId,
      before: p.matchRating,
      after: p.matchRating + delta,
      delta,
    };
  });
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 1000;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function actualScore(red: number, yellow: number): number {
  if (red > yellow) return 1;
  if (red < yellow) return 0;
  return 0.5;
}

function kFactor(red: number, yellow: number): number {
  const diff = Math.abs(red - yellow);
  return 32 * (1 + diff / 5);
}
