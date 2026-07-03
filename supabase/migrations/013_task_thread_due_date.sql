alter table public.taskmanager_task_threads
add column if not exists due_date timestamptz;
