"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Link as LinkIcon, Users, Settings, MessageCircle } from "lucide-react";

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
      .then((r) => (r.ok ? r.json() : null))
      .then(setOrg)
      .finally(() => setLoading(false));
  }, []);

  async function copyInviteLink() {
    if (!org) return;
    const link = `${window.location.origin}/join/${org.inviteCode}`;
    await navigator.clipboard.writeText(link);
    toast.success("Invite link copied!");
  }

  if (loading) return <div className="p-10 text-center text-slate-400">Loading…</div>;
  if (!org) return <div className="p-10 text-center text-slate-400">Organisation not found.</div>;

  const inviteLink = `${typeof window !== "undefined" ? window.location.origin : ""}/join/${org.inviteCode}`;

  return (
    <div className="space-y-6">
      {/* General */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <Settings className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">General</h2>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Organisation name
            </label>
            <input
              value={org.name}
              disabled
              className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-700"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">URL slug</label>
            <input
              value={org.slug}
              disabled
              className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-700"
            />
          </div>
          <div className="flex items-center gap-1.5 text-sm text-slate-500">
            <Users className="w-4 h-4" />
            {org.memberCount} members
          </div>
        </div>
      </section>

      {/* Invite */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <LinkIcon className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">Invite link</h2>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-500">
            Share this link with players to join your organisation.
          </p>
          <div className="flex items-center gap-2">
            <input
              value={inviteLink}
              readOnly
              className="flex-1 h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 font-mono text-xs text-slate-700"
            />
            <button
              onClick={copyInviteLink}
              className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
            >
              <Copy className="w-4 h-4" />
              Copy
            </button>
          </div>
        </div>
      </section>

      {/* WhatsApp */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <MessageCircle className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">WhatsApp bot</h2>
        </div>
        <div className="p-6 space-y-4">
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
              org.whatsappBotEnabled
                ? "bg-green-100 text-green-700"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {org.whatsappBotEnabled ? "Enabled" : "Disabled"}
          </span>
          {org.whatsappGroupId && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                WhatsApp group ID
              </label>
              <input
                value={org.whatsappGroupId}
                disabled
                className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 font-mono text-xs text-slate-700"
              />
            </div>
          )}
          <p className="text-xs text-slate-500">
            Bot configuration is managed server-side. Contact your administrator to enable or reconfigure.
          </p>
        </div>
      </section>
    </div>
  );
}
