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
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="border-red-200 dark:border-red-900">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-red-500" />
              Red Team
            </CardTitle>
            {redScore !== null && redScore !== undefined && (
              <span className="text-2xl font-bold text-red-500">{redScore}</span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {redTeam.map((player) => (
              <li key={player.id} className="flex items-center gap-2">
                <Avatar className="h-6 w-6">
                  <AvatarImage src={player.image ?? undefined} />
                  <AvatarFallback className="text-xs">{player.name?.charAt(0)}</AvatarFallback>
                </Avatar>
                <span className="text-sm">{player.name}</span>
                {player.positions.length > 0 && (
                  <Badge variant="outline" className="text-xs ml-auto">{player.positions[0]}</Badge>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card className="border-yellow-200 dark:border-yellow-900">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-yellow-400" />
              Yellow Team
            </CardTitle>
            {yellowScore !== null && yellowScore !== undefined && (
              <span className="text-2xl font-bold text-yellow-500">{yellowScore}</span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {yellowTeam.map((player) => (
              <li key={player.id} className="flex items-center gap-2">
                <Avatar className="h-6 w-6">
                  <AvatarImage src={player.image ?? undefined} />
                  <AvatarFallback className="text-xs">{player.name?.charAt(0)}</AvatarFallback>
                </Avatar>
                <span className="text-sm">{player.name}</span>
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
