alter table public.messages
add column if not exists client_message_id text;

create unique index if not exists messages_sender_client_message_id_unique
on public.messages (sender_id, client_message_id)
where client_message_id is not null;
