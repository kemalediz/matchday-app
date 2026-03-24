import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface AttendancePlayer {
  id: string;
  status: string;
  position: number;
  user: {
    id: string;
    name: string | null;
    image: string | null;
    positions: string[];
  };
}

interface AttendanceListProps {
  attendances: AttendancePlayer[];
  maxPlayers: number;
}

export function AttendanceList({ attendances, maxPlayers }: AttendanceListProps) {
  const confirmed = attendances
    .filter((a) => a.status === "CONFIRMED")
    .sort((a, b) => a.position - b.position);
  const bench = attendances
    .filter((a) => a.status === "BENCH")
    .sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-2">
          Players ({confirmed.length}/{maxPlayers})
        </h3>
        <ul className="space-y-2">
          {confirmed.map((a, i) => (
            <li key={a.id} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-5">{i + 1}.</span>
              <Avatar className="h-6 w-6">
                <AvatarImage src={a.user.image ?? undefined} />
                <AvatarFallback className="text-xs">{a.user.name?.charAt(0)}</AvatarFallback>
              </Avatar>
              <span className="text-sm">{a.user.name}</span>
              <div className="ml-auto flex gap-1">
                {a.user.positions.slice(0, 2).map((pos) => (
                  <Badge key={pos} variant="outline" className="text-xs">{pos}</Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {bench.length > 0 && (
        <>
          <Separator />
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Bench ({bench.length})
            </h3>
            <ul className="space-y-2">
              {bench.map((a, i) => (
                <li key={a.id} className="flex items-center gap-2 opacity-60">
                  <span className="text-xs text-muted-foreground w-5">{i + 1}.</span>
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={a.user.image ?? undefined} />
                    <AvatarFallback className="text-xs">{a.user.name?.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm">{a.user.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
