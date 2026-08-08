"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalDecision, KernelEvent, PendingApproval } from "@/kernel/types";

/**
 * Client-side kernel connection.
 *
 * Owns the SSE stream, the rendered transcript, and the pending-approval
 * queue. Approvals are the interesting part: a turn that stops for approval
 * ends its stream, so approving is a *new* request that resumes the same
 * server-side loop — the hook hides that seam from the UI.
 */

export interface TranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "thinking" | "syscall" | "error" | "system";
  text: string;
  /** Syscall entries only. */
  syscall?: { name: string; ok?: boolean; running: boolean };
}

export interface SystemState {
  storeBackend: string;
  policy: { defaults: Record<string, string>; overrides: Record<string, string> };
  syscalls: {
    name: string;
    summary: string;
    risk: "read" | "write" | "dangerous";
    connector: string;
    available: boolean;
    decision: "allow" | "ask" | "deny";
  }[];
  connectors: {
    id: string;
    name: string;
    description: string;
    configured: boolean;
    ready: boolean;
    missing: string[];
    setup: string;
  }[];
  sessions: { id: string; title: string; updatedAt: string }[];
  memory: { id: string; key: string; value: string; kind: string; updatedAt: string }[];
}

let entryCounter = 0;
const nextId = () => `e${++entryCounter}`;

export function useJarvis() {
  const [sessionId, setSessionId] = useState<string>("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [running, setRunning] = useState(false);
  const [system, setSystem] = useState<SystemState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Resume the last session across reloads so a refresh doesn't discard a
    // conversation the kernel still has state for.
    const saved = localStorage.getItem("jarvis.session");
    setSessionId(saved ?? crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (sessionId) localStorage.setItem("jarvis.session", sessionId);
  }, [sessionId]);

  const refreshSystem = useCallback(async () => {
    try {
      const res = await fetch("/api/system");
      if (res.ok) setSystem((await res.json()) as SystemState);
    } catch {
      // The shell stays usable without the panels; don't surface a toast for
      // a failed background refresh.
    }
  }, []);

  useEffect(() => {
    void refreshSystem();
  }, [refreshSystem]);

  const append = useCallback((entry: Omit<TranscriptEntry, "id">) => {
    setTranscript((prev) => [...prev, { ...entry, id: nextId() }]);
  }, []);

  /** Append streamed text onto the trailing entry of the same kind. */
  const appendStreaming = useCallback((kind: "assistant" | "thinking", text: string) => {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === kind) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: nextId(), kind, text }];
    });
  }, []);

  const consume = useCallback(
    async (body: Record<string, unknown>) => {
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/kernel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...body,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          append({ kind: "error", text: `Kernel returned ${res.status}. ${detail}`.trim() });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line; a partial frame stays
          // in the buffer until the rest arrives.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;

            const event = JSON.parse(line.slice(6)) as KernelEvent;

            switch (event.type) {
              case "text":
                appendStreaming("assistant", event.text);
                break;
              case "thinking":
                appendStreaming("thinking", event.text);
                break;
              case "syscall_start":
                append({
                  kind: "syscall",
                  text: JSON.stringify(event.input),
                  syscall: { name: event.name, running: true },
                });
                break;
              case "syscall_end":
                setTranscript((prev) => {
                  const index = prev.findLastIndex(
                    (e: TranscriptEntry) =>
                      e.kind === "syscall" && e.syscall?.name === event.name && e.syscall.running,
                  );
                  if (index === -1) return prev;
                  const next = [...prev];
                  next[index] = {
                    ...next[index],
                    text: event.summary,
                    syscall: { name: event.name, ok: event.ok, running: false },
                  };
                  return next;
                });
                break;
              case "approval_required":
                setApprovals(event.approvals);
                break;
              case "error":
                append({ kind: "error", text: event.message });
                break;
              case "done":
                if (event.reason === "max_iterations") {
                  append({
                    kind: "system",
                    text: "Stopped after 40 steps. Say 'continue' to keep going.",
                  });
                }
                break;
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          append({ kind: "error", text: (err as Error).message });
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
        void refreshSystem();
      }
    },
    [sessionId, append, appendStreaming, refreshSystem],
  );

  const send = useCallback(
    async (message: string) => {
      if (!message.trim() || running) return;
      append({ kind: "user", text: message });
      setApprovals([]);
      await consume({ message });
    },
    [consume, running, append],
  );

  const resolve = useCallback(
    async (decisions: ApprovalDecision[]) => {
      setApprovals([]);
      await consume({ decisions });
    },
    [consume],
  );

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const newSession = useCallback(() => {
    interrupt();
    setSessionId(crypto.randomUUID());
    setTranscript([]);
    setApprovals([]);
  }, [interrupt]);

  const openSession = useCallback(
    (id: string) => {
      interrupt();
      setSessionId(id);
      setTranscript([]);
      setApprovals([]);
    },
    [interrupt],
  );

  return {
    sessionId,
    transcript,
    approvals,
    running,
    system,
    send,
    resolve,
    interrupt,
    newSession,
    openSession,
    refreshSystem,
  };
}
