import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Users, Calendar, Clock, CheckCircle, ChevronRight } from "lucide-react";

export default async function AdminDashboardPage() {
  const [playerCount, activeActivities, upcomingMatches, completedMatches] = await Promise.all([
    db.user.count({ where: { isActive: true } }),
    db.activity.count({ where: { isActive: true } }),
    db.match.count({ where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } } }),
    db.match.count({ where: { status: "COMPLETED" } }),
  ]);

  return (
    <div className="space-y-8">
      <div className="grid gap-5 sm:grid-cols-4">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Players
            </CardTitle>
          </CardHeader>
          <CardContent><p className="text-4xl font-bold">{playerCount}</p></CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Activities
            </CardTitle>
          </CardHeader>
          <CardContent><p className="text-4xl font-bold">{activeActivities}</p></CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Upcoming
            </CardTitle>
          </CardHeader>
          <CardContent><p className="text-4xl font-bold">{upcomingMatches}</p></CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Completed
            </CardTitle>
          </CardHeader>
          <CardContent><p className="text-4xl font-bold">{completedMatches}</p></CardContent>
        </Card>
      </div>

      <div className="flex gap-4">
        <Button size="lg" render={<Link href="/admin/activities" />}>
          Manage Activities
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
        <Button variant="outline" size="lg" render={<Link href="/admin/players" />}>
          Manage Players
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
