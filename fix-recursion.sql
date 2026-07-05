-- ================================================================
--  FIX: infinite recursion in group_members RLS policies
--
--  Run this ONCE in the SQL Editor. It's safe even if you already
--  ran the full supabase-schema.sql — this only touches the broken
--  policies, it won't try to recreate tables that already exist.
--
--  Root cause: the original group_members policies queried
--  group_members from within their own policy definition, which
--  Postgres can't resolve (it has to re-check the policy to read the
--  table, which requires re-checking the policy, forever).
--  Fix: SECURITY DEFINER helper functions bypass RLS internally,
--  breaking the loop.
-- ================================================================

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

-- ── Drop and recreate the affected policies ─────────────────────
drop policy if exists "Members can read their group" on public.groups;
create policy "Members can read their group"
  on public.groups for select
  to authenticated
  using (public.is_group_member(id, auth.uid()));

drop policy if exists "Admins can update group details" on public.groups;
create policy "Admins can update group details"
  on public.groups for update
  to authenticated
  using (public.is_group_admin(id, auth.uid()));

drop policy if exists "Members can see the member list of their group" on public.group_members;
create policy "Members can see the member list of their group"
  on public.group_members for select
  to authenticated
  using (public.is_group_member(group_id, auth.uid()));

drop policy if exists "Admins can add members, or a user can add themself on creation" on public.group_members;
create policy "Admins can add members, or a user can add themself on creation"
  on public.group_members for insert
  to authenticated
  with check (
    auth.uid() = user_id
    or public.is_group_admin(group_id, auth.uid())
  );

drop policy if exists "Admins can change roles, members can remove themselves" on public.group_members;
create policy "Admins can change roles, members can remove themselves"
  on public.group_members for update
  to authenticated
  using (public.is_group_admin(group_id, auth.uid()));

drop policy if exists "Admins can remove others, members can remove themselves" on public.group_members;
create policy "Admins can remove others, members can remove themselves"
  on public.group_members for delete
  to authenticated
  using (
    auth.uid() = user_id
    or public.is_group_admin(group_id, auth.uid())
  );

drop policy if exists "DM participants can read messages" on public.messages;
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

drop policy if exists "DM participants and group members can send messages" on public.messages;
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

drop policy if exists "Chat members can see typing status" on public.typing_status;
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
