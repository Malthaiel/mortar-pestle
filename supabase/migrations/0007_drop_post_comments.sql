-- 0007_drop_post_comments.sql — removing a table nothing can write to.
--
-- `post_comments` (0004) was built to hold the review a client leaves on their
-- session note. Phase 6 gave reviews their own table instead (0006), because a
-- review is proof-of-purchase text that has to exist whether or not a note was
-- ever written for that day — and there are no notes. Nothing has ever inserted
-- a post_comments row, and after 0006 nothing ever will.
--
-- `coaching_post_published()` goes with it: it was a SECURITY DEFINER helper
-- built for exactly one RLS policy, the one on post_comments.
--
-- The view has to be DROPPED and rebuilt rather than replaced. `create or
-- replace view` may only append columns, and this removes one — comment_count
-- counted the table being deleted, so leaving it would break the view outright.
-- Dropping takes the grants with it, so the grant is re-issued below; that
-- re-grant is not optional decoration, without it the site reads nothing at all.

drop view coaching_posts_public;

create view coaching_posts_public as
  select p.id, p.slug, p.title, p.session_date, p.preview_md, p.published_at,
         p.player_handle
    from coaching_posts p
   where p.published_at is not null;
grant select on coaching_posts_public to anon, authenticated;

drop table post_comments;
drop function coaching_post_published(uuid);
