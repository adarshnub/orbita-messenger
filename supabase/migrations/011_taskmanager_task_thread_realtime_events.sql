alter table public.realtime_events
drop constraint if exists realtime_events_kind_check;

alter table public.realtime_events
add constraint realtime_events_kind_check
check (
  kind in (
    'direct_conversation_created',
    'group_created',
    'group_member_added',
    'message_created',
    'conversation_read',
    'taskmanager_admin_status_changed',
    'taskmanager_agent_updated',
    'task_thread_updated',
    'task_thread_member_added'
  )
);
