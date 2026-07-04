# Plan 001: Feedback Board RLS — block role self-escalation and official-badge forgery

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — otherwise skip.
>
> **Drift check (run first)**:
> `git -C C:/Users/malth/Code/mortar-pestle diff --stat 57a6c80..HEAD -- supabase/migrations/0001_feedback_board.sql supabase/migrations/0002_votes_direction.sql`
> Expected: no output (both files unchanged since this plan was written). If
> either file changed, compare the "Current state" excerpts below against the
> live SQL before proceeding; on any mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The Feedback Board's entire trust model is client-side: the app ships an anon
Supabase key by design, and **RLS is the only enforcement boundary**. Dev
powers (read every user's opt-in diagnostic logs, read hidden/deleted posts,
post "official" replies, set status/pin/hide/delete-any) are gated by
`is_dev()`, which reads `profiles.role` for the caller's `auth.uid()`.

Two RLS gaps let an ordinary authenticated client (anon key + any user JWT)
promote itself to dev and forge the developer badge — via direct PostgREST
calls, no app UI needed:

1. **Role self-escalation.** `profiles_insert` constrains only `id`, not
   `role`; there is no before-insert guard and `role` is free-text. A client
   inserts its own profile row with `role='dev'` → `is_dev()` returns true →
   full public-board takeover, including reading other users' machine logs in
   `post_diagnostics`.
2. **Official-badge forgery.** `comments_update_own` has no `WITH CHECK` and
   there is no comments before-update trigger. A user inserts a normal comment
   (blocked from `is_official=true` at insert), then UPDATEs it to
   `is_official=true`, impersonating a developer's official reply.

Posts are already safe (the `posts_before_update` trigger resets dev-only
fields for non-devs) — comments and the profiles insert path are the two
unguarded seams. This plan closes both in a new migration.

## Current state

Live migrations (only two exist): `supabase/migrations/0001_feedback_board.sql`
(schema + all RLS) and `supabase/migrations/0002_votes_direction.sql` (adds
signed vote direction; **does not** touch the profiles or comments policies).
The DB may already have 0001 **and** 0002 applied — this plan adds a THIRD
migration and must not rewrite the first two.

**Gap 1 — role is free-text and unconstrained at insert.**

`0001_feedback_board.sql:19` (column):
```sql
  role         text not null default 'user',          -- 'user' | 'dev'
```
No `CHECK` / enum — `role` accepts any string.

`0001_feedback_board.sql:207` (the insert policy — **the hole**):
```sql
create policy profiles_insert on profiles for insert to authenticated with check (id = auth.uid());
```
`WITH CHECK` constrains `id` only. A client may set `role` to anything.

`0001_feedback_board.sql:154-163` — the only profiles guard is a **BEFORE
UPDATE** trigger; there is no before-**insert** guard:
```sql
create or replace function profiles_before_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and not is_dev() then
    new.role := old.role;
  end if;
  return new;
end; $$;
create trigger profiles_before_update_trg before update on profiles
  for each row execute function profiles_before_update();
```
So the two-step attack (insert `role='user'`, then UPDATE to `'dev'`) is
**already blocked** by this trigger — only the direct INSERT of `role='dev'`
escapes.

`0001_feedback_board.sql:92-95` — what the escalation unlocks:
```sql
create or replace function is_dev() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'dev');
$$;
```
And the sensitive data it exposes, `0001_feedback_board.sql:70-76`:
```sql
create table post_diagnostics (
  post_id     uuid primary key references posts(id) on delete cascade,
  app_version text,
  os          text,
  logs        text,                                   -- only when user toggled logs ON
  created_at  timestamptz not null default now()
);
```
gated dev-only at `0001:236`: `create policy diag_read_dev on post_diagnostics for select to authenticated using (is_dev());`

**Gap 2 — comments UPDATE has no WITH CHECK.**

`0001_feedback_board.sql:225` (insert is correctly guarded):
```sql
create policy comments_insert_user on comments for insert to authenticated with check (author_id = auth.uid() and is_official = false);
```
`0001_feedback_board.sql:227-228` (update — **the hole**, then the dev policy):
```sql
create policy comments_update_own  on comments for update to authenticated using (author_id = auth.uid());
create policy comments_update_dev  on comments for update to authenticated using (is_dev());
```
`comments_update_own` has **no `WITH CHECK`**, so when Postgres validates the
NEW row on UPDATE it falls back to the `USING` expression (`author_id =
auth.uid()`), which says nothing about `is_official`. There is no comments
before-update trigger (the only comments trigger is `comments_count_trg`, an
AFTER trigger for counts, `0001:150-151`). Result: a user flips
`is_official` to true on their own comment.

**Why posts are safe (the pattern to mirror)** — `0001:100-117`
`posts_before_update()` resets `status`/`pinned`/`hidden` for non-devs. Comments
have no equivalent, so this plan uses the RLS `WITH CHECK` layer instead (a
smaller, declarative fix that needs no new trigger).

**Convention — `set_config` is the repo's session-GUC primitive.** The count
triggers already use it: `0001:122` `perform set_config('app.bypass_post_guard','on',true);`
and `0001:128` the matching `'off'`. The RLS simulation test below uses the same
`set_config(...)` call to set `request.jwt.claims` — this is the standard
Supabase per-principal RLS test technique. (Note: the repo does not currently
ship any JWT-simulation test; you are adding the first one. `auth.uid()` on a
Supabase project returns `(request.jwt.claims ->> 'sub')::uuid`.)

## How the fix works (read before writing)

`ALTER POLICY ... WITH CHECK (...)` replaces a policy's check expression in
place without dropping it — the right tool for a hardening migration that must
not rewrite 0001.

- **Gap 1**: tighten `profiles_insert`'s `WITH CHECK` to also require
  `role = 'user'`, and add a `CHECK (role in ('user','dev'))` table constraint
  (defense-in-depth against arbitrary role strings). The two-step UPDATE attack
  is already blocked by `profiles_before_update` (above), so no new trigger is
  needed. Service-role/dashboard access bypasses RLS, so the documented "first
  dev" bootstrap (`update profiles set role='dev'`) is unaffected.
- **Gap 2**: add a `WITH CHECK (author_id = auth.uid() and is_official = false)`
  to `comments_update_own`. With multiple permissive UPDATE policies, Postgres
  ORs the `WITH CHECK` expressions: a non-dev's forged `is_official=true` fails
  `comments_update_own`'s check and `comments_update_dev`'s check
  (`is_dev()` is false) → rejected; a real dev still passes via
  `comments_update_dev` (`is_dev()` true) → official replies keep working.

A before-insert trigger on profiles was **considered and rejected**: redundant
with the tightened `WITH CHECK` + the existing update trigger, and a blanket
`new.role := 'user'` trigger would fire in the dashboard (where `auth.uid()` is
null) and could interfere with the manual first-dev bootstrap.

## Commands you will need

The repo applies migrations either via the Supabase CLI or by pasting SQL into
the project's SQL editor. Use whichever is available in your environment.

| Purpose | Command | Expected on success |
|---|---|---|
| Check CLI present | `supabase --version` | prints a version, exit 0 |
| Apply migration (CLI) | `supabase db push` (run in `C:/Users/malth/Code/mortar-pestle`) | reports `0003_rls_hardening.sql` applied, exit 0 |
| Apply migration (no CLI) | Paste the full body of `supabase/migrations/0003_rls_hardening.sql` into the Supabase dashboard SQL editor and Run | `ALTER TABLE` / `ALTER POLICY` success notices, no error |
| Run RLS simulation | Paste the Step-2 test blocks into the SQL editor / `psql` | see per-block expected results in Step 2 |

If neither the CLI nor SQL-editor access is available to you, STOP and report
— you cannot verify this plan without a database to apply it to.

## Scope

**In scope** (create this one file only):
- `supabase/migrations/0003_rls_hardening.sql` (new)

**Out of scope** (do NOT touch):
- `supabase/migrations/0001_feedback_board.sql` — may already be applied;
  editing an applied migration diverges the file from the live DB and breaks
  `supabase db push` history. All fixes go in 0003.
- `supabase/migrations/0002_votes_direction.sql` — same reason.
- Any Rust `feedback_*` command or `web/` code — the vulnerability and the fix
  are entirely in RLS; the app code is unaffected (it already never sends
  `role` or sets `is_official` on its own writes).

## Git workflow

- Branch: `advisor/001-feedback-board-rls-hardening` (or the repo's convention).
- One commit; message style matches the repo — e.g.
  `security(supabase): 0003 RLS hardening — pin role at insert, block official-badge forgery`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the hardening migration

Create `supabase/migrations/0003_rls_hardening.sql` with exactly this body
(header comments follow the style of 0001/0002):

```sql
-- Mortar & Pestle Feedback Board — migration 0003: RLS hardening.
-- Run ONCE against the project that already has 0001 + 0002 applied (SQL editor
-- or `supabase db push`). Closes two client-reachable escalation paths:
--   (a) role self-escalation: profiles_insert constrained only `id`, letting a
--       client self-insert role='dev' via direct PostgREST.
--   (b) official-badge forgery: comments_update_own had no WITH CHECK, letting a
--       user flip their own comment to is_official=true.
-- No data migration (pre-beta, no rows yet). Plan: mortar-pestle plans/001-*.md.

-- ── (a1) constrain valid role values (was free-text) ──
alter table profiles add constraint role_valid check (role in ('user','dev'));

-- ── (a2) pin role at INSERT — the missing half of profiles_insert's WITH CHECK ──
alter policy profiles_insert on profiles
  with check (id = auth.uid() and role = 'user');

-- ── (b) pin is_official at UPDATE for non-devs ──
-- Multiple permissive UPDATE policies OR their WITH CHECKs: a non-dev's forged
-- is_official=true fails this check AND comments_update_dev's is_dev() check →
-- rejected; a real dev still passes via comments_update_dev.
alter policy comments_update_own on comments
  with check (author_id = auth.uid() and is_official = false);
```

**Verify** (file exists and is syntactically applied): apply it via the
command from the table above.
- CLI: `supabase db push` → exit 0, reports `0003_rls_hardening.sql` applied.
- SQL editor: Run the file → three success notices (`ALTER TABLE`,
  `ALTER POLICY`, `ALTER POLICY`), no error.

If the `add constraint role_valid` step errors with `check constraint
"role_valid" ... is violated by some row`, the DB has pre-existing rows with an
unexpected role — STOP and report (do not delete or mutate data).

### Step 2: Prove the fix with a per-principal RLS simulation

Run each block below in the SQL editor / `psql`. Each is wrapped in
`begin; ... rollback;` so it leaves no data behind. These exercise the RLS as
the `authenticated` role with a simulated JWT — the exact surface a malicious
anon-key client has.

**2a — role self-escalation is now REJECTED:**
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
-- id matches the JWT sub, so only `role` can block this:
insert into profiles (id, handle, role)
  values ('11111111-1111-1111-1111-111111111111','attacker','dev');
rollback;
```
Expected: `ERROR: new row violates row-level security policy for table "profiles"`.
(Before the fix this returned `INSERT 0 1`.)

**2b — a legitimate user profile still inserts (positive control):**
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
insert into profiles (id, handle, role)
  values ('22222222-2222-2222-2222-222222222222','legituser','user');
rollback;
```
Expected: `INSERT 0 1` (success).

**2c — official-badge forgery is now REJECTED:**
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
insert into profiles (id, handle, role)
  values ('33333333-3333-3333-3333-333333333333','forger','user');
insert into posts (id, author_id, category, title)
  values ('44444444-4444-4444-4444-444444444444',
          '33333333-3333-3333-3333-333333333333','bug','test title');
insert into comments (id, post_id, author_id, body, is_official)
  values ('55555555-5555-5555-5555-555555555555',
          '44444444-4444-4444-4444-444444444444',
          '33333333-3333-3333-3333-333333333333','hi', false);
-- forge the official badge on my own comment:
update comments set is_official = true
  where id = '55555555-5555-5555-5555-555555555555';
rollback;
```
Expected: the three inserts succeed, then the UPDATE raises
`ERROR: new row violates row-level security policy "comments_update_own" for table "comments"`.
(Before the fix the UPDATE returned `UPDATE 1`.)

If block 2a or 2c returns success instead of the expected ERROR, the migration
did not apply — STOP and report.

## Test plan

There is no automated test harness for SQL in this repo; the RLS simulation
in Step 2 **is** the test and must be run and its expected results confirmed:

- 2a: dev-role INSERT rejected (the escalation fix).
- 2b: user-role INSERT succeeds (no false-positive lockout of normal signup).
- 2c: `is_official=true` self-UPDATE rejected (the forgery fix).

Record the observed output of each block in your report.

## Done criteria

ALL must hold:

- [ ] `supabase/migrations/0003_rls_hardening.sql` exists with the Step-1 body.
- [ ] Migration applied cleanly (CLI `db push` exit 0, or SQL-editor run with no error).
- [ ] Step 2a returns the RLS-violation ERROR (dev-role insert blocked).
- [ ] Step 2b returns `INSERT 0 1` (user-role insert still works).
- [ ] Step 2c's UPDATE returns the RLS-violation ERROR (badge forgery blocked).
- [ ] `git status` shows only `supabase/migrations/0003_rls_hardening.sql` added — no other file modified.
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The drift check shows 0001 or 0002 changed since commit `57a6c80`, and the
  live SQL no longer matches the excerpts in "Current state".
- `add constraint role_valid` fails because existing rows violate it (data you
  must not touch is present).
- Any Step-2 simulation returns a result that contradicts its "Expected" line
  (especially: 2a or 2c succeeding — that means the fix did not take).
- You have no way to apply or query the database (no CLI, no SQL-editor access).
- Applying the fix appears to require editing 0001, 0002, or any non-SQL file.

## Maintenance notes

For whoever owns the Feedback Board schema next:

- **Every future UPDATE policy needs an explicit `WITH CHECK`.** When a policy
  omits it, Postgres validates the NEW row against the `USING` expression, which
  usually does not constrain the columns an attacker wants to change. Gap 2 was
  exactly this. Audit new policies for it.
- **Every new privileged column** (anything a dev may set but a user may not —
  like `role`, `is_official`, `pinned`, `hidden`, `status`) needs the guard at
  BOTH insert and update: pin it in the insert policy's `WITH CHECK` and either
  a `WITH CHECK` on every update policy or a before-update trigger that resets
  it for non-devs (the `posts_before_update` pattern).
- The first-dev bootstrap (`update profiles set role='dev' where id='<uid>'`)
  runs as the service role in the dashboard and bypasses RLS + the tightened
  insert check — it is unaffected by this migration. If a future change moves
  the bootstrap into client-reachable code, revisit the `role='user'` insert
  pin.
- A reviewer should confirm the `ALTER POLICY` statements target the same
  policy names that exist in 0001 (`profiles_insert`, `comments_update_own`)
  and that no fourth migration between 0002 and this one renamed them.
