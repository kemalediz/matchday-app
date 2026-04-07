"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { createOrganisation } from "@/app/actions/org";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function nameToSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export default function CreateOrgPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function handleNameChange(value: string) {
    setName(value);
    setSlug(nameToSlug(value));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await createOrganisation({ name, slug });
      toast.success("Organisation created!");
      router.push("/admin/activities");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 bg-gradient-to-b from-primary/5 to-background">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-2 pb-2">
          <CardTitle className="text-2xl font-bold">
            Create your organisation
          </CardTitle>
          <CardDescription className="text-base">
            Set up your club, team, or group
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4 pb-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="org-name">Organisation name</Label>
              <Input
                id="org-name"
                type="text"
                placeholder="e.g. Sunday League FC"
                className="h-11"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">URL</Label>
              <div className="flex items-center gap-0 rounded-lg border border-input bg-muted/50 overflow-hidden">
                <span className="px-3 text-sm text-muted-foreground whitespace-nowrap select-none">
                  matchday.app/join/
                </span>
                <Input
                  id="slug"
                  type="text"
                  className="h-11 border-0 border-l rounded-none bg-background focus-visible:ring-0 focus-visible:border-ring"
                  value={slug}
                  readOnly
                />
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}

            <Button
              type="submit"
              size="lg"
              className="w-full h-11"
              disabled={loading || !name.trim()}
            >
              {loading ? "Creating..." : "Create organisation"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Or{" "}
            <Link
              href="/"
              className="font-medium text-primary hover:underline"
            >
              join an existing organisation
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
