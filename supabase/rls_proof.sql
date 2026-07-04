-- Feedback Board — RLS deny/allow proof.
-- Runs as-is in TWO places:
--   * Supabase Dashboard -> SQL Editor: open this file, select all, paste, Run.
--   * psql:  psql "<direct-connection-string>" -f supabase/rls_proof.sql
--            (add `-v ON_ERROR_STOP=1` if you want a non-zero exit on failure)
--
-- Proves the access-control model WITHOUT a second app account: each principal is
-- simulated via `SET LOCAL ROLE` + `request.jwt.claims` (exactly what PostgREST does per
-- request). Everything runs inside one transaction that ROLLS BACK — the DB is untouched.
-- A failed check RAISEs and aborts loudly; no error = every check passed.
--
-- Covers the leak-critical policies from 0001_feedback_board.sql:
--   A  anon can read public posts                         (posts_read_public)
--   B  anon CANNOT read post_diagnostics  [LEAK-critical] (diag_read_dev is authenticated+is_dev only)
--   C  a non-dev user cannot change post.status           (posts_update_dev / posts_before_update)
--   D  a dev CAN change post.status                        (posts_update_dev)
--   E  a non-dev cannot self-escalate profiles.role  [LEAK-critical] (profiles_before_update)
--      E runs LAST because it mutates the dev row for setup. To get a *genuine* non-dev
--      principal it force-demotes the dev with the role-guard trigger momentarily disabled
--      (owner-side setup), then attempts self-promotion with the trigger back on — which the
--      trigger must block. Without the disable, the demote itself is reverted by the trigger
--      and the test reads a false LEAK.
-- F (follower notification fan-out on a dev status change) is NOT asserted here: it needs a
--   second real auth.users/profiles row, and cross-user testing was dropped (2026-07-04).

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
    raise exception 'no dev profile found - set profiles.role=''dev'' for your account first';
  end if;
  select id into v_post from posts limit 1;

  -- A: anon can read public posts (raises if the SELECT is denied outright)
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '', true);
  perform count(*) from posts;
  execute 'reset role';
  raise notice 'A PASS: anon can read posts';

  -- B: anon must NOT see post_diagnostics (dev-only). RLS -> 0 rows; a grant-level
  --    denial is also acceptable (both mean "no leak").
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '', true);
  begin
    select count(*) into n from post_diagnostics;
    if n <> 0 then
      raise exception 'B FAIL: anon saw % post_diagnostics rows (LEAK)', n;
    end if;
  exception when insufficient_privilege then
    null;  -- denied at the grant level - still a pass
  end;
  execute 'reset role';
  raise notice 'B PASS: anon sees 0 diagnostics rows';

  -- C: a non-dev user cannot change a post's status
  if v_post is not null then
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_userA, 'role', 'authenticated')::text, true);
    update posts set status = 'planned' where id = v_post;
    get diagnostics n = row_count;
    execute 'reset role';
    if n <> 0 then
      raise exception 'C FAIL: non-dev updated % post row(s)', n;
    end if;
    raise notice 'C PASS: non-dev status change blocked (0 rows)';
  else
    raise notice 'C SKIP: no posts exist to test against';
  end if;

  -- D: a dev CAN change a post's status (run while the dev row is still pristine)
  if v_post is not null then
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_dev, 'role', 'authenticated')::text, true);
    update posts set status = 'under_review' where id = v_post;
    get diagnostics n = row_count;
    execute 'reset role';
    if n <> 1 then
      raise exception 'D FAIL: dev status change touched % row(s), want 1', n;
    end if;
    raise notice 'D PASS: dev status change allowed (1 row)';
  else
    raise notice 'D SKIP: no posts exist to test against';
  end if;

  -- E: a non-dev cannot self-escalate profiles.role. LAST — mutates the dev row.
  --    Setup: force-demote the dev to 'user' with the role-guard trigger disabled, so the
  --    principal is a genuine non-dev (the trigger would otherwise revert the demote).
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  execute 'alter table profiles disable trigger profiles_before_update_trg';
  update profiles set role = 'user' where id = v_dev;
  execute 'alter table profiles enable trigger profiles_before_update_trg';
  --    Attempt: as that now-non-dev principal, self-promote back to dev (trigger must block).
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_dev, 'role', 'authenticated')::text, true);
  update profiles set role = 'dev' where id = v_dev;
  execute 'reset role';
  select role into r from profiles where id = v_dev;
  if r <> 'user' then
    raise exception 'E FAIL: non-dev self-escalation succeeded (role=%) (LEAK)', r;
  end if;
  raise notice 'E PASS: non-dev self role-escalation blocked';

  raise notice 'ALL RLS ASSERTIONS PASSED';
end $$;

rollback;
