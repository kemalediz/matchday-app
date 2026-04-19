import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentOrgId } from "@/lib/org";
import { Plus, Check, Users, Calendar, CalendarDays } from "lucide-react";

/**
 * Lists every org the signed-in user is a member of (active memberships
 * only — `leftAt` is null). Each row shows basic counts and role. Click
 * Switch to make it active; click the name to open its admin dashboard.
 * Topmost CTA: create a new organisation.
 */
export default async function OrganisationsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const currentOrgId = await getCurrentOrgId();

  const memberships = await db.membership.findMany({
    where: { userId: session.user.id, leftAt: null },
    include: {
      org: {
        select: {
          id: true,
          name: true,
          slug: true,
          whatsappGroupId: true,
          createdAt: true,
          _count: {
            select: {
              memberships: { where: { leftAt: null } },
              activities: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Count matches per org (can't trivially include through activity.matches,
  // so separate query).
  const matchCounts = await Promise.all(
    memberships.map((m) =>
      db.match.count({
        where: { activity: { orgId: m.org.id } },
      }),
    ),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Your organisations</h2>
          <p className="text-sm text-slate-500 mt-1">
            Every group you&apos;re a member of. Switch between them to manage each one.
          </p>
        </div>
        <Link
          href="/create-org"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
        >
          <Plus className="w-4 h-4" />
          Create organisation
        </Link>
      </div>

      {memberships.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <p className="text-slate-500">You aren&apos;t in any organisations yet.</p>
          <Link
            href="/create-org"
            className="inline-flex items-center gap-2 px-4 py-2.5 mt-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
          >
            <Plus className="w-4 h-4" />
            Create your first
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
          {memberships.map((m, i) => {
            const isCurrent = m.org.id === currentOrgId;
            const matchCount = matchCounts[i];
            return (
              <div
                key={m.id}
                className={`px-6 py-5 flex items-start justify-between gap-4 ${
                  isCurrent ? "bg-blue-50/40" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-slate-800 truncate">{m.org.name}</p>
                    {isCurrent && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 text-[10px] font-semibold uppercase">
                        <Check className="w-3 h-3" />
                        Active
                      </span>
                    )}
                    <span
                      className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                        m.role === "OWNER"
                          ? "bg-purple-100 text-purple-700"
                          : m.role === "ADMIN"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {m.role.toLowerCase()}
                    </span>
                  </div>
                  <p className="text-sm text-slate-500 mt-1">/{m.org.slug}</p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {m.org._count.memberships} member{m.org._count.memberships === 1 ? "" : "s"}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {m.org._count.activities} activit
                      {m.org._count.activities === 1 ? "y" : "ies"}
                    </span>
                    <span className="flex items-center gap-1">
                      <CalendarDays className="w-3 h-3" />
                      {matchCount} match{matchCount === 1 ? "" : "es"}
                    </span>
                    {m.org.whatsappGroupId && (
                      <span className="inline-flex items-center gap-1 text-green-600">
                        <Check className="w-3 h-3" />
                        WhatsApp linked
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!isCurrent && (
                    <form action={switchOrgAction}>
                      <input type="hidden" name="orgId" value={m.org.id} />
                      <button
                        type="submit"
                        className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
                      >
                        Switch
                      </button>
                    </form>
                  )}
                  {isCurrent && (
                    <Link
                      href="/admin"
                      className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
                    >
                      Manage
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

async function switchOrgAction(formData: FormData) {
  "use server";
  const { switchOrg } = await import("@/app/actions/org");
  const orgId = formData.get("orgId") as string;
  if (orgId) await switchOrg(orgId);
  const { redirect } = await import("next/navigation");
  redirect("/admin/organisations");
}
