-- Nardy statistics, achievements and titles. Applied to the live project
-- (zocoaqqcrxpbkyzlfzsf) on 11 Oct 2026. Running it again is safe.
--
-- Like the card games, only online games with two people count; the referee
-- (/api/cards, statsEvents) sends the result through cards_record(). This
-- replaces cards_record() and set_selected_title() from supabase/cards.sql.

alter table public.player_profiles
  add column if not exists nardy_games integer not null default 0,
  add column if not exists nardy_wins integer not null default 0,
  add column if not exists nardy_mars integer not null default 0,
  add column if not exists nardy_short_wins integer not null default 0,
  add column if not exists nardy_long_wins integer not null default 0;

create or replace function public.cards_record(p_profile_id text, p_name text, p_delta jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  d jsonb := coalesce(p_delta, '{}'::jsonb);
  n text;
begin
  if p_profile_id is null or p_profile_id !~ '^(tg|anon):[A-Za-z0-9_-]{1,70}$' then return jsonb_build_object('error', 'bad_request'); end if;
  n := public.moderate_display_name(p_name);
  insert into player_profiles as pp (id, display_name, last_played_date,
    durak_games, durak_wins, durak_fools, durak_firsts, blot_games, blot_wins, blot_made, blot_capots,
    bj_rounds, bj_wins, bj_blackjacks, bj_best_chips, bj_best_win,
    nardy_games, nardy_wins, nardy_mars, nardy_short_wins, nardy_long_wins)
  values (p_profile_id, nullif(n, ''), current_date,
    greatest(coalesce((d->>'durak_games')::int, 0), 0), greatest(coalesce((d->>'durak_wins')::int, 0), 0),
    greatest(coalesce((d->>'durak_fools')::int, 0), 0), greatest(coalesce((d->>'durak_firsts')::int, 0), 0),
    greatest(coalesce((d->>'blot_games')::int, 0), 0), greatest(coalesce((d->>'blot_wins')::int, 0), 0),
    greatest(coalesce((d->>'blot_made')::int, 0), 0), greatest(coalesce((d->>'blot_capots')::int, 0), 0),
    greatest(coalesce((d->>'bj_rounds')::int, 0), 0), greatest(coalesce((d->>'bj_wins')::int, 0), 0),
    greatest(coalesce((d->>'bj_blackjacks')::int, 0), 0), greatest(coalesce((d->>'bj_best_chips')::int, 0), 0),
    greatest(coalesce((d->>'bj_best_win')::int, 0), 0),
    greatest(coalesce((d->>'nardy_games')::int, 0), 0), greatest(coalesce((d->>'nardy_wins')::int, 0), 0),
    greatest(coalesce((d->>'nardy_mars')::int, 0), 0), greatest(coalesce((d->>'nardy_short_wins')::int, 0), 0),
    greatest(coalesce((d->>'nardy_long_wins')::int, 0), 0))
  on conflict (id) do update set
    durak_games = pp.durak_games + excluded.durak_games,
    durak_wins = pp.durak_wins + excluded.durak_wins,
    durak_fools = pp.durak_fools + excluded.durak_fools,
    durak_firsts = pp.durak_firsts + excluded.durak_firsts,
    blot_games = pp.blot_games + excluded.blot_games,
    blot_wins = pp.blot_wins + excluded.blot_wins,
    blot_made = pp.blot_made + excluded.blot_made,
    blot_capots = pp.blot_capots + excluded.blot_capots,
    bj_rounds = pp.bj_rounds + excluded.bj_rounds,
    bj_wins = pp.bj_wins + excluded.bj_wins,
    bj_blackjacks = pp.bj_blackjacks + excluded.bj_blackjacks,
    bj_best_chips = greatest(pp.bj_best_chips, excluded.bj_best_chips),
    bj_best_win = greatest(pp.bj_best_win, excluded.bj_best_win),
    nardy_games = pp.nardy_games + excluded.nardy_games,
    nardy_wins = pp.nardy_wins + excluded.nardy_wins,
    nardy_mars = pp.nardy_mars + excluded.nardy_mars,
    nardy_short_wins = pp.nardy_short_wins + excluded.nardy_short_wins,
    nardy_long_wins = pp.nardy_long_wins + excluded.nardy_long_wins,
    display_name = coalesce(pp.display_name, nullif(n, '')),
    last_played_date = current_date,
    updated_at = now();
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.cards_record(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.cards_record(text, text, jsonb) to service_role;

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
    else false
  end;

  if not unlocked then
    return;
  end if;

  update public.player_profiles set selected_title = p_title_id, updated_at = now() where id = p_id;
end;
$function$;
