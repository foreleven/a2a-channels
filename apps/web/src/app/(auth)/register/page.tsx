"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { RadioTower } from "lucide-react";

import { register } from "@/lib/api";
import { extractApiErrorMessage } from "@/lib/api-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await register(username, password);
      router.push("/");
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
            Create a gateway account
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Create Account</CardTitle>
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
                  placeholder="Choose a username"
                  required
                  value={username}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  autoComplete="new-password"
                  id="password"
                  minLength={6}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  required
                  type="password"
                  value={password}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm">Confirm Password</FieldLabel>
                <Input
                  autoComplete="new-password"
                  id="confirm"
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat password"
                  required
                  type="password"
                  value={confirm}
                />
              </Field>
              <Button className="w-full" disabled={loading} type="submit">
                {loading ? "Creating account…" : "Create Account"}
              </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
            href="/login"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
