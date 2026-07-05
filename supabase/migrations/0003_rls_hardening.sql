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
