import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (user?.role !== "ADMIN") redirect("/");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center gap-6 mb-6 border-b pb-4">
        <h1 className="text-2xl font-bold">Admin</h1>
        <nav className="flex gap-4 text-sm">
          <Link href="/admin/activities" className="text-muted-foreground hover:text-foreground transition-colors">
            Activities
          </Link>
          <Link href="/admin/players" className="text-muted-foreground hover:text-foreground transition-colors">
            Players
          </Link>
          <Link href="/admin/stats" className="text-muted-foreground hover:text-foreground transition-colors">
            Stats
          </Link>
        </nav>
      </div>
      {children}
    </div>
  );
}
