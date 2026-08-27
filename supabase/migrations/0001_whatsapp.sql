-- Quadem WhatsApp intake
-- Run this in the Supabase SQL editor, or save it under supabase/migrations/ and push.

-- ---------------------------------------------------------------------------
-- Raw inbound log. This is the idempotency guard: Meta retries deliveries, and
-- processing the same message twice would create two leads. wa_message_id is
-- unique, so a retry hits the conflict and does nothing.
-- ---------------------------------------------------------------------------
create table if not exists public.wa_messages (
  id            bigserial primary key,
  wa_message_id text not null unique,
  from_wa_id    text not null,
  profile_name  text,
  body          text,
  msg_type      text not null default 'text',
  raw           jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  process_error text
);

create index if not exists wa_messages_from_idx on public.wa_messages (from_wa_id, received_at desc);
create index if not exists wa_messages_unprocessed_idx
  on public.wa_messages (received_at)
  where processed_at is null;

-- ---------------------------------------------------------------------------
-- One row per person who has ever messaged. wa_id is the WhatsApp phone number
-- in international format without the plus, which is what Meta sends and what
-- you send back to. It is the join key for everything.
-- ---------------------------------------------------------------------------
create type wa_stage as enum (
  'new',              -- greeted, waiting on what they need
  'asked_need',
  'asked_city',
  'asked_website',
  'qualified',        -- all three answers captured
  'needs_human',      -- flow could not classify, do not auto-reply again
  'closed'
);

create table if not exists public.wa_leads (
  id             bigserial primary key,
  wa_id          text not null unique,
  profile_name   text,
  stage          wa_stage not null default 'new',

  -- what the flow captures
  need           text,          -- free text: what they said they want
  city           text,
  has_website    boolean,
  website_url    text,

  -- your own qualification, filled in later by you or by a scoring job
  headline_fault text,
  fault_severity text check (fault_severity in ('critical','high','medium','low')),
  recommended_tier text check (recommended_tier in ('starter','growth','premium')),

  first_seen_at  timestamptz not null default now(),
  qualified_at   timestamptz,   -- speed to lead is measured from first_seen_at to here
  last_message_at timestamptz not null default now(),
  notes          text
);

create index if not exists wa_leads_stage_idx on public.wa_leads (stage, last_message_at desc);

-- ---------------------------------------------------------------------------
-- Outbound log. Every message the system sends, with the Meta message id it
-- came back with. Without this you cannot answer "did we actually reply?"
-- ---------------------------------------------------------------------------
create table if not exists public.wa_outbound (
  id            bigserial primary key,
  wa_id         text not null,
  body          text not null,
  in_reply_to   text,                    -- wa_message_id that triggered it
  wa_message_id text,                    -- id Meta returned, null if send failed
  error         text,
  sent_at       timestamptz not null default now()
);

create index if not exists wa_outbound_wa_id_idx on public.wa_outbound (wa_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- Lock everything down. The edge function uses the service role key and bypasses
-- RLS. Nothing else should be able to read customer conversations.
-- ---------------------------------------------------------------------------
alter table public.wa_messages enable row level security;
alter table public.wa_leads    enable row level security;
alter table public.wa_outbound enable row level security;
-- No policies created deliberately: with RLS on and no policy, anon and
-- authenticated get nothing. Add a policy later if you build an inbox UI.

-- ---------------------------------------------------------------------------
-- The view you will actually look at each morning.
-- ---------------------------------------------------------------------------
-- security_invoker is required. Without it Postgres runs the view with the
-- creator's permissions and bypasses the querying user's RLS, exposing
-- wa_leads through the view even though RLS is enabled on the table.
create or replace view public.wa_inbox
with (security_invoker = on) as
select
  l.wa_id,
  l.profile_name,
  l.stage,
  l.city,
  l.need,
  l.has_website,
  l.website_url,
  l.recommended_tier,
  l.first_seen_at,
  l.qualified_at,
  case
    when l.qualified_at is not null
    then round(extract(epoch from (l.qualified_at - l.first_seen_at)) / 60)
  end as minutes_to_qualify,
  l.last_message_at
from public.wa_leads l
order by l.last_message_at desc;
