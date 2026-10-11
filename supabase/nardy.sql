-- Nardy: what the database needs. Applied to the live project
-- (zocoaqqcrxpbkyzlfzsf) on 11 Oct 2026. Running it again is safe.
--
-- Online nardy rooms live in card_rooms like the card games (the referee is
-- /api/cards, phones read their view with cards_view()); nothing new there.
-- Only two lists learn the new game id 'nardy':

-- The rating card ("how was it?") after a game of nardy.
alter table public.feedback drop constraint if exists feedback_game_check;
alter table public.feedback add constraint feedback_game_check
  check (game = any (array['spy','alias','croc','wordless','countdown','telephone','mafia','bunker','court','durak','blot','blackjack','nardy']::text[]));

-- Open rooms: open_room_upsert() accepts 'nardy' (only the first check of
-- the function changes; the rest is as in the live database).
create or replace function public.open_room_upsert(p_game text, p_code text, p_owner_id text, p_secret text, p_name text, p_players integer, p_max integer, p_lang text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_hash text;
  v_row open_rooms;
  v_name text;
  v_players integer;
  v_max integer;
  v_lang text;
  v_id bigint;
begin
  if p_game is null or p_game not in ('bunker', 'court', 'mafia', 'durak', 'blot', 'blackjack', 'nardy') then return jsonb_build_object('error', 'bad_request'); end if;
  if p_code is null or p_code !~ '^[0-9]{4}$' then return jsonb_build_object('error', 'bad_request'); end if;
  if p_owner_id is null or p_owner_id !~ '^[A-Za-z0-9:_-]{4,80}$' then return jsonb_build_object('error', 'bad_request'); end if;
  if p_secret is null or length(p_secret) < 16 or length(p_secret) > 100 then return jsonb_build_object('error', 'bad_request'); end if;

  v_hash := encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  -- A name the filter rejects is shown as a plain "Player" by the website.
  v_name := coalesce(public.moderate_display_name(left(coalesce(p_name, ''), 20)), '');
  v_players := least(20, greatest(1, coalesce(p_players, 1)));
  v_max := case when p_max is null then null else least(20, greatest(2, p_max)) end;
  v_lang := case when p_lang in ('ru', 'en', 'hy') then p_lang else null end;

  select * into v_row from open_rooms where game = p_game and owner_id = p_owner_id;
  if found then
    if v_row.secret_hash <> v_hash then return jsonb_build_object('error', 'forbidden'); end if;
    update open_rooms set code = p_code, host_name = v_name, players = v_players, max_players = v_max, lang = v_lang, updated_at = now() where id = v_row.id;
    return jsonb_build_object('ok', true);
  end if;

  -- A brake on someone flooding the list with made-up rooms.
  if (select count(*) from open_rooms where updated_at > now() - interval '60 seconds') >= 100 then
    return jsonb_build_object('error', 'busy');
  end if;

  begin
    -- Reuse a row nobody has refreshed for a while instead of adding one.
    update open_rooms set game = p_game, code = p_code, owner_id = p_owner_id, secret_hash = v_hash, host_name = v_name,
                          players = v_players, max_players = v_max, lang = v_lang, updated_at = now()
     where id = (select id from open_rooms where updated_at < now() - interval '10 minutes' order by updated_at limit 1 for update skip locked)
     returning id into v_id;
    if v_id is null then
      if (select count(*) from open_rooms) >= 300 then return jsonb_build_object('error', 'busy'); end if;
      insert into open_rooms (game, code, owner_id, secret_hash, host_name, players, max_players, lang)
      values (p_game, p_code, p_owner_id, v_hash, v_name, v_players, v_max, v_lang);
    end if;
  exception when unique_violation then
    return jsonb_build_object('error', 'busy');
  end;
  return jsonb_build_object('ok', true);
end $function$;
