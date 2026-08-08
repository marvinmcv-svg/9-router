"use client";

import { useState } from "react";
import type { PendingApproval } from "@/kernel/types";
import type { SystemState, TranscriptEntry } from "./useJarvis";

/** Shared panel chrome. Every window on the desktop uses this frame. */
export function Panel({
  title,
  subtitle,
  children,
  flex,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  flex?: boolean;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: flex ? 1 : undefined,
        background: "var(--bg-panel)",
        backdropFilter: "blur(20px)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.11em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
          }}
        >
          {title}
        </h2>
        {subtitle && (
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{subtitle}</span>
        )}
      </header>
      <div style={{ overflowY: "auto", padding: 14, minHeight: 0, flex: 1 }}>{children}</div>
    </section>
  );
}

const RISK_COLOR: Record<string, string> = {
  read: "var(--ok)",
  write: "var(--warn)",
  dangerous: "var(--danger)",
};

/**
 * The approval card — the single most important surface in the OS.
 *
 * It shows the *rendered* action, not the raw tool JSON, because the decision
 * being asked for is "do you want this email sent", not "is this a well-formed
 * function call".
 */
export function ApprovalQueue({
  approvals,
  onResolve,
  busy,
}: {
  approvals: PendingApproval[];
  onResolve: (decisions: { id: string; decision: "allow" | "deny"; note?: string }[]) => void;
  busy: boolean;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (!approvals.length) return null;

  return (
    <div
      style={{
        border: "1px solid var(--border-bright)",
        borderRadius: 14,
        background: "rgba(30, 44, 70, 0.55)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--warn)", fontSize: 13 }}>◆</span>
        <strong style={{ fontSize: 13 }}>
          {approvals.length === 1
            ? "JARVIS wants to do this"
            : `JARVIS wants to do ${approvals.length} things`}
        </strong>
      </div>

      {approvals.map((approval) => (
        <div
          key={approval.id}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 12,
            background: "rgba(10, 14, 22, 0.5)",
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>
              {approval.syscall}
            </code>
            <span
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: RISK_COLOR[approval.risk],
                border: `1px solid ${RISK_COLOR[approval.risk]}`,
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {approval.risk}
            </span>
          </div>

          <pre
            style={{
              margin: "0 0 10px",
              fontFamily: "var(--sans)",
              fontSize: 13,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 260,
              overflowY: "auto",
              color: "var(--text)",
            }}
          >
            {approval.preview}
          </pre>

          <input
            placeholder="Optional: why you're denying (JARVIS reads this)"
            value={notes[approval.id] ?? ""}
            onChange={(e) => setNotes((n) => ({ ...n, [approval.id]: e.target.value }))}
            style={{
              fontSize: 12,
              padding: "6px 8px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              marginBottom: 8,
              color: "var(--text-dim)",
            }}
          />

          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={busy}
              onClick={() => onResolve([{ id: approval.id, decision: "allow" }])}
              style={{ borderColor: "var(--ok)", color: "var(--ok)" }}
            >
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() =>
                onResolve([
                  { id: approval.id, decision: "deny", note: notes[approval.id] || undefined },
                ])
              }
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              Deny
            </button>
          </div>
        </div>
      ))}

      {approvals.length > 1 && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={busy}
            onClick={() => onResolve(approvals.map((a) => ({ id: a.id, decision: "allow" as const })))}
          >
            Approve all {approvals.length}
          </button>
          <button
            disabled={busy}
            onClick={() => onResolve(approvals.map((a) => ({ id: a.id, decision: "deny" as const })))}
          >
            Deny all
          </button>
        </div>
      )}
    </div>
  );
}

/** One line of the transcript. */
export function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "14px 0" }}>
        <div
          style={{
            maxWidth: "76%",
            background: "var(--accent-dim)",
            border: "1px solid rgba(78, 163, 255, 0.3)",
            borderRadius: "12px 12px 3px 12px",
            padding: "9px 13px",
            whiteSpace: "pre-wrap",
          }}
        >
          {entry.text}
        </div>
      </div>
    );
  }

  if (entry.kind === "thinking") {
    return (
      <details style={{ margin: "10px 0", color: "var(--text-faint)", fontSize: 12.5 }}>
        <summary style={{ cursor: "pointer", listStyle: "none" }}>
          <span style={{ opacity: 0.75 }}>◇ reasoning</span>
        </summary>
        <div
          style={{
            marginTop: 6,
            paddingLeft: 12,
            borderLeft: "1px solid var(--border)",
            whiteSpace: "pre-wrap",
            fontStyle: "italic",
          }}
        >
          {entry.text}
        </div>
      </details>
    );
  }

  if (entry.kind === "syscall") {
    const { name, ok, running } = entry.syscall ?? { name: "?", running: false };
    const color = running ? "var(--accent)" : ok ? "var(--text-faint)" : "var(--danger)";
    return (
      <div
        style={{
          margin: "8px 0",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color,
          display: "flex",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <span>{running ? "◐" : ok ? "✓" : "✕"}</span>
        <span style={{ color: "var(--accent)", flexShrink: 0 }}>{name}</span>
        <span
          style={{
            color: "var(--text-faint)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.text}
        </span>
      </div>
    );
  }

  if (entry.kind === "error") {
    return (
      <div
        style={{
          margin: "10px 0",
          padding: "9px 12px",
          border: "1px solid var(--danger)",
          borderRadius: 8,
          color: "var(--danger)",
          fontSize: 13,
        }}
      >
        {entry.text}
      </div>
    );
  }

  if (entry.kind === "system") {
    return (
      <div style={{ margin: "10px 0", fontSize: 12, color: "var(--text-faint)" }}>{entry.text}</div>
    );
  }

  return (
    <div style={{ margin: "12px 0", whiteSpace: "pre-wrap", lineHeight: 1.65 }}>{entry.text}</div>
  );
}

/** Syscall table with inline permission control. */
export function SyscallPanel({
  system,
  onChange,
}: {
  system: SystemState | null;
  onChange: () => void;
}) {
  if (!system) return <div style={{ color: "var(--text-faint)" }}>Loading…</div>;

  async function setDecision(name: string, decision: string) {
    await fetch("/api/system", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syscall: name, decision }),
    });
    onChange();
  }

  const available = system.syscalls.filter((s) => s.available);
  const unavailable = system.syscalls.filter((s) => !s.available);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {available.map((s) => (
        <div
          key={s.name}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 0",
            borderBottom: "1px solid rgba(120,150,200,0.07)",
          }}
        >
          <span
            title={s.risk}
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: RISK_COLOR[s.risk],
              flexShrink: 0,
            }}
          />
          <code
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={s.summary}
          >
            {s.name}
          </code>
          <select
            value={s.decision}
            onChange={(e) => setDecision(s.name, e.target.value)}
            style={{
              fontSize: 10,
              background: "var(--bg-raised)",
              color: "var(--text-dim)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "2px 4px",
            }}
          >
            <option value="allow">auto</option>
            <option value="ask">ask</option>
            <option value="deny">off</option>
          </select>
        </div>
      ))}

      {unavailable.length > 0 && (
        <p style={{ marginTop: 12, fontSize: 11.5, color: "var(--text-faint)" }}>
          {unavailable.length} more syscall{unavailable.length === 1 ? "" : "s"} need credentials —
          see Connectors.
        </p>
      )}
    </div>
  );
}

export function ConnectorPanel({ system }: { system: SystemState | null }) {
  if (!system) return <div style={{ color: "var(--text-faint)" }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {system.connectors.map((c) => (
        <div key={c.id} style={{ borderBottom: "1px solid rgba(120,150,200,0.07)", paddingBottom: 9 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: c.ready ? "var(--ok)" : "var(--text-faint)" }}>
              {c.ready ? "●" : "○"}
            </span>
            <strong style={{ fontSize: 12.5, flex: 1 }}>{c.name}</strong>
            {c.id === "google" && c.configured && !c.ready && (
              <a href="/api/auth/google" style={{ fontSize: 11 }}>
                Connect →
              </a>
            )}
          </div>
          {!c.configured && (
            <p style={{ margin: "4px 0 0 20px", fontSize: 11, color: "var(--text-faint)" }}>
              Missing {c.missing.join(", ")}. {c.setup}
            </p>
          )}
        </div>
      ))}
      <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0 }}>
        State: {system.storeBackend}
      </p>
    </div>
  );
}

export function MemoryPanel({
  system,
  onChange,
}: {
  system: SystemState | null;
  onChange: () => void;
}) {
  if (!system) return <div style={{ color: "var(--text-faint)" }}>Loading…</div>;
  if (!system.memory.length) {
    return (
      <p style={{ color: "var(--text-faint)", fontSize: 12.5, margin: 0 }}>
        Nothing remembered yet. JARVIS writes here as it learns how you work.
      </p>
    );
  }

  async function forget(id: string) {
    await fetch("/api/system", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forgetMemoryId: id }),
    });
    onChange();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {system.memory.map((m) => (
        <div key={m.id} style={{ fontSize: 12.5 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <code style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>
              {m.key}
            </code>
            <span style={{ fontSize: 9.5, color: "var(--text-faint)" }}>{m.kind}</span>
            <button
              onClick={() => forget(m.id)}
              title="Forget this"
              style={{
                marginLeft: "auto",
                border: "none",
                background: "none",
                padding: 0,
                color: "var(--text-faint)",
                fontSize: 12,
              }}
            >
              ×
            </button>
          </div>
          <div style={{ color: "var(--text-dim)" }}>{m.value}</div>
        </div>
      ))}
    </div>
  );
}
