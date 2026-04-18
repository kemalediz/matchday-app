"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { completeOnboarding } from "@/app/actions/players";
import { POSITION_LABELS } from "@/lib/constants";

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

export default function OnboardingPage() {
  const { data: session } = useSession();
  const [name, setName] = useState(session?.user?.name ?? "");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [selectedPositions, setSelectedPositions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function togglePosition(pos: string) {
    setSelectedPositions((prev) =>
      prev.includes(pos) ? prev.filter((p) => p !== pos) : [...prev, pos],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) return setError("Please enter your name");
    if (selectedPositions.length === 0) return setError("Select at least one position");

    setLoading(true);
    try {
      await completeOnboarding({
        name: name.trim(),
        phoneNumber: phoneNumber.trim() || undefined,
        positions: selectedPositions,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-10 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-slate-800">Welcome to MatchDay</h1>
          <p className="text-sm text-slate-500 mt-1">
            Let&apos;s set up your player profile
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-1.5">
              Your name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              className="w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-slate-700 mb-1.5">
              Phone number <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <input
              id="phone"
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+44 7700 900000"
              className="w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-slate-400 mt-1">
              Used to match your WhatsApp messages to your attendance.
            </p>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="block text-sm font-medium text-slate-700">Preferred positions</label>
              <span className="text-xs text-slate-400">Select all that apply</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {POSITIONS.map((pos) => {
                const selected = selectedPositions.includes(pos);
                return (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => togglePosition(pos)}
                    className={`h-11 rounded-lg border-2 text-sm font-medium transition-colors ${
                      selected
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:bg-blue-50"
                    }`}
                  >
                    {POSITION_LABELS[pos]}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? "Saving…" : "Complete setup"}
          </button>
        </form>
      </div>
    </div>
  );
}
