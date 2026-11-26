-- The design copilot (the panel in the editor) stores its turns next to the consultant chat, kept apart by kind.
-- payload holds the structured turn: the scope of a question, or the checked reply (observations, recommendations).
-- Both kinds share one daily cap per user, so the copilot cannot be used to get around the chat's limit.
alter table public.ai_messages
  add column kind text not null default 'chat' check (kind in ('chat', 'copilot')),
  add column payload jsonb check (payload is null or (jsonb_typeof(payload) = 'object' and pg_column_size(payload) < 65536));

drop index public.ai_messages_conversation_idx;
create index ai_messages_conversation_idx on public.ai_messages (conversation_id, kind, id);

drop function public.reserve_ai_message(uuid, uuid, text, int);
create function public.reserve_ai_message(
  p_conversation uuid, p_user uuid, p_content text, p_cap int, p_kind text default 'chat', p_payload jsonb default null
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare used int; new_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  select count(*) into used
    from public.ai_messages m join public.ai_conversations c on c.id = m.conversation_id
   where c.user_id = p_user and m.role = 'user' and m.created_at > now() - interval '1 day';
  if used >= p_cap then
    raise exception 'daily message cap reached' using errcode = 'P0001';
  end if;
  insert into public.ai_messages (conversation_id, role, content, kind, payload)
    values (p_conversation, 'user', p_content, p_kind, p_payload)
    returning id into new_id;
  return new_id;
end $$;

revoke all on function public.reserve_ai_message(uuid, uuid, text, int, text, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_ai_message(uuid, uuid, text, int, text, jsonb) to service_role;
