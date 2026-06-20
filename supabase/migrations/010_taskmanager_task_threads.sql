create table if not exists public.taskmanager_task_threads (
  id uuid primary key default gen_random_uuid(),
  taskmanager_org_id text not null,
  taskmanager_task_id text not null,
  task_number text not null,
  title text not null,
  parent_task_id text,
  root_task_id text not null,
  status text not null default 'open',
  agent_profile_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (taskmanager_org_id, taskmanager_task_id),
  unique (conversation_id)
);

create index if not exists taskmanager_task_threads_org_root_idx
on public.taskmanager_task_threads (taskmanager_org_id, root_task_id);

create table if not exists public.taskmanager_task_thread_members (
  taskmanager_org_id text not null,
  taskmanager_task_id text not null,
  taskmanager_user_id text not null,
  orbita_user_id uuid references public.profiles(id) on delete set null,
  role text not null default 'member',
  status text not null default 'pending' check (status in ('linked', 'pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (taskmanager_org_id, taskmanager_task_id, taskmanager_user_id)
);

create index if not exists taskmanager_task_thread_members_pending_idx
on public.taskmanager_task_thread_members (taskmanager_org_id, taskmanager_user_id)
where status = 'pending';

alter table public.taskmanager_task_threads enable row level security;
alter table public.taskmanager_task_thread_members enable row level security;
