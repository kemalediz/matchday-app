import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { joinOrganisation } from "@/app/actions/org";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
      <div className="flex min-h-screen items-center justify-center px-6 bg-gradient-to-b from-primary/5 to-background">
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader className="text-center space-y-2">
            <CardTitle className="text-2xl font-bold text-destructive">
              Invalid invite link
            </CardTitle>
            <CardDescription className="text-base">
              This invite link is invalid or has expired. Ask your organiser for
              a new one.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  async function handleJoin() {
    "use server";
    await joinOrganisation(code);
    redirect("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 bg-gradient-to-b from-primary/5 to-background">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-2">
          <CardTitle className="text-2xl font-bold">
            Join {org.name}
          </CardTitle>
          <CardDescription className="text-base">
            You&apos;ve been invited to join this organisation on MatchDay.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          <form action={handleJoin}>
            <Button type="submit" size="lg" className="w-full h-11">
              Join {org.name}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
