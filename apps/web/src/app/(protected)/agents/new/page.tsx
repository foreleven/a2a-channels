"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, Bot, Terminal } from "lucide-react";

import type { AgentProtocol } from "@/lib/api";
import { createAgent } from "@/lib/api";
import {
  AGENT_PROTOCOL_OPTIONS,
  AgentConfigFormMapper,
  agentCreateHref,
  createAgentFormState,
  normalizeAgentProtocol,
} from "@/lib/agent-config-form";
import { AgentConfigFields } from "@/components/agent-config-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const formMapper = new AgentConfigFormMapper();

export default function NewAgentDefaultPage() {
  return <NewAgentPage initialProtocol="a2a" key="a2a" />;
}

export function NewAgentPage({
  initialProtocol,
}: {
  initialProtocol: string;
}) {
  const router = useRouter();
  const routeProtocol = normalizeAgentProtocol(initialProtocol);
  const [form, setForm] = useState(() => createAgentFormState(routeProtocol));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProtocol = useMemo(
    () => formMapper.protocolOption(form.protocol),
    [form.protocol],
  );

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await createAgent(formMapper.toPayload(form));
      router.push("/agents");
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Button asChild className="mb-3" size="sm" variant="ghost">
            <Link href="/agents">
              <ArrowLeft />
              Agents
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-normal">New Agent</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Register an A2A endpoint or an ACP stdio process for channel routing.
          </p>
        </div>
        <Button
          disabled={saving || !formMapper.canSubmit(form)}
          onClick={handleSave}
        >
          {saving ? "Saving..." : "Create Agent"}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-[520px] gap-5 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-lg border border-border bg-card p-2">
          <div className="px-3 py-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Protocol
            </p>
          </div>
          <div className="flex flex-col gap-1">
            {AGENT_PROTOCOL_OPTIONS.map((protocol) => (
              <Link
                className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  form.protocol === protocol.value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                href={agentCreateHref(protocol.value)}
                key={protocol.value}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {protocol.value === "acp" ? (
                    <Terminal className="size-4 shrink-0" />
                  ) : (
                    <Bot className="size-4 shrink-0" />
                  )}
                  <span className="truncate">{protocol.label}</span>
                </span>
                <Badge variant="secondary">{protocol.value}</Badge>
              </Link>
            ))}
          </div>
        </aside>

        <Card className="min-w-0">
          <CardHeader className="border-b border-border">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle>{selectedProtocol.label}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedProtocol.summary}
                </p>
              </div>
              <Badge variant="outline">{selectedProtocol.value}</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-5">
            <AgentConfigFields
              form={form}
              onChange={(nextForm) =>
                setForm({
                  ...nextForm,
                  protocol: routeProtocol,
                })
              }
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function isSupportedAgentProtocol(value: string): value is AgentProtocol {
  return value === "a2a" || value === "acp";
}
