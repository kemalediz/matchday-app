import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { joinOrganisation } from "@/app/actions/org";

export default async function JoinOrgPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  const org = await db.organisation.findUnique({
    where: { inviteCode: code },
    select: { name: true, slug: true },
  });

  if (!org) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <h1 className="text-2xl font-bold text-red-600">Invalid invite link</h1>
          <p className="text-sm text-slate-500 mt-2">
            This invite link is invalid or has expired. Ask your organiser for a new one.
          </p>
        </div>
      </div>
    );
  }

  async function handleJoin() {
    "use server";
    await joinOrganisation(code);
    redirect("/");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-slate-800">Join {org.name}</h1>
          <p className="text-sm text-slate-500 mt-1">
            You&apos;ve been invited to join this organisation on MatchDay.
          </p>
        </div>
        <form action={handleJoin}>
          <button
            type="submit"
            className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
          >
            Join {org.name}
          </button>
        </form>
      </div>
    </div>
  );
}
