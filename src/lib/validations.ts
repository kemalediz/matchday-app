import { z } from "zod";

export const onboardingSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  phoneNumber: z.string().optional(),
  positions: z.array(z.enum(["GK", "DEF", "MID", "FWD"])).min(1, "Select at least one position"),
});

export const activitySchema = z.object({
  name: z.string().min(2),
  dayOfWeek: z.number().min(0).max(6),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:mm format"),
  venue: z.string().min(2),
  format: z.enum(["FIVE_A_SIDE", "SEVEN_A_SIDE"]),
  deadlineHours: z.number().min(1).max(48).default(5),
  matchDurationMins: z.number().min(20).max(180).default(60),
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

export const signUpSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createOrgSchema = z.object({
  name: z.string().min(2, "Organisation name must be at least 2 characters"),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, "URL slug must be lowercase letters, numbers and hyphens only"),
});

export const seedRatingSchema = z.object({
  players: z.array(
    z.object({
      userId: z.string(),
      rating: z.number().min(1).max(10),
    })
  ),
});
