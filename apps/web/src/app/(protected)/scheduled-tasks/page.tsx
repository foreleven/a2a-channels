"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import type { ChannelBinding, ScheduledJob } from "@/lib/api";
import {
  createScheduledJob,
  deleteScheduledJob,
  listChannels,
  listScheduledJobs,
  updateScheduledJob,
} from "@/lib/api";
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
import {
  Field as ShadcnField,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Textarea } from "@/components/ui/textarea";

interface JobFormState {
  name: string;
  channelBindingId: string;
  sessionKey: string;
  prompt: string;
  cronExpression: string;
}

const EMPTY_FORM: JobFormState = {
  name: "",
  channelBindingId: "",
  sessionKey: "",
  prompt: "",
  cronExpression: "0 9 * * *",
};

export default function ScheduledTasksPage() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [channels, setChannels] = useState<ChannelBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<JobFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [jobData, channelData] = await Promise.all([
        listScheduledJobs(),
        listChannels(),
      ]);
      setJobs(jobData);
      setChannels(channelData);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!search.trim()) return jobs;
    const q = search.toLowerCase();
    return jobs.filter(
      (j) =>
        j.name.toLowerCase().includes(q) ||
        j.sessionKey.toLowerCase().includes(q) ||
        j.cronExpression.toLowerCase().includes(q) ||
        j.prompt.toLowerCase().includes(q),
    );
  }, [jobs, search]);

  async function handleCreate() {
    setSaving(true);
    try {
      await createScheduledJob({ ...form, enabled: true });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(job: ScheduledJob) {
    try {
      await updateScheduledJob(job.id, { enabled: !job.enabled });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this scheduled task?")) return;
    try {
      await deleteScheduledJob(id);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  const canSubmit =
    form.name.trim() &&
    form.channelBindingId &&
    form.sessionKey.trim() &&
    form.prompt.trim() &&
    form.cronExpression.trim();

  const activeCount = jobs.filter((j) => j.enabled).length;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">
            Scheduled Tasks
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage proactive message tasks delivered to channel sessions on a
            cron schedule.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus />
          New Task
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Task Definitions</CardTitle>
              <CardDescription>
                Cron-scheduled outbound prompts routed through channel bindings.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{jobs.length} total</Badge>
              <Badge variant="success">{activeCount} active</Badge>
            </div>
          </div>
          <div className="mt-3">
            <Input
              className="sm:max-w-xs"
              placeholder="Search tasks…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarClock className="size-4" />
                </EmptyMedia>
                <EmptyTitle>No scheduled tasks</EmptyTitle>
                <EmptyDescription>
                  Create a task to send proactive prompts on a schedule.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-28 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium">
                      <div>{job.name}</div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {job.sessionKey}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {channelName(job.channelBindingId, channels)}
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {job.cronExpression}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge variant={job.enabled ? "success" : "secondary"}>
                        {job.enabled ? "active" : "paused"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          aria-label={
                            job.enabled
                              ? `Pause ${job.name}`
                              : `Enable ${job.name}`
                          }
                          onClick={() => handleToggle(job)}
                          size="icon"
                          variant="outline"
                        >
                          {job.enabled ? (
                            <Pause className="size-4" />
                          ) : (
                            <Play className="size-4" />
                          )}
                        </Button>
                        <Button
                          aria-label={`Delete ${job.name}`}
                          onClick={() => handleDelete(job.id)}
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
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreate(false);
            setForm(EMPTY_FORM);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Scheduled Task</DialogTitle>
            <DialogDescription>
              Define a cron-scheduled prompt that will be sent to a channel
              session via the gateway.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name">
              <Input
                placeholder="Daily digest"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </FormField>
            <FormField label="Channel">
              <Select
                value={form.channelBindingId}
                onValueChange={(v) =>
                  setForm({ ...form, channelBindingId: v })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a channel" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {channels.map((ch) => (
                      <SelectItem key={ch.id} value={ch.id}>
                        {ch.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Session Key">
              <Input
                placeholder="agent:user_id:chat_id"
                value={form.sessionKey}
                onChange={(e) =>
                  setForm({ ...form, sessionKey: e.target.value })
                }
              />
            </FormField>
            <FormField label="Cron Expression">
              <Input
                placeholder="0 9 * * *"
                value={form.cronExpression}
                onChange={(e) =>
                  setForm({ ...form, cronExpression: e.target.value })
                }
              />
            </FormField>
            <FormField className="sm:col-span-2" label="Prompt">
              <Textarea
                className="min-h-24"
                placeholder="Enter the prompt to send…"
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              />
            </FormField>
          </FieldGroup>
          <Separator className="my-4" />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowCreate(false);
                setForm(EMPTY_FORM);
              }}
            >
              Cancel
            </Button>
            <Button disabled={saving || !canSubmit} onClick={handleCreate}>
              {saving ? "Creating…" : "Create"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FormField({
  className,
  label,
  children,
}: {
  className?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <ShadcnField className={className}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </ShadcnField>
  );
}

function channelName(bindingId: string, channels: ChannelBinding[]): string {
  return channels.find((c) => c.id === bindingId)?.name ?? bindingId;
}
