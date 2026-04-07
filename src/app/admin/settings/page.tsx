"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Copy, Link as LinkIcon } from "lucide-react";

interface OrgData {
  id: string;
  name: string;
  slug: string;
  inviteCode: string;
  whatsappGroupId: string | null;
  whatsappBotEnabled: boolean;
  memberCount: number;
}

export default function SettingsPage() {
  const [org, setOrg] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/org/settings")
      .then((r) => r.ok ? r.json() : null)
      .then(setOrg)
      .finally(() => setLoading(false));
  }, []);

  async function copyInviteLink() {
    if (!org) return;
    const link = `${window.location.origin}/join/${org.inviteCode}`;
    await navigator.clipboard.writeText(link);
    toast.success("Invite link copied!");
  }

  if (loading) return <p className="text-muted-foreground text-lg">Loading...</p>;
  if (!org) return <p className="text-muted-foreground text-lg">Organisation not found</p>;

  const inviteLink = `${typeof window !== "undefined" ? window.location.origin : ""}/join/${org.inviteCode}`;

  return (
    <div className="space-y-8">
      <h2>Organisation Settings</h2>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-[15px]">Organisation Name</Label>
            <Input value={org.name} disabled className="h-11" />
          </div>
          <div className="space-y-2">
            <Label className="text-[15px]">URL Slug</Label>
            <Input value={org.slug} disabled className="h-11" />
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="text-sm px-3 py-1">
              {org.memberCount} members
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <LinkIcon className="h-5 w-5" />
            Invite Link
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">Share this link with players to join your organisation.</p>
          <div className="flex items-center gap-3">
            <Input value={inviteLink} readOnly className="h-11 font-mono text-sm" />
            <Button variant="outline" onClick={copyInviteLink}>
              <Copy className="h-4 w-4 mr-2" />
              Copy
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">WhatsApp Bot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Badge variant={org.whatsappBotEnabled ? "default" : "secondary"}>
              {org.whatsappBotEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          {org.whatsappGroupId && (
            <div className="space-y-2">
              <Label className="text-[15px]">WhatsApp Group ID</Label>
              <Input value={org.whatsappGroupId} disabled className="h-11 font-mono text-sm" />
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            WhatsApp bot configuration is managed via the server. Contact the administrator to enable or configure the bot for your organisation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
