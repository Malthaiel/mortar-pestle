-- 0005 — a session post may credit the player it was for, and the locked note
-- bodies stop resting on a single mechanism.
--
-- Additive only. Nothing is dropped and no existing column changes shape.

-- Optional by construction: nullable, and the publish script sets it only when
-- the note's frontmatter carries `player_handle`. Silence is the default, so a
-- post is anonymous unless the player actually agreed to be named.
alter table coaching_posts add column player_handle text
  check (player_handle is null or char_length(player_handle) between 1 and 40);

-- `create or replace view` may append columns but never reorder the existing
-- ones, so player_handle goes last. body_md is still not a column of this view.
-- That absence IS the privacy mechanism — this change must not disturb it.
create or replace view coaching_posts_public as
  select p.id, p.slug, p.title, p.session_date, p.preview_md, p.published_at,
         (select count(*) from post_comments c where c.post_id = p.id) as comment_count,
         p.player_handle
    from coaching_posts p
   where p.published_at is not null;
grant select on coaching_posts_public to anon, authenticated;

-- Belt and braces. Row-level security already returned nothing to anon here, but
-- the table-level SELECT grant was still being handed out, so a future policy
-- mistake would have been enough on its own to expose every locked body. Two
-- independent locks now.
--
-- Safe for the public view: a Postgres view executes with its owner's rights,
-- not the caller's, so coaching_posts_public keeps reading the base table.
-- `authenticated` keeps its grant — the dev policy needs it.
revoke select on coaching_posts from anon;
