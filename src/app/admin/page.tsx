import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default async function AdminDashboardPage() {
  const [playerCount, activeActivities, upcomingMatches, completedMatches] = await Promise.all([
    db.user.count({ where: { isActive: true } }),
    db.activity.count({ where: { isActive: true } }),
    db.match.count({ where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } } }),
    db.match.count({ where: { status: "COMPLETED" } }),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Players</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{playerCount}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Activities</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{activeActivities}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Upcoming</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{upcomingMatches}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completed</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{completedMatches}</p></CardContent>
        </Card>
      </div>

      <div className="flex gap-3">
        <Button render={<Link href="/admin/activities" />}>Manage Activities</Button>
        <Button variant="outline" render={<Link href="/admin/players" />}>Manage Players</Button>
      </div>
    </div>
  );
}
