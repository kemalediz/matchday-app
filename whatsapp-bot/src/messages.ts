interface MatchStatus {
  name: string;
  date: string;
  venue: string;
  confirmed: number;
  max: number;
  remaining: number;
  confirmedPlayers: string[];
  benchPlayers: string[];
}

interface TeamPlayer {
  name: string;
  position: string;
}

export function statusMessage(match: MatchStatus): string {
  const lines = [
    `*${match.name}*`,
    `${match.date} @ ${match.venue}`,
    "",
    `*${match.confirmed}/${match.max}* confirmed`,
  ];

  if (match.remaining > 0) {
    lines.push(`Need *${match.remaining}* more! Say *IN* to play`);
  } else {
    lines.push("Full squad! Extra players go on bench");
  }

  if (match.confirmedPlayers.length > 0) {
    lines.push("");
    lines.push("*Confirmed:*");
    match.confirmedPlayers.forEach((name, i) => {
      lines.push(`${i + 1}. ${name}`);
    });
  }

  if (match.benchPlayers.length > 0) {
    lines.push("");
    lines.push("*Bench:*");
    match.benchPlayers.forEach((name, i) => {
      lines.push(`${i + 1}. ${name}`);
    });
  }

  return lines.join("\n");
}

export function attendanceResponse(playerName: string, action: "IN" | "OUT", status: string, confirmed: number, max: number): string {
  if (action === "IN") {
    if (status === "BENCH") {
      return `${playerName} added to *bench*. You'll be promoted if someone drops. (${confirmed}/${max})`;
    }
    return `${playerName} is *IN*! (${confirmed}/${max})`;
  }
  return `${playerName} *dropped out*. (${confirmed}/${max})`;
}

export function teamsMessage(matchName: string, red: TeamPlayer[], yellow: TeamPlayer[]): string {
  const lines = [
    `*Teams for ${matchName}*`,
    "",
    "*Red Team:*",
    ...red.map((p) => `- ${p.name} (${p.position || "?"})`),
    "",
    "*Yellow Team:*",
    ...yellow.map((p) => `- ${p.name} (${p.position || "?"})`),
  ];

  return lines.join("\n");
}

export function unknownPlayerMessage(phone: string): string {
  return `Phone number ${phone} is not registered in MatchDay. Please sign up at the app and add your phone number to your profile.`;
}

export function errorMessage(): string {
  return "Something went wrong. Please try again or use the MatchDay app directly.";
}
