"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Phone, Star } from "lucide-react";
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
        <div className="flex items-center gap-2">
          <Link
            href="/admin/players/phones"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            <Phone className="w-4 h-4" />
            Phones
            <span className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold">
              {withPhoneCount}/{players.length}
            </span>
          </Link>
          <Link
            href="/admin/players/ratings"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            <Star className="w-4 h-4" />
            Seed ratings
          </Link>
        </div>
      </div>

      <p className="text-sm text-slate-500">
        <span className="font-medium text-slate-700">Seed rating</span> is the player&apos;s
        starting skill score (1–10) used by the team-balancer until they&apos;ve
        accumulated enough peer ratings from completed matches.
      </p>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="hidden sm:grid grid-cols-[1fr_auto_auto] gap-4 px-6 py-3 border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <span>Player</span>
          <span className="w-24 text-center">Seed rating</span>
          <span className="w-28 text-center">Role</span>
        </div>
        <div className="divide-y divide-slate-100">
          {players.map((p) => (
            <div
              key={p.id}
              className="grid grid-cols-[1fr_auto_auto] gap-4 px-6 py-4 items-center"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-sm font-semibold shrink-0">
                  {(p.name ?? p.email).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
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
              </div>
              <div className="w-24 flex flex-col items-center">
                <label className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-0.5">
                  Seed
                </label>
                <input
                  type="number"
                  defaultValue={p.seedRating ?? ""}
                  min={1}
                  max={10}
                  step={0.5}
                  title="Seed rating (1–10). Used by the team-balancer until peer ratings accumulate."
                  onBlur={(e) => e.target.value && handleSeedRating(p.id, e.target.value)}
                  className="w-20 h-10 px-2 rounded-lg border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="w-28 flex flex-col items-center">
                <label className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-0.5">
                  Role
                </label>
                <select
                  value={p.role}
                  onChange={(e) => handleRoleChange(p.id, e.target.value)}
                  className="w-28 h-10 px-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="PLAYER">Player</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
