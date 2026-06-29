-- コスト防衛の中核テーブル。いずれも「公開 anon key から一切触れない」ことを最重要要件とする。
-- 設計(オーナー要望「RLSしっかり」+ Codex/多観点レビュー合意):
--   anon key はフロントJSに焼かれ公開される。したがってこれらの内部テーブルは
--   RLS を有効化しつつ「ポリシーを一切作らない」= default deny とし、anon/authenticated には
--   select/insert/update/delete を一切許可しない。Edge Function は service_role キー(サーバ側秘密)で
--   アクセスし、service_role は RLS をバイパスするためここだけが唯一の入口になる。
-- 本番(ref: vpbixcwxjhmapcyaarbq)へは MCP で適用済み。本ファイルは再現性のための版管理。

-- 解説キャッシュ: 同一局面の再解説で LLM を再課金しないため(コスト核)。
create table if not exists public.explain_cache (
  cache_key text primary key,                 -- 正規化した局面事実+level のハッシュ(SHA-256 16進)
  game text not null check (game in ('chess', 'shogi')),
  level text not null default 'beginner',
  explanation text not null,                  -- 生成済み解説本文
  provider text not null,                     -- claude / grok / gemini 等
  hit_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
alter table public.explain_cache enable row level security;
-- 意図的にポリシーを作らない: anon/authenticated は default deny。service_role のみアクセス可。
comment on table public.explain_cache is
  'LLM解説キャッシュ。RLS有効・ポリシー無し(default deny)=公開anon keyから触れない。Edge Functionのservice_roleのみ。';

-- レート制限/日次クォータ用カウンタ。bucket_key にウィンドウ種別を encode する
-- (例: "min:ip:<ip>:<epoch分>", "day:ip:<ip>:<日付>")。Edge Function が rate_check RPC 経由で atomic increment。
create table if not exists public.rate_counters (
  bucket_key text primary key,
  count integer not null default 0,
  expires_at timestamptz not null,            -- このカウンタの有効期限(掃除用)
  created_at timestamptz not null default now()
);
alter table public.rate_counters enable row level security;
create index if not exists rate_counters_expires_at_idx on public.rate_counters (expires_at);
comment on table public.rate_counters is
  'レート制限/日次クォータのカウンタ。RLS有効・ポリシー無し(default deny)=公開anon keyから触れない。service_roleのみ。';
