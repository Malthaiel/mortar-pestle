-- 0006_reviews.sql — Phase 6 of malthaiel.com: reviews from real clients.
--
-- A review is proof-of-purchase text. The proof is `bookings.review_token`, a
-- uuid minted only when a booking reaches 'confirmed' — by create-checkout for a
-- free session, by stripe-webhook for a paid one. Nobody without that token can
-- write here at all: anon has no INSERT policy of any kind, and the only path in
-- is the `review` edge function, running as the service role.
--
-- `booking_id unique` IS the one-use rule, in the database rather than in
-- function logic. A second submission on the same token is a 23505 the database
-- refuses, not a branch a future edit can forget to write.
--
-- A review is joined to a session note by DATE, not by a foreign key. A note is
-- usually written after the review has already arrived, so a link stored at
-- submit time would be null nearly every time; matching on the day means a note
-- written later picks up its review on its own, with nothing to backfill.

create table reviews (
  id             uuid primary key default gen_random_uuid(),
  booking_id     uuid not null unique references bookings(id) on delete cascade,
  session_date   date not null,
  -- '' is a deliberate value, not a missing one: the form's name box can be
  -- cleared, and an empty one means the reviewer chose to stay anonymous.
  author_name    text not null default '' check (char_length(author_name) <= 60),
  rating         smallint not null check (rating between 1 and 5),
  body           text not null check (char_length(body) between 1 and 4000),
  -- Nothing is public until Malthaiel says so. `default false` is the entire
  -- moderation policy — there is no other gate to keep in sync with it.
  approved       boolean not null default false,
  -- The secret inside the publish / bin links emailed to him. Random per review,
  -- so a leaked link can moderate that one review and nothing else.
  moderation_key text not null,
  created_at     timestamptz not null default now()
);
create index reviews_date_idx on reviews (session_date);

alter table reviews enable row level security;
-- No anon policy at all. booking_id and moderation_key are unreachable with the
-- anon key; the public read goes through the view below.
create policy reviews_dev on reviews for all to authenticated
  using (is_dev()) with check (is_dev());

-- Supabase grants anon everything on a new public table by default, leaving RLS
-- as the only thing in the way. RLS does hold — an anon insert is a 42501 — but
-- an anon SELECT then answers `200 []`, which is indistinguishable from a table
-- that is simply empty and cannot be proven either way. Revoking makes a read a
-- hard 42501, exactly as 0005 did for coaching_posts. The view below is
-- unaffected: a view runs with its OWNER's rights, not the caller's.
revoke all on reviews from anon;

-- The public shape. Like coaching_posts_public this is SECURITY DEFINER by
-- default (no `security_invoker`), so it runs with its owner's rights and can
-- read a table anon cannot — and it simply has no booking_id or moderation_key
-- column to ask for. Unapproved rows are not filtered downstream either; they
-- are not in the view.
create view reviews_public as
  select id, session_date, author_name, rating, body, created_at
    from reviews
   where approved;
grant select on reviews_public to anon, authenticated;
