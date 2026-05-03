"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock,
  Plus,
  RadioTower,
  Unplug,
} from "lucide-react";

import type { DashboardSnapshot } from "@/lib/dashboard";
import { DashboardEventStream, DashboardSnapshotFactory } from "@/lib/dashboard";
import { listAgents, listChannels } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
        const [channels, agents] = await Promise.all([
          listChannels(),
          listAgents(),
        ]);
        if (!cancelled) {
          setSnapshot(factory.create(channels, agents));
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
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <Unplug className="size-4" />
            {error}
          </CardContent>
        </Card>
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
          label="Channel Types"
          value={snapshot?.channelTypes.length ?? 0}
          detail="Configured providers"
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
          <CardContent className="space-y-3">
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
          <CardContent className="space-y-3">
            {snapshot && snapshot.channelTypes.length > 0 ? (
              snapshot.channelTypes.map((type) => (
                <div key={type.name} className="space-y-2">
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
    <div className="rounded-md border border-dashed border-border p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
