import { z } from "zod";

export const onboardingSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  positions: z.array(z.enum(["GK", "DEF", "MID", "FWD"])).min(1, "Select at least one position"),
});

export const activitySchema = z.object({
  name: z.string().min(2),
  dayOfWeek: z.number().min(0).max(6),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:mm format"),
  venue: z.string().min(2),
  format: z.enum(["FIVE_A_SIDE", "SEVEN_A_SIDE"]),
  deadlineHours: z.number().min(1).max(48).default(5),
  ratingWindowHours: z.number().min(1).max(168).default(48),
});

export const ratingSchema = z.object({
  ratings: z.array(
    z.object({
      playerId: z.string(),
      score: z.number().min(1).max(10),
    })
  ),
});

export const momVoteSchema = z.object({
  playerId: z.string(),
});

export const matchScoreSchema = z.object({
  redScore: z.number().min(0),
  yellowScore: z.number().min(0),
});

export const seedRatingSchema = z.object({
  players: z.array(
    z.object({
      userId: z.string(),
      rating: z.number().min(1).max(10),
    })
  ),
});
