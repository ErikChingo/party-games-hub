-- Card games (Durak, Blot, Blackjack): everything in the database.
-- Already applied to the live project (zocoaqqcrxpbkyzlfzsf) -- this file is
-- the record of what is there, as of 11 Oct 2026. Running it again is safe.
--
-- How it fits together:
--   * /api/cards (Vercel, region sin1) is the referee. It reads and writes
--     card_rooms through PostgREST with the service key, using an optimistic
--     `version` column (update ... where version = what I read).
--   * Phones read their own view of a room with cards_view(): the deck, the
--     dealer's hidden card (state.secret), other people's hands and everybody's
--     secretHash / profileId never leave the database.
--   * When an online game with at least two people ends (and after every Blot
--     deal / Blackjack round) the referee calls cards_record() to add the
--     result to each person's player_profiles row.

-- ---------- rooms ----------
create table if not exists public.card_rooms (
  code text primary key,
  game text not null default 'durak',
  state jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.card_rooms enable row level security;
-- No policies on purpose: only the service key (the referee) touches the table.
revoke all on public.card_rooms from anon, authenticated;

create or replace function public.cards_view(p_code text, p_player_id text, p_secret text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r card_rooms;
  v_hash text;
  v_ok boolean;
  v_players jsonb;
begin
  if p_code is null or p_player_id is null or p_secret is null then return jsonb_build_object('error', 'bad_request'); end if;
  select * into r from card_rooms where code = p_code;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  v_hash := encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  select exists (select 1 from jsonb_array_elements(r.state->'players') p where p->>'id' = p_player_id and p->>'secretHash' = v_hash) into v_ok;
  if not v_ok then return jsonb_build_object('error', 'not_in_room'); end if;
  select jsonb_agg(
           case when p->>'id' = p_player_id
                then (p - 'secretHash' - 'profileId') || jsonb_build_object('handCount', jsonb_array_length(coalesce(p->'hand', '[]'::jsonb)))
                else (p - 'secretHash' - 'profileId' - 'hand') || jsonb_build_object('handCount', jsonb_array_length(coalesce(p->'hand', '[]'::jsonb)))
           end order by ord)
    into v_players
    from jsonb_array_elements(r.state->'players') with ordinality t(p, ord);
  return jsonb_build_object(
    'ok', true, 'code', r.code, 'version', r.version,
    'view', (r.state - 'deck' - 'secret') || jsonb_build_object('deckCount', jsonb_array_length(coalesce(r.state->'deck', '[]'::jsonb)), 'players', coalesce(v_players, '[]'::jsonb))
  );
end $function$;
grant execute on function public.cards_view(text, text, text) to anon, authenticated;

-- ---------- statistics ----------
alter table public.player_profiles
  add column if not exists durak_games integer not null default 0,
  add column if not exists durak_wins integer not null default 0,
  add column if not exists durak_fools integer not null default 0,
  add column if not exists durak_firsts integer not null default 0,
  add column if not exists blot_games integer not null default 0,
  add column if not exists blot_wins integer not null default 0,
  add column if not exists blot_made integer not null default 0,
  add column if not exists blot_capots integer not null default 0,
  add column if not exists bj_rounds integer not null default 0,
  add column if not exists bj_wins integer not null default 0,
  add column if not exists bj_blackjacks integer not null default 0,
  add column if not exists bj_best_chips integer not null default 0,
  add column if not exists bj_best_win integer not null default 0;

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
    bj_rounds, bj_wins, bj_blackjacks, bj_best_chips, bj_best_win)
  values (p_profile_id, nullif(n, ''), current_date,
    greatest(coalesce((d->>'durak_games')::int, 0), 0), greatest(coalesce((d->>'durak_wins')::int, 0), 0),
    greatest(coalesce((d->>'durak_fools')::int, 0), 0), greatest(coalesce((d->>'durak_firsts')::int, 0), 0),
    greatest(coalesce((d->>'blot_games')::int, 0), 0), greatest(coalesce((d->>'blot_wins')::int, 0), 0),
    greatest(coalesce((d->>'blot_made')::int, 0), 0), greatest(coalesce((d->>'blot_capots')::int, 0), 0),
    greatest(coalesce((d->>'bj_rounds')::int, 0), 0), greatest(coalesce((d->>'bj_wins')::int, 0), 0),
    greatest(coalesce((d->>'bj_blackjacks')::int, 0), 0), greatest(coalesce((d->>'bj_best_chips')::int, 0), 0),
    greatest(coalesce((d->>'bj_best_win')::int, 0), 0))
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
    display_name = coalesce(pp.display_name, nullif(n, '')),
    last_played_date = current_date,
    updated_at = now();
  return jsonb_build_object('ok', true);
end $function$;
-- Only the referee (service key) may write results.
revoke all on function public.cards_record(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.cards_record(text, text, jsonb) to service_role;

-- ---------- changes to older functions (already live) ----------
-- open_room_upsert(): p_game may also be 'durak', 'blot', 'blackjack'
--   (see supabase/open_rooms.sql for the rest of the function).
-- feedback: the rating card may be sent for every game:
alter table public.feedback drop constraint if exists feedback_game_check;
alter table public.feedback add constraint feedback_game_check
  check (game = any (array['spy','alias','croc','wordless','countdown','telephone','mafia','bunker','court','durak','blot','blackjack']::text[]));
-- set_selected_title(): knows four more titles (this replaces the version in
-- supabase/profile_titles.sql):
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
    else false
  end;

  if not unlocked then
    return;
  end if;

  update public.player_profiles set selected_title = p_title_id, updated_at = now() where id = p_id;
end;
$function$;
