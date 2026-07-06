alter table public.taskmanager_task_threads
add column if not exists department_ids text[] not null default '{}',
add column if not exists department_names text[] not null default '{}';

