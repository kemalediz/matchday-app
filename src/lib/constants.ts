import { MatchFormat, Position } from "@/generated/prisma/client";

export const POSITION_LABELS: Record<Position, string> = {
  GK: "Goalkeeper",
  DEF: "Defender",
  MID: "Midfielder",
  FWD: "Forward",
};

export const POSITION_SHORT: Record<Position, string> = {
  GK: "GK",
  DEF: "DEF",
  MID: "MID",
  FWD: "FWD",
};

export const FORMAT_CONFIG: Record<
  MatchFormat,
  { label: string; maxPlayers: number; perTeam: number; composition: Record<Position, number> }
> = {
  SEVEN_A_SIDE: {
    label: "7-a-side",
    maxPlayers: 14,
    perTeam: 7,
    composition: { GK: 1, DEF: 2, MID: 2, FWD: 2 },
  },
  FIVE_A_SIDE: {
    label: "5-a-side",
    maxPlayers: 10,
    perTeam: 5,
    composition: { GK: 1, DEF: 1, MID: 2, FWD: 1 },
  },
};

export const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const TEAM_COLORS: Record<string, { label: string; bg: string; text: string }> = {
  RED: { label: "Red", bg: "bg-red-500", text: "text-white" },
  YELLOW: { label: "Yellow", bg: "bg-yellow-400", text: "text-black" },
};
