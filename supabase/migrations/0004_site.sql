-- malthaiel.com site bridge — migration 0004: availability, bookings, coaching posts.
-- Run ONCE against the project that already has 0001 + 0002 + 0003 applied
-- (Dashboard → SQL Editor → paste → Run).
-- Plan: Citadel `Knowledge/Mortar & Pestle/Plans/Site Bridge.md`.
--
-- Security model, unchanged from 0001: the desktop app holds no service-role key.
-- Dev powers are gated by `is_dev()` (0001). The public website talks to PostgREST
-- with the anon key only, so every anon-reachable surface below is deliberate:
--   availability_busy      anon SELECT   — times only, NO title column, ever
--   bookings_busy   (view) anon SELECT   — times only, derived from bookings
--   coaching_posts_public  anon SELECT   — has no body_md column: THE privacy gate
--   post_comments          anon SELECT   — published posts only
--   bookings               anon INSERT   — status/stripe/token pinned by trigger
--   custom_requests        anon INSERT
-- Everything else is dev-only or unreachable.

-- ───────────────────────── enums ─────────────────────────
create type booking_status as enum ('pending','confirmed','cancelled');

-- ───────────────────────── availability ─────────────────────────
-- Pushed by the desktop app (commands/site.rs `site_push_busy`). The whole table
-- is replaced on every push — the app's computed window IS the truth.
-- There is no title/label column and there must never be one: this table is
-- world-readable, and the point is that the site learns WHEN he is busy without
-- learning WHAT he is doing.
create table availability_busy (
  id        uuid primary key default gen_random_uuid(),
  start_ts  timestamptz not null,
  end_ts    timestamptz not null,
  pushed_at timestamptz not null default now(),
  constraint busy_range_ordered check (end_ts > start_ts)
);
create index availability_busy_start_idx on availability_busy (start_ts);

alter table availability_busy enable row level security;
create policy busy_read      on availability_busy for select to anon, authenticated using (true);
create policy busy_write_dev on availability_busy for all    to authenticated
  using (is_dev()) with check (is_dev());

-- Atomic replace: delete + insert in one statement-visible transaction so the
-- site never sees an empty calendar mid-push (a naive DELETE-then-POST from the
-- client leaves a window where every slot looks free). SECURITY INVOKER — RLS
-- still applies, so only a dev can actually run the mutation inside.
create or replace function site_replace_busy(ranges jsonb) returns int
  language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  -- `where true` is load-bearing: Supabase runs pg_safeupdate for `authenticated`,
  -- and a bare DELETE aborts with 21000 "DELETE requires a WHERE clause". This
  -- function is security invoker, so it inherits that guard. Do not "simplify".
  delete from availability_busy where true;
  insert into availability_busy (start_ts, end_ts)
  select (e->>'start_ts')::timestamptz, (e->>'end_ts')::timestamptz
    from jsonb_array_elements(coalesce(ranges, '[]'::jsonb)) e;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function site_replace_busy(jsonb) from public, anon;
grant  execute on function site_replace_busy(jsonb) to authenticated;

-- ───────────────────────── bookings ─────────────────────────
create table bookings (
  id                uuid primary key default gen_random_uuid(),
  service_id        text not null check (char_length(service_id) between 2 and 40),
  start_ts          timestamptz not null,
  mins              int  not null check (mins between 5 and 480),
  client_name       text not null check (char_length(client_name) between 1 and 120),
  client_email      text not null check (client_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  client_discord    text not null default '' check (char_length(client_discord) <= 60),
  notes             text not null default '' check (char_length(notes) <= 2000),
  status            booking_status not null default 'pending',
  stripe_session_id text,
  review_token      uuid,
  created_at        timestamptz not null default now()
);
create index bookings_start_idx on bookings (start_ts);

-- Anon inserts are visitor-supplied. Pin the three fields a visitor must never
-- control: a self-declared 'confirmed' would skip payment, and a self-chosen
-- review_token would let anyone post a "verified client" review later.
create or replace function bookings_before_insert() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if not is_dev() then
    -- A free service takes no payment, so no Stripe webhook will ever arrive to
    -- confirm it. Born confirmed instead: pinned to 'pending' it would fall out
    -- of bookings_busy after 30 minutes and the slot would silently reopen for
    -- someone else, and site_fetch_bookings (confirmed only) would never put it
    -- on the planner. Free means there is nothing to defraud.
    new.status            := case when new.service_id = 'intro' then 'confirmed' else 'pending' end;
    new.stripe_session_id := null;
    new.review_token      := null;
  end if;
  return new;
end;
$$;
create trigger bookings_pin_untrusted_fields before insert on bookings
  for each row execute function bookings_before_insert();

alter table bookings enable row level security;
-- INSERT only for anon; no SELECT policy at all → reads are denied (rows hold PII).
-- The Stripe webhook edge function uses the service role and bypasses RLS to confirm.
create policy bookings_insert     on bookings for insert to anon, authenticated with check (true);
create policy bookings_read_dev   on bookings for select to authenticated using (is_dev());
create policy bookings_update_dev on bookings for update to authenticated
  using (is_dev()) with check (is_dev());

-- Times-only window onto bookings so the site's slot generator can subtract
-- already-taken slots without ever reading a name or email. SECURITY DEFINER by
-- default (no `security_invoker`) — that is deliberate and is what lets anon read
-- derived columns from a table anon cannot select.
-- Unpaid 'pending' rows expire after 30 min (the Stripe Checkout window) so an
-- abandoned checkout does not hold a slot hostage forever.
create view bookings_busy as
  select b.start_ts,
         b.start_ts + (b.mins * interval '1 minute') as end_ts
    from bookings b
   where b.status = 'confirmed'
      or (b.status = 'pending' and b.created_at > now() - interval '30 minutes');
grant select on bookings_busy to anon, authenticated;

-- ───────────────────────── coaching posts ─────────────────────────
create table coaching_posts (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9-]{3,80}$'),
  title        text not null check (char_length(title) between 3 and 160),
  session_date date not null,
  preview_md   text not null default '' check (char_length(preview_md) <= 8000),
  body_md      text not null default '' check (char_length(body_md) <= 200000),
  published_at timestamptz
);

alter table coaching_posts enable row level security;
-- No anon policy of any kind. body_md is never reachable with the anon key.
create policy coaching_posts_dev on coaching_posts for all to authenticated
  using (is_dev()) with check (is_dev());

-- (`coaching_posts_public`, the read view, is created after post_comments below —
--  it counts comments, so the table has to exist first.)

-- ───────────────────────── comments on coaching posts ─────────────────────────
-- Distinct from the Feedback Board's `comments` table (0001). Anon may READ but
-- not INSERT: comments arrive through an edge function that validates the
-- booking's review_token, which runs as the service role and bypasses RLS.
create table post_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references coaching_posts(id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 60),
  body        text not null check (char_length(body) between 1 and 4000),
  created_at  timestamptz not null default now()
);
create index post_comments_post_idx on post_comments (post_id, created_at);

-- An RLS policy's subquery runs under the caller's own RLS, and anon cannot
-- select coaching_posts at all — so the "is this post published" test has to be
-- a SECURITY DEFINER helper, exactly like is_dev().
create or replace function coaching_post_published(p uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from coaching_posts where id = p and published_at is not null);
$$;

alter table post_comments enable row level security;
create policy post_comments_read on post_comments for select to anon, authenticated
  using (coaching_post_published(post_id));
create policy post_comments_dev  on post_comments for all to authenticated
  using (is_dev()) with check (is_dev());

-- ───────────────────────── the public post view ─────────────────────────
-- The privacy mechanism: this view simply has no body_md column, so the locked
-- half of a session note is not withheld by a filter that could be bypassed — it
-- is not part of the shape the site can ask for.
create view coaching_posts_public as
  select p.id, p.slug, p.title, p.session_date, p.preview_md, p.published_at,
         (select count(*) from post_comments c where c.post_id = p.id) as comment_count
    from coaching_posts p
   where p.published_at is not null;
grant select on coaching_posts_public to anon, authenticated;

-- ───────────────────────── custom requests ─────────────────────────
-- "Custom request" form → a row here → he quotes by hand. No admin UI.
create table custom_requests (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  email      text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  discord    text not null default '' check (char_length(discord) <= 60),
  detail     text not null default '' check (char_length(detail) <= 4000),
  status     text not null default 'new' check (status in ('new','quoted','closed')),
  created_at timestamptz not null default now()
);

alter table custom_requests enable row level security;
create policy custom_requests_insert on custom_requests for insert to anon, authenticated
  with check (status = 'new');
create policy custom_requests_dev    on custom_requests for all to authenticated
  using (is_dev()) with check (is_dev());
