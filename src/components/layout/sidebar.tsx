"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState } from "react";
import { Home, CalendarDays, User, Shield, Menu, X, LogOut, LogIn } from "lucide-react";

type NavItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  /** tailwind classes applied to the active state (bg + text) */
  activeColor: string;
  adminOnly?: boolean;
};

const NAV: NavItem[] = [
  {
    label: "Dashboard",
    href: "/",
    icon: <Home className="w-5 h-5 shrink-0" />,
    activeColor: "bg-blue-600 text-white",
  },
  {
    label: "Matches",
    href: "/matches",
    icon: <CalendarDays className="w-5 h-5 shrink-0" />,
    activeColor: "bg-teal-600 text-white",
  },
  {
    label: "Profile",
    href: "/profile",
    icon: <User className="w-5 h-5 shrink-0" />,
    activeColor: "bg-purple-600 text-white",
  },
  {
    label: "Admin",
    href: "/admin",
    icon: <Shield className="w-5 h-5 shrink-0" />,
    activeColor: "bg-amber-600 text-white",
    adminOnly: true,
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Don't render on auth routes
  if (pathname?.startsWith("/login") || pathname?.startsWith("/signup") || pathname?.startsWith("/verify-email")) {
    return null;
  }

  const user = session?.user;
  // Admin is visible to everyone; admin layout itself enforces access.
  // A cleaner approach would pass isAdmin via session but keeps the sidebar
  // a pure client component without extra fetches.

  const items = NAV.filter((n) => !n.adminOnly || !!user);

  const sidebarContent = (
    <>
      {/* Logo / brand */}
      <div className="px-5 py-5 border-b border-slate-700">
        <h1 className="text-lg font-bold tracking-tight text-white">MatchDay</h1>
        <p className="text-[11px] text-slate-400 mt-0.5 tracking-wide uppercase">
          Sports Management
        </p>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-3 space-y-1">
        {items.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname?.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? item.activeColor
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Account */}
      <div className="px-4 py-4 border-t border-slate-700">
        {user ? (
          <>
            <div className="flex items-center gap-3">
              {user.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.image}
                  alt=""
                  className="w-9 h-9 rounded-full ring-2 ring-slate-700"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center text-sm font-semibold text-white">
                  {user.name?.[0]?.toUpperCase() ?? "?"}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">
                  {user.name ?? "Player"}
                </p>
                <p className="text-xs text-slate-400 truncate">{user.email}</p>
              </div>
            </div>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="mt-3 w-full flex items-center gap-2 text-xs text-slate-400 hover:text-white transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          </>
        ) : (
          <Link
            href="/login"
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <LogIn className="w-4 h-4" />
            Sign in
          </Link>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center justify-between px-4 h-14 bg-slate-900 text-white border-b border-slate-800">
        <button
          onClick={() => setMobileOpen((v) => !v)}
          className="p-2 -ml-2 rounded-md hover:bg-slate-800"
          aria-label="Toggle menu"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
        <span className="font-semibold tracking-tight">MatchDay</span>
        <div className="w-9" />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-30 bg-black/50"
          onClick={() => setMobileOpen(false)}
        >
          <aside
            className="absolute left-0 top-0 bottom-0 w-72 bg-slate-900 text-white flex flex-col pt-14 animate-in slide-in-from-left duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Desktop fixed sidebar */}
      <aside className="hidden lg:flex fixed left-0 top-0 bottom-0 w-64 bg-slate-900 text-white flex-col z-30">
        {sidebarContent}
      </aside>
    </>
  );
}
