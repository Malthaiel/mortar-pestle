-- Feedback Board — RLS deny/allow proof.
-- Run:  psql "<direct-connection-string>" -f supabase/rls_proof.sql
--   conn = Supabase Dashboard -> Settings -> Database -> Connection string (URI, direct, port 5432).
--
-- Proves the access-control model WITHOUT a second app account: each principal is
-- simulated via `SET LOCAL ROLE` + `request.jwt.claims` (exactly what PostgREST does per
-- request). Everything runs inside one transaction that ROLLS BACK — the DB is untouched.
-- A failed ASSERT aborts loudly (ON_ERROR_STOP -> psql exits non-zero).
--
-- Covers the leak-critical policies from 0001_feedback_board.sql:
--   A  anon can read public posts                         (posts_read_public)
--   B  anon CANNOT read post_diagnostics  [LEAK-critical] (diag_read_dev is authenticated+is_dev only)
--   C  a non-dev user cannot change post.status           (posts_update_dev / posts_before_update)
--   D  a non-dev cannot self-escalate profiles.role  [LEAK-critical] (profiles_before_update)
--   E  a dev CAN change post.status                        (posts_update_dev)
-- F (follower notification fan-out on a dev status change) is NOT asserted here: it needs a
--   second real auth.users/profiles row, and cross-user testing was dropped (2026-07-04). The
--   trigger (notify_status_change) is covered by solo dev-bar verification instead.

\set ON_ERROR_STOP on
set client_min_messages to notice;

begin;

do $$
declare
  v_dev  uuid;
  v_post uuid;
  v_userA uuid := '11111111-1111-1111-1111-111111111111';  -- synthetic non-dev principal
  n int;
  r text;
begin
  select id into v_dev  from profiles where role = 'dev' limit 1;
  if v_dev is null then
    raise exception 'no dev profile found — set profiles.role=''dev'' for your account first';
  end if;
  select id into v_post from posts limit 1;

  -- A ── anon can read public posts (raises if the SELECT is denied outright)
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '', true);
  perform count(*) from posts;
  execute 'reset role';
  raise notice 'A PASS: anon can read posts';

  -- B ── anon must NOT see post_diagnostics (dev-only). RLS -> 0 rows; a grant-level
  --       denial is also acceptable (both mean "no leak").
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '', true);
  begin
    select count(*) into n from post_diagnostics;
    assert n = 0, format('B FAIL: anon saw %s post_diagnostics rows (LEAK)', n);
  exception when insufficient_privilege then
    n := 0;  -- denied at the grant level — still a pass
  end;
  execute 'reset role';
  raise notice 'B PASS: anon sees 0 diagnostics rows';

  -- C ── a non-dev user cannot change a post's status
  if v_post is not null then
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_userA, 'role', 'authenticated')::text, true);
    update posts set status = 'planned' where id = v_post;
    get diagnostics n = row_count;
    execute 'reset role';
    assert n = 0, format('C FAIL: non-dev updated %s post row(s)', n);
    raise notice 'C PASS: non-dev status change blocked (0 rows)';
  else
    raise notice 'C SKIP: no posts exist to test against';
  end if;

  -- D ── no self role-escalation. Demote the dev inside the tx, then (as that now-non-dev
  --       principal) try to self-promote; the profiles_before_update trigger must ignore it.
  update profiles set role = 'user' where id = v_dev;      -- owner bypass; rolled back
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_dev, 'role', 'authenticated')::text, true);
  update profiles set role = 'dev' where id = v_dev;        -- should be silently ignored
  execute 'reset role';
  select role into r from profiles where id = v_dev;
  assert r = 'user', format('D FAIL: self-escalation succeeded (role=%s) (LEAK)', r);
  raise notice 'D PASS: non-dev self role-escalation blocked';
  update profiles set role = 'dev' where id = v_dev;        -- restore for case E (tx rolls back regardless)

  -- E ── a dev CAN change a post's status
  if v_post is not null then
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_dev, 'role', 'authenticated')::text, true);
    update posts set status = 'under_review' where id = v_post;
    get diagnostics n = row_count;
    execute 'reset role';
    assert n = 1, format('E FAIL: dev status change touched %s row(s), want 1', n);
    raise notice 'E PASS: dev status change allowed (1 row)';
  else
    raise notice 'E SKIP: no posts exist to test against';
  end if;

  raise notice '── ALL RLS ASSERTIONS PASSED ──';
end $$;

rollback;
