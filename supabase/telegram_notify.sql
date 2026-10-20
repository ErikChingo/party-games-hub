-- Telegram notifications from @hatsit_games_bot. Applied to the live project
-- (zocoaqqcrxpbkyzlfzsf) on 20 Oct 2026. Running it again is safe.
--
-- Only people who allowed the bot to write to them (the «Уведомления» switch
-- in the Mini App -> Telegram's own "allow messages" prompt) are here. The
-- website never touches these tables: /api/notify and /api/cards do, with the
-- service key. Each claim_* function picks who gets a message AND marks them
-- in one step, so two requests at once can never send the same note twice.
--
--   * daily task reminder: once a day (19:00 Yerevan, Vercel cron), only to
--     those who have not done today's task;
--   * «someone is waiting»: when an open room appears, at most once per 3 hours
--     per person, never to the one who opened it;
--   * «your turn»: in an online game, only while the app is in the background,
--     at most once per 3 minutes.

create table if not exists public.tg_subscribers (
  tg_id bigint primary key,
  lang text not null default 'ru',
  want_daily boolean not null default true,
  want_rooms boolean not null default true,
  want_turns boolean not null default true,
  active boolean not null default true, -- false once Telegram says the bot was blocked
  last_daily_ping date,
  last_room_ping timestamptz,
  last_turn_ping timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tg_subscribers enable row level security;
revoke all on public.tg_subscribers from anon, authenticated;

-- One alert per open room (game + code), even though the room's host
-- re-announces it every few seconds.
create table if not exists public.tg_room_alerts (
  game text not null,
  code text not null,
  sent_at timestamptz not null default now(),
  primary key (game, code)
);
alter table public.tg_room_alerts enable row level security;
revoke all on public.tg_room_alerts from anon, authenticated;

-- Today's reminder: everyone subscribed who has not done the task of p_day
-- and has not been reminded on p_day yet. Returns what the message needs.
create or replace function public.tg_claim_daily(p_day date)
returns table (tg_id bigint, lang text, streak integer, done_yesterday boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return query
  update public.tg_subscribers s
     set last_daily_ping = p_day, updated_at = now()
   where s.active and s.want_daily
     and s.last_daily_ping is distinct from p_day
     and not exists (select 1 from public.player_profiles pp where pp.id = 'tg:' || s.tg_id and pp.daily_last = p_day)
  returning s.tg_id, s.lang,
    coalesce((select pp.daily_streak from public.player_profiles pp where pp.id = 'tg:' || s.tg_id), 0),
    coalesce((select pp.daily_last = p_day - 1 from public.player_profiles pp where pp.id = 'tg:' || s.tg_id), false);
end;
$function$;

-- An open room: claims the room once (per 2 hours), then the subscribers to
-- tell (not the host, at most once per 3 hours each). Empty when already sent.
create or replace function public.tg_claim_room(p_game text, p_code text, p_host bigint)
returns table (tg_id bigint, lang text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_claimed boolean;
begin
  insert into public.tg_room_alerts as a (game, code) values (p_game, p_code)
  on conflict (game, code) do update set sent_at = now() where a.sent_at < now() - interval '2 hours'
  returning true into v_claimed;
  if not coalesce(v_claimed, false) then return; end if;
  return query
  update public.tg_subscribers s
     set last_room_ping = now(), updated_at = now()
   where s.active and s.want_rooms
     and s.tg_id is distinct from p_host
     and (s.last_room_ping is null or s.last_room_ping < now() - interval '3 hours')
  returning s.tg_id, s.lang;
end;
$function$;

-- «Your turn» for one person: their language if they want it and were not
-- told in the last 3 minutes, nothing otherwise.
create or replace function public.tg_claim_turn(p_tg bigint)
returns table (tg_id bigint, lang text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return query
  update public.tg_subscribers s
     set last_turn_ping = now(), updated_at = now()
   where s.tg_id = p_tg and s.active and s.want_turns
     and (s.last_turn_ping is null or s.last_turn_ping < now() - interval '3 minutes')
  returning s.tg_id, s.lang;
end;
$function$;

revoke all on function public.tg_claim_daily(date) from public, anon, authenticated;
revoke all on function public.tg_claim_room(text, text, bigint) from public, anon, authenticated;
revoke all on function public.tg_claim_turn(bigint) from public, anon, authenticated;
grant execute on function public.tg_claim_daily(date) to service_role;
grant execute on function public.tg_claim_room(text, text, bigint) to service_role;
grant execute on function public.tg_claim_turn(bigint) to service_role;
