-- Hatsit: what people actually do on the site, for the owner's statistics
-- page (hatsit.vercel.app/?stats=1).
--
-- * app_events      one row per "something happened" (site opened, game
--                   started, game finished...). Written only through
--                   log_event(); nobody can read the table directly.
-- * admin_stats()   the numbers for the statistics page, given the password.
-- * set_stats_password()  sets that password. Run it yourself in
--                   Supabase -> SQL Editor:
--                       select set_stats_password('your password here');
--                   It cannot be called from the website.

create table if not exists public.app_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  name text not null,
  game text,
  player_id text,
  lang text,
  platform text,
  extra jsonb
);
create index if not exists app_events_at_idx on public.app_events (at);

create table if not exists public.app_secrets (
  name text primary key,
  hash text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_events enable row level security;
alter table public.app_secrets enable row level security;
revoke all on public.app_events, public.app_secrets from anon, authenticated;

-- Called by the website. Deliberately strict about shape and size: this is
-- an open door, so it only lets small, well-formed rows through.
create or replace function public.log_event(p_name text, p_game text, p_player_id text, p_lang text, p_platform text, p_extra jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_name is null or p_name !~ '^[a-z][a-z0-9_]{1,39}$' then return; end if;
  if p_game is not null and p_game !~ '^[a-z]{2,20}$' then p_game := null; end if;
  if p_player_id is not null and (length(p_player_id) > 80 or p_player_id !~ '^(tg|anon):[A-Za-z0-9_-]+$') then p_player_id := null; end if;
  if p_lang is not null and p_lang not in ('ru', 'en', 'hy') then p_lang := null; end if;
  if p_platform is not null and p_platform not in ('web', 'telegram', 'pwa') then p_platform := null; end if;
  if p_extra is not null and length(p_extra::text) > 400 then p_extra := null; end if;
  insert into app_events (name, game, player_id, lang, platform, extra)
  values (p_name, p_game, p_player_id, p_lang, p_platform, p_extra);
end $$;

create or replace function public.set_stats_password(p_password text)
returns text language plpgsql set search_path = public, pg_temp as $$
begin
  if p_password is null or length(p_password) < 8 then
    return 'Password is too short: use at least 8 characters.';
  end if;
  insert into app_secrets (name, hash) values ('stats', encode(sha256(convert_to(p_password, 'UTF8')), 'hex'))
  on conflict (name) do update set hash = excluded.hash, updated_at = now();
  return 'Password saved. Open hatsit.vercel.app/?stats=1 and enter it.';
end $$;

create or replace function public.admin_stats(p_password text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hash text;
  v_days jsonb; v_games jsonb; v_feedback jsonb; v_comments jsonb; v_totals jsonb; v_split jsonb;
begin
  select hash into v_hash from app_secrets where name = 'stats';
  if v_hash is null then return jsonb_build_object('error', 'not_configured'); end if;
  if p_password is null or encode(sha256(convert_to(p_password, 'UTF8')), 'hex') <> v_hash then
    perform pg_sleep(1);
    return jsonb_build_object('error', 'forbidden');
  end if;

  select jsonb_build_object(
    'profiles', (select count(*) from player_profiles),
    'new_7d', (select count(*) from player_profiles where created_at > now() - interval '7 days'),
    'new_prev_7d', (select count(*) from player_profiles where created_at > now() - interval '14 days' and created_at <= now() - interval '7 days'),
    'active_7d', (select count(distinct player_id) from app_events where at > now() - interval '7 days' and player_id is not null),
    'came_back', (select count(*) from player_profiles where streak_longest >= 2),
    'came_back_3', (select count(*) from player_profiles where streak_longest >= 3),
    'named', (select count(*) from player_profiles where coalesce(display_name, '') <> ''),
    'games_started_7d', (select count(*) from app_events where name = 'game_started' and at > now() - interval '7 days'),
    'games_completed_7d', (select count(*) from app_events where name = 'game_completed' and at > now() - interval '7 days'),
    'events_since', (select min(at) from app_events),
    'feedback', (select count(*) from feedback),
    'rating', (select round(avg(rating), 2) from feedback),
    'mafia_rooms_now', (select count(*) from mafia_rooms where updated_at > now() - interval '2 hours'),
    'mafia_players', (select count(*) from player_profiles where mafia_games > 0)
  ) into v_totals;

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', d::date,
           'new', (select count(*) from player_profiles where created_at::date = d::date),
           'active', (select count(distinct player_id) from app_events where at::date = d::date and player_id is not null),
           'opens', (select count(*) from app_events where at::date = d::date and name = 'app_open'),
           'started', (select count(*) from app_events where at::date = d::date and name = 'game_started'),
           'completed', (select count(*) from app_events where at::date = d::date and name = 'game_completed')
         ) order by d), '[]'::jsonb)
    into v_days
    from generate_series(current_date - 13, current_date, interval '1 day') d;

  select coalesce(jsonb_agg(row_to_json(g) order by g.started desc, g.game), '[]'::jsonb) into v_games from (
    select game,
           count(*) filter (where name = 'game_started' and at > now() - interval '7 days') as started,
           count(*) filter (where name = 'game_completed' and at > now() - interval '7 days') as completed,
           count(distinct player_id) filter (where name = 'game_started' and at > now() - interval '7 days') as players,
           count(*) filter (where name = 'game_started') as started_all
      from app_events where game is not null and name in ('game_started', 'game_completed')
     group by game
  ) g;

  select coalesce(jsonb_agg(row_to_json(f) order by f.n desc), '[]'::jsonb) into v_feedback from (
    select game, count(*) as n, round(avg(rating), 2) as rating from feedback group by game
  ) f;

  select coalesce(jsonb_agg(row_to_json(c)), '[]'::jsonb) into v_comments from (
    select game, rating, comment, language, created_at from feedback order by created_at desc limit 30
  ) c;

  select jsonb_build_object(
    'platform', (select coalesce(jsonb_object_agg(coalesce(platform, 'unknown'), n), '{}'::jsonb) from (
        select platform, count(distinct coalesce(player_id, id::text)) n from app_events where at > now() - interval '7 days' group by platform) p),
    'lang', (select coalesce(jsonb_object_agg(coalesce(lang, 'unknown'), n), '{}'::jsonb) from (
        select lang, count(distinct coalesce(player_id, id::text)) n from app_events where at > now() - interval '7 days' group by lang) l)
  ) into v_split;

  return jsonb_build_object('ok', true, 'generated_at', now(), 'totals', v_totals, 'days', v_days, 'games', v_games,
                            'feedback', v_feedback, 'comments', v_comments, 'split', v_split);
end $$;

revoke execute on function public.log_event(text, text, text, text, text, jsonb) from public;
revoke execute on function public.admin_stats(text) from public;
revoke execute on function public.set_stats_password(text) from public, anon, authenticated;
grant execute on function public.log_event(text, text, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.admin_stats(text) to anon, authenticated;
