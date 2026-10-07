-- Comprehensive EN+RU display-name moderation (седьмой заход): the
-- previous version used a short hand-picked denylist that kept missing
-- common words one bug report at a time ("СУКА" got through, then
-- "сучка"...). This version is generated from two established, curated
-- word lists (LDNOOBW's English and Russian profanity lists) expanded
-- with additional Russian obscenity roots, and was checked against this
-- app's own text, the top 20,000 most common Russian and English words,
-- and a hand list of common names before shipping -- see this project's
-- history for how it was built (build_denylist.js). Kept byte-for-byte in
-- sync with moderateDisplayNameClient() in index.html; both are generated
-- from the same source lists.
create or replace function public.moderate_display_name(p_name text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $function$
declare
  cleaned text;
  ru_test text;
  ru_pattern text := 'хуй|хуе|хуё|хуя|пизд|ебат|ебал|ёбан|еблан|ебок|ёбар|ебуч|ёбну|залуп|мудак|мудил|мудозвон|мудло|муда|гандон|гондон|пидор|пидар|пидр|педик|бляд|сволоч|сук|суч|падл|гнид|тварь|мраз|шлюх|шалав|стерв|курв|говн|дерьм|жоп|ссат|срать|малаф|хохл|хохол|хер';
  en_pattern text := '\y2g1c\y|2 girls 1 cup|\yacrotomophilia\y|alabama hot pocket|alaskan pipeline|\yanal\y|\yanilingus\y|\yanus\y|\yapeshit\y|\yarsehole\y|\yass\y|asshole|\yassmunch\y|auto erotic|\yautoerotic\y|\ybabeland\y|baby batter|baby juice|ball gag|ball gravy|ball kicking|ball licking|ball sack|ball sucking|\ybangbros\y|\ybangbus\y|\ybareback\y|barely legal|\ybarenaked\y|\ybastard\y|\ybastardo\y|\ybastinado\y|\ybbw\y|\ybdsm\y|\ybeaner\y|\ybeaners\y|beaver cleaver|beaver lips|\ybeastiality\y|\ybestiality\y|big black|big breasts|big knockers|big tits|\ybimbos\y|\ybirdlock\y|bitch|bitches|black cock|blonde action|blonde on blonde action|\yblowjob\y|blow job|blow your load|blue waffle|\yblumpkin\y|\ybollocks\y|\ybondage\y|\yboner\y|\yboob\y|\yboobs\y|booty call|brown showers|brunette action|\ybukkake\y|\ybulldyke\y|bullet vibe|bullshit|bung hole|\ybunghole\y|\ybusty\y|\ybutt\y|\ybuttcheeks\y|\ybutthole\y|camel toe|\ycamgirl\y|\ycamslut\y|\ycamwhore\y|carpet muncher|\ycarpetmuncher\y|chocolate rosebuds|\ycialis\y|\ycirclejerk\y|cleveland steamer|\yclit\y|\yclitoris\y|clover clamps|\yclusterfuck\y|\ycock\y|\ycocks\y|\ycoprolagnia\y|\ycoprophilia\y|\ycornhole\y|\ycoon\y|\ycoons\y|\ycreampie\y|\ycum\y|\ycumming\y|\ycumshot\y|\ycumshots\y|\ycunnilingus\y|cunt|\ydarkie\y|date rape|\ydaterape\y|deep throat|\ydeepthroat\y|\ydendrophilia\y|\ydick\y|\ydildo\y|\ydingleberry\y|\ydingleberries\y|dirty pillows|dirty sanchez|doggie style|\ydoggiestyle\y|doggy style|\ydoggystyle\y|dog style|\ydolcett\y|\ydomination\y|\ydominatrix\y|\ydommes\y|donkey punch|double dong|double penetration|dp action|dry hump|\ydvda\y|eat my ass|\yecchi\y|\yejaculation\y|\yerotic\y|\yerotism\y|\yescort\y|\yeunuch\y|fag|faggot|\yfecal\y|\yfelch\y|\yfellatio\y|\yfeltch\y|female squirting|\yfemdom\y|\yfigging\y|\yfingerbang\y|\yfingering\y|\yfisting\y|foot fetish|\yfootjob\y|\yfrotting\y|fuck|fuck buttons|fuckin|fucking|\yfucktards\y|fudge packer|\yfudgepacker\y|\yfutanari\y|\ygangbang\y|gang bang|gay sex|\ygenitals\y|giant cock|girl on|girl on top|girls gone wild|\ygoatcx\y|\ygoatse\y|god damn|\ygokkun\y|golden shower|\ygoodpoop\y|goo girl|\ygoregasm\y|\ygrope\y|group sex|g-spot|\yguro\y|hand job|\yhandjob\y|hard core|\yhardcore\y|\yhentai\y|\yhomoerotic\y|\yhonkey\y|\yhorny\y|hot carl|hot chick|how to kill|how to murder|huge fat|\yhumping\y|\yincest\y|\yintercourse\y|jack off|jail bait|\yjailbait\y|jelly donut|jerk off|\yjigaboo\y|\yjiggaboo\y|\yjiggerboo\y|\yjizz\y|\yjuggs\y|\ykike\y|\ykinbaku\y|\ykinkster\y|\ykinky\y|\yknobbing\y|leather restraint|leather straight jacket|lemon party|\ylivesex\y|\ylolita\y|\ylovemaking\y|make me come|male squirting|\ymasturbate\y|\ymasturbating\y|\ymasturbation\y|menage a trois|\ymilf\y|missionary position|\ymong\y|motherfucker|mound of venus|mr hands|muff diver|\ymuffdiving\y|\ynambla\y|\ynawashi\y|\ynegro\y|\yneonazi\y|nigga|nigger|nig nog|\ynimphomania\y|\ynipple\y|\ynipples\y|\ynsfw\y|nsfw images|\ynude\y|\ynudity\y|\ynutten\y|\ynympho\y|\ynymphomania\y|\yoctopussy\y|\yomorashi\y|one cup two girls|one guy one jar|\yorgasm\y|\yorgy\y|\ypaedophile\y|\ypaki\y|\ypanties\y|\ypanty\y|\ypedobear\y|\ypedophile\y|\ypegging\y|\ypenis\y|phone sex|piece of shit|\ypikey\y|\ypissing\y|piss pig|\ypisspig\y|\yplayboy\y|pleasure chest|pole smoker|\yponyplay\y|\ypoof\y|\ypoon\y|\ypoontang\y|\ypunany\y|poop chute|\ypoopchute\y|porn|porno|\ypornography\y|prince albert piercing|\ypthc\y|\ypubes\y|\ypussy\y|\yqueaf\y|\yqueef\y|\yquim\y|\yraghead\y|raging boner|\yrape\y|\yraping\y|\yrapist\y|\yrectum\y|reverse cowgirl|\yrimjob\y|\yrimming\y|rosy palm|rosy palm and her 5 sisters|rusty trombone|\ysadism\y|\ysantorum\y|\yscat\y|\yschlong\y|\yscissoring\y|\ysemen\y|\ysex\y|\ysexcam\y|\ysexo\y|\ysexy\y|\ysexual\y|\ysexually\y|\ysexuality\y|shaved beaver|shaved pussy|\yshibari\y|shit|\yshitblimp\y|shitty|\yshota\y|\yshrimping\y|\yskeet\y|\yslanteye\y|slut|s&m|\ysmut\y|\ysnatch\y|\ysnowballing\y|\ysodomize\y|\ysodomy\y|\yspastic\y|\yspic\y|\ysplooge\y|splooge moose|\yspooge\y|spread legs|\yspunk\y|strap on|\ystrapon\y|\ystrappado\y|strip club|style doggy|\ysuck\y|\ysucks\y|suicide girls|sultry women|\yswastika\y|tainted love|taste my|tea bagging|\ythreesome\y|\ythroating\y|\ythumbzilla\y|tied up|tight white|\ytit\y|\ytits\y|\ytitties\y|\ytitty\y|tongue in a|\ytopless\y|\ytosser\y|\ytowelhead\y|\ytranny\y|\ytribadism\y|tub girl|\ytubgirl\y|\ytushy\y|twat|\ytwink\y|\ytwinkie\y|two girls one cup|\yundressing\y|\yupskirt\y|urethra play|\yurophilia\y|\yvagina\y|venus mound|\yviagra\y|\yvibrator\y|violet wand|\yvorarephilia\y|\yvoyeur\y|\yvoyeurweb\y|\yvoyuer\y|\yvulva\y|\ywank\y|\ywetback\y|wet dream|white power|whore|\yworldsex\y|wrapping men|wrinkled starfish|\yyaoi\y|yellow showers|\yyiffy\y|\yzoophilia\y|🖕|niggas|\yf4ck\y|\yfck\y|\ysh1t\y|\yb1tch\y';
begin
  if p_name is null then
    return null;
  end if;

  cleaned := p_name;

  cleaned := regexp_replace(cleaned, '[' || chr(1) || '-' || chr(31) || chr(127) || ']', '', 'g');

  cleaned := replace(cleaned, chr(8203), '');
  cleaned := replace(cleaned, chr(8204), '');
  cleaned := replace(cleaned, chr(8205), '');
  cleaned := replace(cleaned, chr(8206), '');
  cleaned := replace(cleaned, chr(8207), '');
  cleaned := replace(cleaned, chr(8234), '');
  cleaned := replace(cleaned, chr(8235), '');
  cleaned := replace(cleaned, chr(8236), '');
  cleaned := replace(cleaned, chr(8237), '');
  cleaned := replace(cleaned, chr(8238), '');
  cleaned := replace(cleaned, chr(8288), '');
  cleaned := replace(cleaned, chr(8289), '');
  cleaned := replace(cleaned, chr(8290), '');
  cleaned := replace(cleaned, chr(8291), '');
  cleaned := replace(cleaned, chr(8292), '');

  cleaned := regexp_replace(cleaned, '\s+', ' ', 'g');
  cleaned := trim(cleaned);
  cleaned := left(cleaned, 40);

  if cleaned = '' then
    return null;
  end if;

  -- English: word-boundary (\y) matched for ordinary alphanumeric words
  -- (so "assist"/"cockpit"/"class" aren't false positives), plain
  -- substring for the handful of most common/recognizable slurs in
  -- en_pattern that were checked to have zero innocent collisions (so
  -- "FuCkYoU"/no-space concatenation evasion still gets caught) and for
  -- multi-word phrases.
  if cleaned ~* en_pattern then
    return null;
  end if;

  -- Russian: roots matched as substrings (mat is a small set of roots
  -- that combine productively with prefixes/suffixes -- matching whole
  -- words would miss most real inflected forms), after stripping out
  -- specific real, common, innocent words that happen to contain one of
  -- those roots (e.g. "барсук" contains "сук", "оскорблять" contains
  -- "бля") so they don't get caught.
  ru_test := lower(cleaned);
  ru_test := replace(ru_test, 'парикмахерская', ' ');
  ru_test := replace(ru_test, 'парикмахерской', ' ');
  ru_test := replace(ru_test, 'чебоксарской', ' ');
  ru_test := replace(ru_test, 'инкассаторов', ' ');
  ru_test := replace(ru_test, 'стервятников', ' ');
  ru_test := replace(ru_test, 'инкассатора', ' ');
  ru_test := replace(ru_test, 'стервятника', ' ');
  ru_test := replace(ru_test, 'стервятники', ' ');
  ru_test := replace(ru_test, 'парикмахер', ' ');
  ru_test := replace(ru_test, 'чебоксарах', ' ');
  ru_test := replace(ru_test, 'инкассатор', ' ');
  ru_test := replace(ru_test, 'стервятник', ' ');
  ru_test := replace(ru_test, 'барсуками', ' ');
  ru_test := replace(ru_test, 'педикюрша', ' ');
  ru_test := replace(ru_test, 'чебоксары', ' ');
  ru_test := replace(ru_test, 'барсуков', ' ');
  ru_test := replace(ru_test, 'барсуках', ' ');
  ru_test := replace(ru_test, 'хохлатый', ' ');
  ru_test := replace(ru_test, 'хохлатая', ' ');
  ru_test := replace(ru_test, 'хохлатое', ' ');
  ru_test := replace(ru_test, 'хохлатые', ' ');
  ru_test := replace(ru_test, 'хохолком', ' ');
  ru_test := replace(ru_test, 'херувима', ' ');
  ru_test := replace(ru_test, 'педикюра', ' ');
  ru_test := replace(ru_test, 'галлахер', ' ');
  ru_test := replace(ru_test, 'барсуки', ' ');
  ru_test := replace(ru_test, 'барсука', ' ');
  ru_test := replace(ru_test, 'гребцов', ' ');
  ru_test := replace(ru_test, 'любляна', ' ');
  ru_test := replace(ru_test, 'любляне', ' ');
  ru_test := replace(ru_test, 'любляну', ' ');
  ru_test := replace(ru_test, 'хохолок', ' ');
  ru_test := replace(ru_test, 'херувим', ' ');
  ru_test := replace(ru_test, 'педикюр', ' ');
  ru_test := replace(ru_test, 'пассата', ' ');
  ru_test := replace(ru_test, 'разгреб', ' ');
  ru_test := replace(ru_test, 'херберт', ' ');
  ru_test := replace(ru_test, 'барсук', ' ');
  ru_test := replace(ru_test, 'суккуб', ' ');
  ru_test := replace(ru_test, 'гребля', ' ');
  ru_test := replace(ru_test, 'гребли', ' ');
  ru_test := replace(ru_test, 'гребец', ' ');
  ru_test := replace(ru_test, 'пассат', ' ');
  ru_test := replace(ru_test, 'саблей', ' ');
  ru_test := replace(ru_test, 'колеба', ' ');
  ru_test := replace(ru_test, 'херман', ' ');
  ru_test := replace(ru_test, 'сукно', ' ');
  ru_test := replace(ru_test, 'сабля', ' ');
  ru_test := replace(ru_test, 'сабли', ' ');
  ru_test := replace(ru_test, 'саблю', ' ');
  ru_test := replace(ru_test, 'дебат', ' ');
  ru_test := replace(ru_test, 'херб', ' ');

  if ru_test ~* ru_pattern then
    return null;
  end if;

  if cleaned ~* '(https?://|www\.|t\.me/|\.[a-z]{2,6}(/|$))' then
    return null;
  end if;

  return cleaned;
end;
$function$;

grant execute on function public.moderate_display_name(text) to anon, authenticated;
