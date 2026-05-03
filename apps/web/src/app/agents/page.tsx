"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Pencil, Plus, Trash2 } from "lucide-react";

import type { AgentConfig } from "@/lib/api";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const EMPTY_FORM = { name: "", url: "", description: "" };
type FormState = typeof EMPTY_FORM;

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
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(agent: AgentConfig) {
    setEditingId(agent.id);
    setForm({
      name: agent.name,
      url: agent.url,
      description: agent.description ?? "",
    });
    setShowForm(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        url: form.url,
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
            Register A2A-compatible targets that channel bindings can route to.
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
                  <TableHead>URL</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-28 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell className="max-w-sm truncate font-mono text-xs text-muted-foreground">
                      {agent.url}
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
              Configure the JSON-RPC endpoint used by the gateway transport.
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
            <Field label="URL">
              <Input
                value={form.url}
                onChange={(event) =>
                  setForm({ ...form, url: event.target.value })
                }
                placeholder="http://localhost:3001"
              />
            </Field>
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
            <Button onClick={handleSave} disabled={saving}>
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
