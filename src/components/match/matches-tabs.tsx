"use client";

import { useState, type ReactNode } from "react";

export function MatchesTabs({
  upcoming,
  past,
  upcomingCount,
  pastCount,
}: {
  upcoming: ReactNode;
  past: ReactNode;
  upcomingCount: number;
  pastCount: number;
}) {
  const [tab, setTab] = useState<"upcoming" | "past">("upcoming");

  return (
    <div>
      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit mb-6">
        <button
          onClick={() => setTab("upcoming")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            tab === "upcoming"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Upcoming ({upcomingCount})
        </button>
        <button
          onClick={() => setTab("past")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            tab === "past"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Past ({pastCount})
        </button>
      </div>

      <div className="space-y-3">
        {tab === "upcoming" ? (
          upcomingCount === 0 ? (
            <div className="py-12 text-center text-slate-400">No upcoming matches.</div>
          ) : (
            upcoming
          )
        ) : pastCount === 0 ? (
          <div className="py-12 text-center text-slate-400">No past matches.</div>
        ) : (
          past
        )}
      </div>
    </div>
  );
}
