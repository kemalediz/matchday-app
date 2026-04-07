"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createOrgSchema } from "@/lib/validations";
import { setCurrentOrgId } from "@/lib/org";
import { revalidatePath } from "next/cache";

export async function createOrganisation(formData: { name: string; slug: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = createOrgSchema.parse(formData);

  const existing = await db.organisation.findUnique({ where: { slug: parsed.slug } });
  if (existing) throw new Error("This URL is already taken. Try a different one.");

  const org = await db.organisation.create({
    data: {
      name: parsed.name,
      slug: parsed.slug,
      memberships: {
        create: {
          userId: session.user.id,
          role: "OWNER",
        },
      },
    },
  });

  await setCurrentOrgId(org.id);
  revalidatePath("/");
  return { orgId: org.id, slug: org.slug };
}

export async function joinOrganisation(inviteCode: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const org = await db.organisation.findUnique({ where: { inviteCode } });
  if (!org) throw new Error("Invalid invite link");

  const existing = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId: org.id } },
  });

  if (existing) {
    await setCurrentOrgId(org.id);
    return { orgId: org.id, alreadyMember: true };
  }

  await db.membership.create({
    data: {
      userId: session.user.id,
      orgId: org.id,
      role: "PLAYER",
    },
  });

  await setCurrentOrgId(org.id);
  revalidatePath("/");
  return { orgId: org.id, alreadyMember: false };
}

export async function switchOrg(orgId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId } },
  });

  if (!membership) throw new Error("Not a member of this organisation");

  await setCurrentOrgId(orgId);
  revalidatePath("/");
}
