-- Mortar & Pestle Feedback Board — Phase 0 schema (all phases; app code lands incrementally).
-- Run ONCE against a fresh Supabase project (SQL editor or `supabase db push`).
-- Plan: Citadel `Knowledge/Mortar & Pestle/Plans/Feedback Board.md`.
-- Security model: the webview never holds the service-role key. Dev powers are gated
-- by `is_dev()` (the caller's own profiles.role), enforced in RLS. The first dev is
-- set by hand in the dashboard: update profiles set role='dev' where id='<your uid>'.

-- ───────────────────────── enums ─────────────────────────
create type post_category as enum ('bug','feature','improvement','other');
create type post_status   as enum ('open','under_review','planned','in_progress','done','declined');
create type notif_kind    as enum ('status_change','new_comment','official_reply');

-- ───────────────────────── tables ─────────────────────────
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text not null,
  display_name text not null default '',
  avatar_url   text,
  role         text not null default 'user',          -- 'user' | 'dev'
  created_at   timestamptz not null default now(),
  constraint handle_format check (handle ~ '^[a-z0-9_]{3,30}$')
);
create unique index profiles_handle_lower_idx on profiles (lower(handle));

create table posts (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references profiles(id) on delete cascade,
  category      post_category not null,
  title         text not null check (char_length(title) between 3 and 140),
  body          text not null default '' check (char_length(body) <= 8000),
  status        post_status not null default 'open',
  pinned        boolean not null default false,
  hidden        boolean not null default false,       -- dev soft-hide
  deleted       boolean not null default false,       -- author/dev soft-delete
  vote_count    integer not null default 0,           -- denormalized (trigger)
  comment_count integer not null default 0,           -- denormalized (trigger)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index posts_feed_idx     on posts (pinned desc, created_at desc) where not deleted and not hidden;
create index posts_status_idx   on posts (status)   where not deleted and not hidden;
create index posts_category_idx on posts (category) where not deleted and not hidden;

create table votes (
  post_id    uuid not null references posts(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references posts(id) on delete cascade,
  author_id   uuid not null references profiles(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 4000),
  is_official boolean not null default false,         -- dev-only true
  deleted     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index comments_post_idx on comments (post_id, created_at) where not deleted;

create table follows (
  post_id    uuid not null references posts(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- DEV-ONLY readable. Separate table because Postgres RLS is row-level, not column-level.
create table post_diagnostics (
  post_id     uuid primary key references posts(id) on delete cascade,
  app_version text,
  os          text,
  logs        text,                                   -- only when user toggled logs ON
  created_at  timestamptz not null default now()
);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,  -- recipient
  post_id    uuid not null references posts(id) on delete cascade,
  actor_id   uuid references profiles(id) on delete set null,
  kind       notif_kind not null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_inbox_idx on notifications (user_id, created_at desc);

-- ───────────────────────── dev gate ─────────────────────────
-- SECURITY DEFINER so it can read profiles.role regardless of row policies,
-- keyed strictly to the caller's auth.uid() (cannot be spoofed by the client).
create or replace function is_dev() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'dev');
$$;

-- ───────────────────────── triggers ─────────────────────────
-- posts BEFORE UPDATE: bump updated_at, reset counts (only the count triggers may
-- change them, via the bypass flag), and reject non-dev edits to dev-only fields.
create or replace function posts_before_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.bypass_post_guard', true) = 'on' then
    return new;                                        -- count-maintenance path
  end if;
  if not is_dev() then
    new.status := old.status;
    new.pinned := old.pinned;
    new.hidden := old.hidden;
  end if;
  new.vote_count    := old.vote_count;                -- counts only via count triggers
  new.comment_count := old.comment_count;
  new.updated_at    := now();
  return new;
end; $$;
create trigger posts_before_update_trg before update on posts
  for each row execute function posts_before_update();

create or replace function bump_vote_count() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.bypass_post_guard','on',true);
  if (tg_op = 'INSERT') then
    update posts set vote_count = vote_count + 1 where id = new.post_id;
  elsif (tg_op = 'DELETE') then
    update posts set vote_count = greatest(vote_count - 1, 0) where id = old.post_id;
  end if;
  perform set_config('app.bypass_post_guard','off',true);
  return null;
end; $$;
create trigger votes_count_trg after insert or delete on votes
  for each row execute function bump_vote_count();

create or replace function bump_comment_count() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.bypass_post_guard','on',true);
  if (tg_op = 'INSERT') then
    update posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif (tg_op = 'UPDATE') then
    if new.deleted and not old.deleted then
      update posts set comment_count = greatest(comment_count - 1, 0) where id = new.post_id;
    elsif old.deleted and not new.deleted then
      update posts set comment_count = comment_count + 1 where id = new.post_id;
    end if;
  end if;
  perform set_config('app.bypass_post_guard','off',true);
  return null;
end; $$;
create trigger comments_count_trg after insert or update of deleted on comments
  for each row execute function bump_comment_count();

-- profiles BEFORE UPDATE: silently ignore non-dev role escalation attempts.
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

-- notification fan-out (SECURITY DEFINER so it can insert rows for OTHER users,
-- which RLS would otherwise forbid). Never notify the actor.
create or replace function notify_status_change() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into notifications (user_id, post_id, actor_id, kind)
    select f.user_id, new.id, auth.uid(), 'status_change'
    from follows f
    where f.post_id = new.id
      and f.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
  end if;
  return null;
end; $$;
create trigger posts_notify_trg after update of status on posts
  for each row execute function notify_status_change();

create or replace function notify_comment() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, post_id, actor_id, kind)
  select f.user_id, new.post_id, new.author_id,
         case when new.is_official then 'official_reply'::notif_kind
              else 'new_comment'::notif_kind end
  from follows f
  where f.post_id = new.post_id and f.user_id <> new.author_id;
  return null;
end; $$;
create trigger comments_notify_trg after insert on comments
  for each row execute function notify_comment();

-- ───────────────────────── RLS ─────────────────────────
alter table profiles         enable row level security;
alter table posts            enable row level security;
alter table votes            enable row level security;
alter table comments         enable row level security;
alter table follows          enable row level security;
alter table post_diagnostics enable row level security;
alter table notifications    enable row level security;

-- profiles: public read; own insert/update; dev may edit any (handle reclaim).
create policy profiles_read   on profiles for select to anon, authenticated using (true);
create policy profiles_insert on profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on profiles for update to authenticated using (id = auth.uid() or is_dev());

-- posts: public sees live rows; dev sees all; own insert; own update (guarded) + dev update.
create policy posts_read_public on posts for select to anon, authenticated using (not deleted and not hidden);
create policy posts_read_dev    on posts for select to authenticated using (is_dev());
create policy posts_insert      on posts for insert to authenticated with check (author_id = auth.uid());
create policy posts_update_own  on posts for update to authenticated using (author_id = auth.uid());
create policy posts_update_dev  on posts for update to authenticated using (is_dev());

-- votes: public read (for counts + "did I vote"); own insert/delete.
create policy votes_read   on votes for select to anon, authenticated using (true);
create policy votes_insert on votes for insert to authenticated with check (user_id = auth.uid());
create policy votes_delete on votes for delete to authenticated using (user_id = auth.uid());

-- comments: public sees non-deleted; dev sees all; non-dev insert (is_official=false) or dev insert; own + dev update.
create policy comments_read_public on comments for select to anon, authenticated using (not deleted);
create policy comments_read_dev    on comments for select to authenticated using (is_dev());
create policy comments_insert_user on comments for insert to authenticated with check (author_id = auth.uid() and is_official = false);
create policy comments_insert_dev  on comments for insert to authenticated with check (is_dev());
create policy comments_update_own  on comments for update to authenticated using (author_id = auth.uid());
create policy comments_update_dev  on comments for update to authenticated using (is_dev());

-- follows: own only (do not expose the follower graph).
create policy follows_read   on follows for select to authenticated using (user_id = auth.uid());
create policy follows_insert on follows for insert to authenticated with check (user_id = auth.uid());
create policy follows_delete on follows for delete to authenticated using (user_id = auth.uid());

-- diagnostics: DEV-ONLY read; insert by the post's author.
create policy diag_read_dev     on post_diagnostics for select to authenticated using (is_dev());
create policy diag_insert_author on post_diagnostics for insert to authenticated
  with check (exists (select 1 from posts p where p.id = post_id and p.author_id = auth.uid()));

-- notifications: own inbox read + update (read_at). Inserts come only from triggers.
create policy notif_read   on notifications for select to authenticated using (user_id = auth.uid());
create policy notif_update on notifications for update to authenticated using (user_id = auth.uid());

-- ───────────────────────── storage (avatars) ─────────────────────────
insert into storage.buckets (id, name, public) values ('avatars','avatars', true)
  on conflict (id) do nothing;
create policy avatars_read         on storage.objects for select to anon, authenticated using (bucket_id = 'avatars');
create policy avatars_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
