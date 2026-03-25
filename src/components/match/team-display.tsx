import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Player {
  id: string;
  name: string | null;
  image: string | null;
  positions: string[];
}

interface TeamDisplayProps {
  redTeam: Player[];
  yellowTeam: Player[];
  redScore?: number | null;
  yellowScore?: number | null;
}

export function TeamDisplay({ redTeam, yellowTeam, redScore, yellowScore }: TeamDisplayProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Card className="border-2 border-red-200 dark:border-red-900/50 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2.5 text-lg">
              <span className="h-4 w-4 rounded-full bg-red-500 shadow-sm shadow-red-500/30" />
              Red Team
            </CardTitle>
            {redScore !== null && redScore !== undefined && (
              <span className="text-3xl font-bold text-red-500">{redScore}</span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {redTeam.map((player) => (
              <li key={player.id} className="flex items-center gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={player.image ?? undefined} />
                  <AvatarFallback className="text-xs bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300 font-semibold">{player.name?.charAt(0)}</AvatarFallback>
                </Avatar>
                <span className="text-[15px] font-medium">{player.name}</span>
                {player.positions.length > 0 && (
                  <Badge variant="outline" className="text-xs ml-auto">{player.positions[0]}</Badge>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card className="border-2 border-yellow-200 dark:border-yellow-900/50 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2.5 text-lg">
              <span className="h-4 w-4 rounded-full bg-yellow-400 shadow-sm shadow-yellow-400/30" />
              Yellow Team
            </CardTitle>
            {yellowScore !== null && yellowScore !== undefined && (
              <span className="text-3xl font-bold text-yellow-500">{yellowScore}</span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {yellowTeam.map((player) => (
              <li key={player.id} className="flex items-center gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={player.image ?? undefined} />
                  <AvatarFallback className="text-xs bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300 font-semibold">{player.name?.charAt(0)}</AvatarFallback>
                </Avatar>
                <span className="text-[15px] font-medium">{player.name}</span>
                {player.positions.length > 0 && (
                  <Badge variant="outline" className="text-xs ml-auto">{player.positions[0]}</Badge>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
