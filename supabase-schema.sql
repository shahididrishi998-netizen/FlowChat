-- ================================================================
--  FlowChat — Supabase Database Schema
--
--  HOW TO RUN:
--  Supabase Dashboard → SQL Editor → New query → paste this whole
--  file → Run. Safe to run once on a fresh project.
-- ================================================================

-- ── Extensions ───────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ================================================================
--  TABLES
-- ================================================================

-- ── profiles ─────────────────────────────────────────────────────
-- One row per auth user. Created automatically by a trigger (below)
-- the moment someone signs up — mirrors what `users/{uid}` did in
-- the old Firestore version.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  email       text not null,
  avatar_url  text,
  online      boolean not null default false,
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- ── conversations ────────────────────────────────────────────────
-- One row per DM thread between exactly two users.
create table public.conversations (
  id            uuid primary key default uuid_generate_v4(),
  user_a        uuid not null references public.profiles(id) on delete cascade,
  user_b        uuid not null references public.profiles(id) on delete cascade,
  last_message  text,
  last_at       timestamptz,
  created_at    timestamptz not null default now(),
  constraint different_users check (user_a <> user_b),
  -- Prevent duplicate conversations between the same pair regardless of order.
  constraint unique_pair unique (user_a, user_b)
);
create index idx_conversations_user_a on public.conversations(user_a);
create index idx_conversations_user_b on public.conversations(user_b);

-- ── groups ───────────────────────────────────────────────────────
create table public.groups (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  photo_url   text,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  last_message text,
  last_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- ── group_members ────────────────────────────────────────────────
-- Junction table: who's in which group, and who's an admin.
-- This replaces the memberIds/admins arrays from the Firestore version
-- with a proper relational table — easier to secure with RLS and to
-- query ("which groups am I in").
create table public.group_members (
  group_id    uuid not null references public.groups(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  is_admin    boolean not null default false,
  joined_at   timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index idx_group_members_user on public.group_members(user_id);

-- ── messages ─────────────────────────────────────────────────────
-- Unified table for BOTH DM and group messages. `conversation_id` xor
-- `group_id` is set, never both — simpler than two separate tables
-- with duplicated logic, and makes the chat.js code path uniform.
create table public.messages (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  group_id        uuid references public.groups(id) on delete cascade,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  type            text not null default 'text' check (type in ('text','image','video','audio','file')),
  text            text,
  url             text,
  file_name       text,
  file_size       bigint,
  reply_to_id     uuid references public.messages(id) on delete set null,
  reply_to_name   text,
  reply_to_text   text,
  edited          boolean not null default false,
  deleted         boolean not null default false,
  created_at      timestamptz not null default now(),
  constraint exactly_one_target check (
    (conversation_id is not null and group_id is null) or
    (conversation_id is null and group_id is not null)
  )
);
create index idx_messages_conversation on public.messages(conversation_id, created_at);
create index idx_messages_group on public.messages(group_id, created_at);

-- ── typing_status ────────────────────────────────────────────────
-- Ephemeral "X is typing…" state. One row per (chat, user); upserted
-- on every keystroke and naturally goes stale — frontend treats
-- updated_at older than ~5s as "not typing". Uses a surrogate id +
-- two partial unique indexes (DM vs group) since Postgres unique
-- constraints don't play well with nullable composite keys.
create table public.typing_status (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  group_id        uuid references public.groups(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  updated_at      timestamptz not null default now(),
  constraint exactly_one_target_typing check (
    (conversation_id is not null and group_id is null) or
    (conversation_id is null and group_id is not null)
  )
);
create unique index typing_status_dm_unique
  on public.typing_status (conversation_id, user_id)
  where conversation_id is not null;
create unique index typing_status_group_unique
  on public.typing_status (group_id, user_id)
  where group_id is not null;

-- ================================================================
--  AUTO-CREATE PROFILE ON SIGNUP
-- ================================================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ================================================================
--  ROW LEVEL SECURITY
-- ================================================================
alter table public.profiles      enable row level security;
alter table public.conversations enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.messages      enable row level security;
alter table public.typing_status enable row level security;

-- ── profiles ─────────────────────────────────────────────────────
create policy "Anyone signed in can read profiles"
  on public.profiles for select
  to authenticated
  using (true);

create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id);

-- ── conversations ────────────────────────────────────────────────
create policy "Participants can read their conversation"
  on public.conversations for select
  to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);

create policy "Authenticated users can start a conversation"
  on public.conversations for insert
  to authenticated
  with check (auth.uid() = user_a or auth.uid() = user_b);

create policy "Participants can update their conversation"
  on public.conversations for update
  to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);

-- ── groups ───────────────────────────────────────────────────────
-- Helper functions: SECURITY DEFINER means these run with the
-- privileges of the function owner (bypassing RLS on group_members),
-- which breaks the recursion loop that happens when a group_members
-- policy tries to query group_members itself.
create or replace function public.is_group_member(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id
  );
$$;

create or replace function public.is_group_admin(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id and is_admin = true
  );
$$;

create policy "Members can read their group"
  on public.groups for select
  to authenticated
  using (public.is_group_member(id, auth.uid()));

create policy "Authenticated users can create a group"
  on public.groups for insert
  to authenticated
  with check (auth.uid() = created_by);

create policy "Admins can update group details"
  on public.groups for update
  to authenticated
  using (public.is_group_admin(id, auth.uid()));

create policy "Creator can delete the group"
  on public.groups for delete
  to authenticated
  using (auth.uid() = created_by);

-- ── group_members ────────────────────────────────────────────────
-- Each policy below uses the helper functions instead of querying
-- group_members directly from within its own policy — this is what
-- avoids the "infinite recursion detected in policy" error.
create policy "Members can see the member list of their group"
  on public.group_members for select
  to authenticated
  using (public.is_group_member(group_id, auth.uid()));

create policy "Admins can add members, or a user can add themself on creation"
  on public.group_members for insert
  to authenticated
  with check (
    auth.uid() = user_id  -- joining yourself (e.g. creator's first row)
    or public.is_group_admin(group_id, auth.uid())
  );

create policy "Admins can change roles, members can remove themselves"
  on public.group_members for update
  to authenticated
  using (public.is_group_admin(group_id, auth.uid()));

create policy "Admins can remove others, members can remove themselves"
  on public.group_members for delete
  to authenticated
  using (
    auth.uid() = user_id
    or public.is_group_admin(group_id, auth.uid())
  );


-- ── messages ─────────────────────────────────────────────────────
create policy "DM participants can read messages"
  on public.messages for select
  to authenticated
  using (
    (conversation_id is not null and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and (c.user_a = auth.uid() or c.user_b = auth.uid())
    ))
    or
    (group_id is not null and public.is_group_member(group_id, auth.uid()))
  );

create policy "DM participants and group members can send messages"
  on public.messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and (
      (conversation_id is not null and exists (
        select 1 from public.conversations c
        where c.id = conversation_id and (c.user_a = auth.uid() or c.user_b = auth.uid())
      ))
      or
      (group_id is not null and public.is_group_member(group_id, auth.uid()))
    )
  );

create policy "Senders can edit or soft-delete their own messages"
  on public.messages for update
  to authenticated
  using (sender_id = auth.uid());

-- ── typing_status ────────────────────────────────────────────────
create policy "Chat members can see typing status"
  on public.typing_status for select
  to authenticated
  using (
    (conversation_id is not null and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and (c.user_a = auth.uid() or c.user_b = auth.uid())
    ))
    or
    (group_id is not null and public.is_group_member(group_id, auth.uid()))
  );

create policy "Users can upsert their own typing status"
  on public.typing_status for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update their own typing status"
  on public.typing_status for update
  to authenticated
  using (user_id = auth.uid());

create policy "Users can delete their own typing status"
  on public.typing_status for delete
  to authenticated
  using (user_id = auth.uid());

-- ================================================================
--  REALTIME — enable live updates on these tables
-- ================================================================
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.groups;
alter publication supabase_realtime add table public.group_members;
alter publication supabase_realtime add table public.typing_status;
alter publication supabase_realtime add table public.profiles;

-- ================================================================
--  STORAGE BUCKET — media (images, video, audio, files)
-- ================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', true, 104857600) -- 100MB
on conflict (id) do nothing;

create policy "Anyone signed in can read media"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'media');

create policy "Anyone signed in can upload media"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'media');

create policy "Uploader can delete their own media"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'media' and owner = auth.uid());
