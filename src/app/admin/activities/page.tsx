"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createActivity, updateActivity, generateMatchesForActivity } from "@/app/actions/activities";
import { DAYS_OF_WEEK } from "@/lib/constants";
import { toast } from "sonner";
import { Plus, Zap } from "lucide-react";

interface Activity {
  id: string;
  name: string;
  dayOfWeek: number;
  time: string;
  venue: string;
  format: string;
  isActive: boolean;
  deadlineHours: number;
  ratingWindowHours: number;
}

export default function ActivitiesPage() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState("2"); // Tuesday
  const [time, setTime] = useState("21:30");
  const [venue, setVenue] = useState("");
  const [format, setFormat] = useState<"FIVE_A_SIDE" | "SEVEN_A_SIDE">("SEVEN_A_SIDE");
  const [deadlineHours, setDeadlineHours] = useState("5");

  useEffect(() => {
    loadActivities();
  }, []);

  async function loadActivities() {
    const res = await fetch("/api/activities");
    if (res.ok) {
      setActivities(await res.json());
    }
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createActivity({
        name,
        dayOfWeek: parseInt(dayOfWeek),
        time,
        venue,
        format,
        deadlineHours: parseInt(deadlineHours),
      });
      toast.success("Activity created!");
      setDialogOpen(false);
      loadActivities();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create");
    }
  }

  async function handleGenerateMatch(activityId: string) {
    try {
      await generateMatchesForActivity(activityId);
      toast.success("Match generated for next week!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate");
    }
  }

  async function handleToggleActive(activity: Activity) {
    try {
      await updateActivity(activity.id, { isActive: !activity.isActive });
      toast.success(activity.isActive ? "Activity deactivated" : "Activity activated");
      loadActivities();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  }

  if (loading) return <p className="text-muted-foreground text-lg">Loading...</p>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h2>Activities</h2>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button size="lg" />}>
            <Plus className="h-4 w-4 mr-2" />
            Create Activity
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-xl">New Activity</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-5 mt-2">
              <div className="space-y-2">
                <Label className="text-[15px]">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Tuesday 7-a-side" className="h-11" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-[15px]">Day</Label>
                  <Select value={dayOfWeek} onValueChange={(v) => v && setDayOfWeek(v)}>
                    <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DAYS_OF_WEEK.map((day, i) => (
                        <SelectItem key={i} value={String(i)}>{day}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-[15px]">Time</Label>
                  <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-11" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-[15px]">Venue</Label>
                <Input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="e.g., Goals North Cheam" className="h-11" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-[15px]">Format</Label>
                  <Select value={format} onValueChange={(v) => v && setFormat(v as typeof format)}>
                    <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SEVEN_A_SIDE">7-a-side (14 players)</SelectItem>
                      <SelectItem value="FIVE_A_SIDE">5-a-side (10 players)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-[15px]">Deadline (hours before)</Label>
                  <Input type="number" value={deadlineHours} onChange={(e) => setDeadlineHours(e.target.value)} min="1" max="48" className="h-11" />
                </div>
              </div>
              <Button type="submit" className="w-full text-base py-5" size="lg">Create</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-3">
        {activities.map((activity) => (
          <Card key={activity.id} className="shadow-sm">
            <CardContent className="py-5 flex items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2.5">
                  <p className="text-[15px] font-semibold">{activity.name}</p>
                  <Badge variant={activity.isActive ? "default" : "secondary"}>
                    {activity.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {DAYS_OF_WEEK[activity.dayOfWeek]}s at {activity.time} &middot; {activity.venue}
                </p>
                <p className="text-sm text-muted-foreground">
                  {activity.format === "SEVEN_A_SIDE" ? "7-a-side" : "5-a-side"} &middot; Deadline: {activity.deadlineHours}h before
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button variant="outline" onClick={() => handleGenerateMatch(activity.id)}>
                  <Zap className="h-4 w-4 mr-1.5" />
                  Generate Match
                </Button>
                <Button variant="ghost" onClick={() => handleToggleActive(activity)}>
                  {activity.isActive ? "Deactivate" : "Activate"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {activities.length === 0 && (
          <p className="text-muted-foreground text-center py-12 text-lg">No activities yet. Create your first one!</p>
        )}
      </div>
    </div>
  );
}
