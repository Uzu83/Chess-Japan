-- 0004: profiles テーブル — ユーザーが anon key 経由で直接触れる「初の」テーブル
--
-- ============================================================================
-- 【信頼境界の変化 — このファイルを読む未来の担当者へ最重要】
-- 既存の explain_cache / rate_counters は「RLS 有効・ポリシー無し(default deny)・
-- anon/authenticated GRANT 剥奪・service_role のみ」で全面ロックされている
-- (0001/0002/COST_DEFENSE.md)。それはコスト防衛の核であり、本 migration は
-- その2テーブルに一切触れない。
-- profiles だけは意図的に別方針: 「auth.uid() = id の行に限る owner スコープの
-- 直アクセス」を許す。この非対称は事故ではなく設計 (Codex ゲート①合意 2026-07-07)。
-- 誤って explain_cache/rate_counters に同様のポリシーを足すと課金事故に直結する。
-- ============================================================================
--
-- 列レベル GRANT の考え方 (0002 の多層防御思想の踏襲):
--   - rating / games / rating_initialized / rating_source は client の UPDATE GRANT
--     から外す = RLS を通っても物理的に書けない。変更は SECURITY DEFINER RPC
--     (0005) のみ。「rating=9999」のような絶対値チートを GRANT 層で封じる。
--   - updated_at も client に開けない (Codex ゲート①指摘 #3)。touch トリガ専用。
--     ユーザーが任意値を書ける列を増やす意味がない。
--   - client が直接書けるのは display_name ただ1列。

create table if not exists public.profiles (
  -- auth.users と 1:1。退会 (auth.users 削除) で cascade 削除。
  id uuid primary key references auth.users (id) on delete cascade,

  -- 表示名。既定は Google プロフィール名 (handle_new_user トリガが設定)。
  -- 長さ上限 40: 無制限 text は DoS/ストレージ面 (Claude 独自指摘・ゲート①追補)。
  -- 40 の根拠: チェスサイトのハンドル慣行 (lichess=20, chess.com=25) より緩く、
  -- UI レイアウトを壊さない上限。NULL 許容 (未設定でも動く)。
  display_name text check (display_name is null or char_length(display_name) between 1 and 40),

  -- 内部レート。1200 = src/core/rating.ts の INITIAL_RATING と一致させること。
  -- check の [100, 3000] は rating.ts の RATING_FLOOR / RATING_CEILING と一致させる
  -- こと (ゲート①指摘 #1: 上限はフロントにも導入済み。片方だけ変えると
  -- 2990 台の勝利で check violation が起きる)。
  rating integer not null default 1200 check (rating between 100 and 3000),

  -- レート戦の対局数 (RPC のみが加算)。
  games integer not null default 0 check (games >= 0),

  -- 初期レート設定 (オンボーディング/ローカル移行) が済んだか。
  -- set_initial_rating はこれが false のときだけ絶対値セットを許す = 「好きな時に
  -- 好きな値へ再設定」を防ぐ門。
  rating_initialized boolean not null default false,

  -- 初期レートの由来 (2C-3 のアンチチート文脈で ranked/provisional 判定の材料)。
  -- whitelist check (ゲート①指摘 #4): 自由 text だと任意文字列を保存する口になる。
  rating_source text check (
    rating_source in (
      'default',            -- スキップ or 明示的に初期値
      'self_beginner',      -- 自己申告: 初心者 1200
      'self_intermediate',  -- 自己申告: 中級 1500
      'self_advanced',      -- 自己申告: 上級 1800
      'self_custom',        -- 自己申告: 数値直接入力
      'local_migrated'      -- localStorage (cj:rating) からの移行
    )
  ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- owner スコープのポリシー。SELECT/UPDATE とも本人の行のみ。
-- INSERT ポリシーは意図的に作らない: 行生成は handle_new_user トリガ (0005) に
-- 一元化し、client に INSERT の口を与えない。
-- DELETE ポリシーも作らない: 退会は auth.users 削除の cascade のみ。
-- 公開 read (リーダーボード) を今開けない WHY: display_name は Google 実名が
-- 既定値になりうる。全行 read 可にすると実名スクレイピング面ができる。
-- 2C-3 で「SECURITY DEFINER RPC か列限定 VIEW」で意図的に開く (ゲート①合意)。
create policy profiles_select_own on public.profiles
  for select using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- 多層防御: まず全剥奪 → 必要最小だけ付与 (0002 と同じ流儀)。
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
-- client が直接書けるのは display_name のみ (updated_at はトリガ専用・ゲート①#3)。
grant update (display_name) on table public.profiles to authenticated;
-- anon には一切与えない: 未ログインは profiles に触れない (localStorage で完結)。

comment on table public.profiles is
  'ユーザープロフィール。owner スコープ(auth.uid()=id)の直アクセスを許す初のテーブル。'
  'rating/games/rating_initialized/rating_source は UPDATE GRANT 外 = RPC(0005)のみが更新。'
  'explain_cache/rate_counters の全面ロック方針とは意図的に別 (COST_DEFENSE.md 参照)。';

-- updated_at の自動タッチ。client に updated_at の GRANT が無いのはこのため。
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
