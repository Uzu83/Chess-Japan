-- 0006: games（AI戦の自己用クラウド履歴）+ strength 公開プロフィールの最小 RPC
--
-- ============================================================================
-- 【信頼モデル — このファイルを読む未来の担当者へ最重要】
-- 公開 SPA は anon key で REST/RPC を直叩きできる前提（COST_DEFENSE.md 冒頭の脅威モデルと
-- 同じ)。クライアントが「こう指した」「この評価値だった」と言ってきても、サーバーはそれを
-- 権威ある事実として扱えない。だから本 migration は一貫して:
--   - games への authenticated 直 INSERT/UPDATE GRANT は絶対に付けない
--     (owner スコープの RLS ポリシーがあっても「本当にアプリ経由で指した対局か」は
--      anon key 直叩きでは証明できない。ポリシーだけで守った気になるのが一番危険)。
--   - 書き込み口は SECURITY DEFINER RPC のみに集約する
--     (save_unverified_ai_game=新規保存 / attach_unverified_analysis=解析の後付け)。
--   - 保存データは常に trust_level='unverified'・rated=false をサーバーが固定する
--     (クライアントは trust_level も rated も選べない = 自己申告で verified を名乗れない)。
--   - apply_rated_result（0005）への GRANT は今回も行わない(現状維持)。クラウドレートは
--     「サーバー主導の game_id 発行 + 棋譜合法性検証」が揃うまで独立の計画とする
--     (ADR docs/decisions/0002-unverified-ai-games-no-cloud-rating.md 決定3)。
--
-- 【この migration が触れないもの(既存不変条件の再確認)】
--   - explain_cache / rate_counters: 一切変更しない。RLS(ポリシー無し)+GRANT剥奪の
--     全面ロックは COST_DEFENSE.md の心臓部で、profiles(0004)の owner スコープ例外とも
--     信頼境界が別（「お金が直接出るテーブル」と「ユーザーデータのテーブル」は混ぜない）。
--   - apply_rated_result(0005): GRANT を追加しない。関数定義だけが存在する現状を維持。
--
-- 【Codex 由来 findings の通し番号(F001-F009) — 他ファイルからも参照される値なので
--   ここでの番号を勝手に変えないこと(games.ts/ADR 0002/PrivacySettings.tsx が F001/F004/
--   F007 を名前で参照している)】
--   F001 テーブル直 INSERT 禁止・RPC のみが書き込み口(ADR 0002 / src/auth/games.ts)。
--   F002 apply_rated_result への再 GRANT は行わない・クラウドレートは独立計画(ADR 0002 決定3)。
--   F003 保存の多重防御(頻度・サイズ・件数)を RPC 本体で強制。table の CHECK だけに
--        頼らない(CHECK は「保存された値の形」しか縛れず、「保存させる頻度/総量」は
--        縛れないため)。
--   F004 メール確認済み(email_confirmed_at)をサーバー側で検査。save/attach/
--        set_strength_visibility の3関数すべてに同じガードを重複して置く(1箇所を
--        通せば残りは素通り、という穴を作らない)。UI 側の確認はあくまで補助。
--   F005 analysis_payload は「クライアント端末計測・サーバーは非権威」として扱う。
--        サーバーはサイズ/形状の物理的な健全性だけを検査し、値の真偽(本当にその局面で
--        その評価だったか)は判定しない=判定できない。過信して集計を公開指標に使わない。
--   F006 保存件数上限 200・超過は最古から自動削除(ユーザー単位)。無制限行増加による
--        ストレージ/一覧クエリコストの膨張を防ぐ(COST_DEFENSE の「上限を必ず置く」流儀を
--        LLM 呼び出し以外のテーブルにも適用)。
--   F007 公開 RPC(get_public_strength)は user_id/棋譜/相手情報/絶対局数を一切返さない。
--        返すのは粗い活動量バケット+ハンドルのみ(src/auth/games.ts / PrivacySettings.tsx
--        のコメントもこの番号を参照)。
--   F008 列挙防止: 「該当ハンドルが存在しない」と「存在するが非公開/局数不足」を同じ
--        NULL 応答にする。エラー種別やレイテンシで存在有無を推測させない。
--   F009 公開の最小局数フロア(20局)を set_strength_visibility(切替時のゲート)と
--        get_public_strength(表示時のゲート)の両方で同じ値に揃える。0005 の
--        「K=32/floor=100/ceiling=3000 は rating.ts と同期させること」と同種の地雷:
--        片方だけ変えると「公開に切り替えられたのに表示は常に空」という不整合になる。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) games — 対局履歴(初版は AI 戦の unverified 自己記録のみ)
-- ---------------------------------------------------------------------------
create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),

  -- 退会(auth.users 削除)で対局履歴も cascade 削除。profiles(0004)と同じ扱い。
  user_id uuid not null references auth.users (id) on delete cascade,

  game_kind text not null check (game_kind in ('chess', 'shogi')),

  -- 初版 RPC(save_unverified_ai_game)は 'ai' のみを書く。'pvp' は列自体は今用意し、
  -- 実際に書き込む口(専用 RPC)は PvP 実装側(別 migration)の責務にする。ここで先に
  -- check 制約を広げておくのは「後から check を緩める migration」を避けるため
  -- (check を後で緩めるのは既存行のバックフィル要否まで考える必要があり地味に重い)。
  mode text not null check (mode in ('ai', 'pvp')),

  -- unverified=クライアント自己申告(改ざん可能・F001)。verified=サーバー/対戦相手が
  -- 立ち会った結果(将来の PvP 裁定など)。本 migration の RPC は unverified しか書かない。
  trust_level text not null default 'unverified'
    check (trust_level in ('unverified', 'verified')),

  -- 表示用の自由記述(「Stockfish easy」「対 yane_fan」等)。上限80字は profiles.display_name
  -- (0004・上限40字)よりやや緩いが、対局相手名+難度表記程度を想定した実用上の上限。
  opponent_label text not null default ''
    check (char_length(opponent_label) <= 80),

  -- PvP 実装まで常に NULL(RPC が固定)。列だけ先に用意しておき、後続 migration で
  -- opponent_user_id を書く専用 RPC を追加すれば games テーブル自体の変更は不要になる。
  opponent_user_id uuid references auth.users (id) on delete set null,

  you_color text not null check (you_color in ('white', 'black')),

  -- PGN 風("1-0"/"0-1"/"1/2-1/2"/"*")と将棋側の表記(例: "先手勝ち")が混在しうるため、
  -- 値そのものを列挙で縛らない(縛ると将棋の表記追加ごとに migration が要る)。
  -- 文字数だけ RPC 側(<=16字)で検査する(F003 の一部・野放図な長文混入の防止)。
  result text not null default '*',

  outcome text not null check (outcome in ('win', 'loss', 'draw', 'unfinished')),

  -- 500 = chess/shogi 双方の実用上の対局上限手数を十分に超える安全マージン
  -- (異常に長い/バグで手数が膨らんだ棋譜を機械的に弾く。厳密なルール上限ではない)。
  move_count integer not null default 0 check (move_count >= 0 and move_count <= 500),

  -- 16KB: COST_DEFENSE.md の explain Edge Function の body 上限(MAX_BODY_BYTES=16KB)と
  -- 揃えた棋譜上限。正当な対局(PGN/KIF双方)には十分大きく、巨大テキスト混入(自己DoS/
  -- ストレージ濫用)には十分小さい、という同じ思想をここにも適用する。
  record_text text not null default ''
    check (octet_length(record_text) <= 16384),

  -- 1局分の解析(手ごとの quality/phase/tags 等)を jsonb 1列にまとめる。
  -- WHY 行正規化(手ごとに別テーブル)を避けるか: 1局最大500手 × 保存上限200局
  -- (F006)を素直に正規化すると最大10万行/ユーザーになりうる(行爆発)。jsonb 1列なら
  -- 「1局=1行」で件数上限がそのままストレージ上限になり、F006 の 200 件キャップが
  -- そのまま解析データ量の天井としても効く。サイズ検査(<=65536バイト・F005)は
  -- RPC 側(table の CHECK ではない)で行う理由: analysis_payload の内部形状は
  -- クライアント(AnalysisPayload 型・src/auth/games.ts)側で進化中で、table の CHECK に
  -- 形状を焼き込むと将来の形状変更で migration が必須になる。RPC の関数本体なら
  -- create or replace function だけで検査ロジックを更新できる。
  analysis_payload jsonb,

  -- rated=true は将来のクラウドレート機能専用(F002)。本 migration の RPC は常に false。
  rated boolean not null default false,

  created_at timestamptz not null default now()
);

-- 「自分の履歴を新しい順に一覧」(list_my_games)がこのテーブルの支配的なクエリ形なので、
-- (user_id, created_at desc) の複合インデックスをその並びのまま作る(インデックスオンリー
-- スキャンに近い形で効かせる)。頻度チェック(直近60秒の件数・F003)も user_id 前方一致で
-- この索引に乗る。
create index if not exists games_user_created_idx
  on public.games (user_id, created_at desc);

alter table public.games enable row level security;

-- SELECT のみ本人(auth.uid()=user_id)。INSERT/UPDATE/DELETE のポリシーは意図的に
-- 作らない = クライアントは何をしても行を書けない(RLS を通っても書き込み文自体が無い)。
-- 書き込みは全て SECURITY DEFINER RPC(下記)がテーブル所有者(postgres)権限で行う
-- (postgres はテーブル所有者として RLS を自動的にバイパスする。0005 の
-- set_initial_rating が profiles に INSERT ポリシー無しで書けているのと同じ仕組み)。
create policy games_select_own on public.games
  for select using ((select auth.uid()) = user_id);

-- 多層防御(0002 と同じ流儀): まず全剥奪 → 必要最小だけ付与。
revoke all on table public.games from anon, authenticated;
grant select on table public.games to authenticated;
-- INSERT/UPDATE GRANT は付けない(F001)。anon には select も与えない(未ログインは
-- 対局履歴に一切触れない)。

comment on table public.games is
  '対局履歴。AI戦は trust_level=unverified(自己申告・改ざん可能・F001)。'
  '書き込みは save_unverified_ai_game / attach_unverified_analysis のみ(INSERT/UPDATE GRANT無し)。'
  'explain_cache/rate_counters(全面ロック)とは別の信頼境界(0004のprofilesと同種のownerスコープ)。'
  '公開集計・クラウドレートは trust_level=verified のみ対象(未実装・ADR 0002)。';

-- ---------------------------------------------------------------------------
-- 2) profiles 拡張 — 公開設定の列を先に用意(公開ロジック自体は RPC 側・F007-F009)
-- ---------------------------------------------------------------------------

-- 既定 private: オプトインのみ公開になる(オプトアウト運用にしない)。個人のプレイ傾向
-- (得意/苦手・活動量)は display_name(0004)より機微度が高いと判断し、既定を最も
-- 保守的な側に固定する。
alter table public.profiles
  add column if not exists strength_visibility text not null default 'private'
    check (strength_visibility in ('private', 'public'));

-- 3-24字・英小文字数字アンダースコアのみ。URL/表示に安全に使え、実名(display_name は
-- Google 実名が既定値になりうる・0004/COST_DEFENSE.md)を晒さない別ハンドルにする。
-- nullable: 非公開ユーザーはハンドルを持たなくてよい(強制しない)。
alter table public.profiles
  add column if not exists public_handle text
    check (
      public_handle is null
      or (
        char_length(public_handle) between 3 and 24
        and public_handle ~ '^[a-z0-9_]+$'
      )
    );

-- 重複ハンドルの取得(横取り/なりすまし)を DB 制約レベルで物理的に不可能にする
-- (RPC 側のアプリケーションロジックだけに頼らない多層防御)。where 句で NULL を除外する
-- ことで「非公開で public_handle=NULL のユーザーが複数いる」ことは許容する
-- (NULL は unique index で重複とみなされない=標準動作)。
create unique index if not exists profiles_public_handle_uidx
  on public.profiles (public_handle)
  where public_handle is not null;

-- 【意図的に GRANT UPDATE を追加しない】strength_visibility / public_handle は
-- 0004 の "client が直接書けるのは display_name のみ" という不変条件をここでも維持する。
-- ハンドルは「一意な公開名」というスカースリソースなので、client 直 UPDATE を許すと
-- 検証(形式チェック・最小局数ゲート F009・メール確認 F004)を経ずに書き換えられてしまう。
-- 変更は set_strength_visibility(下記)経由のみ。

-- ---------------------------------------------------------------------------
-- 3) save_unverified_ai_game — AI戦の唯一の新規書き込み口(F001)
-- ---------------------------------------------------------------------------
create or replace function public.save_unverified_ai_game(
  p_game_kind text,
  p_you_color text,
  p_outcome text,
  p_result text,
  p_move_count integer,
  p_opponent_label text,
  p_record_text text,
  p_analysis_payload jsonb default null
) returns public.games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.games;
  v_recent integer;
  v_total integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- F004: メール確認済み必須。OAuth(Google/Apple)は通常 confirmed だが、メール+パスワード
  -- 登録(AuthContext.signInWithEmailPassword)は確認前は email_confirmed_at が NULL のまま
  -- ログイン状態になりうる(Supabase の設定次第)。使い捨てメールでの量産保存(F003/F006の
  -- 上限を使い捨てアカウントで水平展開して回避する濫用)を最初の関門で止める。
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;

  -- ここから信頼境界の内側でも入力を信じない検証(validate.ts の思想と同じ:
  -- anon key で直叩きできる前提なので、フロントの型が守ってくれる保証はない)。
  if p_game_kind is null or p_game_kind not in ('chess', 'shogi') then
    raise exception 'invalid game_kind';
  end if;
  if p_you_color is null or p_you_color not in ('white', 'black') then
    raise exception 'invalid you_color';
  end if;
  if p_outcome is null or p_outcome not in ('win', 'loss', 'draw', 'unfinished') then
    raise exception 'invalid outcome';
  end if;
  if p_move_count is null or p_move_count < 0 or p_move_count > 500 then
    raise exception 'invalid move_count';
  end if;
  -- result は列挙で縛らない(games.result のコメント参照)ので長さだけ検査。
  if p_result is null or char_length(p_result) > 16 then
    raise exception 'invalid result';
  end if;
  if p_opponent_label is null or char_length(p_opponent_label) > 80 then
    raise exception 'invalid opponent_label';
  end if;
  if p_record_text is null or octet_length(p_record_text) > 16384 then
    raise exception 'record_text too large';
  end if;

  -- F005: analysis_payload はサイズ/形状の物理検査のみ(内容の真偽は判定しない)。
  -- WHY jsonb_typeof チェックを「AND で1つの if にまとめない」か(重要・地雷):
  -- PostgreSQL は AND/OR 両辺の評価順序を仕様上保証しない(マニュアル "Controlling
  -- Execution" 参照)。`jsonb_typeof(x)='array' and jsonb_array_length(x)>500` を
  -- 1つの if に書くと、稀に typeof チェックより先に jsonb_array_length が評価され、
  -- x が配列でないときに「cannot get array length of a non-array」で例外になりうる。
  -- 保存ではなく検査失敗として扱いたいだけなので、ネストした if で評価順序を構造的に
  -- 固定する(CASE 式に頼る手もあるが、ここは可読性優先でネスト if にした)。
  if p_analysis_payload is not null then
    if octet_length(p_analysis_payload::text) > 65536 then
      raise exception 'analysis_payload too large';
    end if;
    if jsonb_typeof(p_analysis_payload -> 'plies') = 'array' then
      if jsonb_array_length(p_analysis_payload -> 'plies') > 500 then
        raise exception 'too many analysis plies';
      end if;
    end if;
  end if;

  -- F003: 並行 RPC で件数上限をすり抜けないよう、ユーザー単位で直列化する。
  -- advisory_xact_lock はトランザクション終了まで保持され、commit で自動解放される。
  perform pg_advisory_xact_lock(hashtext('cj:games:' || v_uid::text));

  -- F003: 頻度上限(バースト対局の偽装量産・ストレージ濫用の抑止)。
  -- WHY ">10" ではなく ">=10" で拒否するか: 「直近1分に10件を超えたら拒否」という
  -- 要件を「挿入前チェック」として実装すると、既存10件で拒否しない場合は11件目まで
  -- 通ってしまい実質上限が11になる。挿入前チェックで意図した上限(10件/分)を厳密に
  -- 守るには「既に10件あるなら11件目を拒否」= count>=10 が正しい(1分あたりの
  -- 通常のAI対局頻度を大きく超えるバーストのみ止める設計で、通常利用を妨げない)。
  select count(*) into v_recent
    from public.games
   where user_id = v_uid
     and created_at > now() - interval '60 seconds';
  if v_recent >= 10 then
    raise exception 'rate limited: too many games saved in the last minute';
  end if;

  -- mode/trust_level/opponent_user_id/rated はここで固定(パラメータに存在しない=
  -- クライアントが選べない)。id もパラメータに無い=クライアント指定を拒否しサーバー発行
  -- (gen_random_uuid() のデフォルトのみが使われる)。
  insert into public.games (
    user_id, game_kind, mode, trust_level,
    opponent_label, opponent_user_id, you_color,
    result, outcome, move_count, record_text, analysis_payload, rated
  ) values (
    v_uid, p_game_kind, 'ai', 'unverified',
    p_opponent_label, null, p_you_color,
    p_result, p_outcome, p_move_count, p_record_text, p_analysis_payload, false
  )
  returning * into v_row;

  -- F006: 保存件数上限200。超過分は最古から削除(ユーザー単位)。
  -- 「挿入後に数える→超過分だけ削除」なので、通常の1件保存では毎回 count(*) が
  -- 1回余分に走るが、games は user_id 索引があり件数も上限200なのでコストは無視できる。
  select count(*) into v_total from public.games where user_id = v_uid;
  if v_total > 200 then
    delete from public.games
     where id in (
       select id from public.games
        where user_id = v_uid
        order by created_at asc
        limit (v_total - 200)
     );
  end if;

  return v_row;
end;
$$;

revoke all on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_unverified_ai_game(
  text, text, text, text, integer, text, text, jsonb
) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) attach_unverified_analysis — 保存済みの自己対局に解析を後付け(F001/F004/F005)
--
-- WHY 別関数にするか(save 時に一括で渡させない理由):
--   対局終了直後(cloudSync.syncAiGameToCloud)は「投了/終局」の事実だけが確定していて、
--   全手の詳細解析(レビュー画面での全手解析・classify.ts)はまだ走っていないことが多い。
--   ユーザーが後でレビューを開いて初めて analysis_payload が揃うケースがあるため、
--   「保存」と「解析の添付」を別の呼び出しに分離する(src/auth/games.ts の
--   attachUnverifiedAnalysis)。INSERT ではなく UPDATE なので F006(件数上限200)・
--   F003(頻度上限)は適用しない(新しい行を作らないため無制限成長のリスクが無い)。
-- ---------------------------------------------------------------------------
create or replace function public.attach_unverified_analysis(
  p_game_id uuid,
  p_analysis_payload jsonb
) returns public.games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.games;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;
  if p_game_id is null then
    raise exception 'invalid game_id';
  end if;
  if p_analysis_payload is null then
    raise exception 'analysis_payload required';
  end if;

  -- save_unverified_ai_game と同じ検査(F005)。ネスト if の理由も同じ(AND短絡非保証)。
  if octet_length(p_analysis_payload::text) > 65536 then
    raise exception 'analysis_payload too large';
  end if;
  if jsonb_typeof(p_analysis_payload -> 'plies') = 'array' then
    if jsonb_array_length(p_analysis_payload -> 'plies') > 500 then
      raise exception 'too many analysis plies';
    end if;
  end if;

  -- where 句に trust_level='unverified' and mode='ai' を含めるのは多層防御:
  -- 将来 verified/pvp 行が増えても、この RPC が誤ってそれらを書き換えないよう
  -- 構造的に対象を絞る(将来の担当者が呼び出し元を変えても事故りにくい)。
  update public.games
     set analysis_payload = p_analysis_payload
   where id = p_game_id
     and user_id = v_uid
     and trust_level = 'unverified'
     and mode = 'ai'
  returning * into v_row;

  if not found then
    -- 他人の行/存在しない行/verified・pvp 行のいずれでも同じメッセージにする
    -- (「他人の対局IDが存在する」を推測させる情報を返さない=F008 と同じ発想)。
    raise exception 'game not found';
  end if;
  return v_row;
end;
$$;

revoke all on function public.attach_unverified_analysis(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.attach_unverified_analysis(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) list_my_games — 自分の履歴を新しい順で取得
-- ---------------------------------------------------------------------------
create or replace function public.list_my_games(p_limit integer default 50)
returns setof public.games
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  -- クランプ(1..100): 0/負値/巨大値の誤指定でも安全に振る舞う(拒否ではなくクランプに
  -- した理由: これは読み取り専用の一覧取得で、書き込み側(F003等)のような濫用インセンティブ
  -- が無く、UI の使い勝手を優先してよい)。
  v_limit := greatest(1, least(100, coalesce(p_limit, 50)));
  return query
    select g.*
      from public.games g
     where g.user_id = v_uid
     order by g.created_at desc
     limit v_limit;
end;
$$;

revoke all on function public.list_my_games(integer) from public, anon, authenticated;
grant execute on function public.list_my_games(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) set_strength_visibility — 公開設定の切替(F004/F007/F009)
--
-- 初版の方針: private への切替とハンドル設定はいつでも可能。public への切替は
-- 「確認済みメール(F004)+ 20局以上(F009)+ 有効な形式のハンドル」が揃ったときのみ許可。
-- 非公開へ戻すときはハンドルをクリアする(公開歴があった旧ハンドルを他人が再利用しても
-- 「元は誰か」の手掛かりを残さない=列挙・追跡面を最小化)。
-- ---------------------------------------------------------------------------
create or replace function public.set_strength_visibility(
  p_visibility text,
  p_handle text default null
) returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles;
  v_handle text;
  v_game_count integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- F004: ハンドルは早い者勝ちの一意リソース(profiles_public_handle_uidx)なので、
  -- 使い捨てメールでの量産取得(ハンドル squatting)をここでも同じガードで止める。
  if (select email_confirmed_at from auth.users where id = v_uid) is null then
    raise exception 'email not confirmed';
  end if;

  if p_visibility is null or p_visibility not in ('private', 'public') then
    raise exception 'invalid visibility';
  end if;

  if p_visibility = 'public' then
    v_handle := nullif(lower(trim(coalesce(p_handle, ''))), '');
    -- profiles.public_handle の table CHECK と同じ形式規則をここでも先に検査する
    -- (multi-layer: RPC で分かりやすいエラーを返し、table CHECK は最後の保険にする)。
    if v_handle is null or v_handle !~ '^[a-z0-9_]{3,24}$' then
      raise exception 'invalid handle';
    end if;

    -- F009: 最小局数フロア。get_public_strength(下記)と同じ 20 を使う(揃える義務)。
    -- WHY 20 か: 局数が少ないと粗い集計であっても実質「その1局の結果」を晒すのに近く、
    -- 統計的なノイズ不足=個別対局の事実上の暴露になる(F005 の「集計を過信しない」と
    -- 対になる、公開側からの防御)。厳密な統計的根拠のある値ではなく、実用上のフロア。
    select count(*) into v_game_count from public.games where user_id = v_uid;
    if v_game_count < 20 then
      raise exception 'not enough games for a public profile';
    end if;
  else
    v_handle := null; -- 非公開化時はハンドルをクリア(上のコメント参照)。
  end if;

  update public.profiles
     set strength_visibility = p_visibility,
         public_handle = case when p_visibility = 'public' then v_handle else null end
   where id = v_uid
  returning * into v_row;

  if not found then
    raise exception 'no profile';
  end if;
  return v_row;
exception
  -- profiles_public_handle_uidx とのハンドル重複を、生の制約違反メッセージではなく
  -- 利用者に分かる文言に変換する(内部索引名を露出しない=情報漏らしすぎない配慮)。
  when unique_violation then
    raise exception 'handle already taken';
end;
$$;

revoke all on function public.set_strength_visibility(text, text) from public, anon, authenticated;
grant execute on function public.set_strength_visibility(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) get_public_strength — 公開プロフィールの粗い要約のみ(F007/F008/F009)
--
-- 匿名(anon)からも呼べる唯一の games/profiles 関連 RPC。だからこそ最も慎重に絞る:
--   - 返すのは handle・粗い活動量バケット・(将来の)得意/苦手タグの2件までで、
--     user_id・棋譜・相手情報・絶対局数は一切返さない(F007)。
--   - 「該当ハンドルが無い」と「あるが非公開/局数不足」を同じ NULL で返す(F008)。
--   - 20局未満は非公開と同じ扱いで NULL(F009。set_strength_visibility の切替ゲートと
--     同値。片方だけ変えると「切替は通ったのに表示は常に空」になる地雷)。
--
-- 【accuracy_bucket / top_strengths / top_weaknesses を今プレースホルダにする理由】
-- クライアント側には既に本物の集計ロジックがある(src/core/strengthAggregator.ts /
-- src/core/playstyle.ts の PlaystyleTag)。しかしそのタグ語彙・閾値は TypeScript 側で
-- まだ変化しうる「動いている標的」で、analysis_payload には version:1 しか無くタグ
-- 語彙自体のバージョンは乗っていない。もしここで SQL 側に同じ集計ロジックを複製すると、
-- 0005 が K/floor/ceiling で踏んだ「2言語に同じ定数/閾値を置いて同期を忘れる」地雷を
-- タグ集計という遥かに複雑なロジックで再現することになる。よって初版は「本人向け
-- (StrengthProfileView・非公開)は TypeScript 集計、公開向け(この RPC)は活動量バケット
-- のみ」と役割を分け、得意/苦手タグの公開集計は語彙が安定してから別 migration で
-- 追加する(このコメントで意図的な未実装であることを明示し、後続 F00x の裁定を待つ)。
-- ---------------------------------------------------------------------------
create or replace function public.get_public_strength(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_handle text := nullif(lower(trim(coalesce(p_handle, ''))), '');
  v_profile public.profiles;
  v_game_count integer;
  v_games_bucket text;
begin
  -- 形式不正は「該当ハンドルなし」と区別せず即 NULL(F008)。正規表現不一致の理由を
  -- 返すと「有効な形式のハンドル空間」を教えてしまうので、ここでは無言で NULL にする。
  if v_handle is null or v_handle !~ '^[a-z0-9_]{3,24}$' then
    return null;
  end if;

  select * into v_profile
    from public.profiles
   where public_handle = v_handle
     and strength_visibility = 'public';
  if not found then
    return null; -- 「存在しない」も「存在するが非公開」もここに合流する(F008)。
  end if;

  select count(*) into v_game_count from public.games where user_id = v_profile.id;
  if v_game_count < 20 then
    -- 公開設定後に対局を大量削除する等で条件を割った場合も同様に非開示に倒す(F009)。
    return null;
  end if;

  -- 件数は範囲バケットのみ(絶対値を返さない=F007)。
  v_games_bucket := case
    when v_game_count < 50 then '20-49'
    when v_game_count < 100 then '50-99'
    else '100+'
  end;

  return jsonb_build_object(
    'handle', v_profile.public_handle,
    -- 'not_available': 上のコメント参照。将来タグ集計を追加したらここを実値に差し替える。
    'accuracy_bucket', 'not_available',
    'top_strengths', '[]'::jsonb,
    'top_weaknesses', '[]'::jsonb,
    'games_bucket', v_games_bucket
  );
end;
$$;

revoke all on function public.get_public_strength(text) from public, anon, authenticated;
grant execute on function public.get_public_strength(text) to anon, authenticated;

comment on function public.get_public_strength(text) is
  '公開プロフィールの粗い要約のみ。user_id/棋譜/相手/絶対局数は返さない(F007)。'
  'ハンドル不存在と非公開/局数不足は同一のNULL(F008)。局数フロア20はset_strength_visibilityと同値(F009)。'
  'accuracy_bucket/top_strengths/top_weaknessesは意図的にプレースホルダ(理由は関数定義直前のコメント)。';
