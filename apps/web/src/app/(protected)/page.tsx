"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock,
  MessageSquareText,
  Plus,
  RadioTower,
  Unplug,
} from "lucide-react";

import type { DashboardSnapshot } from "@/lib/dashboard";
import { DashboardEventStream, DashboardSnapshotFactory } from "@/lib/dashboard";
import { listAgents, listChannels, listMessages } from "@/lib/api";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export default function DashboardPage() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);

  const stream = useMemo(() => new DashboardEventStream(), []);

  useEffect(() => {
    let cancelled = false;
    const factory = new DashboardSnapshotFactory();

    async function loadInitialSnapshot() {
      try {
        const [channels, agents, messages] = await Promise.all([
          listChannels(),
          listAgents(),
          listMessages(),
        ]);
        if (!cancelled) {
          setSnapshot(factory.create(channels, agents, messages));
        }
      } catch (initialError) {
        if (!cancelled) {
          setError(
            initialError instanceof Error
              ? initialError.message
              : String(initialError),
          );
        }
      }
    }

    void loadInitialSnapshot();
    stream.connect({
      onOpen: () => {
        setStatus("live");
        setError(null);
      },
      onSnapshot: (nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setStatus("live");
        setError(null);
      },
      onError: (nextError) => {
        setStatus("offline");
        setError(nextError);
      },
    });

    return () => {
      cancelled = true;
      stream.close();
    };
  }, [stream]);

  const totals = snapshot?.totals;
  const enabledRatio =
    totals && totals.channels > 0
      ? Math.round((totals.enabledChannels / totals.channels) * 100)
      : 0;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant={status === "live" ? "success" : "secondary"}>
              {status === "live" ? "Live" : status === "offline" ? "Offline" : "Connecting"}
            </Badge>
            {snapshot && (
              <span className="text-xs text-muted-foreground">
                Updated {new Date(snapshot.generatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <h1 className="text-2xl font-semibold tracking-normal">
            Gateway Dashboard
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational view of channel bindings, agent inventory, and routing
            coverage.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/agents">
              <Bot />
              Manage Agents
            </Link>
          </Button>
          <Button asChild>
            <Link href="/channels">
              <Plus />
              New Binding
            </Link>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <Unplug />
          <AlertDescription>
            {error}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={<RadioTower className="size-4" />}
          label="Channel Bindings"
          value={totals?.channels ?? 0}
          detail={`${totals?.enabledChannels ?? 0} enabled`}
        />
        <MetricCard
          icon={<CheckCircle2 className="size-4" />}
          label="Enabled Coverage"
          value={`${enabledRatio}%`}
          detail={`${totals?.disabledChannels ?? 0} disabled`}
        />
        <MetricCard
          icon={<Bot className="size-4" />}
          label="Agents"
          value={totals?.agents ?? 0}
          detail={`${totals?.unassignedAgents ?? 0} unassigned`}
        />
        <MetricCard
          icon={<Activity className="size-4" />}
          label="Recent Messages"
          value={totals?.messages ?? 0}
          detail={`${totals?.inboundMessages ?? 0} in / ${totals?.outboundMessages ?? 0} out`}
        />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Recent Bindings</CardTitle>
            <CardDescription>
              Latest channel-to-agent routes known to the gateway.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {snapshot && snapshot.recentBindings.length > 0 ? (
              snapshot.recentBindings.map((binding) => (
                <div
                  key={binding.id}
                  className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {binding.name}
                      </span>
                      <Badge variant={binding.enabled ? "success" : "secondary"}>
                        {binding.enabled ? "enabled" : "disabled"}
                      </Badge>
                    </div>
                    <p className="mt-1 break-all text-xs text-muted-foreground sm:truncate">
                      {binding.channelType} / {binding.accountId} {"->"}{" "}
                      {binding.agentId}
                    </p>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    {new Date(binding.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))
            ) : (
              <EmptyPanel
                title="No bindings yet"
                description="Create a channel binding to route provider messages into an A2A agent."
              />
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Provider Mix</CardTitle>
            <CardDescription>
              Binding count grouped by channel provider.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {snapshot && snapshot.channelTypes.length > 0 ? (
              snapshot.channelTypes.map((type) => (
                <div key={type.name} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium capitalize">{type.name}</span>
                    <span className="text-muted-foreground">{type.count}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted">
                    <div
                      className="h-2 rounded-full bg-primary"
                      style={{
                        width: `${Math.max(
                          8,
                          (type.count / Math.max(snapshot.totals.channels, 1)) *
                            100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <EmptyPanel
                title="No provider data"
                description="Provider distribution appears after bindings are configured."
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Message Monitor</CardTitle>
          <CardDescription>
            Recent channel messages persisted by the gateway relay path.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {snapshot && snapshot.recentMessages.length > 0 ? (
            snapshot.recentMessages.map((message) => (
              <div
                key={message.id ?? `${message.channelBindingId}-${message.createdAt}`}
                className="grid gap-3 rounded-md border border-border p-3 md:grid-cols-[140px_1fr_180px]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <MessageSquareText className="size-4 shrink-0 text-muted-foreground" />
                  <Badge
                    variant={
                      message.direction === "input" ? "outline" : "secondary"
                    }
                  >
                    {message.direction === "input" ? "inbound" : "outbound"}
                  </Badge>
                </div>
                <div className="min-w-0">
                  <p className="line-clamp-2 break-words text-sm">
                    {message.content || "(empty message)"}
                  </p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {message.channelType} / {message.accountId} /{" "}
                    {message.sessionKey}
                  </p>
                </div>
                <div className="flex items-start justify-start md:justify-end">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    {formatTimestamp(message.createdAt)}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <EmptyPanel
              title="No messages yet"
              description="Messages appear here after a connected channel receives or sends relay traffic."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-4 flex size-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
          {icon}
        </div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-2 text-3xl font-semibold tracking-normal">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function EmptyPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty className="border p-6 md:p-6">
      <EmptyHeader>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "unknown";
  return new Date(value).toLocaleString();
}
