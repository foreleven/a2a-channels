"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  QrCode,
  RadioTower,
} from "lucide-react";

import type { AgentConfig } from "@/lib/api";
import {
  createChannel,
  listAgents,
  startChannelQrLogin,
  waitForChannelQrLogin,
} from "@/lib/api";
import {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_CONFIG_TEMPLATES,
  CHANNEL_OPTIONS,
  ChannelFormMapper,
  type FormState,
  channelCreateHref,
  channelGuide,
  channelLabel,
  normalizeChannelType,
  stringifyConfig,
  supportsQrLogin,
} from "@/lib/channel-binding-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type QrState = {
  imageUrl?: string;
  message?: string;
  sessionKey?: string;
  connectedAccountId?: string;
};

const formMapper = new ChannelFormMapper();

export default function NewChannelBindingDefaultPage() {
  return <NewChannelBindingPage initialChannelType="feishu" key="feishu" />;
}

export function NewChannelBindingPage({
  initialChannelType,
}: {
  initialChannelType: string;
}) {
  const router = useRouter();
  const routeChannelType = normalizeChannelType(initialChannelType);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [form, setForm] = useState<FormState>(() =>
    createFormState(routeChannelType),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrState, setQrState] = useState<QrState>({});
  const [error, setError] = useState<string | null>(null);

  const selectedChannel = useMemo(
    () => CHANNEL_OPTIONS.find((channel) => channel.value === form.channelType),
    [form.channelType],
  );
  const guide = useMemo(() => channelGuide(form.channelType), [form.channelType]);

  useEffect(() => {
    let cancelled = false;
    async function loadAgents() {
      try {
        const nextAgents = await listAgents();
        if (cancelled) return;
        setAgents(nextAgents);
        setForm((current) => ({
          ...current,
          agentId: current.agentId || nextAgents[0]?.id || "",
        }));
      } catch (loadError) {
        if (!cancelled) setError(String(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadAgents();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateConfigValue = useCallback(
    (key: string, value: string) => {
      setForm((current) => {
        const currentConfig = parseConfig(current.channelConfigJson);
        const nextValue =
          key === "allowFrom"
            ? value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : value;
        return {
          ...current,
          channelConfigJson: stringifyConfig({
            ...currentConfig,
            [key]: nextValue,
          }),
        };
      });
    },
    [],
  );

  async function startQr() {
    setQrLoading(true);
    setError(null);
    setQrState({});
    try {
      const result = await startChannelQrLogin(form.channelType, {
        accountId: form.accountId || undefined,
        force: true,
      });
      setQrState({
        imageUrl: result.qrDataUrl,
        message: result.message,
        sessionKey: result.sessionKey,
      });
    } catch (qrError) {
      setError(String(qrError));
    } finally {
      setQrLoading(false);
    }
  }

  async function checkQr() {
    setQrLoading(true);
    setError(null);
    try {
      const result = await waitForChannelQrLogin(form.channelType, {
        accountId: form.accountId || undefined,
        sessionKey: qrState.sessionKey,
        timeoutMs: 30_000,
      });
      setQrState((current) => ({
        ...current,
        message: result.message,
        connectedAccountId: result.accountId,
      }));
      if (result.connected && result.accountId) {
        const accountId = result.accountId;
        setForm((current) => ({
          ...current,
          accountId,
          channelConfigJson: result.channelConfig
            ? stringifyConfig({
                ...parseConfig(current.channelConfigJson),
                ...result.channelConfig,
              })
            : current.channelConfigJson,
        }));
      }
    } catch (qrError) {
      setError(String(qrError));
    } finally {
      setQrLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await createChannel(formMapper.toPayload(form));
      router.push("/channels");
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
            <Link href="/channels">
              <ArrowLeft />
              Channels
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-normal">
            New Channel Binding
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a provider and bind one account to an A2A agent.
          </p>
        </div>
        <Button
          disabled={saving || !form.name || !form.agentId || !form.accountId}
          onClick={handleSave}
        >
          {saving ? "Saving..." : "Create Binding"}
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      <div className="grid min-h-[620px] gap-5 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-lg border border-border bg-card p-2">
          <div className="px-3 py-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Channel
            </p>
          </div>
          <div className="space-y-1">
            {CHANNEL_OPTIONS.map((channel) => (
              <Link
                className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  form.channelType === channel.value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                href={channelCreateHref(channel.value)}
                key={channel.value}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <RadioTower className="size-4 shrink-0" />
                  <span className="truncate">{channel.label}</span>
                </span>
                {channel.supportsQr && <Badge variant="secondary">QR</Badge>}
              </Link>
            ))}
          </div>
        </aside>

        <Card className="min-w-0">
          <CardHeader className="border-b border-border">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle>{selectedChannel?.label ?? form.channelType}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  {supportsQrLogin(form.channelType)
                    ? "QR login can populate the channel settings before saving."
                    : "Enter the provider account configuration."}
                </p>
              </div>
              {supportsQrLogin(form.channelType) && (
                <Badge variant={qrState.connectedAccountId ? "success" : "outline"}>
                  {qrState.connectedAccountId ? "connected" : "QR login"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-6 p-5">
            {supportsQrLogin(form.channelType) && (
              <QrLoginPanel
                channelLabel={channelLabel(form.channelType)}
                loading={qrLoading}
                onCheck={checkQr}
                onStart={startQr}
                state={qrState}
              />
            )}

            <ChannelGuidePanel guide={guide} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value })
                  }
                  placeholder={`${channelLabel(form.channelType)} Bot`}
                  value={form.name}
                />
              </Field>
              <Field label="Agent">
                <Select
                  disabled={loading}
                  onChange={(event) =>
                    setForm({ ...form, agentId: event.target.value })
                  }
                  value={form.agentId}
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
              <Field label="Account ID">
                <Input
                  onChange={(event) =>
                    setForm({ ...form, accountId: event.target.value })
                  }
                  placeholder={
                    supportsQrLogin(form.channelType) ? "QR login result" : "default"
                  }
                  value={form.accountId}
                />
              </Field>
              <Field label="Enabled">
                <label className="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
                  <input
                    checked={form.enabled}
                    onChange={(event) =>
                      setForm({ ...form, enabled: event.target.checked })
                    }
                    type="checkbox"
                  />
                  Enabled
                </label>
              </Field>
            </div>

            <ChannelConfigFields
              channelType={form.channelType}
              config={parseConfig(form.channelConfigJson)}
              onChange={updateConfigValue}
            />

            <Field label="Advanced Config JSON">
              <Textarea
                className="min-h-36 font-mono text-xs"
                onChange={(event) =>
                  setForm({ ...form, channelConfigJson: event.target.value })
                }
                spellCheck={false}
                value={form.channelConfigJson}
              />
            </Field>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function QrLoginPanel({
  channelLabel,
  loading,
  onCheck,
  onStart,
  state,
}: {
  channelLabel: string;
  loading: boolean;
  onCheck(): void;
  onStart(): void;
  state: QrState;
}) {
  return (
    <div className="grid gap-4 rounded-md border border-border bg-muted/35 p-4 md:grid-cols-[220px_1fr]">
      <div className="flex aspect-square items-center justify-center rounded-md border border-border bg-background">
        {state.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt="WeChat login QR code"
            className="max-h-[190px] max-w-[190px]"
            src={state.imageUrl}
          />
        ) : (
          <QrCode className="size-12 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-col justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            {state.connectedAccountId ? (
              <CheckCircle2 className="size-4 text-emerald-600" />
            ) : (
              <QrCode className="size-4" />
            )}
            {channelLabel} QR Login
          </div>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {state.message ?? "Generate a QR code from the channel gateway."}
          </p>
          {state.connectedAccountId && (
            <p className="mt-2 break-all text-xs text-muted-foreground">
              {state.connectedAccountId}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={loading} onClick={onStart} variant="outline">
            {loading ? <Loader2 className="animate-spin" /> : <QrCode />}
            Generate QR
          </Button>
          <Button
            disabled={loading || !state.sessionKey}
            onClick={onCheck}
            variant="secondary"
          >
            {loading ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            Check Login
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChannelGuidePanel({ guide }: { guide: ReturnType<typeof channelGuide> }) {
  return (
    <div className="rounded-md border border-border bg-background p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <p className="text-sm font-medium">Configuration Guide</p>
          <p className="mt-1 text-sm text-muted-foreground">{guide.summary}</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <a href={guide.docsUrl} rel="noreferrer" target="_blank">
            Docs
          </a>
        </Button>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{guide.setup}</p>
      <ul className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        {guide.fields.map((field) => (
          <li className="rounded-md bg-muted/60 px-3 py-2" key={field}>
            {field}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChannelConfigFields({
  channelType,
  config,
  onChange,
}: {
  channelType: string;
  config: Record<string, unknown>;
  onChange(key: string, value: string): void;
}) {
  const fields = CHANNEL_CONFIG_FIELDS[channelType] ?? [];
  if (fields.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => (
        <Field key={field.key} label={field.label}>
          <Input
            onChange={(event) => onChange(field.key, event.target.value)}
            type={field.secret ? "password" : "text"}
            value={fieldValue(config[field.key])}
          />
          {field.help && (
            <p className="text-xs text-muted-foreground">{field.help}</p>
          )}
        </Field>
      ))}
    </div>
  );
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

function parseConfig(rawConfig: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawConfig || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function fieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : "";
}

function createFormState(channelType: string, agentId = ""): FormState {
  const normalizedChannelType = normalizeChannelType(channelType);
  return {
    name: "",
    channelType: normalizedChannelType,
    accountId: normalizedChannelType === "wechat" ? "" : "default",
    agentId,
    enabled: true,
    channelConfigJson: stringifyConfig(
      CHANNEL_CONFIG_TEMPLATES[normalizedChannelType] ?? {},
    ),
  };
}
