"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Pencil, Plus, Trash2 } from "lucide-react";

import type {
  AgentConfig,
  AgentProtocol,
  AgentProtocolConfig,
} from "@/lib/api";
import {
  createAgent,
  deleteAgent,
  listAgents,
  updateAgent,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const DEFAULT_PROTOCOL: AgentProtocol = "a2a";
type FormState = {
  name: string;
  url: string;
  protocol: AgentProtocol;
  command: string;
  args: string;
  description: string;
};
const EMPTY_FORM: FormState = {
  name: "",
  url: "",
  protocol: DEFAULT_PROTOCOL,
  command: "",
  args: "",
  description: "",
};
const SUPPORTED_PROTOCOLS = [
  { value: "a2a", label: "A2A JSON-RPC" },
  { value: "acp", label: "ACP" },
];

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setAgents(await listAgents());
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  function openNew() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, protocol: DEFAULT_PROTOCOL });
    setShowForm(true);
  }

  function openEdit(agent: AgentConfig) {
    setEditingId(agent.id);
    setForm({
      name: agent.name,
      url: getConfigUrl(agent.config),
      protocol: agent.protocol,
      command: getConfigCommand(agent.config),
      args: getConfigArgs(agent.config),
      description: agent.description ?? "",
    });
    setShowForm(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const config = buildAgentConfig(form);
      const payload = {
        name: form.name,
        protocol: form.protocol,
        config,
        description: form.description || undefined,
      };
      if (editingId) {
        await updateAgent(editingId, payload);
      } else {
        await createAgent(payload);
      }
      setShowForm(false);
      await refresh();
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this agent?")) return;
    try {
      await deleteAgent(id);
      await refresh();
    } catch (deleteError) {
      setError(String(deleteError));
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Register agent targets that channel bindings can route to.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus />
          New Agent
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Agent Configs</CardTitle>
              <CardDescription>
                Endpoint inventory available to channel bindings.
              </CardDescription>
            </div>
            <Badge variant="secondary">{agents.length} total</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : agents.length === 0 ? (
            <EmptyState />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-28 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {agent.protocol}
                        {getConfigTransportLabel(agent.config)
                          ? `:${getConfigTransportLabel(agent.config)}`
                          : ""}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-sm truncate font-mono text-xs text-muted-foreground">
                      {describeAgentTarget(agent)}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {agent.description ?? "-"}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          aria-label={`Edit ${agent.name}`}
                          onClick={() => openEdit(agent)}
                          size="icon"
                          variant="outline"
                        >
                          <Pencil />
                        </Button>
                        <Button
                          aria-label={`Delete ${agent.name}`}
                          onClick={() => handleDelete(agent.id)}
                          size="icon"
                          variant="outline"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showForm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Agent" : "New Agent"}</DialogTitle>
            <DialogDescription>
              Configure the target used by the gateway transport.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Echo Agent"
              />
            </Field>
            <Field label="Protocol">
              <Select
                value={form.protocol}
                onChange={(event) =>
                  setForm({
                    ...form,
                    protocol: parseAgentProtocol(event.target.value),
                  })
                }
              >
                {SUPPORTED_PROTOCOLS.map((protocol) => (
                  <option key={protocol.value} value={protocol.value}>
                    {protocol.label}
                  </option>
                ))}
              </Select>
            </Field>
            {form.protocol === "acp" && (
              <>
                <Field label="Command">
                  <Input
                    value={form.command}
                    onChange={(event) =>
                      setForm({ ...form, command: event.target.value })
                    }
                    placeholder="npx"
                  />
                </Field>
                <Field label="Args">
                  <Input
                    value={form.args}
                    onChange={(event) =>
                      setForm({ ...form, args: event.target.value })
                    }
                    placeholder="@zed-industries/codex-acp"
                  />
                </Field>
              </>
            )}
            {form.protocol !== "acp" && (
              <Field label="URL">
                <Input
                  value={form.url}
                  onChange={(event) =>
                    setForm({ ...form, url: event.target.value })
                  }
                  placeholder="http://localhost:3001"
                />
              </Field>
            )}
            <Field label="Description">
              <Textarea
                rows={3}
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
              />
            </Field>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !canSave(form)}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border p-10 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-accent text-accent-foreground">
        <Bot className="size-4" />
      </div>
      <p className="text-sm font-medium">No agents configured</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Add an agent before creating channel bindings.
      </p>
    </div>
  );
}

function buildAgentConfig(form: FormState): AgentProtocolConfig {
  if (form.protocol === "a2a") return { url: form.url };
  return {
    transport: "stdio",
    command: form.command,
    args: splitArgs(form.args),
  };
}

function canSave(form: FormState): boolean {
  if (!form.name.trim()) return false;
  if (form.protocol === "acp") {
    return Boolean(form.command.trim());
  }

  return Boolean(form.url.trim());
}

function describeAgentTarget(agent: AgentConfig): string {
  const config = agent.config;
  if ("transport" in config) {
    return buildCommandLine(config.command, getConfigArgs(config));
  }
  return config.url;
}

function getConfigUrl(config: AgentProtocolConfig): string {
  return "url" in config ? config.url : "";
}

function getConfigTransportLabel(config: AgentProtocolConfig): string {
  return "transport" in config ? config.transport : "";
}

function getConfigCommand(config: AgentProtocolConfig): string {
  return "transport" in config ? config.command : "";
}

function getConfigArgs(config: AgentProtocolConfig): string {
  return "transport" in config ? (config.args ?? []).join(" ") : "";
}

function splitArgs(value: string): string[] {
  return value
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildCommandLine(command: string, args: string): string {
  return [command, args].filter(Boolean).join(" ").trim();
}

function parseAgentProtocol(value: string): AgentProtocol {
  return value === "acp" ? "acp" : "a2a";
}
