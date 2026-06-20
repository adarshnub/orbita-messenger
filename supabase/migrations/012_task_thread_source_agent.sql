alter table public.taskmanager_task_threads
add column if not exists source_agent_conversation_id uuid references public.conversations(id) on delete set null;

create index if not exists taskmanager_task_threads_source_agent_conversation_idx
on public.taskmanager_task_threads (source_agent_conversation_id);
