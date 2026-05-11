create extension if not exists pgcrypto;

create type public.conversation_kind as enum ('direct', 'group');
create type public.message_kind as enum ('text', 'image', 'video', 'document', 'audio', 'voice');
create type public.message_delivery_status as enum ('sent', 'delivered', 'read');
create type public.status_kind as enum ('text', 'image', 'video');
create type public.status_visibility as enum ('contacts', 'selected', 'excluded');
create type public.call_kind as enum ('voice', 'video');
create type public.call_status as enum ('ringing', 'active', 'ended', 'missed', 'declined');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Orbita user',
  phone text unique,
  phone_hash text unique,
  avatar_url text,
  about text not null default 'Available',
  last_seen_at timestamptz,
  is_online boolean not null default false,
  public_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_name text not null,
  platform text not null,
  push_token text,
  identity_public_key text not null,
  signed_prekey text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.contacts (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  contact_user_id uuid not null references public.profiles(id) on delete cascade,
  nickname text,
  created_at timestamptz not null default now(),
  primary key (owner_id, contact_user_id),
  check (owner_id <> contact_user_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind public.conversation_kind not null,
  title text,
  avatar_url text,
  invite_code text unique,
  encrypted_group_key text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_participants (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  muted_until timestamptz,
  archived_at timestamptz,
  pinned_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  kind public.message_kind not null default 'text',
  encrypted_payload jsonb not null,
  reply_to_message_id uuid references public.messages(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.message_receipts (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status public.message_delivery_status not null,
  delivered_at timestamptz,
  read_at timestamptz,
  primary key (message_id, user_id)
);

create table public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table public.media_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.messages(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
  bucket text not null,
  object_path text not null,
  mime_type text not null,
  byte_size bigint not null,
  encrypted_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.status_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  kind public.status_kind not null,
  encrypted_payload jsonb not null,
  visibility public.status_visibility not null default 'contacts',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create table public.status_audience (
  status_id uuid not null references public.status_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('selected', 'excluded')),
  primary key (status_id, user_id)
);

create table public.status_views (
  status_id uuid not null references public.status_posts(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (status_id, viewer_id)
);

create table public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete set null,
  created_by uuid not null references public.profiles(id),
  kind public.call_kind not null,
  status public.call_status not null default 'ringing',
  signaling_payload jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.call_participants (
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz,
  left_at timestamptz,
  primary key (call_id, user_id)
);

create or replace function public.is_conversation_member(conversation uuid, member uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_participants
    where conversation_id = conversation and user_id = member
  );
$$;

create or replace function public.can_view_status(status public.status_posts, viewer uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select
    status.author_id = viewer
    or (
      status.expires_at > now()
      and exists (
        select 1 from public.contacts
        where owner_id = status.author_id and contact_user_id = viewer
      )
      and (
        status.visibility = 'contacts'
        or (
          status.visibility = 'selected'
          and exists (
            select 1 from public.status_audience
            where status_id = status.id and user_id = viewer and mode = 'selected'
          )
        )
        or (
          status.visibility = 'excluded'
          and not exists (
            select 1 from public.status_audience
            where status_id = status.id and user_id = viewer and mode = 'excluded'
          )
        )
      )
    );
$$;

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.message_receipts enable row level security;
alter table public.message_reactions enable row level security;
alter table public.media_attachments enable row level security;
alter table public.status_posts enable row level security;
alter table public.status_audience enable row level security;
alter table public.status_views enable row level security;
alter table public.call_sessions enable row level security;
alter table public.call_participants enable row level security;

create policy "profiles are visible to self and contacts"
on public.profiles for select
using (
  id = auth.uid()
  or exists (
    select 1 from public.contacts
    where owner_id = auth.uid() and contact_user_id = profiles.id
  )
);

create policy "users update own profile"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid());

create policy "users insert own profile"
on public.profiles for insert
with check (id = auth.uid());

create policy "users manage own devices"
on public.devices for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "users manage own contacts"
on public.contacts for all
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "members view conversations"
on public.conversations for select
using (public.is_conversation_member(id, auth.uid()));

create policy "users create conversations"
on public.conversations for insert
with check (created_by = auth.uid());

create policy "members update conversations"
on public.conversations for update
using (public.is_conversation_member(id, auth.uid()));

create policy "members view participants"
on public.conversation_participants for select
using (public.is_conversation_member(conversation_id, auth.uid()));

create policy "admins manage participants"
on public.conversation_participants for all
using (
  exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = conversation_participants.conversation_id
      and cp.user_id = auth.uid()
      and cp.role in ('owner', 'admin')
  )
)
with check (
  exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = conversation_participants.conversation_id
      and cp.user_id = auth.uid()
      and cp.role in ('owner', 'admin')
  )
  or user_id = auth.uid()
);

create policy "members view messages"
on public.messages for select
using (public.is_conversation_member(conversation_id, auth.uid()));

create policy "members send messages"
on public.messages for insert
with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id, auth.uid())
);

create policy "senders soft delete messages"
on public.messages for update
using (sender_id = auth.uid())
with check (sender_id = auth.uid());

create policy "members manage own receipts"
on public.message_receipts for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "members view receipts"
on public.message_receipts for select
using (
  exists (
    select 1 from public.messages m
    where m.id = message_receipts.message_id
      and public.is_conversation_member(m.conversation_id, auth.uid())
  )
);

create policy "members react to messages"
on public.message_reactions for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "members view reactions"
on public.message_reactions for select
using (
  exists (
    select 1 from public.messages m
    where m.id = message_reactions.message_id
      and public.is_conversation_member(m.conversation_id, auth.uid())
  )
);

create policy "owners manage media"
on public.media_attachments for all
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "members view message media"
on public.media_attachments for select
using (
  exists (
    select 1 from public.messages m
    where m.id = media_attachments.message_id
      and public.is_conversation_member(m.conversation_id, auth.uid())
  )
);

create policy "authors create statuses"
on public.status_posts for insert
with check (author_id = auth.uid());

create policy "visible statuses"
on public.status_posts for select
using (public.can_view_status(status_posts, auth.uid()));

create policy "authors update statuses"
on public.status_posts for update
using (author_id = auth.uid())
with check (author_id = auth.uid());

create policy "authors manage status audience"
on public.status_audience for all
using (
  exists (
    select 1 from public.status_posts sp
    where sp.id = status_audience.status_id and sp.author_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.status_posts sp
    where sp.id = status_audience.status_id and sp.author_id = auth.uid()
  )
);

create policy "viewers mark visible statuses"
on public.status_views for insert
with check (
  viewer_id = auth.uid()
  and exists (
    select 1 from public.status_posts sp
    where sp.id = status_views.status_id
      and public.can_view_status(sp, auth.uid())
  )
);

create policy "authors view own status views"
on public.status_views for select
using (
  viewer_id = auth.uid()
  or exists (
    select 1 from public.status_posts sp
    where sp.id = status_views.status_id and sp.author_id = auth.uid()
  )
);

create policy "call members view sessions"
on public.call_sessions for select
using (
  created_by = auth.uid()
  or exists (
    select 1 from public.call_participants cp
    where cp.call_id = call_sessions.id and cp.user_id = auth.uid()
  )
);

create policy "users create calls"
on public.call_sessions for insert
with check (created_by = auth.uid());

create policy "call members update sessions"
on public.call_sessions for update
using (
  created_by = auth.uid()
  or exists (
    select 1 from public.call_participants cp
    where cp.call_id = call_sessions.id and cp.user_id = auth.uid()
  )
);

create policy "call members manage participation"
on public.call_participants for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

insert into storage.buckets (id, name, public)
values
  ('avatars', 'avatars', false),
  ('chat-media', 'chat-media', false),
  ('voice-notes', 'voice-notes', false),
  ('status-media', 'status-media', false)
on conflict (id) do nothing;

create policy "users upload own avatar"
on storage.objects for insert
with check (bucket_id = 'avatars' and owner = auth.uid());

create policy "owners read own storage"
on storage.objects for select
using (owner = auth.uid());

do $$
declare
  realtime_table text;
  realtime_tables text[] := array[
    'conversations',
    'conversation_participants',
    'messages',
    'message_receipts',
    'message_reactions',
    'status_posts',
    'status_views',
    'call_sessions',
    'call_participants'
  ];
begin
  foreach realtime_table in array realtime_tables loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = realtime_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', realtime_table);
    end if;
  end loop;
end $$;
