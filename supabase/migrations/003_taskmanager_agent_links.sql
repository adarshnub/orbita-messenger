create table if not exists public.taskmanager_agent_links (
  id uuid primary key default gen_random_uuid(),
  taskmanager_org_id text not null,
  taskmanager_user_id text not null,
  orbita_user_id uuid not null references public.profiles(id) on delete cascade,
  agent_profile_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (taskmanager_org_id, taskmanager_user_id),
  unique (conversation_id)
);

create index if not exists taskmanager_agent_links_conversation_idx
on public.taskmanager_agent_links (conversation_id)
where enabled = true;

alter table public.taskmanager_agent_links enable row level security;
