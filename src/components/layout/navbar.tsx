"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function Navbar() {
  const { data: session } = useSession();

  return (
    <nav className="border-b bg-card">
      <div className="mx-auto max-w-5xl flex items-center justify-between px-4 h-14">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-bold text-lg">
            MatchDay
          </Link>
          {session && (
            <div className="hidden sm:flex items-center gap-4 text-sm">
              <Link href="/matches" className="text-muted-foreground hover:text-foreground transition-colors">
                Matches
              </Link>
              <Link href="/profile" className="text-muted-foreground hover:text-foreground transition-colors">
                Profile
              </Link>
            </div>
          )}
        </div>

        {session ? (
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={session.user.image ?? undefined} alt={session.user.name ?? ""} />
                  <AvatarFallback>{session.user.name?.charAt(0) ?? "?"}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <div className="px-2 py-1.5 text-sm font-medium">{session.user.name}</div>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link href="/matches" />}>Matches</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/profile" />}>Profile</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/admin" />}>Admin</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => signOut()}>Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-medium h-7 px-2.5 hover:bg-primary/80 transition-all"
          >
            Sign in
          </Link>
        )}
      </div>
    </nav>
  );
}
