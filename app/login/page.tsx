"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      // A hard navigation, so the middleware re-evaluates with the new cookie.
      window.location.href = params.get("next") || "/";
      return;
    }

    setError(((await res.json()) as { error?: string }).error ?? "Sign-in failed.");
    setBusy(false);
  }

  return (
    <form
      onSubmit={submit}
      style={{
        width: "min(340px, 90vw)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        background: "var(--bg-panel)",
        backdropFilter: "blur(20px)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 26,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: "var(--accent)",
            boxShadow: "0 0 12px var(--accent)",
          }}
        />
        <h1 style={{ margin: 0, fontSize: 15, letterSpacing: "0.24em", fontWeight: 500 }}>JARVIS</h1>
      </div>

      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-dim)" }}>
        This system holds live access to your accounts. Sign in to continue.
      </p>

      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        style={{
          padding: "9px 11px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "rgba(10,14,22,0.6)",
        }}
      />

      {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{error}</p>}

      <button type="submit" disabled={busy || !password}>
        {busy ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main
      style={{
        position: "relative",
        zIndex: 1,
        height: "100dvh",
        display: "grid",
        placeItems: "center",
      }}
    >
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
