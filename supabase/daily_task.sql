-- Daily task («Задание дня»): one task a day, the same for everyone, picked
-- by the website from the date; any game counts, bots included (Erik's
-- choice), so the phone reports it. Applied to the live project
-- (zocoaqqcrxpbkyzlfzsf) on 20 Oct 2026. Running it again is safe.
--
-- record_daily_task(id, name, day): counts a day at most once. The day is the
-- player's own date (Yerevan is UTC+4), accepted only within a day of the
-- server's, so days cannot be banked ahead. Returns the profile row, like
-- record_wordless_score, so the site can check achievements at once.
-- set_selected_title() also learns the daily_30 title (replaces the version
-- in supabase/nardy_stats.sql).

alter table public.player_profiles
  add column if not exists daily_done integer not null default 0,
  add column if not exists daily_streak integer not null default 0,
  add column if not exists daily_best integer not null default 0,
  add column if not exists daily_last date;

create or replace function public.record_daily_task(p_id text, p_name text, p_day date)
returns public.player_profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.player_profiles;
  v_streak int;
begin
  if p_id is null or p_id !~ '^(tg|anon):[A-Za-z0-9_-]{1,70}$' then return null; end if;
  select * into v_row from public.player_profiles where id = p_id;
  -- Out of range, or this day (or a later one) is counted already.
  if p_day is null or p_day < current_date - 1 or p_day > current_date + 1
     or (v_row.daily_last is not null and p_day <= v_row.daily_last) then
    return v_row;
  end if;
  v_streak := case when v_row.daily_last = p_day - 1 then coalesce(v_row.daily_streak, 0) + 1 else 1 end;
  p_name := public.moderate_display_name(p_name);
  insert into public.player_profiles as pp (id, display_name, last_played_date, daily_done, daily_streak, daily_best, daily_last)
  values (p_id, nullif(p_name, ''), current_date, 1, v_streak, v_streak, p_day)
  on conflict (id) do update set
    daily_done = pp.daily_done + 1,
    daily_streak = v_streak,
    daily_best = greatest(pp.daily_best, v_streak),
    daily_last = p_day,
    display_name = coalesce(pp.display_name, nullif(p_name, '')),
    updated_at = now()
  returning * into v_row;
  return v_row;
end;
$function$;
revoke all on function public.record_daily_task(text, text, date) from public;
grant execute on function public.record_daily_task(text, text, date) to anon, authenticated;

create or replace function public.set_selected_title(p_id text, p_title_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  p public.player_profiles;
  unlocked boolean;
begin
  if p_title_id is null then
    update public.player_profiles set selected_title = null, updated_at = now() where id = p_id;
    return;
  end if;

  select * into p from public.player_profiles where id = p_id;
  if not found then
    return;
  end if;

  -- Mirrors ACHIEVEMENTS in index.html for the ids that have a title.
  unlocked := case p_title_id
    when 'first_steps'  then coalesce(p.wordless_best, 0) > 0 or coalesce(p.countdown_best, 0) > 0
    when 'wordless_5'   then coalesce(p.wordless_best, 0) >= 5
    when 'wordless_10'  then coalesce(p.wordless_best, 0) >= 10
    when 'countdown_5'  then coalesce(p.countdown_best, 0) >= 5
    when 'countdown_10' then coalesce(p.countdown_best, 0) >= 10
    when 'streak_3'     then coalesce(p.streak_longest, 0) >= 3
    when 'streak_7'     then coalesce(p.streak_longest, 0) >= 7
    when 'streak_30'    then coalesce(p.streak_longest, 0) >= 30
    when 'mafia_win_1'      then p.mafia_wins >= 1
    when 'mafia_win_25'     then p.mafia_wins >= 25
    when 'mafia_godfather'  then p.mafia_mafia_wins >= 5
    when 'mafia_sheriff_10' then p.mafia_finds >= 10
    when 'mafia_doctor_10'  then p.mafia_saves >= 10
    when 'court_10'         then p.court_played >= 10
    when 'court_judge_10'   then p.court_judge >= 10
    when 'court_acquitted_5' then p.court_acquitted >= 5
    when 'court_all_roles'  then (p.court_roles_mask & 15) = 15
    when 'durak_win_50'     then p.durak_wins >= 50
    when 'durak_fool_10'    then p.durak_fools >= 10
    when 'blot_win_50'      then p.blot_wins >= 50
    when 'bj_chips_5000'    then p.bj_best_chips >= 5000
    when 'nardy_win_50'     then p.nardy_wins >= 50
    when 'nardy_mars_10'    then p.nardy_mars >= 10
    when 'daily_30'         then coalesce(p.daily_done, 0) >= 30
    else false
  end;

  if not unlocked then
    return;
  end if;

  update public.player_profiles set selected_title = p_title_id, updated_at = now() where id = p_id;
end;
$function$;
