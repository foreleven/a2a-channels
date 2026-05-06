"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Bot, Pencil, Plus, Trash2 } from "lucide-react";

import type { AgentConfig } from "@/lib/api";
import { deleteAgent, listAgents, updateAgent } from "@/lib/api";
import {
  AgentConfigFormMapper,
  createAgentFormState,
  type AgentConfigFormState,
} from "@/lib/agent-config-form";
import { AgentConfigFields } from "@/components/agent-config-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const formMapper = new AgentConfigFormMapper();

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentConfigFormState>(() =>
    createAgentFormState(),
  );
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

  function openEdit(agent: AgentConfig) {
    setEditingId(agent.id);
    setForm(formMapper.fromAgent(agent));
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await updateAgent(editingId, formMapper.toPayload(form));
      setEditingId(null);
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
        <Button asChild>
          <Link href="/agents/new">
            <Plus />
            New Agent
          </Link>
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
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
            <div className="flex flex-col gap-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
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
                        {formMapper.transportLabel(agent.config)
                          ? `:${formMapper.transportLabel(agent.config)}`
                          : ""}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-sm truncate font-mono text-xs text-muted-foreground">
                      {formMapper.describeTarget(agent)}
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

      <Dialog
        open={Boolean(editingId)}
        onOpenChange={(open) => {
          if (!open) setEditingId(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Agent</DialogTitle>
            <DialogDescription>
              Configure the target used by the gateway transport.
            </DialogDescription>
          </DialogHeader>
          <AgentConfigFields form={form} onChange={setForm} />
          <Separator className="my-6" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
            <Button
              disabled={saving || !formMapper.canSubmit(form)}
              onClick={handleSave}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
        <Bot className="size-4" />
        </EmptyMedia>
        <EmptyTitle>No agents configured</EmptyTitle>
        <EmptyDescription>
        Add an agent before creating channel bindings.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
