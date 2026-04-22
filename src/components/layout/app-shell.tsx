"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Sidebar } from "./sidebar";

/**
 * Shell that decides whether to render the app's Sidebar and how much
 * left-padding the main content needs.
 *
 * - Auth routes (`/login`, `/signup`, `/verify-email`) are always
 *   full-bleed — they have their own background.
 * - The marketing landing (`/`) is full-bleed for signed-out visitors
 *   so the Sidebar doesn't leak behind the hero gradient.
 * - Everything else gets the sidebar + the `lg:pl-64` offset so content
 *   doesn't slide underneath the 16rem fixed sidebar on desktop.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const sessionCtx = useSession();
  const status = sessionCtx.status;
  const hasUser = status === "authenticated";

  const isAuthRoute =
    pathname?.startsWith("/login") ||
    pathname?.startsWith("/signup") ||
    pathname?.startsWith("/verify-email");

  const isMagicLink = pathname?.startsWith("/r/");
  const isJoinLink = pathname?.startsWith("/join/");
  const isOnboarding = pathname?.startsWith("/onboarding");

  // Treat "loading" as signed-in-for-now so we don't flash the marketing
  // layout for half a second on a signed-in user's hard refresh.
  const isPublicMarketing =
    pathname === "/" && !hasUser && status !== "loading";

  const showSidebar = !isAuthRoute && !isMagicLink && !isJoinLink && !isPublicMarketing && !isOnboarding;

  return (
    <>
      {showSidebar && <Sidebar />}
      <main className={`min-h-screen ${showSidebar ? "lg:pl-64" : ""}`}>
        {children}
      </main>
    </>
  );
}
