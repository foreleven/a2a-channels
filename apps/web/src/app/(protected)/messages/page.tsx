"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  MessageSquareText,
} from "lucide-react";

import type { AgentConfig, ChannelBinding, ChannelMessage } from "@/lib/api";
import { listAgents, listChannels, listMessages } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const LIMIT = 100;

export default function MessagesPage() {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [channels, setChannels] = useState<ChannelBinding[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filterAgentId, setFilterAgentId] = useState("");
  const [filterChannelId, setFilterChannelId] = useState("");

  const fetchMessages = useCallback(
    async (agentId?: string, channelBindingId?: string) => {
      setLoading(true);
      try {
        setError(null);
        const data = await listMessages({
          limit: LIMIT,
          agentId: agentId || undefined,
          channelBindingId: channelBindingId || undefined,
        });
        setMessages(data);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    async function loadFilters() {
      try {
        const [channelData, agentData] = await Promise.all([
          listChannels(),
          listAgents(),
        ]);
        setChannels(channelData);
        setAgents(agentData);
      } catch (err) {
        setError(String(err));
      }
    }
    void loadFilters();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        void fetchMessages(
          filterAgentId || undefined,
          filterChannelId || undefined,
        ),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [fetchMessages, filterAgentId, filterChannelId]);

  const filtered = useMemo(() => {
    if (!search.trim()) return messages;
    const q = search.toLowerCase();
    return messages.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        m.accountId.toLowerCase().includes(q) ||
        m.sessionKey.toLowerCase().includes(q) ||
        m.channelType.toLowerCase().includes(q),
    );
  }, [messages, search]);

  const inbound = filtered.filter((m) => m.direction === "input").length;
  const outbound = filtered.filter((m) => m.direction === "output").length;

  return (
    <div className="flex w-full flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">Messages</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recent channel messages relayed through the gateway.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          icon={<MessageSquareText className="size-4" />}
          label="Total"
          value={filtered.length}
        />
        <MetricCard
          icon={<ArrowDownLeft className="size-4" />}
          label="Inbound"
          value={inbound}
        />
        <MetricCard
          icon={<ArrowUpRight className="size-4" />}
          label="Outbound"
          value={outbound}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Message Log</CardTitle>
              <CardDescription>
                Filtered view of inbound and outbound relay messages.
              </CardDescription>
            </div>
            <Badge variant="secondary">{filtered.length} shown</Badge>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              className="sm:max-w-xs"
              placeholder="Search content, account, session…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              value={filterAgentId}
              onValueChange={setFilterAgentId}
            >
              <SelectTrigger className="sm:w-48">
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">All agents</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={filterChannelId}
              onValueChange={setFilterChannelId}
            >
              <SelectTrigger className="sm:w-48">
                <SelectValue placeholder="All channels" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">All channels</SelectItem>
                  {channels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.id}>
                      {ch.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <Empty className="border p-6">
              <EmptyHeader>
                <EmptyTitle className="text-sm">No messages found</EmptyTitle>
                <EmptyDescription>
                  No messages match the current filters.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-3">
              {filtered.map((message) => (
                <MessageRow
                  key={
                    message.id ??
                    `${message.channelBindingId}-${message.createdAt}`
                  }
                  message={message}
                  channelName={channelName(message.channelBindingId, channels)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MessageRow({
  message,
  channelName: bindingName,
}: {
  message: ChannelMessage;
  channelName: string;
}) {
  return (
    <div className="grid gap-3 rounded-md border border-border p-3 md:grid-cols-[140px_1fr_180px]">
      <div className="flex min-w-0 items-center gap-2">
        <MessageSquareText className="size-4 shrink-0 text-muted-foreground" />
        <Badge
          variant={message.direction === "input" ? "outline" : "secondary"}
        >
          {message.direction === "input" ? "inbound" : "outbound"}
        </Badge>
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 break-words text-sm">
          {message.content || "(empty message)"}
        </p>
        <p className="mt-1 break-all text-xs text-muted-foreground">
          {bindingName} / {message.channelType} / {message.accountId} /{" "}
          {message.sessionKey}
        </p>
      </div>
      <div className="flex items-start justify-start md:justify-end">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="size-3" />
          {message.createdAt ? new Date(message.createdAt).toLocaleString() : "unknown"}
        </span>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-4 flex size-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
          {icon}
        </div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-2 text-3xl font-semibold tracking-normal">{value}</p>
      </CardContent>
    </Card>
  );
}

function channelName(bindingId: string, channels: ChannelBinding[]): string {
  return channels.find((c) => c.id === bindingId)?.name ?? bindingId;
}
