import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { AdminSubnav } from "@/components/layout/admin-subnav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/");

  const admin = await isOrgAdmin(session.user.id, membership.orgId);
  if (!admin) redirect("/");

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Admin</h1>
        <p className="text-sm text-slate-500 mt-1">{membership.org.name}</p>
      </div>
      <AdminSubnav />
      <div className="mt-6">{children}</div>
    </div>
  );
}
