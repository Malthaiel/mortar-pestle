-- 0008_lock_bookings.sql — taking away the last anonymous write path into bookings.
--
-- 0004 gave anon an INSERT policy because the booking page wrote its own row.
-- It no longer does: since 2026-08-04 every booking, free or paid, goes through
-- the create-checkout edge function running as the service role, which bypasses
-- RLS entirely. `Book.jsx:77` states it outright — "the page never writes a
-- booking row, paid or free."
--
-- Left in place that grant is not merely dead, it is a slot-squatting vector.
-- `bookings_before_insert()` pins a free `intro` row to 'confirmed' on purpose
-- (a pending free row falls out of bookings_busy after 30 minutes and silently
-- reopens the slot). So an anonymous script can mint confirmed intro rows that
-- never expire and hold every slot on the calendar. Proven live 2026-08-04: an
-- empty POST /rest/v1/bookings under the anon key returned 23502 (not-null
-- violation — the write was permitted and only the payload was wrong), where
-- every other locked table answers 42501.
--
-- `bookings_busy` is unaffected: it is a SECURITY DEFINER view and runs as its
-- owner, so the site keeps reading busy times from a table anon can no longer
-- touch. `custom_requests` is a separate table and keeps its anon INSERT — the
-- reason the prior audit gave for leaving this open ("the custom-request form
-- needs it") confused the two.

revoke all on bookings from anon;
-- The policy stays for the dev role; only anon leaves its role list.
alter policy bookings_insert on bookings to authenticated;

-- ───────────────────── leftover grants on signed-in-only tables ─────────────────────
--
-- Supabase grants anon everything on a new public table by default. These three
-- are only ever reached by feedback.rs with a user token (`rest(..., true)`) —
-- follows and notifications are per-user, post_diagnostics is a crash-report
-- sink. Their RLS already refuses anon, but a refusal that reaches RLS answers
-- an unprovable `200 []`; revoking the grant turns it into a hard 42501 that an
-- audit can actually read. `profiles`, `posts`, `votes` and `comments` keep
-- theirs — feedback.rs reads all four signed-out for the public board.

revoke all on follows           from anon;
revoke all on notifications     from anon;
revoke all on post_diagnostics  from anon;
