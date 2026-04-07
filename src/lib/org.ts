import { db } from "./db";
import { cookies } from "next/headers";

export async function getCurrentOrgId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get("orgId")?.value ?? null;
}

export async function setCurrentOrgId(orgId: string) {
  const cookieStore = await cookies();
  cookieStore.set("orgId", orgId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
}

export async function getUserOrg(userId: string) {
  const orgId = await getCurrentOrgId();

  if (orgId) {
    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      include: { org: true },
    });
    if (membership) return membership;
  }

  // Fallback: get first org the user belongs to
  const membership = await db.membership.findFirst({
    where: { userId },
    include: { org: true },
    orderBy: { createdAt: "asc" },
  });

  return membership;
}

export async function isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  return membership?.role === "OWNER" || membership?.role === "ADMIN";
}

export async function requireOrgAdmin(userId: string, orgId: string) {
  const admin = await isOrgAdmin(userId, orgId);
  if (!admin) throw new Error("Admin access required");
}
