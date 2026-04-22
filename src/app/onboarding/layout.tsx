import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";

/**
 * Guard: require auth. If the user already belongs to any org (including
 * as a player in someone else's group), we don't force them through the
 * wizard again — they can still create a second org from the org
 * switcher if they want.
 *
 * Landing on /onboarding without a session just bounces to /login with
 * a callback back here.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/onboarding");
  }

  const owned = await db.membership.count({
    where: { userId: session.user.id, role: "OWNER", leftAt: null },
  });
  if (owned > 0) {
    // Already running a group — send them to their admin panel.
    redirect("/admin");
  }

  return <>{children}</>;
}
