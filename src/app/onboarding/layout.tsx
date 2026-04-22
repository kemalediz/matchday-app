import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

/**
 * Guard: require auth. That's it.
 *
 * A user who already owns an org can still come here to spin up another
 * — plenty of admins run multiple groups (football + basketball,
 * Tuesdays + Saturdays, etc.). createOrgFromWizard adds a second OWNER
 * Membership cleanly; setCurrentOrgId pivots the session to the new org
 * on success.
 *
 * Unauthenticated users bounce to /login?callbackUrl=/onboarding so
 * they sign in first and land back here.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/onboarding");
  }
  return <>{children}</>;
}
