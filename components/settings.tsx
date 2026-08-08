"use client";

import { useCallback, useEffect, useState } from "react";

interface ProviderView {
  kind: string;
  baseUrl?: string;
  model: string;
  supportsThinking: boolean;
  hasKey: boolean;
  keyHint: string | null;
}

interface AgentView {
  id: string;
  name: string;
  description: string;
  canWrite: boolean;
  allow: string[];
  maxIterations: number;
  model?: { kind?: string; baseUrl?: string; model?: string };
}

const KINDS = [
  { id: "anthropic", label: "Anthropic", hint: "api.anthropic.com" },
  { id: "anthropic-compatible", label: "Anthropic-compatible", hint: "GLM / Z.ai, LiteLLM, proxies" },
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "Ollama, vLLM, OpenRouter" },
];

const field = {
  fontSize: 12,
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "rgba(10,14,22,0.5)",
  width: "100%",
} as const;

const label = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-faint)",
  display: "block",
  marginBottom: 3,
} as const;

/**
 * Model configuration.
 *
 * The key never comes back from the server — only a hint — so an empty field
 * means "leave it alone", not "clear it". Test sends a real request, because
 * a configuration that looks right and doesn't work is the expensive kind.
 */
export function ModelPanel() {
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/model");
    if (!res.ok) return;
    const data = (await res.json()) as { provider: ProviderView };
    setProvider(data.provider);
    setDraft({
      kind: data.provider.kind,
      baseUrl: data.provider.baseUrl ?? "",
      model: data.provider.model,
      apiKey: "",
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(test: boolean) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            kind: draft.kind,
            baseUrl: draft.baseUrl || undefined,
            model: draft.model,
            apiKey: draft.apiKey || undefined,
          },
          test,
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        reply?: string;
        error?: string;
        model?: string;
        provider: ProviderView;
      };
      setProvider(data.provider);
      setDraft((d) => ({ ...d, apiKey: "" }));
      if (test) {
        setStatus(
          data.ok
            ? { ok: true, message: `${data.model} replied: "${data.reply}"` }
            : { ok: false, message: data.error ?? "Unknown error" },
        );
      } else {
        setStatus({ ok: true, message: "Saved." });
      }
    } catch (err) {
      setStatus({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!provider) return <div style={{ color: "var(--text-faint)" }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <div>
        <label style={label}>Provider</label>
        <select
          value={draft.kind}
          onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
          style={{ ...field, color: "var(--text)" }}
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label} — {k.hint}
            </option>
          ))}
        </select>
      </div>

      {draft.kind !== "anthropic" && (
        <div>
          <label style={label}>Base URL</label>
          <input
            value={draft.baseUrl}
            placeholder="https://api.z.ai/api/anthropic"
            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            style={field}
          />
        </div>
      )}

      <div>
        <label style={label}>Model</label>
        <input
          value={draft.model}
          placeholder="glm-4.6"
          onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          style={field}
        />
      </div>

      <div>
        <label style={label}>
          API key {provider.hasKey && <span style={{ color: "var(--ok)" }}>· set ({provider.keyHint})</span>}
        </label>
        <input
          type="password"
          value={draft.apiKey}
          placeholder={provider.hasKey ? "Leave blank to keep current key" : "Paste your key"}
          onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
          style={field}
        />
      </div>

      <div style={{ display: "flex", gap: 7 }}>
        <button disabled={busy} onClick={() => save(false)} style={{ fontSize: 12 }}>
          Save
        </button>
        <button disabled={busy} onClick={() => save(true)} style={{ fontSize: 12 }}>
          {busy ? "Testing…" : "Save & test"}
        </button>
      </div>

      {status && (
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            color: status.ok ? "var(--ok)" : "var(--danger)",
            wordBreak: "break-word",
          }}
        >
          {status.message}
        </p>
      )}
    </div>
  );
}

/** Agent roster — what JARVIS can delegate to, and where each one runs. */
export function AgentPanel() {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/model");
    if (res.ok) setAgents(((await res.json()) as { agents: AgentView[] }).agents);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveAgent(id: string) {
    await fetch("/api/model", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: {
          id,
          model: draft.model
            ? { kind: draft.kind || "openai-compatible", baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey || undefined }
            : undefined,
          canWrite: draft.canWrite === "true",
        },
      }),
    });
    setEditing(null);
    await load();
  }

  if (!agents) return <div style={{ color: "var(--text-faint)" }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {agents.map((agent) => (
        <div key={agent.id} style={{ borderBottom: "1px solid rgba(120,150,200,0.07)", paddingBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <strong style={{ fontSize: 12.5 }}>{agent.name}</strong>
            <span
              style={{
                fontSize: 9.5,
                padding: "1px 5px",
                borderRadius: 4,
                border: `1px solid ${agent.canWrite ? "var(--warn)" : "var(--ok)"}`,
                color: agent.canWrite ? "var(--warn)" : "var(--ok)",
              }}
            >
              {agent.canWrite ? "can write" : "read-only"}
            </span>
            <button
              onClick={() => {
                setEditing(editing === agent.id ? null : agent.id);
                setDraft({
                  kind: agent.model?.kind ?? "openai-compatible",
                  baseUrl: agent.model?.baseUrl ?? "",
                  model: agent.model?.model ?? "",
                  apiKey: "",
                  canWrite: String(agent.canWrite),
                });
              }}
              style={{ marginLeft: "auto", fontSize: 10, padding: "2px 7px" }}
            >
              {editing === agent.id ? "Close" : "Configure"}
            </button>
          </div>

          <p style={{ margin: "4px 0 0", fontSize: 11.5, color: "var(--text-dim)" }}>
            {agent.description}
          </p>
          <p style={{ margin: "3px 0 0", fontSize: 10.5, color: "var(--text-faint)" }}>
            {agent.model?.model ?? "inherits your model"} · {agent.allow.length || "all"} syscall
            {agent.allow.length === 1 ? "" : "s"}
          </p>

          {editing === agent.id && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 8 }}>
              <select
                value={draft.kind}
                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
                style={{ ...field, color: "var(--text)" }}
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input
                value={draft.baseUrl}
                placeholder="http://localhost:11434/v1"
                onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                style={field}
              />
              <input
                value={draft.model}
                placeholder="model name — blank to inherit yours"
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                style={field}
              />
              <input
                type="password"
                value={draft.apiKey}
                placeholder="API key (blank if the endpoint needs none)"
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                style={field}
              />
              <label style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={draft.canWrite === "true"}
                  onChange={(e) => setDraft((d) => ({ ...d, canWrite: String(e.target.checked) }))}
                  style={{ width: "auto" }}
                />
                Allow this agent to change things directly
              </label>
              <button onClick={() => saveAgent(agent.id)} style={{ fontSize: 12 }}>
                Save {agent.name}
              </button>
            </div>
          )}
        </div>
      ))}
      <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0 }}>
        Read-only agents report findings; JARVIS carries out the action, so every write still
        passes your approval card.
      </p>
    </div>
  );
}
