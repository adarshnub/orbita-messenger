create table if not exists public.realtime_events (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  kind text not null check (
    kind in (
      'direct_conversation_created',
      'group_created',
      'group_member_added',
      'message_created',
      'conversation_read'
    )
  ),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists realtime_events_target_created_idx
on public.realtime_events (target_user_id, created_at desc);

create index if not exists realtime_events_conversation_idx
on public.realtime_events (conversation_id);

alter table public.realtime_events enable row level security;

create policy "users view own realtime events"
on public.realtime_events for select
using (target_user_id = auth.uid());

create policy "users mark own realtime events"
on public.realtime_events for update
using (target_user_id = auth.uid())
with check (target_user_id = auth.uid());

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'realtime_events'
  ) then
    alter publication supabase_realtime add table public.realtime_events;
  end if;
end $$;
