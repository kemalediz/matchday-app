import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ADMIN_EMAIL } from "@/lib/constants";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  if (session.user.email !== ADMIN_EMAIL) redirect("/");

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex items-center gap-8 mb-8 border-b pb-5">
        <h1>Admin</h1>
        <nav className="flex gap-6 text-[15px] font-medium">
          <Link href="/admin" className="text-muted-foreground hover:text-foreground transition-colors">
            Dashboard
          </Link>
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
