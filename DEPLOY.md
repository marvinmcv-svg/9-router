# Deploying JARVIS

Ten minutes, three steps. The result is a private URL you can open from any
browser, on any device.

> **Read this first.** Vercel runs your code on a serverless host with a
> **read-only filesystem and no shell**. `fs.write`, `fs.edit` and `shell.exec`
> are therefore hidden on a Vercel deployment — JARVIS detects the host and
> tells the model up front rather than letting it plan work it can't do.
>
> What you get deployed: mail, calendar, drive, GitHub, memory, subagents, web
> fetch, routines. What you don't: editing files and running commands.
> For those, run JARVIS on a real machine (`npm run dev`, or a container on
> Fly/Railway/a VPS with `JARVIS_ALLOW_EXEC=true`).

---

## 1. Import the repo

Open **[vercel.com/new](https://vercel.com/new)** and import
`marvinmcv-svg/9-router`, selecting the branch you want to deploy.

Importing from GitHub rather than uploading files is deliberate: every push
redeploys, so you never have to think about shipping again.

## 2. Set the environment variables

In the import screen (or **Project → Settings → Environment Variables**):

| Variable | Value | Required |
|---|---|---|
| `JARVIS_PASSWORD` | The password you'll sign in with | **Yes** |
| `JARVIS_AUTH_SECRET` | Any long random string | **Yes** |
| `SUPABASE_URL` | `https://cpdrclazmvboenhlsccf.supabase.co` | **Yes** |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role | **Yes** |
| `JARVIS_BASE_URL` | `https://<your-app>.vercel.app` | For Google OAuth |
| `JARVIS_CRON_SECRET` | Any long random string | For routines |
| `JARVIS_TIMEZONE` | e.g. `America/New_York` | Recommended |

**Without `JARVIS_PASSWORD` the app serves 503 on every route.** That is
deliberate — a deployment that can't authenticate anyone is locked, not open.

You do *not* need to set a model key here. Sign in and paste it into the Model
panel instead; it's stored in Supabase and changeable without a redeploy.

### Why Supabase is not optional

Serverless functions get an ephemeral filesystem that isn't shared between
invocations, so the local JSON store silently loses your memory, sessions and
OAuth tokens between requests. Postgres is the only durable option here. The
schema is already applied to your project — `jarvis_kv` plus a read-only query
function — and RLS is on with no policies, so only the service role can read it.

## 3. Sign in

Open the deployment URL. You'll get the login page; enter `JARVIS_PASSWORD`.
Then:

1. **Model** panel → paste your key → **Save & test**. It sends a real request
   and shows you the reply, so you know it works before you rely on it.
2. **Links** panel → connect Google if you want mail and calendar.

---

## Connecting Google on a deployment

Google OAuth requires the exact redirect URI to be pre-registered:

1. Set `JARVIS_BASE_URL` to your deployment URL (no trailing slash).
2. In [console.cloud.google.com](https://console.cloud.google.com) → your OAuth
   client → **Authorized redirect URIs**, add
   `https://<your-app>.vercel.app/api/auth/google`.
3. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to Vercel and redeploy.

Vercel gives every deployment a unique preview URL, and those won't match the
registered redirect. Use your production domain for the Google flow.

## Routines

`vercel.json` schedules the morning brief and evening wrap. Vercel's Hobby plan
allows two cron jobs at daily granularity, which is what's configured. They
call `/api/routines/run`, which **refuses to run in production without
`JARVIS_CRON_SECRET`** — that endpoint starts a paid agent run with full access
to your accounts, so it is not left open.

Set the same value in Vercel's cron settings so the scheduler sends it as
`Authorization: Bearer <secret>`.

## Costs

- **Vercel Hobby** — free. Function duration is capped at 300s, which is what
  the kernel routes are set to. A long agentic turn can hit that ceiling; the
  session survives and you can say "continue".
- **Supabase free tier** — pauses after a week of inactivity. If JARVIS starts
  reporting store errors, unpause it in the dashboard.
- **Model usage** — billed by whoever issued your key.

## Security posture

This is a single-user system. There are no accounts, no roles, and no
multi-tenancy: whoever knows the password has your mailbox.

- Authentication is enforced in middleware, so no route reaches the kernel or
  its stored credentials without passing it.
- The session cookie is HMAC-signed with the password itself, so changing the
  password invalidates every existing session.
- Writes still require approval in the UI regardless of deployment.
- **Rotate any key you have pasted into a chat window, including with me.**

For a second layer, turn on Vercel Authentication under
**Project → Settings → Deployment Protection**.
