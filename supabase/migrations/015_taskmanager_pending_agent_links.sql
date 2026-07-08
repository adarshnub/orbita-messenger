create table if not exists public.taskmanager_pending_agent_links (
  id uuid primary key default gen_random_uuid(),
  taskmanager_org_id text not null,
  taskmanager_user_id text not null,
  phone text not null,
  agent_display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (taskmanager_org_id, taskmanager_user_id)
);

create index if not exists taskmanager_pending_agent_links_phone_idx
on public.taskmanager_pending_agent_links (phone);

alter table public.taskmanager_pending_agent_links enable row level security;
