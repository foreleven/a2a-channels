"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CircleDashed,
  Pencil,
  Plus,
  Power,
  RadioTower,
  Trash2,
} from "lucide-react";

import type { AgentConfig, ChannelBinding, RuntimeChannelStatus } from "@/lib/api";
import {
  createChannel,
  deleteChannel,
  listAgents,
  listChannels,
  listRuntimeChannelStatuses,
  updateChannel,
} from "@/lib/api";
import { ChannelStatusEventStream } from "@/lib/channel-status";
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
import { Textarea } from "@/components/ui/textarea";

const CHANNEL_OPTIONS = [
  { value: "feishu", label: "Feishu / Lark" },
  { value: "discord", label: "Discord" },
  { value: "slack", label: "Slack" },
  { value: "telegram", label: "Telegram" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "wechat", label: "WeChat / Weixin" },
  { value: "qqbot", label: "QQ Bot" },
] as const;

const CHANNEL_CONFIG_TEMPLATES: Record<string, Record<string, unknown>> = {
  feishu: {
    appId: "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    allowFrom: ["*"],
  },
  discord: {
    botToken: "",
    allowFrom: ["*"],
  },
  slack: {
    botToken: "",
    appToken: "",
    signingSecret: "",
    allowFrom: ["*"],
  },
  telegram: {
    botToken: "",
    allowFrom: ["*"],
  },
  whatsapp: {
    allowFrom: ["*"],
  },
  wechat: {},
  qqbot: {
    appId: "",
    token: "",
    secret: "",
    allowFrom: ["*"],
  },
};

interface FormState {
  name: string;
  channelType: string;
  accountId: string;
  agentId: string;
  enabled: boolean;
  channelConfigJson: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  channelType: "feishu",
  accountId: "default",
  agentId: "",
  enabled: true,
  channelConfigJson: stringifyConfig(CHANNEL_CONFIG_TEMPLATES["feishu"]),
};

class ChannelFormMapper {
  toPayload(form: FormState): Omit<ChannelBinding, "id" | "createdAt"> {
    return {
      name: form.name,
      channelType: form.channelType,
      accountId: form.accountId,
      agentId: form.agentId,
      enabled: form.enabled,
      channelConfig: this.parseConfig(form.channelConfigJson),
    };
  }

  fromBinding(binding: ChannelBinding): FormState {
    return {
      name: binding.name,
      channelType: binding.channelType,
      accountId: binding.accountId,
      agentId: binding.agentId,
      enabled: binding.enabled,
      channelConfigJson: stringifyConfig(binding.channelConfig),
    };
  }

  private parseConfig(rawConfig: string): Record<string, unknown> {
    const parsed = JSON.parse(rawConfig || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Channel config must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }
}

const formMapper = new ChannelFormMapper();

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelBinding[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [statuses, setStatuses] = useState<RuntimeChannelStatus[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const statusStream = useMemo(() => new ChannelStatusEventStream(), []);
  const statusesByBindingId = useMemo(
    () => new Map(statuses.map((status) => [status.bindingId, status])),
    [statuses],
  );

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [channelData, agentData] = await Promise.all([
        listChannels(),
        listAgents(),
      ]);
      setChannels(channelData);
      setAgents(agentData);
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

  useEffect(() => {
    let cancelled = false;

    async function loadInitialStatuses() {
      try {
        const nextStatuses = await listRuntimeChannelStatuses();
        if (!cancelled) {
          setStatuses(nextStatuses);
          setStatusError(null);
        }
      } catch (initialError) {
        if (!cancelled) {
          setStatusError(String(initialError));
        }
      }
    }

    void loadInitialStatuses();
    statusStream.connect({
      onSnapshot: (snapshot) => {
        setStatuses(snapshot.statuses);
        setStatusError(null);
      },
      onError: (streamError) => setStatusError(streamError),
    });

    return () => {
      cancelled = true;
      statusStream.close();
    };
  }, [statusStream]);

  function openNew() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, agentId: agents[0]?.id ?? "" });
    setShowForm(true);
  }

  function updateChannelType(channelType: string) {
    setForm({
      ...form,
      channelType,
      channelConfigJson: stringifyConfig(
        CHANNEL_CONFIG_TEMPLATES[channelType] ?? {},
      ),
    });
  }

  function openEdit(binding: ChannelBinding) {
    setEditingId(binding.id);
    setForm(formMapper.fromBinding(binding));
    setShowForm(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = formMapper.toPayload(form);
      if (editingId) {
        await updateChannel(editingId, payload);
      } else {
        await createChannel(payload);
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
    if (!confirm("Delete this channel binding?")) return;
    try {
      await deleteChannel(id);
      await refresh();
    } catch (deleteError) {
      setError(String(deleteError));
    }
  }

  async function handleToggle(binding: ChannelBinding) {
    try {
      await updateChannel(binding.id, { enabled: !binding.enabled });
      await refresh();
    } catch (toggleError) {
      setError(String(toggleError));
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Channels</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Bind messaging provider accounts to registered A2A agents.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus />
          New Binding
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      <section className="flex flex-col gap-4">
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-base font-semibold">Channel Bindings</h2>
            <p className="text-sm text-muted-foreground">
              Runtime-owned routes from provider accounts to agent configs.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{channels.length} total</Badge>
            {statusError && <Badge variant="destructive">status offline</Badge>}
          </div>
        </div>

        {loading ? (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              Loading...
            </CardContent>
          </Card>
        ) : channels.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {channels.map((binding) => (
              <ChannelCard
                key={binding.id}
                agentLabel={agentLabel(binding.agentId, agents)}
                binding={binding}
                onDelete={() => handleDelete(binding.id)}
                onEdit={() => openEdit(binding)}
                onToggle={() => handleToggle(binding)}
                status={statusesByBindingId.get(binding.id)}
              />
            ))}
          </div>
        )}
      </section>

      <Dialog open={showForm}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingId ? "Edit Channel Binding" : "New Channel Binding"}
            </DialogTitle>
            <DialogDescription>
              Store plugin-owned account settings as the OpenClaw channel config.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Support Bot"
              />
            </Field>
            <Field label="Channel Type">
              <Select
                value={form.channelType}
                onChange={(event) => updateChannelType(event.target.value)}
              >
                {CHANNEL_OPTIONS.map((channel) => (
                  <option key={channel.value} value={channel.value}>
                    {channel.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Account ID">
              <Input
                value={form.accountId}
                onChange={(event) =>
                  setForm({ ...form, accountId: event.target.value })
                }
                placeholder="default"
              />
            </Field>
            <Field label="Agent">
              <Select
                value={form.agentId}
                onChange={(event) =>
                  setForm({ ...form, agentId: event.target.value })
                }
              >
                <option value="" disabled>
                  Select an agent
                </option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field className="sm:col-span-2" label="Channel Config">
              <Textarea
                className="min-h-44 font-mono text-xs"
                value={form.channelConfigJson}
                onChange={(event) =>
                  setForm({ ...form, channelConfigJson: event.target.value })
                }
                spellCheck={false}
              />
            </Field>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) =>
                setForm({ ...form, enabled: event.target.checked })
              }
            />
            Enabled
          </label>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !form.agentId || !form.name || !form.accountId}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function agentLabel(agentId: string, agents: AgentConfig[]) {
  const agent = agents.find((candidate) => candidate.id === agentId);
  return agent ? `${agent.name} (${agent.url})` : agentId;
}

function ChannelCard({
  agentLabel,
  binding,
  onDelete,
  onEdit,
  onToggle,
  status,
}: {
  agentLabel: string;
  binding: ChannelBinding;
  onDelete(): void;
  onEdit(): void;
  onToggle(): void;
  status?: RuntimeChannelStatus;
}) {
  const displayStatus = status ?? fallbackStatus(binding);
  const statusView = describeStatus(displayStatus);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{binding.name}</CardTitle>
            <CardDescription className="mt-1 truncate">
              {channelLabel(binding.channelType)} / {binding.accountId}
            </CardDescription>
          </div>
          <Badge variant={binding.enabled ? "success" : "secondary"}>
            {binding.enabled ? "enabled" : "disabled"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {statusView.icon}
              {statusView.label}
            </div>
            <Badge variant={statusView.badgeVariant}>{displayStatus.status}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{statusView.detail}</p>
          {displayStatus.updatedAt && (
            <p className="mt-2 text-xs text-muted-foreground">
              Updated {new Date(displayStatus.updatedAt).toLocaleString()}
            </p>
          )}
          {displayStatus.error && (
            <p className="mt-2 break-words text-xs text-destructive">
              {displayStatus.error}
            </p>
          )}
        </div>

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <Info label="Agent" value={agentLabel} />
          <Info label="Ownership" value={statusView.ownership} />
          <Info label="Config" value={summarizeConfig(binding.channelConfig)} />
          <Info label="Lease" value={displayStatus.leaseHeld ? "held" : "none"} />
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button
            aria-label={
              binding.enabled ? `Disable ${binding.name}` : `Enable ${binding.name}`
            }
            onClick={onToggle}
            size="icon"
            variant="outline"
          >
            <Power />
          </Button>
          <Button
            aria-label={`Edit ${binding.name}`}
            onClick={onEdit}
            size="icon"
            variant="outline"
          >
            <Pencil />
          </Button>
          <Button
            aria-label={`Delete ${binding.name}`}
            onClick={onDelete}
            size="icon"
            variant="outline"
          >
            <Trash2 />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm">{value || "-"}</p>
    </div>
  );
}

function fallbackStatus(binding: ChannelBinding): RuntimeChannelStatus {
  return {
    bindingId: binding.id,
    mode: "local",
    ownership: binding.enabled ? "unassigned" : "disabled",
    status: binding.enabled ? "unknown" : "idle",
    leaseHeld: false,
  };
}

function describeStatus(status: RuntimeChannelStatus): {
  badgeVariant: "success" | "secondary" | "destructive" | "outline";
  detail: string;
  icon: React.ReactNode;
  label: string;
  ownership: string;
} {
  if (status.ownership === "disabled") {
    return {
      badgeVariant: "secondary",
      detail: "This binding is disabled, so no runtime connection is expected.",
      icon: <CircleDashed className="size-4" />,
      label: "Disabled",
      ownership: "Disabled",
    };
  }

  if (status.ownership === "cluster-lease") {
    return {
      badgeVariant: "outline",
      detail:
        "A cluster lease is held by another node; this node cannot report the remote connection edge.",
      icon: <Activity className="size-4" />,
      label: "Owned in cluster",
      ownership: "Other cluster node",
    };
  }

  if (status.status === "connected") {
    return {
      badgeVariant: "success",
      detail: `Connected on ${status.ownerDisplayName ?? status.ownerNodeId ?? "this node"}.`,
      icon: <Activity className="size-4" />,
      label: "Connected",
      ownership: "Current node",
    };
  }

  if (status.status === "error") {
    return {
      badgeVariant: "destructive",
      detail: "The local runtime hit a connection error and may retry.",
      icon: <Activity className="size-4" />,
      label: "Error",
      ownership: status.ownership === "local" ? "Current node" : "Unassigned",
    };
  }

  if (status.status === "connecting") {
    return {
      badgeVariant: "outline",
      detail: "The local runtime is starting the channel connection.",
      icon: <Activity className="size-4" />,
      label: "Connecting",
      ownership: "Current node",
    };
  }

  return {
    badgeVariant: "secondary",
    detail:
      status.mode === "cluster"
        ? "No cluster lease is visible for this binding yet."
        : "The local runtime has not attached this binding yet.",
    icon: <CircleDashed className="size-4" />,
    label: "Not connected",
    ownership: status.ownership === "local" ? "Current node" : "Unassigned",
  };
}

function Field({
  className,
  label,
  children,
}: {
  className?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className ? `space-y-2 ${className}` : "space-y-2"}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function channelLabel(channelType: string): string {
  return (
    CHANNEL_OPTIONS.find((channel) => channel.value === channelType)?.label ??
    channelType
  );
}

function stringifyConfig(config: Record<string, unknown> | undefined): string {
  return JSON.stringify(config ?? {}, null, 2);
}

function summarizeConfig(config: Record<string, unknown>): string {
  const keys = Object.keys(config).filter((key) => config[key] !== "");
  if (keys.length === 0) {
    return "{}";
  }
  return keys.slice(0, 3).join(", ") + (keys.length > 3 ? "..." : "");
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border p-10 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-accent text-accent-foreground">
        <RadioTower className="size-4" />
      </div>
      <p className="text-sm font-medium">No channel bindings</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Create a binding after at least one agent is registered.
      </p>
    </div>
  );
}
