interface Player {
  id: string;
  name: string | null;
  image: string | null;
  positions: string[];
}

function TeamCard({
  color,
  players,
  score,
}: {
  color: "red" | "yellow";
  players: Player[];
  score?: number | null;
}) {
  const palette =
    color === "red"
      ? {
          dot: "bg-red-500",
          border: "border-red-200",
          scoreText: "text-red-600",
          initialsBg: "bg-red-50 text-red-700",
          label: "Red team",
        }
      : {
          dot: "bg-amber-400",
          border: "border-amber-200",
          scoreText: "text-amber-600",
          initialsBg: "bg-amber-50 text-amber-700",
          label: "Yellow team",
        };

  return (
    <div className={`bg-white rounded-xl border-2 ${palette.border} shadow-sm`}>
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`h-3 w-3 rounded-full ${palette.dot}`} />
          <h3 className="font-semibold text-slate-800">{palette.label}</h3>
        </div>
        {score != null && <span className={`text-2xl font-bold ${palette.scoreText}`}>{score}</span>}
      </div>
      <ul className="divide-y divide-slate-100">
        {players.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-5 py-3">
            <div className={`w-8 h-8 rounded-full ${palette.initialsBg} flex items-center justify-center text-xs font-semibold`}>
              {(p.name ?? "?").charAt(0).toUpperCase()}
            </div>
            <span className="text-sm font-medium text-slate-800 truncate">{p.name}</span>
            {p.positions.length > 0 && (
              <span className="ml-auto inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold">
                {p.positions[0]}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TeamDisplay({
  redTeam,
  yellowTeam,
  redScore,
  yellowScore,
}: {
  redTeam: Player[];
  yellowTeam: Player[];
  redScore?: number | null;
  yellowScore?: number | null;
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <TeamCard color="red" players={redTeam} score={redScore} />
      <TeamCard color="yellow" players={yellowTeam} score={yellowScore} />
    </div>
  );
}
