-- 0005: profiles の行生成トリガ + rating 更新 RPC (rating への唯一の書き込み口)
--
-- rating/games は 0004 で client の UPDATE GRANT から外してある。
-- ここで定義する SECURITY DEFINER RPC だけが更新経路 = 「Elo の計算はサーバーが
-- 権威」という 2C-3 (対人レート戦) への布石。ただし 2C-1/2C-2 時点の正直な限界:
-- p_opp_elo / p_score は client 供給なので「対2800に勝った」と偽ることは可能。
-- それでも ①絶対値セット (rating=9999) は不可能で ±K/回に束縛される
-- ②Elo 計算式がサーバー1箇所に集約される、の2点でチート費用を上げる。
-- 2C-3 では apply_rated_result を「サーバーが立ち会った試合の裁定結果」からのみ
-- 呼べる形に差し替え、移行/自己申告レートは provisional 扱いにする (ゲート①合意)。
--
-- 定数の同期義務: K=32 / floor=100 / ceiling=3000 / 初期値1200 は
-- src/core/rating.ts (K_FACTOR/RATING_FLOOR/RATING_CEILING/INITIAL_RATING) と
-- 0004 の check 制約に一致させること。片方だけ変えると check violation や
-- クライアント表示とのズレが起きる (ゲート①指摘 #1 の再発防止)。

-- ---------------------------------------------------------------------------
-- 1) profile 自動生成: auth.users への新規登録で 1 行作る (Supabase 定石)。
--    client に INSERT GRANT を与えない設計 (0004) とセット。
--    on conflict do nothing: 再実行・競合・(将来の)手動復旧に対して冪等。
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    -- Google OAuth の raw_user_meta_data から表示名を拾う (name → full_name の順)。
    -- 0004 の check (1..40字) に合わせて左40文字に切る。空文字は NULL に倒す。
    nullif(left(coalesce(new.raw_user_meta_data->>'name',
                         new.raw_user_meta_data->>'full_name'), 40), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- auth.users へのトリガ。既存があれば作り直し (create or replace はトリガに無い)。
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2) 初期レート設定 (オンボーディング / ローカル移行)。
--    「絶対値でレートをセットできる唯一の口」であり、本人 + 未初期化のときの
--    1回しか通らない。2回目以降は現状の行を返すだけ (冪等 = リトライ安全)。
-- ---------------------------------------------------------------------------
create or replace function public.set_initial_rating(p_rating integer, p_source text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.profiles;
begin
  -- auth.uid() が無い (anon から呼ばれた等) なら即拒否。
  -- EXECUTE GRANT は authenticated 限定だが、防衛は GRANT に依存させない (多層)。
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- p_source の NULL 拒否 (Codex ゲート②blocking #1)。
  -- WHY 明示チェックが要るか: 0004 の check 制約 `rating_source in (...)` は SQL の
  -- 三値論理で `NULL in (...)` が NULL(=非FALSE)に評価されるため NULL を素通しする。
  -- REST 直叩きで p_source=null を送ると whitelist を迂回できてしまう。
  if p_source is null then
    raise exception 'invalid source';
  end if;

  update public.profiles
     set rating = greatest(100, least(3000, p_rating)), -- サーバークランプ (改竄値対策)
         rating_source = p_source,  -- whitelist は 0004 の check 制約が強制
         rating_initialized = true
   where id = auth.uid()
     and rating_initialized = false  -- 初期化は一度だけ
  returning * into v_row;

  if not found then
    -- 既に初期化済み (or 行が無い)。初期化済みなら現状を返す = 冪等。
    select * into v_row from public.profiles where id = auth.uid();
    if not found then
      -- トリガ失敗等で行が無い異常系。client 直 INSERT は許さないので、ここで
      -- 自己修復として行を作る (SECURITY DEFINER なので可能)。
      -- on conflict do nothing: 複数タブ同時リトライで後着が 23505 で 500 になる
      -- のを防ぐ (監査ワークフロー指摘)。負けた側は下の再 SELECT で行を拾う。
      insert into public.profiles (id, rating, rating_source, rating_initialized)
      values (auth.uid(), greatest(100, least(3000, p_rating)), p_source, true)
      on conflict (id) do nothing;
      select * into v_row from public.profiles where id = auth.uid();
    end if;
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) レート戦結果の反映。Elo をサーバーで再計算して原子更新。
--    【2C-1 では migration のみ同梱・client からの配線は 2C-2】(ゲート①合意)。
--    式は src/core/rating.ts と完全パリティ:
--      E = 1 / (1 + 10^((opp - me) / 400)) 、delta = round(K * (score - E))、K = 32
-- ---------------------------------------------------------------------------
create or replace function public.apply_rated_result(p_opp_elo integer, p_score numeric)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.profiles;
  v_opp integer;
  v_e numeric;
  v_delta integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- 入力検証 (ゲート①指摘 #2: score だけでなく opp_elo も client 供給なので検証)。
  -- 範囲クランプでなく「拒否」にする WHY: クランプは黙って別の対局条件に読み替える
  -- ことになり、バグ (フロントが変な値を送っている) を隠す。範囲外は明示エラー。
  if p_opp_elo is null or p_opp_elo < 100 or p_opp_elo > 3000 then
    raise exception 'invalid opponent elo';
  end if;
  if p_score is null or p_score not in (0, 0.5, 1) then
    raise exception 'invalid score';
  end if;
  v_opp := p_opp_elo;

  select * into v_row from public.profiles where id = auth.uid() for update;
  if not found then
    raise exception 'no profile';
  end if;

  -- 初期化前のレート操作を拒否 (Codex ゲート②blocking #2)。
  -- WHY: これが無いと「未初期化のまま rated 結果を積む → その後 set_initial_rating で
  -- 絶対値を上書き」という順序倒錯が REST 直叩きで可能になる。
  if not v_row.rating_initialized then
    raise exception 'rating not initialized';
  end if;

  -- 丸めは floor(x + 0.5) = JS の Math.round と同方向 (half-toward-+infinity)。
  -- WHY 素の round() を使わないか: PostgreSQL の round(numeric) は half-away-from-zero
  -- で、負の -X.5 ちょうどのとき JS と 1 ずれる。整数 Elo 入力では実際には発生しない
  -- ことを数値検証済みだが、形式的パリティを構造で保証しておく (監査ワークフロー指摘)。
  v_e := 1.0 / (1.0 + power(10.0, (v_opp - v_row.rating) / 400.0));
  v_delta := floor(32 * (p_score - v_e) + 0.5)::integer;

  -- floor/ceiling クランプ (0004 check と同値。check 違反例外でなくクランプで返す)。
  update public.profiles
     set rating = greatest(100, least(3000, v_row.rating + v_delta)),
         games = games + 1
   where id = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 実行権限。
-- handle_new_user はトリガ専用なので全ロールから剥奪。
-- set_initial_rating は authenticated が自分の行に対して呼ぶ (オンボーディング)。
--
-- 【apply_rated_result は 2C-1 では誰にも GRANT しない — 意図的】
-- 監査ワークフロー指摘 (medium): authenticated に GRANT すると、UI 未配線でも
-- REST 直叩き (/rest/v1/rpc/apply_rated_result) の無制限リプレイで ~57 回の
-- 「対2800勝利」を積んでレート 3000 に到達できる。2C-1 はそもそも client から
-- 呼ばないので、関数定義だけ先行させ GRANT は配線する 2C-2 で行う。
-- 2C-2 で再 GRANT する際の必須条件 (Codex ゲートで再審査すること):
--   - rate_check (0003) 等による呼び出し回数の上限、または
--   - サーバー主導の game_id 発行 + 冪等キー検証
-- ---------------------------------------------------------------------------
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.set_initial_rating(integer, text) from public, anon;
revoke all on function public.apply_rated_result(integer, numeric) from public, anon, authenticated;
grant execute on function public.set_initial_rating(integer, text) to authenticated;
