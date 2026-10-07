-- Mafia "room by code" mode with an automatic host.
--
-- Unlike Bunker/Court (where the room creator's phone holds the whole room
-- and broadcasts it to everyone), every role and every calculation lives
-- here: the creator is an ordinary player, so nothing secret may ever sit
-- on a phone. Both tables are closed to direct reads (RLS on, no policies);
-- phones only talk to the SECURITY DEFINER functions at the bottom, and
-- each call returns that one player's view of the room.

create table if not exists public.mafia_rooms (
  code text primary key,
  host_id text not null,
  voice_id text,
  status text not null default 'lobby',
  settings jsonb not null default '{}'::jsonb,
  phase text not null default 'lobby',
  phase_role text,
  phase_seq integer not null default 0,
  phase_deadline timestamptz,
  phase_speech_seq integer,
  night integer not null default 0,
  speech jsonb not null default '[]'::jsonb,
  speech_seq integer not null default 0,
  act_done boolean not null default false,
  putana_target integer,
  mafia_target integer,
  mafia_missed boolean not null default false,
  don_target integer,
  don_result jsonb,
  maniac_target integer,
  doctor_target integer,
  sheriff_target integer,
  sheriff_result jsonb,
  last_night jsonb,
  lastword_queue integer[] not null default '{}',
  lastword_kind text,
  speaker_seat integer,
  vote_result jsonb,
  exiled_seat integer,
  winner text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mafia_players (
  room_code text not null references public.mafia_rooms(code) on delete cascade,
  player_id text not null,
  secret text not null,
  name text not null,
  seat integer not null,
  joined_at timestamptz not null default now(),
  role text,
  role_public boolean not null default false,
  alive boolean not null default true,
  ready boolean not null default false,
  warnings integer not null default 0,
  no_vote boolean not null default false,
  warned_day integer,
  spoke_day integer,
  night_pick integer,
  vote_target integer,
  voted boolean not null default false,
  can_speak boolean not null default false,
  last_seen timestamptz not null default now(),
  primary key (room_code, player_id)
);

create table if not exists public.mafia_complaints (
  room_code text not null references public.mafia_rooms(code) on delete cascade,
  day integer not null,
  from_id text not null,
  target_seat integer not null,
  primary key (room_code, day, from_id, target_seat)
);

alter table public.mafia_rooms enable row level security;
alter table public.mafia_players enable row level security;
alter table public.mafia_complaints enable row level security;
revoke all on public.mafia_rooms, public.mafia_players, public.mafia_complaints from anon, authenticated;

create index if not exists mafia_rooms_updated_at_idx on public.mafia_rooms (updated_at);

------------------------------------------------------------------------
-- Internal helpers (not callable from phones; see the revoke at the end)
------------------------------------------------------------------------

-- Host phrases are a short queue rather than a single slot, so two things
-- said back to back ("X is out" + "Y speaks") both reach the voice phone.
create or replace function public.mafia__say(p_code text, p_key text, p_params jsonb)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare
  v_seq integer;
begin
  update mafia_rooms
     set speech_seq = speech_seq + 1,
         speech = (
           select coalesce(jsonb_agg(e order by (e->>'seq')::int), '[]'::jsonb)
           from (
             select e from jsonb_array_elements(speech) e where (e->>'seq')::int > speech_seq - 5
             union all
             select jsonb_build_object('seq', speech_seq + 1, 'key', p_key, 'params', coalesce(p_params, '{}'::jsonb))
           ) q
         ),
         updated_at = now()
   where code = p_code
   returning speech_seq into v_seq;
  return v_seq;
end $$;

-- p_gate: the phase is "the host is talking" and ends as soon as the voice
-- phone reports the phrase finished (p_seconds is then only the fallback
-- for a room where no phone can speak).
-- Per-game facts about each player ("found the mafia twice", "saved one"),
-- turned into profile statistics when the player claims the result.
alter table public.mafia_players add column if not exists stats jsonb not null default '{}'::jsonb;
alter table public.mafia_players add column if not exists claimed boolean not null default false;

alter table public.player_profiles add column if not exists mafia_games integer not null default 0;
alter table public.player_profiles add column if not exists mafia_wins integer not null default 0;
alter table public.player_profiles add column if not exists mafia_town_wins integer not null default 0;
alter table public.player_profiles add column if not exists mafia_mafia_wins integer not null default 0;
alter table public.player_profiles add column if not exists mafia_maniac_wins integer not null default 0;
alter table public.player_profiles add column if not exists mafia_survived integer not null default 0;
alter table public.player_profiles add column if not exists mafia_finds integer not null default 0;
alter table public.player_profiles add column if not exists mafia_saves integer not null default 0;
alter table public.player_profiles add column if not exists mafia_kills integer not null default 0;
alter table public.player_profiles add column if not exists mafia_good_votes integer not null default 0;
alter table public.player_profiles add column if not exists mafia_roles_mask integer not null default 0;
alter table public.player_profiles add column if not exists mafia_streak integer not null default 0;
alter table public.player_profiles add column if not exists mafia_best_streak integer not null default 0;

create or replace function public.mafia__bump(p_code text, p_seat integer, p_key text)
returns void language sql set search_path = public, pg_temp as $$
  update mafia_players
     set stats = jsonb_set(stats, array[p_key], to_jsonb(coalesce((stats->>p_key)::int, 0) + 1))
   where room_code = p_code and seat = p_seat;
$$;

-- Earliest moment a "host is speaking" phase may end. The voice phone ends
-- such a phase as soon as it has finished the sentence, but a phone with no
-- voice for the language "finishes" in a few milliseconds -- without this
-- floor the vote result and the morning news flashed by unread.
alter table public.mafia_rooms add column if not exists phase_min_until timestamptz;

create or replace function public.mafia__enter(p_code text, p_phase text, p_role text, p_seconds numeric, p_key text, p_params jsonb, p_gate boolean)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_seq integer := null;
  v_seconds numeric := p_seconds;
begin
  if p_key is not null then
    v_seq := mafia__say(p_code, p_key, p_params);
  end if;
  -- A new game starts with the "look at your role" phase.
  if p_phase = 'roles' then
    update mafia_players set stats = '{}'::jsonb, claimed = false where room_code = p_code;
  end if;
  -- "Host is speaking" phases normally end when the voice phone reports the
  -- sentence as said. This is only how long the room waits if that report
  -- never comes -- long enough for the slow studio voice to finish.
  if p_gate and p_seconds is not null then
    v_seconds := greatest(p_seconds, case p_phase
      when 'morning' then 48 when 'vote_result' then 22 when 'night_wake' then 22
      when 'night_start' then 20 when 'reveal' then 14 else 10 end);
  end if;
  update mafia_rooms
     set phase = p_phase,
         phase_role = p_role,
         phase_seq = phase_seq + 1,
         phase_deadline = case when v_seconds is null then null else now() + make_interval(secs => v_seconds::double precision) end,
         phase_speech_seq = case when p_gate then v_seq else null end,
         phase_min_until = case when p_gate and p_seconds is not null then
             now() + make_interval(secs => (case p_phase
               when 'vote_result' then 8 when 'morning' then 7 when 'night_start' then 6
               when 'reveal' then 5 when 'night_wake' then 4 else 3 end)::double precision)
           else null end,
         act_done = false,
         updated_at = now()
   where code = p_code;
end $$;

-- Same rule as checkMafiaWinner() in index.html.
create or replace function public.mafia__winner(p_code text)
returns text language plpgsql set search_path = public, pg_temp as $$
declare
  v_mafia integer; v_maniac integer; v_town integer;
begin
  select count(*) filter (where role in ('mafia', 'don')),
         count(*) filter (where role = 'maniac'),
         count(*) filter (where role not in ('mafia', 'don', 'maniac'))
    into v_mafia, v_maniac, v_town
    from mafia_players where room_code = p_code and alive;
  if v_maniac = 1 and v_mafia + v_town = 0 then return 'maniac'; end if;
  if v_mafia = 0 and v_maniac = 0 then return 'town'; end if;
  if v_mafia > 0 and v_mafia >= v_town + v_maniac then return 'mafia'; end if;
  return null;
end $$;

create or replace function public.mafia__finish(p_code text, p_winner text)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  update mafia_players set role_public = true where room_code = p_code;
  update mafia_rooms set status = 'ended', winner = p_winner where code = p_code;
  perform mafia__enter(p_code, 'ended', null, null, 'win', jsonb_build_object('winner', p_winner), false);
end $$;

create or replace function public.mafia__role_awake(p_code text, p_role text)
returns boolean language sql set search_path = public, pg_temp as $$
  select exists (
    select 1 from mafia_players
     where room_code = p_code and alive
       and case when p_role = 'mafia' then role in ('mafia', 'don') else role = p_role end
  );
$$;

-- Room setting "don't reveal the roles of players who are out": the host
-- only says who left, and nobody's role is shown until the game ends.
create or replace function public.mafia__hide_roles(p_code text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select coalesce((select (settings->>'hide_roles')::boolean from mafia_rooms where code = p_code), false);
$$;

create or replace function public.mafia__resolve_night(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  v_blocked text;
  v_doctor integer;
  v_maniac integer;
  v_victims integer[] := '{}';
  v_saved boolean := false;
  v_last jsonb;
begin
  select * into r from mafia_rooms where code = p_code;
  -- The putana blocks the *personal* action of whoever she visits; the
  -- mafia's shared kill is a group decision and isn't affected.
  select role into v_blocked from mafia_players where room_code = p_code and seat = r.putana_target;
  v_doctor := case when v_blocked = 'doctor' then null else r.doctor_target end;
  v_maniac := case when v_blocked = 'maniac' then null else r.maniac_target end;

  if r.mafia_target is not null then
    if r.mafia_target = v_doctor then v_saved := true; else v_victims := v_victims || r.mafia_target; end if;
  end if;
  if v_maniac is not null and v_maniac is distinct from r.mafia_target then
    if v_maniac = v_doctor then v_saved := true; else v_victims := v_victims || v_maniac; end if;
  end if;

  -- Statistics: who killed, who saved.
  if r.mafia_target is not null and r.mafia_target = any (v_victims) then
    perform mafia__bump(p_code, seat, 'kills') from mafia_players where room_code = p_code and alive and role in ('mafia', 'don');
  end if;
  if v_maniac is not null and v_maniac = any (v_victims) then
    perform mafia__bump(p_code, seat, 'kills') from mafia_players where room_code = p_code and alive and role = 'maniac';
  end if;
  if v_saved then
    perform mafia__bump(p_code, seat, 'saves') from mafia_players where room_code = p_code and alive and role = 'doctor';
  end if;

  update mafia_players set alive = false, role_public = not mafia__hide_roles(p_code) where room_code = p_code and seat = any (v_victims);

  select jsonb_build_object(
           'victims', coalesce((select jsonb_agg(jsonb_build_object('seat', seat, 'role', case when mafia__hide_roles(p_code) then null else role end) order by seat)
                                  from mafia_players where room_code = p_code and seat = any (v_victims)), '[]'::jsonb),
           'saved', v_saved,
           'missed', r.mafia_missed)
    into v_last;

  update mafia_rooms
     set last_night = v_last,
         winner = mafia__winner(p_code),
         lastword_queue = coalesce((select array_agg(s order by s) from unnest(v_victims) s), '{}'),
         lastword_kind = 'night'
   where code = p_code;
  perform mafia__enter(p_code, 'morning', null, 16, 'morning', v_last, true);
end $$;

-- Wakes the next role that still has a living holder, in the classic
-- order; once there is none left the night is resolved.
create or replace function public.mafia__night_step(p_code text, p_after text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_order text[] := array['putana', 'mafia', 'don', 'maniac', 'doctor', 'sheriff'];
  v_from integer := coalesce(array_position(v_order, p_after), 0) + 1;
  i integer;
begin
  for i in v_from .. array_length(v_order, 1) loop
    if mafia__role_awake(p_code, v_order[i]) then
      perform mafia__enter(p_code, 'night_wake', v_order[i], 7, 'wake_' || v_order[i], null, true);
      return;
    end if;
  end loop;
  perform mafia__resolve_night(p_code);
end $$;

create or replace function public.mafia__start_night(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_night integer;
begin
  update mafia_rooms
     set night = night + 1,
         putana_target = null, mafia_target = null, mafia_missed = false,
         don_target = null, don_result = null, maniac_target = null,
         doctor_target = null, sheriff_target = null, sheriff_result = null,
         last_night = null, vote_result = null, exiled_seat = null,
         lastword_queue = '{}', lastword_kind = null, speaker_seat = null
   where code = p_code
   returning night into v_night;
  update mafia_players set night_pick = null where room_code = p_code;
  perform mafia__enter(p_code, 'night_start', null, 11, 'night_start', jsonb_build_object('night', v_night), true);
end $$;

create or replace function public.mafia__lastword(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_seat integer;
begin
  select lastword_queue[1] into v_seat from mafia_rooms where code = p_code;
  perform mafia__enter(p_code, 'lastword', null, 30, 'lastword', jsonb_build_object('seat', v_seat), false);
end $$;

create or replace function public.mafia__start_vote(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  update mafia_players set voted = false, vote_target = null where room_code = p_code;
  update mafia_rooms set speaker_seat = null where code = p_code;
  perform mafia__enter(p_code, 'vote', null, 45, 'vote_start', null, false);
end $$;

-- Gives the floor to the next living player who hasn't spoken today, going
-- round the table from p_from; when everyone has spoken, the vote starts.
create or replace function public.mafia__next_speaker(p_code text, p_from integer, p_first boolean)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  v_seat integer;
begin
  select * into r from mafia_rooms where code = p_code;
  select seat into v_seat
    from mafia_players
   where room_code = p_code and alive and spoke_day is distinct from r.night
   order by (seat <= p_from), seat
   limit 1;
  if v_seat is null then
    perform mafia__start_vote(p_code);
    return;
  end if;
  update mafia_players set spoke_day = r.night where room_code = p_code and seat = v_seat;
  update mafia_rooms set speaker_seat = v_seat where code = p_code;
  perform mafia__enter(p_code, 'day_speech', null, coalesce((r.settings->>'speech_seconds')::numeric, 60),
                       case when p_first then 'day_first' else 'day_speaker' end, jsonb_build_object('seat', v_seat), false);
end $$;

-- The first speaker moves one seat round the table every day.
create or replace function public.mafia__start_day(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_night integer; v_count integer;
begin
  select night into v_night from mafia_rooms where code = p_code;
  select count(*) into v_count from mafia_players where room_code = p_code;
  perform mafia__next_speaker(p_code, ((v_night - 1) % greatest(v_count, 1)) - 1, true);
end $$;

create or replace function public.mafia__after_day(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_winner text := mafia__winner(p_code);
begin
  if v_winner is not null then
    perform mafia__finish(p_code, v_winner);
  else
    perform mafia__start_night(p_code);
  end if;
end $$;

-- Unique leader is exiled, unless at least as many players chose
-- "nobody"; a tie exiles no one. Whoever sat this vote out because of
-- three warnings gets their vote back afterwards.
create or replace function public.mafia__tally(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_top integer; v_leaders integer; v_leader integer; v_skips integer;
  v_exiled integer := null;
  v_tie boolean := false;
  v_votes jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('from', seat, 'to', vote_target) order by seat), '[]'::jsonb)
    into v_votes
    from mafia_players where room_code = p_code and alive and not no_vote and voted;
  select count(*) into v_skips
    from mafia_players where room_code = p_code and alive and not no_vote and voted and vote_target is null;

  with tally as (
    select v.vote_target as seat, count(*)::int as n
      from mafia_players v
      join mafia_players t on t.room_code = v.room_code and t.seat = v.vote_target and t.alive
     where v.room_code = p_code and v.alive and not v.no_vote and v.voted and v.vote_target is not null
     group by v.vote_target
  )
  select max(n), count(*) filter (where n = (select max(n) from tally)), min(seat) filter (where n = (select max(n) from tally))
    into v_top, v_leaders, v_leader
    from tally;

  if v_top is not null and v_leaders = 1 and v_top > v_skips then
    v_exiled := v_leader;
  elsif v_top is not null and v_leaders > 1 then
    v_tie := true;
  end if;

  if v_exiled is not null then
    -- Statistics: townspeople who voted out a mafia member or the maniac.
    if exists (select 1 from mafia_players where room_code = p_code and seat = v_exiled and role in ('mafia', 'don', 'maniac')) then
      perform mafia__bump(p_code, seat, 'good_votes') from mafia_players
        where room_code = p_code and alive and not no_vote and voted and vote_target = v_exiled and role not in ('mafia', 'don', 'maniac');
    end if;
    update mafia_players set alive = false where room_code = p_code and seat = v_exiled;
  end if;
  update mafia_players set no_vote = false where room_code = p_code;
  update mafia_rooms
     set exiled_seat = v_exiled,
         vote_result = jsonb_build_object('exiled', v_exiled, 'tie', v_tie, 'votes', v_votes)
   where code = p_code;
  perform mafia__enter(p_code, 'vote_result', null, 12, 'vote_result', jsonb_build_object('exiled', v_exiled, 'tie', v_tie), true);
end $$;

-- One step of the game's state machine: what follows the current phase.
create or replace function public.mafia__next(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  v_total integer; v_picked integer; v_distinct integer; v_pick integer;
  v_role text;
begin
  select * into r from mafia_rooms where code = p_code;
  case r.phase
    when 'roles' then
      perform mafia__start_night(p_code);
    when 'night_start' then
      perform mafia__night_step(p_code, null);
    when 'night_wake' then
      perform mafia__enter(p_code, 'night_act', r.phase_role, case when r.phase_role = 'mafia' then 45 else 30 end, null, null, false);
    when 'night_act' then
      if r.phase_role = 'mafia' then
        -- Every living mafia member has to tap the same player; anything
        -- else (a split, or someone who never tapped) is a miss.
        select count(*), count(night_pick), count(distinct night_pick), min(night_pick)
          into v_total, v_picked, v_distinct, v_pick
          from mafia_players where room_code = p_code and alive and role in ('mafia', 'don');
        if v_total > 0 and v_picked = v_total and v_distinct = 1 then
          update mafia_rooms set mafia_target = v_pick, mafia_missed = false where code = p_code;
        else
          update mafia_rooms set mafia_target = null, mafia_missed = true where code = p_code;
        end if;
      end if;
      perform mafia__enter(p_code, 'night_sleep', r.phase_role, 6, 'sleep_' || r.phase_role, null, true);
    when 'night_sleep' then
      perform mafia__night_step(p_code, r.phase_role);
    when 'morning' then
      if r.winner is not null then
        perform mafia__finish(p_code, r.winner);
      elsif coalesce(array_length(r.lastword_queue, 1), 0) > 0 then
        perform mafia__lastword(p_code);
      else
        perform mafia__start_day(p_code);
      end if;
    when 'lastword' then
      update mafia_rooms set lastword_queue = lastword_queue[2:] where code = p_code returning * into r;
      if coalesce(array_length(r.lastword_queue, 1), 0) > 0 then
        perform mafia__lastword(p_code);
      elsif r.lastword_kind = 'night' then
        perform mafia__start_day(p_code);
      elsif mafia__hide_roles(p_code) then
        -- Hidden-roles room: no reveal step at all.
        perform mafia__after_day(p_code);
      else
        -- The exiled player's role is only revealed after their last word.
        update mafia_players set role_public = true where room_code = p_code and seat = r.exiled_seat returning role into v_role;
        perform mafia__enter(p_code, 'reveal', null, 9, 'reveal', jsonb_build_object('seat', r.exiled_seat, 'role', v_role), true);
      end if;
    when 'day_speech' then
      perform mafia__next_speaker(p_code, r.speaker_seat, false);
    when 'vote' then
      perform mafia__tally(p_code);
    when 'vote_result' then
      if r.exiled_seat is not null then
        update mafia_rooms set lastword_queue = array[r.exiled_seat], lastword_kind = 'day' where code = p_code;
        perform mafia__lastword(p_code);
      else
        perform mafia__after_day(p_code);
      end if;
    when 'reveal' then
      perform mafia__after_day(p_code);
    else
      update mafia_rooms set phase_deadline = null where code = p_code;
  end case;
end $$;

-- Nothing here runs on a clock: a phase simply carries a deadline, and
-- whichever phone asks next after it has passed moves the game on. Each
-- new phase gets a deadline counted from "now", so a room nobody looked
-- at for a while advances one step, not through a whole night at once.
create or replace function public.mafia__advance(p_code text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  v_guard integer := 0;
  v_pick text;
begin
  loop
    select * into r from mafia_rooms where code = p_code;
    exit when r.status <> 'playing' or r.phase_deadline is null or r.phase_deadline > now() or v_guard >= 12;
    perform mafia__next(p_code);
    v_guard := v_guard + 1;
  end loop;

  -- The host's voice must always sit on a phone that is here and can
  -- actually speak; if the current one went away, hand it to the next.
  select * into r from mafia_rooms where code = p_code;
  if r.code is not null and not exists (
       select 1 from mafia_players
        where room_code = p_code and player_id = r.voice_id and can_speak and last_seen > now() - interval '12 seconds') then
    select player_id into v_pick
      from mafia_players
     where room_code = p_code and can_speak and last_seen > now() - interval '12 seconds'
     order by seat limit 1;
    if v_pick is not null and v_pick is distinct from r.voice_id then
      update mafia_rooms set voice_id = v_pick where code = p_code;
    end if;
  end if;
end $$;

-- 3rd warning: no vote in the nearest vote. 4th: out of the game, role
-- shown, no last word.
create or replace function public.mafia__add_warning(p_code text, p_seat integer, p_by text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  v_count integer; v_role text; v_winner text;
begin
  update mafia_players set warnings = warnings + 1
   where room_code = p_code and seat = p_seat and alive
   returning warnings, role into v_count, v_role;
  if v_count is null then return; end if;

  if v_count >= 4 then
    update mafia_players set alive = false, role_public = not mafia__hide_roles(p_code), no_vote = false where room_code = p_code and seat = p_seat;
    perform mafia__say(p_code, 'removed', jsonb_build_object('seat', p_seat, 'role', case when mafia__hide_roles(p_code) then null else v_role end));
    v_winner := mafia__winner(p_code);
    select * into r from mafia_rooms where code = p_code;
    if v_winner is not null then
      perform mafia__finish(p_code, v_winner);
    elsif r.phase = 'day_speech' and r.speaker_seat = p_seat then
      perform mafia__next_speaker(p_code, p_seat, false);
    end if;
    return;
  end if;

  if v_count = 3 then
    update mafia_players set no_vote = true where room_code = p_code and seat = p_seat;
  end if;
  perform mafia__say(p_code, 'warning', jsonb_build_object('seat', p_seat, 'count', v_count, 'by', p_by));
end $$;

create or replace function public.mafia__clean_settings(p_settings jsonb, p_players integer)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'mafia_count', least(greatest(1, (greatest(p_players, 5) - 1) / 2),
                         greatest(1, coalesce((p_settings->>'mafia_count')::int, greatest(1, greatest(p_players, 5) / 4)))),
    'doctor', coalesce((p_settings->>'doctor')::boolean, true),
    'sheriff', coalesce((p_settings->>'sheriff')::boolean, true),
    'don', coalesce((p_settings->>'don')::boolean, false),
    'maniac', coalesce((p_settings->>'maniac')::boolean, false),
    'putana', coalesce((p_settings->>'putana')::boolean, false),
    'hide_roles', coalesce((p_settings->>'hide_roles')::boolean, false),
    -- Players who are out watch the game with all roles open.
    'ghosts', coalesce((p_settings->>'ghosts')::boolean, true),
    -- The host tells a short story about the night in the morning.
    'stories', coalesce((p_settings->>'stories')::boolean, true),
    'speech_seconds', least(300, greatest(15, coalesce((p_settings->>'speech_seconds')::int, 60)))
  );
$$;

-- What one player is allowed to know about the room right now.
create or replace function public.mafia__view(p_code text, p_player_id text)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
  v_mafia_side boolean;
  v_can_act boolean := false;
  v_needs_close boolean := false;
  v_pick integer := null;
  v_result jsonb := null;
  v_alive integer;
  v_players jsonb;
  v_ghost boolean := false;
  v_ghost_night jsonb := null;
begin
  select * into r from mafia_rooms where code = p_code;
  select * into me from mafia_players where room_code = p_code and player_id = p_player_id;
  if r.code is null or me.player_id is null then
    return jsonb_build_object('error', 'not_in_room');
  end if;
  v_mafia_side := me.role in ('mafia', 'don');
  -- A player who is out becomes a spectator and sees everything -- but only
  -- once nothing they say can matter any more: after their last word.
  v_ghost := r.status = 'playing' and not me.alive and me.role is not null
             and coalesce((r.settings->>'ghosts')::boolean, true)
             and not (me.seat = any (coalesce(r.lastword_queue, '{}')))
             and not (r.phase = 'vote_result' and r.exiled_seat is not distinct from me.seat);
  if v_ghost and r.phase in ('night_start', 'night_wake', 'night_act', 'night_sleep') then
    v_ghost_night := jsonb_build_object(
      'putana', r.putana_target, 'mafia', r.mafia_target, 'don', r.don_target,
      'maniac', r.maniac_target, 'doctor', r.doctor_target, 'sheriff', r.sheriff_target,
      'mafia_picks', coalesce((select jsonb_agg(jsonb_build_object('seat', seat, 'target', night_pick) order by seat)
                                 from mafia_players where room_code = p_code and alive and role in ('mafia', 'don')
                                  and r.phase = 'night_act' and r.phase_role = 'mafia'), '[]'::jsonb));
  end if;
  select count(*) into v_alive from mafia_players where room_code = p_code and alive;

  if r.status = 'playing' and r.phase = 'night_act' and me.alive then
    if r.phase_role = 'mafia' and v_mafia_side then
      v_pick := me.night_pick;
      v_can_act := me.night_pick is null;
    elsif r.phase_role = me.role and r.phase_role <> 'mafia' then
      v_pick := case r.phase_role
                  when 'putana' then r.putana_target when 'don' then r.don_target when 'maniac' then r.maniac_target
                  when 'doctor' then r.doctor_target when 'sheriff' then r.sheriff_target end;
      v_can_act := not r.act_done;
      v_needs_close := r.act_done;
      if r.act_done then
        v_result := case r.phase_role when 'don' then r.don_result when 'sheriff' then r.sheriff_result else jsonb_build_object('ok', true) end;
      end if;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'seat', p.seat,
           'name', p.name,
           'alive', p.alive,
           'warnings', p.warnings,
           'no_vote', p.no_vote,
           'ready', p.ready,
           'voted', p.voted and r.phase = 'vote',
           'online', p.last_seen > now() - interval '12 seconds',
           'is_host', p.player_id = r.host_id,
           'is_voice', p.player_id = r.voice_id,
           'is_me', p.player_id = p_player_id,
           'role', case when r.status = 'lobby' then null
                        when p.role_public or r.status = 'ended' or p.player_id = p_player_id or v_ghost
                             or (v_mafia_side and p.role in ('mafia', 'don')) then p.role
                        else null end,
           'complaints', (select count(*) from mafia_complaints c
                           join mafia_players f on f.room_code = c.room_code and f.player_id = c.from_id and f.alive
                          where c.room_code = p_code and c.day = r.night and c.target_seat = p.seat),
           'warned_today', p.warned_day is not distinct from r.night and r.night > 0
         ) order by p.seat), '[]'::jsonb)
    into v_players
    from mafia_players p where p.room_code = p_code;

  return jsonb_build_object(
    'code', r.code,
    'status', r.status,
    'phase', r.phase,
    'phase_role', case when r.phase in ('night_wake', 'night_act', 'night_sleep') then r.phase_role else null end,
    'seq', r.phase_seq,
    'night', r.night,
    'ms_left', case when r.phase_deadline is null then null
                    else greatest(0, (extract(epoch from (r.phase_deadline - now())) * 1000)::bigint) end,
    'settings', mafia__clean_settings(r.settings, (select count(*)::int from mafia_players where room_code = p_code)),
    'is_host', me.player_id = r.host_id,
    'is_voice', me.player_id = r.voice_id,
    'gate_seq', r.phase_speech_seq,
    'speech', r.speech,
    'speaker_seat', r.speaker_seat,
    'spoken', (select count(*) from mafia_players where room_code = p_code and alive and spoke_day is not distinct from r.night and r.night > 0),
    'alive_count', v_alive,
    'complaints_needed', (greatest(v_alive, 1) - 1) / 2 + 1,
    'last_night', r.last_night,
    'lastword_seat', case when r.phase = 'lastword' then r.lastword_queue[1] else null end,
    'vote_result', r.vote_result,
    'exiled_seat', r.exiled_seat,
    'winner', r.winner,
    'players', v_players,
    'ghost', v_ghost,
    'ghost_night', v_ghost_night,
    'me', jsonb_build_object(
      'seat', me.seat,
      'name', me.name,
      'role', case when r.status = 'lobby' then null else me.role end,
      'alive', me.alive,
      'warnings', me.warnings,
      'no_vote', me.no_vote,
      'ready', me.ready,
      'can_act', v_can_act,
      'needs_close', v_needs_close,
      'pick', v_pick,
      'result', v_result,
      'voted', me.voted,
      'vote_target', me.vote_target,
      'claimed', me.claimed,
      'stats', me.stats,
      'complained', coalesce((select jsonb_agg(target_seat order by target_seat) from mafia_complaints
                               where room_code = p_code and day = r.night and from_id = p_player_id), '[]'::jsonb)
    )
  );
end $$;

-- Locks the room, checks the caller really is that player, records that
-- their phone is here, and lets any overdue phase move on. Every public
-- function starts with this. Returns the caller's row, or null.
create or replace function public.mafia__open(p_code text, p_player_id text, p_secret text, p_can_speak boolean)
returns mafia_players language plpgsql set search_path = public, pg_temp as $$
declare
  me mafia_players;
begin
  perform 1 from mafia_rooms where code = p_code for update;
  if not found then return null; end if;
  update mafia_players
     set last_seen = now(), can_speak = coalesce(p_can_speak, can_speak)
   where room_code = p_code and player_id = p_player_id and secret = p_secret
   returning * into me;
  if me.player_id is null then return null; end if;
  perform mafia__advance(p_code);
  select * into me from mafia_players where room_code = p_code and player_id = p_player_id;
  return me;
end $$;

------------------------------------------------------------------------
-- Public functions (what the phones call)
------------------------------------------------------------------------

create or replace function public.mafia_create_room(p_player_id text, p_secret text, p_name text, p_can_speak boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
  v_name text;
  i integer;
begin
  if coalesce(length(p_player_id), 0) < 3 or coalesce(length(p_secret), 0) < 16 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  delete from mafia_rooms where updated_at < now() - interval '8 hours';
  for i in 1 .. 40 loop
    v_code := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from mafia_rooms where code = v_code);
    v_code := null;
  end loop;
  if v_code is null then return jsonb_build_object('error', 'busy'); end if;
  v_name := coalesce(nullif(left(moderate_display_name(p_name), 20), ''), 'Player 1');
  insert into mafia_rooms (code, host_id, voice_id) values (v_code, p_player_id, p_player_id);
  insert into mafia_players (room_code, player_id, secret, name, seat, can_speak) values (v_code, p_player_id, p_secret, v_name, 0, coalesce(p_can_speak, false));
  return mafia__view(v_code, p_player_id);
end $$;

create or replace function public.mafia_join_room(p_code text, p_player_id text, p_secret text, p_name text, p_can_speak boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
  v_count integer;
  v_name text;
begin
  if coalesce(length(p_player_id), 0) < 3 or coalesce(length(p_secret), 0) < 16 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select * into r from mafia_rooms where code = p_code for update;
  if r.code is null then return jsonb_build_object('error', 'not_found'); end if;

  select * into me from mafia_players where room_code = p_code and player_id = p_player_id;
  if me.player_id is not null then
    -- Coming back (reload, reconnect) -- allowed at any point of the game.
    if me.secret <> p_secret then return jsonb_build_object('error', 'not_found'); end if;
    update mafia_players set last_seen = now(), can_speak = coalesce(p_can_speak, can_speak) where room_code = p_code and player_id = p_player_id;
    perform mafia__advance(p_code);
    return mafia__view(p_code, p_player_id);
  end if;

  if r.status <> 'lobby' then return jsonb_build_object('error', 'started'); end if;
  select count(*) into v_count from mafia_players where room_code = p_code;
  if v_count >= 20 then return jsonb_build_object('error', 'full'); end if;
  v_name := coalesce(nullif(left(moderate_display_name(p_name), 20), ''), 'Player ' || (v_count + 1));
  insert into mafia_players (room_code, player_id, secret, name, seat, can_speak)
  values (p_code, p_player_id, p_secret, v_name, (select coalesce(max(seat), -1) + 1 from mafia_players where room_code = p_code), coalesce(p_can_speak, false));
  update mafia_rooms set updated_at = now() where code = p_code;
  perform mafia__advance(p_code);
  return mafia__view(p_code, p_player_id);
end $$;

create or replace function public.mafia_view(p_code text, p_player_id text, p_secret text, p_can_speak boolean default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, p_can_speak);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- Leaving the lobby frees the seat (and passes the room on if the creator
-- leaves). Leaving mid-game changes nothing here: the player may come
-- back, and the timers keep the game moving without them.
create or replace function public.mafia_leave_room(p_code text, p_player_id text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
  v_next text;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('ok', true); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'lobby' then
    delete from mafia_players where room_code = p_code and player_id = p_player_id;
    select player_id into v_next from mafia_players where room_code = p_code order by seat limit 1;
    if v_next is null then
      delete from mafia_rooms where code = p_code;
    else
      update mafia_rooms
         set host_id = case when host_id = p_player_id then v_next else host_id end,
             voice_id = case when voice_id = p_player_id then v_next else voice_id end,
             updated_at = now()
       where code = p_code;
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.mafia_update_settings(p_code text, p_player_id text, p_secret text, p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'lobby' and r.host_id = p_player_id then
    update mafia_rooms
       -- Only what the creator actually touched is stored; everything else
       -- keeps following the defaults (the mafia count grows with the room).
       set settings = coalesce(settings, '{}'::jsonb) || coalesce((
             select jsonb_object_agg(key, value) from jsonb_each(coalesce(p_settings, '{}'::jsonb))
              where key in ('mafia_count', 'doctor', 'sheriff', 'don', 'maniac', 'putana', 'hide_roles', 'ghosts', 'stories', 'speech_seconds')), '{}'::jsonb),
           updated_at = now()
     where code = p_code;
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- Deals the roles (same composition rules as buildMafiaRoles() in
-- index.html) and starts the "look at your role" phase.
create or replace function public.mafia_start(p_code text, p_player_id text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
  s jsonb;
  n integer;
  v_roles text[] := '{}';
  v_mafia integer;
  v_don integer;
  i integer;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status <> 'lobby' or r.host_id <> p_player_id then return mafia__view(p_code, p_player_id); end if;
  select count(*) into n from mafia_players where room_code = p_code;
  if n < 5 then return jsonb_build_object('error', 'need_players'); end if;

  s := mafia__clean_settings(r.settings, n);
  v_mafia := (s->>'mafia_count')::int;
  v_don := case when (s->>'don')::boolean and v_mafia >= 1 then 1 else 0 end;
  for i in 1 .. v_mafia - v_don loop v_roles := v_roles || 'mafia'::text; end loop;
  if v_don = 1 then v_roles := v_roles || 'don'::text; end if;
  if (s->>'doctor')::boolean and coalesce(array_length(v_roles, 1), 0) < n then v_roles := v_roles || 'doctor'::text; end if;
  if (s->>'sheriff')::boolean and coalesce(array_length(v_roles, 1), 0) < n then v_roles := v_roles || 'sheriff'::text; end if;
  if (s->>'maniac')::boolean and coalesce(array_length(v_roles, 1), 0) < n then v_roles := v_roles || 'maniac'::text; end if;
  if (s->>'putana')::boolean and coalesce(array_length(v_roles, 1), 0) < n then v_roles := v_roles || 'putana'::text; end if;
  while coalesce(array_length(v_roles, 1), 0) < n loop v_roles := v_roles || 'civilian'::text; end loop;

  with seated as (
    select player_id, row_number() over (order by seat, joined_at) - 1 as new_seat, row_number() over (order by random()) as pick
      from mafia_players where room_code = p_code
  )
  update mafia_players p
     set seat = seated.new_seat::int, role = v_roles[seated.pick::int], role_public = false, alive = true, ready = false,
         warnings = 0, no_vote = false, warned_day = null, spoke_day = null, night_pick = null, vote_target = null, voted = false
    from seated
   where p.room_code = p_code and p.player_id = seated.player_id;

  delete from mafia_complaints where room_code = p_code;
  update mafia_rooms
     set status = 'playing', settings = s, night = 0, winner = null, last_night = null, vote_result = null, exiled_seat = null,
         lastword_queue = '{}', lastword_kind = null, speaker_seat = null, speech = '[]'::jsonb
   where code = p_code;
  perform mafia__enter(p_code, 'roles', null, 60, 'roles_dealt', null, false);
  return mafia__view(p_code, p_player_id);
end $$;

create or replace function public.mafia_ready(p_code text, p_player_id text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'playing' and r.phase = 'roles' then
    update mafia_players set ready = true where room_code = p_code and player_id = p_player_id;
    if not exists (select 1 from mafia_players where room_code = p_code and not ready) then
      update mafia_rooms set phase_deadline = now() where code = p_code;
      perform mafia__advance(p_code);
    end if;
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

create or replace function public.mafia_night_pick(p_code text, p_player_id text, p_secret text, p_target integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
  t mafia_players;
  v_blocked boolean;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  select * into t from mafia_players where room_code = p_code and seat = p_target;
  if r.status <> 'playing' or r.phase <> 'night_act' or not me.alive or t.player_id is null or not t.alive then
    return mafia__view(p_code, p_player_id);
  end if;

  if r.phase_role = 'mafia' then
    if me.role in ('mafia', 'don') and me.night_pick is null and t.role not in ('mafia', 'don') then
      update mafia_players set night_pick = p_target where room_code = p_code and player_id = p_player_id;
      if not exists (select 1 from mafia_players where room_code = p_code and alive and role in ('mafia', 'don') and night_pick is null) then
        update mafia_rooms set phase_deadline = now() where code = p_code;
        perform mafia__advance(p_code);
      end if;
    end if;
    return mafia__view(p_code, p_player_id);
  end if;

  if me.role <> r.phase_role or r.act_done then
    return mafia__view(p_code, p_player_id);
  end if;
  v_blocked := r.putana_target is not null and r.putana_target = me.seat;

  if r.phase_role = 'putana' and t.seat <> me.seat then
    update mafia_rooms set putana_target = p_target, act_done = true where code = p_code;
  elsif r.phase_role = 'don' and t.seat <> me.seat then
    update mafia_rooms
       set don_target = p_target, act_done = true,
           don_result = jsonb_build_object('seat', p_target, 'blocked', v_blocked, 'is_sheriff', (not v_blocked) and t.role = 'sheriff')
     where code = p_code;
    if (not v_blocked) and t.role = 'sheriff' then perform mafia__bump(p_code, me.seat, 'finds'); end if;
  elsif r.phase_role = 'maniac' and t.seat <> me.seat then
    update mafia_rooms set maniac_target = p_target, act_done = true where code = p_code;
  elsif r.phase_role = 'doctor' then
    update mafia_rooms set doctor_target = p_target, act_done = true where code = p_code;
  elsif r.phase_role = 'sheriff' and t.seat <> me.seat then
    update mafia_rooms
       set sheriff_target = p_target, act_done = true,
           sheriff_result = jsonb_build_object('seat', p_target, 'blocked', v_blocked, 'is_mafia', (not v_blocked) and t.role in ('mafia', 'don'))
     where code = p_code;
    if (not v_blocked) and t.role in ('mafia', 'don') then perform mafia__bump(p_code, me.seat, 'finds'); end if;
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- The acting player has seen the answer and tapped "Close".
create or replace function public.mafia_night_close(p_code text, p_player_id text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'playing' and r.phase = 'night_act' and r.act_done and r.phase_role <> 'mafia' and me.alive and me.role = r.phase_role then
    update mafia_rooms set phase_deadline = now() where code = p_code;
    perform mafia__advance(p_code);
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- The voice phone finished saying the phrase that the current phase was
-- waiting for.
create or replace function public.mafia_speech_done(p_code text, p_player_id text, p_secret text, p_seq integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'playing' and r.voice_id = p_player_id and r.phase_speech_seq is not null and r.phase_speech_seq = p_seq then
    -- Not before the phase's minimum time on screen, never later than its own timer.
    update mafia_rooms
       set phase_deadline = least(phase_deadline, greatest(now(), coalesce(phase_min_until, now())))
     where code = p_code;
    perform mafia__advance(p_code);
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- "I'm done": the current speaker (or the player giving their last word)
-- hands the floor on before the timer runs out.
create or replace function public.mafia_end_speech(p_code text, p_player_id text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'playing' and (
       (r.phase = 'day_speech' and r.speaker_seat = me.seat) or
       (r.phase = 'lastword' and r.lastword_queue[1] = me.seat)) then
    update mafia_rooms set phase_deadline = now() where code = p_code;
    perform mafia__advance(p_code);
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- p_target null = "nobody".
create or replace function public.mafia_vote(p_code text, p_player_id text, p_secret text, p_target integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'playing' and r.phase = 'vote' and me.alive and not me.no_vote and not me.voted
     and (p_target is null or exists (select 1 from mafia_players where room_code = p_code and seat = p_target and alive and seat <> me.seat)) then
    update mafia_players set voted = true, vote_target = p_target where room_code = p_code and player_id = p_player_id;
    if not exists (select 1 from mafia_players where room_code = p_code and alive and not no_vote and not voted) then
      update mafia_rooms set phase_deadline = now() where code = p_code;
      perform mafia__advance(p_code);
    end if;
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- Tapping again takes the complaint back. Once more than half of the other
-- living players have complained about someone in the same day, that
-- player gets one warning (at most one such warning per day).
create or replace function public.mafia_complain(p_code text, p_player_id text, p_secret text, p_target integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
  t mafia_players;
  v_alive integer; v_count integer;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  select * into t from mafia_players where room_code = p_code and seat = p_target;
  if r.status <> 'playing' or r.phase <> 'day_speech' or not me.alive or t.player_id is null or not t.alive
     or t.seat = me.seat or t.warned_day is not distinct from r.night then
    return mafia__view(p_code, p_player_id);
  end if;

  delete from mafia_complaints where room_code = p_code and day = r.night and from_id = p_player_id and target_seat = p_target;
  if not found then
    insert into mafia_complaints (room_code, day, from_id, target_seat) values (p_code, r.night, p_player_id, p_target);
    select count(*) into v_alive from mafia_players where room_code = p_code and alive;
    select count(*) into v_count
      from mafia_complaints c join mafia_players f on f.room_code = c.room_code and f.player_id = c.from_id and f.alive
     where c.room_code = p_code and c.day = r.night and c.target_seat = p_target;
    if v_count >= (v_alive - 1) / 2 + 1 then
      update mafia_players set warned_day = r.night where room_code = p_code and seat = p_target;
      delete from mafia_complaints where room_code = p_code and day = r.night and target_seat = p_target;
      perform mafia__add_warning(p_code, p_target, 'players');
    end if;
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

create or replace function public.mafia_host_warn(p_code text, p_player_id text, p_secret text, p_target integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'playing' and r.phase = 'day_speech' and r.host_id = p_player_id and p_target <> me.seat then
    perform mafia__add_warning(p_code, p_target, 'host');
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- The room creator moves a stuck step on (someone's phone died while the
-- whole table waits for their "ready", their speech or their vote).
create or replace function public.mafia_host_skip(p_code text, p_player_id text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'playing' and r.host_id = p_player_id and r.phase in ('roles', 'day_speech', 'vote', 'lastword') then
    update mafia_rooms set phase_deadline = now() where code = p_code;
    perform mafia__advance(p_code);
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- "Host's voice on this phone."
create or replace function public.mafia_set_voice(p_code text, p_player_id text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, true);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  update mafia_rooms set voice_id = p_player_id, updated_at = now() where code = p_code;
  return mafia__view(p_code, p_player_id);
end $$;

-- Back to the lobby with the same people, for another game.
create or replace function public.mafia_play_again(p_code text, p_player_id text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status = 'ended' and r.host_id = p_player_id then
    update mafia_players
       set role = null, role_public = false, alive = true, ready = false, warnings = 0, no_vote = false,
           warned_day = null, spoke_day = null, night_pick = null, vote_target = null, voted = false
     where room_code = p_code;
    delete from mafia_complaints where room_code = p_code;
    update mafia_rooms
       set status = 'lobby', phase = 'lobby', phase_role = null, phase_deadline = null, phase_speech_seq = null,
           night = 0, winner = null, last_night = null, vote_result = null, exiled_seat = null,
           lastword_queue = '{}', lastword_kind = null, speaker_seat = null, speech = '[]'::jsonb, updated_at = now()
     where code = p_code;
  end if;
  return mafia__view(p_code, p_player_id);
end $$;

-- After a game: adds this player's result to their profile (statistics and
-- achievements). Once per game per player; the numbers come from what the
-- server itself recorded, the phone only says whose profile it is.
create or replace function public.mafia_claim_result(p_code text, p_player_id text, p_secret text, p_profile_id text, p_name text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r mafia_rooms;
  me mafia_players;
  v_side text;
  v_won boolean;
  v_bit integer;
  v_name text;
begin
  me := mafia__open(p_code, p_player_id, p_secret, null);
  if me.player_id is null then return jsonb_build_object('error', 'not_in_room'); end if;
  select * into r from mafia_rooms where code = p_code;
  if r.status <> 'ended' or me.role is null or r.winner is null then return jsonb_build_object('error', 'not_finished'); end if;
  if me.claimed then return jsonb_build_object('ok', true, 'already', true); end if;
  if p_profile_id is null or length(p_profile_id) not between 5 and 80 or p_profile_id !~ '^(tg|anon):[A-Za-z0-9_-]+$' then
    return jsonb_build_object('error', 'bad_request');
  end if;

  v_side := case when me.role in ('mafia', 'don') then 'mafia' when me.role = 'maniac' then 'maniac' else 'town' end;
  v_won := v_side = r.winner;
  v_bit := case me.role when 'civilian' then 1 when 'mafia' then 2 when 'don' then 4 when 'doctor' then 8
                        when 'sheriff' then 16 when 'maniac' then 32 when 'putana' then 64 else 0 end;
  v_name := nullif(moderate_display_name(coalesce(p_name, me.name)), '');

  update mafia_players set claimed = true where room_code = p_code and player_id = p_player_id;
  insert into player_profiles as pp (id, display_name, last_played_date,
      mafia_games, mafia_wins, mafia_town_wins, mafia_mafia_wins, mafia_maniac_wins, mafia_survived,
      mafia_finds, mafia_saves, mafia_kills, mafia_good_votes, mafia_roles_mask, mafia_streak, mafia_best_streak)
  values (p_profile_id, v_name, current_date,
      1, v_won::int, (v_won and v_side = 'town')::int, (v_won and v_side = 'mafia')::int, (v_won and v_side = 'maniac')::int, me.alive::int,
      coalesce((me.stats->>'finds')::int, 0), coalesce((me.stats->>'saves')::int, 0), coalesce((me.stats->>'kills')::int, 0),
      coalesce((me.stats->>'good_votes')::int, 0), v_bit, v_won::int, v_won::int)
  on conflict (id) do update set
      display_name = coalesce(pp.display_name, excluded.display_name),
      mafia_games = pp.mafia_games + 1,
      mafia_wins = pp.mafia_wins + excluded.mafia_wins,
      mafia_town_wins = pp.mafia_town_wins + excluded.mafia_town_wins,
      mafia_mafia_wins = pp.mafia_mafia_wins + excluded.mafia_mafia_wins,
      mafia_maniac_wins = pp.mafia_maniac_wins + excluded.mafia_maniac_wins,
      mafia_survived = pp.mafia_survived + excluded.mafia_survived,
      mafia_finds = pp.mafia_finds + excluded.mafia_finds,
      mafia_saves = pp.mafia_saves + excluded.mafia_saves,
      mafia_kills = pp.mafia_kills + excluded.mafia_kills,
      mafia_good_votes = pp.mafia_good_votes + excluded.mafia_good_votes,
      mafia_roles_mask = pp.mafia_roles_mask | excluded.mafia_roles_mask,
      mafia_streak = case when excluded.mafia_wins = 1 then pp.mafia_streak + 1 else 0 end,
      mafia_best_streak = greatest(pp.mafia_best_streak, case when excluded.mafia_wins = 1 then pp.mafia_streak + 1 else 0 end),
      updated_at = now();
  return jsonb_build_object('ok', true, 'won', v_won, 'side', v_side, 'role', me.role, 'survived', me.alive, 'stats', me.stats);
end $$;

------------------------------------------------------------------------
-- Who may call what
------------------------------------------------------------------------
revoke execute on function
  public.mafia__say(text, text, jsonb),
  public.mafia__enter(text, text, text, numeric, text, jsonb, boolean),
  public.mafia__winner(text),
  public.mafia__finish(text, text),
  public.mafia__role_awake(text, text),
  public.mafia__resolve_night(text),
  public.mafia__night_step(text, text),
  public.mafia__start_night(text),
  public.mafia__lastword(text),
  public.mafia__start_vote(text),
  public.mafia__next_speaker(text, integer, boolean),
  public.mafia__start_day(text),
  public.mafia__after_day(text),
  public.mafia__tally(text),
  public.mafia__next(text),
  public.mafia__advance(text),
  public.mafia__add_warning(text, integer, text),
  public.mafia__clean_settings(jsonb, integer),
  public.mafia__hide_roles(text),
  public.mafia__bump(text, integer, text),
  public.mafia__view(text, text),
  public.mafia__open(text, text, text, boolean)
from public, anon, authenticated;

grant execute on function
  public.mafia_create_room(text, text, text, boolean),
  public.mafia_join_room(text, text, text, text, boolean),
  public.mafia_view(text, text, text, boolean),
  public.mafia_leave_room(text, text, text),
  public.mafia_update_settings(text, text, text, jsonb),
  public.mafia_start(text, text, text),
  public.mafia_ready(text, text, text),
  public.mafia_night_pick(text, text, text, integer),
  public.mafia_night_close(text, text, text),
  public.mafia_speech_done(text, text, text, integer),
  public.mafia_end_speech(text, text, text),
  public.mafia_vote(text, text, text, integer),
  public.mafia_complain(text, text, text, integer),
  public.mafia_host_warn(text, text, text, integer),
  public.mafia_host_skip(text, text, text),
  public.mafia_set_voice(text, text, text),
  public.mafia_play_again(text, text, text),
  public.mafia_claim_result(text, text, text, text, text)
to anon, authenticated;
