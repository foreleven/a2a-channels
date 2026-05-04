"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { RadioTower } from "lucide-react";

import { register, login, setAuthToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
      // Register, then immediately log in to obtain a token.
      await register(username, password);
      const result = await login(username, password);
      setAuthToken(result.token);
      router.push("/");
    } catch (err) {
      let message = String(err);
      try {
        const body = JSON.parse(message.replace(/^Error: /, "")) as { error?: string };
        message = body.error ?? message;
      } catch {
        // keep original message
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
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
            <form className="space-y-4" onSubmit={handleSubmit}>
              {error && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  autoComplete="username"
                  id="username"
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Choose a username"
                  required
                  value={username}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
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
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">Confirm Password</Label>
                <Input
                  autoComplete="new-password"
                  id="confirm"
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat password"
                  required
                  type="password"
                  value={confirm}
                />
              </div>
              <Button className="w-full" disabled={loading} type="submit">
                {loading ? "Creating account…" : "Create Account"}
              </Button>
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
