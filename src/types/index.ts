import { Position } from "@/generated/prisma/client";

export interface PlayerWithRating {
  id: string;
  name: string;
  positions: Position[];
  rating: number;
  image?: string | null;
}

export interface TeamResult {
  red: PlayerWithRating[];
  yellow: PlayerWithRating[];
  ratingDiff: number;
}
