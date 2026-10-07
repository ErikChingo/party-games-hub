-- Hatsit: player profiles, records, streaks and post-game ratings.
--
-- This is a copy of what is already in the live database (taken 7 Oct
-- 2026) so the repository has the whole schema. Nothing here needs to be
-- run on the existing project. To build a fresh database, run the files in
-- the order given in README.md.
--
-- * player_profiles  one row per player ("tg:<id>" inside Telegram,
--                    "anon:<uuid>" in a browser). Anyone can read it (the
--                    leaderboard is public); nobody can write it directly
--                    -- every change goes through the functions below.
-- * feedback         the 1-5 rating and comment left after a game. Anyone
--                    can add a row; nobody can read them from the website.

create table if not exists public.player_profiles (
  id text not null primary key,
  display_name text,
  wordless_best integer not null default 0,
  countdown_best integer not null default 0,
  streak_current integer not null default 0,
  streak_longest integer not null default 0,
  last_played_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  bunker_played integer not null default 0,
  court_played integer not null default 0,
  selected_title text,
  -- Online Mafia (filled by mafia_claim_result in mafia_online.sql)
  mafia_games integer not null default 0,
  mafia_wins integer not null default 0,
  mafia_town_wins integer not null default 0,
  mafia_mafia_wins integer not null default 0,
  mafia_maniac_wins integer not null default 0,
  mafia_survived integer not null default 0,
  mafia_finds integer not null default 0,
  mafia_saves integer not null default 0,
  mafia_kills integer not null default 0,
  mafia_good_votes integer not null default 0,
  mafia_roles_mask integer not null default 0,
  mafia_streak integer not null default 0,
  mafia_best_streak integer not null default 0
);
create index if not exists player_profiles_wordless_best_idx on public.player_profiles (wordless_best desc);
create index if not exists player_profiles_countdown_best_idx on public.player_profiles (countdown_best desc);
create index if not exists player_profiles_bunker_played_idx on public.player_profiles (bunker_played desc);
create index if not exists player_profiles_court_played_idx on public.player_profiles (court_played desc);

alter table public.player_profiles enable row level security;
drop policy if exists player_profiles_select_all on public.player_profiles;
create policy player_profiles_select_all on public.player_profiles for select to public using (true);

create table if not exists public.feedback (
  id uuid not null default gen_random_uuid() primary key,
  game text not null check (game = any (array['spy', 'alias', 'mafia', 'bunker', 'court'])),
  rating smallint not null check (rating >= 1 and rating <= 5),
  comment text check (comment is null or char_length(comment) <= 500),
  language text,
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;
drop policy if exists "Allow anonymous feedback insert" on public.feedback;
create policy "Allow anonymous feedback insert" on public.feedback for insert to anon with check (true);

-- ---------- functions the website calls ----------
-- Every name passes through moderate_display_name() (name_moderation.sql).

create or replace function public.set_display_name(p_id text, p_name text)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  p_name := public.moderate_display_name(p_name);
  insert into public.player_profiles (id, display_name) values (p_id, nullif(p_name, ''))
  on conflict (id) do update set display_name = nullif(p_name, ''), updated_at = now();
end;
$function$;

create or replace function public.record_wordless_score(p_id text, p_name text, p_level integer)
returns player_profiles language plpgsql security definer set search_path to 'public' as $function$
declare
  v_row public.player_profiles;
begin
  p_name := public.moderate_display_name(p_name);
  insert into public.player_profiles (id, display_name, wordless_best, last_played_date)
  values (p_id, nullif(p_name, ''), greatest(p_level, 0), current_date)
  on conflict (id) do update set
    wordless_best = greatest(public.player_profiles.wordless_best, excluded.wordless_best),
    display_name = coalesce(nullif(p_name, ''), public.player_profiles.display_name),
    updated_at = now()
  returning * into v_row;
  return v_row;
end;
$function$;

create or replace function public.record_countdown_score(p_id text, p_name text, p_rounds integer)
returns player_profiles language plpgsql security definer set search_path to 'public' as $function$
declare
  v_row public.player_profiles;
begin
  p_name := public.moderate_display_name(p_name);
  insert into public.player_profiles (id, display_name, countdown_best, last_played_date)
  values (p_id, nullif(p_name, ''), greatest(p_rounds, 0), current_date)
  on conflict (id) do update set
    countdown_best = greatest(public.player_profiles.countdown_best, excluded.countdown_best),
    display_name = coalesce(nullif(p_name, ''), public.player_profiles.display_name),
    updated_at = now()
  returning * into v_row;
  return v_row;
end;
$function$;

create or replace function public.record_game_played(p_id text, p_name text, p_game text)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  p_name := public.moderate_display_name(p_name);
  if p_game = 'bunker' then
    insert into public.player_profiles (id, display_name, bunker_played, last_played_date)
    values (p_id, nullif(p_name, ''), 1, current_date)
    on conflict (id) do update set
      bunker_played = public.player_profiles.bunker_played + 1,
      display_name = coalesce(nullif(p_name, ''), public.player_profiles.display_name),
      updated_at = now();
  elsif p_game = 'court' then
    insert into public.player_profiles (id, display_name, court_played, last_played_date)
    values (p_id, nullif(p_name, ''), 1, current_date)
    on conflict (id) do update set
      court_played = public.player_profiles.court_played + 1,
      display_name = coalesce(nullif(p_name, ''), public.player_profiles.display_name),
      updated_at = now();
  else
    raise exception 'record_game_played: invalid p_game %', p_game;
  end if;
end;
$function$;

create or replace function public.record_daily_play(p_id text, p_name text)
returns table(streak_current integer, streak_longest integer)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_last date;
  v_cur int;
  v_long int;
begin
  p_name := public.moderate_display_name(p_name);

  select last_played_date, player_profiles.streak_current, player_profiles.streak_longest
    into v_last, v_cur, v_long
    from public.player_profiles where id = p_id;

  if v_last is null then
    v_cur := 1;
  elsif v_last = current_date then
    v_cur := coalesce(v_cur, 1);
  elsif v_last = current_date - 1 then
    v_cur := coalesce(v_cur, 0) + 1;
  else
    v_cur := 1;
  end if;
  v_long := greatest(coalesce(v_long, 0), v_cur);

  insert into public.player_profiles (id, display_name, streak_current, streak_longest, last_played_date)
  values (p_id, nullif(p_name, ''), v_cur, v_long, current_date)
  on conflict (id) do update set
    streak_current = v_cur,
    streak_longest = v_long,
    display_name = coalesce(nullif(p_name, ''), public.player_profiles.display_name),
    last_played_date = current_date,
    updated_at = now();

  return query select v_cur, v_long;
end;
$function$;

grant execute on function public.set_display_name(text, text) to anon, authenticated;
grant execute on function public.record_wordless_score(text, text, integer) to anon, authenticated;
grant execute on function public.record_countdown_score(text, text, integer) to anon, authenticated;
grant execute on function public.record_game_played(text, text, text) to anon, authenticated;
grant execute on function public.record_daily_play(text, text) to anon, authenticated;
