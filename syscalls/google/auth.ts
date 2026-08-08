import { store } from "@/lib/store";
import { requireEnv } from "../connectors";

/**
 * Google OAuth.
 *
 * We hold the refresh token and mint access tokens on demand rather than
 * caching them long — an access token in the store that outlives its validity
 * turns every syscall into a confusing 401.
 */

const TOKEN_KEY = "google/tokens";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

interface StoredTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  email?: string;
}

export function authUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    // Google only returns a refresh token on the first consent unless we
    // force the prompt — without this, re-connecting yields an access token
    // that expires in an hour and no way to renew it.
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);

  const data = (await res.json()) as {
    refresh_token?: string;
    access_token: string;
    expires_in: number;
  };

  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke JARVIS at myaccount.google.com/permissions and connect again.",
    );
  }

  await store.set<StoredTokens>(TOKEN_KEY, {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
}

export async function isConnected(): Promise<boolean> {
  return Boolean(await store.get<StoredTokens>(TOKEN_KEY));
}

export async function disconnect(): Promise<void> {
  await store.delete(TOKEN_KEY);
}

async function accessToken(): Promise<string> {
  const tokens = await store.get<StoredTokens>(TOKEN_KEY);
  if (!tokens) {
    throw new Error(
      "Google is not connected. Tell the user to open the Connectors panel and connect their Google account.",
    );
  }

  // 60s of slack so a token doesn't expire between the check and the request.
  if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt > Date.now() + 60_000) {
    return tokens.accessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refreshToken,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Google refresh failed (${res.status}). The user may need to reconnect their account.`,
    );
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  await store.set<StoredTokens>(TOKEN_KEY, {
    ...tokens,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

/**
 * Authenticated fetch returning the raw response.
 *
 * Needed for endpoints that don't speak JSON in both directions — Drive's
 * export and media downloads return bytes, and uploads take multipart bodies.
 */
export async function googleRaw(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google API ${res.status} on ${new URL(url).pathname}: ${body.slice(0, 500)}`);
  }
  return res;
}

/** Authenticated JSON fetch against any Google API. */
export async function google<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await googleRaw(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
