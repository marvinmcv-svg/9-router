-- JARVIS state schema.
--
-- Run this against your Supabase project before setting SUPABASE_URL and
-- SUPABASE_SERVICE_ROLE_KEY. Required on serverless hosts, where the
-- filesystem fallback in lib/store.ts does not survive between invocations.

-- ─── Kernel state ────────────────────────────────────────────────────────────
-- One table backs everything the kernel persists: policy, memory, sessions,
-- OAuth tokens and routine output. A single JSONB column keeps the store
-- interface narrow, so swapping backends never means a migration.

create table if not exists public.jarvis_kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- This table holds OAuth refresh tokens and everything JARVIS knows about
-- you. It must never be reachable with an anon key — RLS on with no policies
-- means only the service role (which bypasses RLS) can read it.
alter table public.jarvis_kv enable row level security;

-- ─── Read-only query surface ─────────────────────────────────────────────────
-- Backs the `supabase.query` syscall. The syscall already rejects non-SELECT
-- statements before sending them, but defence in depth matters when the
-- caller is a language model: this function is the second gate.
--
-- Two protections beyond the syscall's own check:
--   * SECURITY INVOKER — runs with the caller's rights, so it cannot be used
--     to escalate past whatever role connects.
--   * A read-only transaction — Postgres itself rejects any write attempt
--     that slips through the syscall's string checks.

create or replace function public.jarvis_readonly_query(query_text text)
returns jsonb
language plpgsql
security invoker
-- Pinned: without this the function resolves unqualified names against the
-- caller's search_path, which is a privilege-escalation shape.
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  -- `\y` is PostgreSQL's word boundary. `\b` is a backspace escape here, not
  -- a boundary as it would be in JavaScript or PCRE — using it made this
  -- guard reject every query, valid SELECTs included.
  if query_text !~* '^\s*select\y' then
    raise exception 'Only SELECT statements are permitted.';
  end if;

  -- Rejects any write for the duration of this statement, whatever the text
  -- managed to smuggle past the regex above.
  set local transaction read only;

  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query_text)
    into result;

  return result;
end;
$$;

revoke all on function public.jarvis_readonly_query(text) from public;
grant execute on function public.jarvis_readonly_query(text) to service_role;
