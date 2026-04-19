export interface PlayerWithRating {
  id: string;
  name: string;
  positions: string[]; // from PlayerActivityPosition (sport-specific labels)
  rating: number;
  image?: string | null;
}

export interface TeamResult {
  red: PlayerWithRating[];
  yellow: PlayerWithRating[];
  ratingDiff: number;
}
