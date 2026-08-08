"use client";

import { useEffect, useRef, useState } from "react";
import { useJarvis } from "@/components/useJarvis";
import {
  ApprovalQueue,
  ConnectorPanel,
  Entry,
  MemoryPanel,
  Panel,
  SyscallPanel,
} from "@/components/panels";

const SUGGESTIONS = [
  "What does my day look like?",
  "Anything in my inbox that needs a reply?",
  "Find me an hour with Sam this week and send the invite",
  "What's failing in CI right now?",
];

export default function Desktop() {
  const jarvis = useJarvis();
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<"syscalls" | "memory" | "connectors">("connectors");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Follow the stream, but only when the user is already at the bottom —
  // yanking the view while they're reading back is worse than a stale scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [jarvis.transcript, jarvis.approvals]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape" && jarvis.running) jarvis.interrupt();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jarvis]);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void jarvis.send(text);
  }

  const pendingCount = jarvis.approvals.length;

  return (
    <main
      style={{
        position: "relative",
        zIndex: 1,
        height: "100dvh",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 340px",
        gap: 14,
        padding: 14,
      }}
    >
      {/* Conversation column */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 4px" }}>
          <div
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: jarvis.running ? "var(--accent)" : "var(--ok)",
              boxShadow: `0 0 12px ${jarvis.running ? "var(--accent)" : "var(--ok)"}`,
            }}
          />
          <h1 style={{ margin: 0, fontSize: 15, letterSpacing: "0.24em", fontWeight: 500 }}>
            JARVIS
          </h1>
          <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
            {jarvis.running
              ? "working — esc to interrupt"
              : pendingCount
                ? `${pendingCount} awaiting your decision`
                : "ready"}
          </span>
          <button onClick={jarvis.newSession} style={{ marginLeft: "auto", fontSize: 12 }}>
            New session
          </button>
        </header>

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "4px 16px",
            background: "var(--bg-panel)",
            backdropFilter: "blur(20px)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            minHeight: 0,
          }}
        >
          {jarvis.transcript.length === 0 && !pendingCount && (
            <div style={{ padding: "12vh 0", textAlign: "center" }}>
              <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
                Ask for anything. Reads happen immediately; anything that changes the world
                asks you first.
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  justifyContent: "center",
                  maxWidth: 560,
                  margin: "0 auto",
                }}
              >
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => jarvis.send(s)} style={{ fontSize: 12 }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {jarvis.transcript.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}

          {pendingCount > 0 && (
            <div style={{ margin: "14px 0" }}>
              <ApprovalQueue
                approvals={jarvis.approvals}
                busy={jarvis.running}
                onResolve={jarvis.resolve}
              />
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-end",
            background: "var(--bg-panel)",
            backdropFilter: "blur(20px)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: "10px 14px",
          }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={pendingCount ? "Decide on the pending action above…" : "⌘K — ask JARVIS anything"}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            style={{ padding: "5px 0", maxHeight: 200, overflowY: "auto" }}
          />
          <button
            onClick={jarvis.running ? jarvis.interrupt : submit}
            disabled={!jarvis.running && !draft.trim()}
            style={{ flexShrink: 0 }}
          >
            {jarvis.running ? "Stop" : "Send"}
          </button>
        </div>
      </div>

      {/* System column */}
      <aside style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(["connectors", "syscalls", "memory"] as const).map((id) => (
            <button
              key={id}
              onClick={() => setPanel(id)}
              style={{
                flex: 1,
                fontSize: 11,
                textTransform: "capitalize",
                borderColor: panel === id ? "var(--border-bright)" : "var(--border)",
                color: panel === id ? "var(--text)" : "var(--text-dim)",
              }}
            >
              {id}
            </button>
          ))}
        </div>

        {panel === "connectors" && (
          <Panel title="Connectors" subtitle="what JARVIS can reach" flex>
            <ConnectorPanel system={jarvis.system} />
          </Panel>
        )}
        {panel === "syscalls" && (
          <Panel title="Syscalls" subtitle="auto · ask · off" flex>
            <SyscallPanel system={jarvis.system} onChange={jarvis.refreshSystem} />
          </Panel>
        )}
        {panel === "memory" && (
          <Panel title="Memory" subtitle="what it knows about you" flex>
            <MemoryPanel system={jarvis.system} onChange={jarvis.refreshSystem} />
          </Panel>
        )}

        <Panel title="Sessions">
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {jarvis.system?.sessions.slice(0, 8).map((s) => (
              <button
                key={s.id}
                onClick={() => jarvis.openSession(s.id)}
                style={{
                  textAlign: "left",
                  border: "none",
                  background: s.id === jarvis.sessionId ? "var(--accent-dim)" : "none",
                  padding: "4px 6px",
                  fontSize: 12,
                  color: s.id === jarvis.sessionId ? "var(--text)" : "var(--text-dim)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.title}
              </button>
            )) ?? null}
            {!jarvis.system?.sessions.length && (
              <span style={{ fontSize: 12, color: "var(--text-faint)" }}>No sessions yet.</span>
            )}
          </div>
        </Panel>
      </aside>
    </main>
  );
}
