"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Pencil, Calendar, Star, Trophy, TrendingUp } from "lucide-react";
import { updateProfile } from "@/app/actions/players";
import { POSITION_LABELS } from "@/lib/constants";

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

type Profile = {
  name: string;
  email: string;
  image: string | null;
  phoneNumber: string | null;
  positions: string[];
  role: string;
};

type Stats = {
  matchesPlayed: number;
  avgRating: number | null;
  momCount: number;
  attendanceRate: number;
};

export default function ProfilePage() {
  const { data: session } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [selectedPositions, setSelectedPositions] = useState<string[]>([]);

  useEffect(() => {
    if (!session?.user?.id) return;
    fetch(`/api/players/${session.user.id}`)
      .then((r) => r.json())
      .then((data) => {
        setProfile(data.player);
        setStats(data.stats);
        setName(data.player.name);
        setPhoneNumber(data.player.phoneNumber ?? "");
        setSelectedPositions(data.player.positions);
      });
  }, [session?.user?.id]);

  function togglePosition(pos: string) {
    setSelectedPositions((prev) =>
      prev.includes(pos) ? prev.filter((p) => p !== pos) : [...prev, pos],
    );
  }

  async function handleSave() {
    try {
      await updateProfile({
        name,
        phoneNumber: phoneNumber.trim() || undefined,
        positions: selectedPositions,
      });
      toast.success("Profile updated!");
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              name,
              phoneNumber: phoneNumber.trim() || null,
              positions: selectedPositions,
            }
          : prev,
      );
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (!profile || !stats) {
    return <div className="p-10 text-center text-slate-400">Loading…</div>;
  }

  return (
    <div className="p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-slate-800">Profile</h1>

      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-start gap-5">
          <div className="w-20 h-20 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-3xl font-bold ring-4 ring-blue-100 shrink-0">
            {(profile.name ?? "?").charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            {editing ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Name
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Phone number
                  </label>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="+44 7700 900000"
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Positions
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {POSITIONS.map((pos) => {
                      const on = selectedPositions.includes(pos);
                      return (
                        <button
                          key={pos}
                          type="button"
                          onClick={() => togglePosition(pos)}
                          className={`h-10 rounded-lg border-2 text-sm font-medium transition-colors ${
                            on
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-white text-slate-700 border-slate-200 hover:border-blue-300"
                          }`}
                        >
                          {POSITION_LABELS[pos]}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={handleSave}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
                  >
                    Save changes
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="px-4 py-2 rounded-lg text-slate-700 hover:bg-slate-100 font-medium"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xl font-bold text-slate-800 truncate">{profile.name}</p>
                    <p className="text-sm text-slate-500 truncate">{profile.email}</p>
                    {profile.phoneNumber && (
                      <p className="text-sm text-slate-500 mt-0.5">{profile.phoneNumber}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-800 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                </div>
                <div className="flex items-center gap-1.5 mt-3">
                  {profile.positions.map((pos) => (
                    <span
                      key={pos}
                      className="inline-flex px-2 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold"
                    >
                      {pos}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile icon={<Calendar className="w-4 h-4" />} label="Matches" value={stats.matchesPlayed} color="blue" />
        <StatTile icon={<Star className="w-4 h-4" />} label="Avg rating" value={stats.avgRating != null ? stats.avgRating.toFixed(1) : "—"} color="green" />
        <StatTile icon={<Trophy className="w-4 h-4" />} label="MoM" value={stats.momCount} color="amber" />
        <StatTile icon={<TrendingUp className="w-4 h-4" />} label="Attendance" value={`${stats.attendanceRate}%`} color="purple" />
      </div>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: "blue" | "green" | "amber" | "purple";
}) {
  const cls = {
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    green: "bg-green-50 text-green-700 border-green-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    purple: "bg-purple-50 text-purple-700 border-purple-200",
  }[color];

  return (
    <div className={`p-5 rounded-xl border ${cls}`}>
      <div className="flex items-center gap-2 opacity-75">
        {icon}
        <p className="text-xs font-medium uppercase tracking-wider">{label}</p>
      </div>
      <p className="text-3xl font-bold mt-2">{value}</p>
    </div>
  );
}
