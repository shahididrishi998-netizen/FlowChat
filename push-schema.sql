-- ================================================================
--  FlowChat — Push Notifications Schema
--
--  Run this AFTER supabase-schema.sql and fix-recursion.sql.
--  Adds: push_subscriptions table, RLS, and a trigger that calls
--  an Edge Function whenever a new message is inserted.
-- ================================================================

-- ── push_subscriptions ───────────────────────────────────────────
-- One row per (user, browser/device). A user can have multiple rows
-- if they're logged in on phone + laptop, etc.
create table public.push_subscriptions (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth_key    text not null,
  created_at  timestamptz not null default now()
);
create index idx_push_subscriptions_user on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

create policy "Users manage their own push subscriptions"
  on public.push_subscriptions for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ================================================================
--  TRIGGER: call the send-push Edge Function on every new message
-- ================================================================
-- Uses pg_net (bundled with Supabase) to fire an async HTTP request
-- to the Edge Function without blocking the insert. Replace
-- YOUR_PROJECT_REF and YOUR_SERVICE_ROLE_KEY below once you've
-- created the project (Settings → API → service_role key).
--
-- IMPORTANT: the service_role key is SECRET — never put it in
-- chat.js or any client-side file. It only belongs here, inside a
-- database function that runs on Supabase's own servers.

create extension if not exists pg_net;

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://zvmzkoinoivbvnwkodhu.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' + 
    ),
    body := jsonb_build_object(
      'message_id', new.id,
      'sender_id', new.sender_id,
      'conversation_id', new.conversation_id,
      'group_id', new.group_id,
      'type', new.type,
      'text', new.text
    )
  );
  return new;
end;
$$;

create trigger on_message_insert_notify
  after insert on public.messages
  for each row execute function public.notify_new_message();

-- ================================================================
--  REALTIME — include push_subscriptions if you want to debug it
--  live in the dashboard (optional, not required for push to work)
-- ================================================================
-- alter publication supabase_realtime add table public.push_subscriptions;
