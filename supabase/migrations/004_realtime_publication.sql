do $$
declare
  realtime_table text;
  realtime_tables text[] := array[
    'conversations',
    'conversation_participants',
    'messages',
    'message_receipts',
    'message_reactions',
    'contacts',
    'realtime_events'
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

alter table public.conversations replica identity full;
alter table public.conversation_participants replica identity full;
alter table public.messages replica identity full;
alter table public.message_receipts replica identity full;
alter table public.message_reactions replica identity full;
alter table public.contacts replica identity full;
alter table public.realtime_events replica identity full;
