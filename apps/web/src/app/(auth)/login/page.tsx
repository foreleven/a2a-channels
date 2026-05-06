"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { RadioTower } from "lucide-react";

import { login } from "@/lib/api";
import { extractApiErrorMessage } from "@/lib/api-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(username, password);
      router.push(safeNextPath(readNextParam()));
      router.refresh();
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-12 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <RadioTower className="size-6" />
          </span>
          <h1 className="text-2xl font-semibold">A2A Channels</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to your gateway account
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Sign In</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit}>
              <FieldGroup className="gap-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="username">Username</FieldLabel>
                <Input
                  autoComplete="username"
                  id="username"
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter username"
                  required
                  value={username}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  autoComplete="current-password"
                  id="password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  required
                  type="password"
                  value={password}
                />
              </Field>
              <Button className="w-full" disabled={loading} type="submit">
                {loading ? "Signing in…" : "Sign In"}
              </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          No account yet?{" "}
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
            href="/register"
          >
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}

function readNextParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("next");
}

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}
