-- Hatsit: choosing a profile title.
--
-- set_selected_title() only stores a title the player has really unlocked;
-- the check repeats ACHIEVEMENTS in index.html for the ids that carry a
-- title. Already applied to the live database on 7 Oct 2026 (the Mafia
-- titles were added then) -- this file is the copy for the repository.

create or replace function public.set_selected_title(p_id text, p_title_id text)
returns void language plpgsql security definer set search_path to 'public' as $function$
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
    else false
  end;

  if not unlocked then
    return;
  end if;

  update public.player_profiles set selected_title = p_title_id, updated_at = now() where id = p_id;
end;
$function$;
