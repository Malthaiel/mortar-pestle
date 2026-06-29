# Mortar & Pestle Supabase backend (Feedback Board)

The Feedback Board is the app's only cloud-backed feature. Everything else in Mortar & Pestle is local-first. The app talks to Supabase **only through Rust** (`src-tauri/src/commands/feedback.rs`) — the webview never calls Supabase directly, and the service-role key is never used by the client.

Plan of record: Citadel vault `Knowledge/Mortar & Pestle/Plans/Feedback Board.md`.

## One-time setup

1. **Create a Supabase project** at https://supabase.com. From Project Settings → API, copy:
   - **Project URL** (e.g. `https://abcdxyz.supabase.co`)
   - **anon public key** (the `anon` / `public` key — safe to embed; RLS is the gate. NOT the `service_role` key.)

2. **Apply the schema.** In the dashboard SQL editor, paste and run `migrations/0001_feedback_board.sql` (or `supabase db push` with the CLI). This creates all tables, enums, RLS policies, triggers, the `is_dev()` helper, and the public `avatars` storage bucket.

3. **Configure email auth.** Authentication → Providers → Email: enable **Email OTP** (one-time code). No SMTP needed for testing — use the local stack's Inbucket, or Supabase's built-in email for low volume.

4. **Build with the keys.** Set these before `npm run tauri dev` (or in CI for a release build) — they bake into the Rust binary via `option_env!`, never into the JS bundle:
   ```sh
   export MORTAR_PESTLE_SUPABASE_URL="https://<project>.supabase.co"
   export MORTAR_PESTLE_SUPABASE_ANON_KEY="<anon-public-key>"
   ```
   On Windows PowerShell: `$env:MORTAR_PESTLE_SUPABASE_URL = "..."` etc.

5. **Make yourself the dev.** Launch the app, sign in by email code, pick a handle (creates your `profiles` row). Then in the dashboard SQL editor:
   ```sql
   update profiles set role = 'dev' where id = '<your-auth-user-id>';
   ```
   Your account now has board moderation / status / pin / official-reply powers, enforced in RLS.

## Local development stack (optional)

`supabase start` runs Postgres + GoTrue + Storage + an **Inbucket** mail catcher locally (read OTP codes without a real inbox). Apply the migration to the local DB, then point the build at the local URL + the local anon key.

## Security notes

- The **anon key is public** by design; row-level security in the migration is what protects data. Verify the RLS allow/deny matrix (anon / user-A / user-B / dev) before trusting a build.
- **Diagnostics** (app version, OS, opt-in logs) are stored in `post_diagnostics`, readable only by the dev role.
- A release build must fail if the placeholder URL/key is still compiled in.
