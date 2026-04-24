"use client";

import { useEffect, useState, useCallback } from "react";
import type { AgentConfig, ChannelBinding } from "@/lib/api";
import {
  listAgents,
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Empty form state
// ---------------------------------------------------------------------------

const EMPTY_FORM = {
  name: "",
  channelType: "feishu",
  accountId: "default",
  agentId: "",
  enabled: true,
  appId: "",
  appSecret: "",
  verificationToken: "",
  encryptKey: "",
};

type FormState = typeof EMPTY_FORM;

function formToPayload(f: FormState): Omit<ChannelBinding, "id" | "createdAt"> {
  return {
    name: f.name,
    channelType: f.channelType,
    accountId: f.accountId,
    agentId: f.agentId,
    enabled: f.enabled,
    channelConfig: {
      appId: f.appId,
      appSecret: f.appSecret,
      verificationToken: f.verificationToken || undefined,
      encryptKey: f.encryptKey || undefined,
      allowFrom: ["*"],
    },
  };
}

function bindingToForm(b: ChannelBinding): FormState {
  const cfg = b.channelConfig as {
    appId?: string;
    appSecret?: string;
    verificationToken?: string;
    encryptKey?: string;
  };
  return {
    name: b.name,
    channelType: b.channelType,
    accountId: b.accountId,
    agentId: b.agentId,
    enabled: b.enabled,
    appId: cfg.appId ?? "",
    appSecret: cfg.appSecret ?? "",
    verificationToken: cfg.verificationToken ?? "",
    encryptKey: cfg.encryptKey ?? "",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelBinding[]>([]);
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
      const [channelData, agentData] = await Promise.all([
        listChannels(),
        listAgents(),
      ]);
      setChannels(channelData);
      setAgents(agentData);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openNew() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, agentId: agents[0]?.id ?? "" });
    setShowForm(true);
  }

  function openEdit(b: ChannelBinding) {
    setEditingId(b.id);
    setForm(bindingToForm(b));
    setShowForm(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (editingId) {
        await updateChannel(editingId, formToPayload(form));
      } else {
        await createChannel(formToPayload(form));
      }
      setShowForm(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this channel binding?")) return;
    try {
      await deleteChannel(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleToggle(b: ChannelBinding) {
    try {
      await updateChannel(b.id, { enabled: !b.enabled });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Channel Bindings</h1>
        <button
          onClick={openNew}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + New Binding
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : channels.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          No channel bindings yet. Click &ldquo;+ New Binding&rdquo; to add one.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {channels.map((b) => (
            <div key={b.id} className="flex items-center gap-4 px-5 py-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{b.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {b.channelType}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      b.enabled
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {b.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  account: {b.accountId} · agent: {b.agentId}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleToggle(b)}
                  className="text-xs px-3 py-1 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                >
                  {b.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => openEdit(b)}
                  className="text-xs px-3 py-1 rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(b.id)}
                  className="text-xs px-3 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
            <h2 className="text-lg font-semibold mb-5">
              {editingId ? "Edit Channel Binding" : "New Channel Binding"}
            </h2>

            <div className="space-y-4">
              <Field label="Name">
                <input
                  className={input}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="My Feishu Bot"
                />
              </Field>
              <Field label="Channel Type">
                <select
                  className={input}
                  value={form.channelType}
                  onChange={(e) =>
                    setForm({ ...form, channelType: e.target.value })
                  }
                >
                  <option value="feishu">Feishu / Lark</option>
                </select>
              </Field>
              <Field label="Account ID">
                <input
                  className={input}
                  value={form.accountId}
                  onChange={(e) =>
                    setForm({ ...form, accountId: e.target.value })
                  }
                  placeholder="default"
                />
              </Field>
              <Field label="Agent">
                <select
                  className={input}
                  value={form.agentId}
                  onChange={(e) =>
                    setForm({ ...form, agentId: e.target.value })
                  }
                >
                  <option value="" disabled>
                    Select an agent
                  </option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.url})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="App ID">
                <input
                  className={input}
                  value={form.appId}
                  onChange={(e) => setForm({ ...form, appId: e.target.value })}
                  placeholder="cli_xxxx"
                />
              </Field>
              <Field label="App Secret">
                <input
                  className={input}
                  type="password"
                  value={form.appSecret}
                  onChange={(e) =>
                    setForm({ ...form, appSecret: e.target.value })
                  }
                  placeholder="••••••••"
                />
              </Field>
              <Field label="Verification Token (optional)">
                <input
                  className={input}
                  value={form.verificationToken}
                  onChange={(e) =>
                    setForm({ ...form, verificationToken: e.target.value })
                  }
                />
              </Field>
              <Field label="Encrypt Key (optional)">
                <input
                  className={input}
                  value={form.encryptKey}
                  onChange={(e) =>
                    setForm({ ...form, encryptKey: e.target.value })
                  }
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }
                />
                Enabled
              </label>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const input =
  "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
