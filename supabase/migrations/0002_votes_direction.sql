-- Mortar & Pestle Feedback Board — migration 0002: directional (up / down) votes.
-- Run ONCE against the project that already has 0001 applied (SQL editor or `supabase db push`).
-- Adds a signed vote direction, splits the denormalized count into up/down + a generated
-- score, and rewrites the count + guard triggers to match. No data migration needed
-- (pre-beta, no rows yet). Plan: Citadel `Knowledge/Mortar & Pestle/Plans/Feedback Board.md`.

-- ── votes: add a signed direction (+1 up / -1 down); one row per (post,user) ──
alter table votes add column value smallint not null default 1 check (value in (-1, 1));

-- ── posts: vote_count → upvote_count + downvote_count + generated score ──
alter table posts rename column vote_count to upvote_count;
alter table posts add column downvote_count integer not null default 0;
alter table posts add column score integer generated always as (upvote_count - downvote_count) stored;

create index if not exists posts_score_idx
  on posts (pinned desc, score desc, created_at desc) where not deleted and not hidden;

-- ── recompute both counts from scratch on any vote change ──
-- Recompute (not delta) is one correct path across add / remove / direction-switch.
create or replace function bump_vote_count() returns trigger
  language plpgsql security definer set search_path = public as $$
declare pid uuid := coalesce(new.post_id, old.post_id);
begin
  perform set_config('app.bypass_post_guard','on',true);
  update posts set
    upvote_count   = (select count(*) from votes where post_id = pid and value =  1),
    downvote_count = (select count(*) from votes where post_id = pid and value = -1)
  where id = pid;
  perform set_config('app.bypass_post_guard','off',true);
  return null;
end; $$;

drop trigger if exists votes_count_trg on votes;
create trigger votes_count_trg after insert or update or delete on votes
  for each row execute function bump_vote_count();

-- ── posts BEFORE UPDATE guard: protect the renamed / new count columns ──
-- (verbatim from 0001 except the count-reset lines; score is generated, untouched).
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
  new.upvote_count   := old.upvote_count;             -- counts only via count triggers
  new.downvote_count := old.downvote_count;
  new.updated_at     := now();
  return new;
end; $$;
