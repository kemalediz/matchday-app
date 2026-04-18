"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Phone } from "lucide-react";
import { toast } from "sonner";
import { updatePlayerRole, seedPlayerRating } from "@/app/actions/players";

interface Player {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  positions: string[];
  seedRating: number | null;
  phoneNumber: string | null;
  isActive: boolean;
  _count: { attendances: number };
}

export default function PlayersPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/org/settings").then((r) => r.json()).then((d) => setOrgId(d.id));
    loadPlayers();
  }, []);

  async function loadPlayers() {
    const res = await fetch("/api/players");
    if (res.ok) setPlayers(await res.json());
    setLoading(false);
  }

  async function handleRoleChange(userId: string, role: string) {
    if (!orgId) return;
    try {
      await updatePlayerRole(userId, orgId, role as "ADMIN" | "PLAYER");
      toast.success("Role updated");
      loadPlayers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleSeedRating(userId: string, value: string) {
    const num = parseFloat(value);
    if (isNaN(num) || num < 1 || num > 10 || !orgId) return;
    try {
      await seedPlayerRating(userId, orgId, num);
      toast.success("Rating updated");
      loadPlayers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (loading) return <div className="p-10 text-center text-slate-400">Loading…</div>;

  const withPhoneCount = players.filter((p) => p.phoneNumber).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-800">Players ({players.length})</h2>
        <Link
          href="/admin/players/phones"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
        >
          <Phone className="w-4 h-4" />
          Bulk edit phones
          <span className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold">
            {withPhoneCount}/{players.length}
          </span>
        </Link>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
        {players.map((p) => (
          <div key={p.id} className="px-6 py-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-sm font-semibold shrink-0">
              {(p.name ?? p.email).charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-slate-800 truncate">{p.name ?? p.email}</p>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5">
                {p.positions.map((pos) => (
                  <span
                    key={pos}
                    className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold"
                  >
                    {pos}
                  </span>
                ))}
                <span>· {p._count.attendances} matches</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                defaultValue={p.seedRating ?? ""}
                min={1}
                max={10}
                step={0.5}
                placeholder="Seed"
                onBlur={(e) => e.target.value && handleSeedRating(p.id, e.target.value)}
                className="w-20 h-10 px-2 rounded-lg border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <select
                value={p.role}
                onChange={(e) => handleRoleChange(p.id, e.target.value)}
                className="h-10 px-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="PLAYER">Player</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
