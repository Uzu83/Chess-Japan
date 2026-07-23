-- RLS / RPC 権限マトリクス（F009）— ローカル Supabase または staging で手動/CI 実行
-- 前提: migration 0006/0007 適用済み。service_role と anon/authenticated JWT で検証。
--
-- 期待:
--   anon: games INSERT 失敗、save_unverified_ai_game 失敗、list_my_games 失敗
--   authenticated (email 未確認): save_unverified_ai_game → 'email not confirmed'
--   authenticated (確認済 owner): save_unverified_ai_game 成功、直 INSERT 失敗
--   authenticated (他ユーザー): 他人の games SELECT 0 行
--   apply_rated_result: authenticated でも execute 不可（GRANT なし）

-- 例（psql / supabase db execute）:
-- set role anon;
-- insert into public.games (user_id, game_kind, mode, you_color, outcome) values (...); -- FAIL
-- select public.save_unverified_ai_game(...); -- FAIL

-- set role authenticated; -- with JWT claim sub=...
-- select public.apply_rated_result(1200, 1); -- FAIL (permission denied for function)

-- 自動化は scripts/rls-smoke.md の手順に従う（本番 service_role での破壊操作禁止）。
