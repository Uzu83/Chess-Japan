# RLS / RPC 権限スモーク（F009）

本番の service_role で破壊的操作をしないこと。ローカル `supabase start` または一時ブランチで実行。

## チェックリスト

| # | ロール | 操作 | 期待 |
|---|---|---|---|
| 1 | anon | `insert into games` | 拒否 |
| 2 | anon | `save_unverified_ai_game` | 拒否 |
| 3 | authenticated（未確認メール） | `save_unverified_ai_game` | `email not confirmed` |
| 4 | authenticated（本人・確認済） | `save_unverified_ai_game` | 成功・`trust_level=unverified`・`rated=false` |
| 5 | authenticated | `games` 直 INSERT | 拒否（GRANT なし） |
| 6 | authenticated（他人） | 他人行 SELECT | 0 行 |
| 7 | authenticated | `apply_rated_result` | 実行権限なし |
| 8 | anon | `get_public_strength('nope')` | null |
| 9 | authenticated | `pvp_join_queue('chess')` | 成功（確認済）。既存 waiting/active があれば再利用 |
| 10 | authenticated | `pvp_join_queue('shogi')` | `shogi pvp not available` |
| 11 | authenticated | `pvp_submit_move` / `pvp_finalize` | **関数不存在**（0010 で DROP） |
| 12 | authenticated | `pvp_apply_move` | 実行権限なし（service_role のみ） |
| 13 | authenticated | `pvp_resign` on active | 呼び出し者敗北・`finish_reason=resign` |
| 14 | authenticated | `pvp_record_game` on finished | 本人行・`trust_level=verified`・冪等 |
| 15 | authenticated | `pvp_record_game` on active | 拒否 |
| 16 | Edge+JWT | 非法 SAN POST `/functions/v1/pvp` | 400・DB 不変 |
| 17 | authenticated | 手番放置 300s 超 + heartbeat | 手番側 timeout 敗北 |
| 18 | anon | `get_public_strength` 連打 | 20/分超で null（rate_check） |
| 19 | authenticated（非参加者） | Realtime 購読 `pvp_rooms` | イベント 0 件 |
| 20 | authenticated | `attach_unverified_analysis` 2回目 | `game not found`（一度だけ） |
| 21 | authenticated | `set_strength_visibility` public（verified&lt;20） | `not enough games` |

SQL ひな形: [`supabase/tests/rls_games_matrix.sql`](../supabase/tests/rls_games_matrix.sql)

## デプロイ順（0010・逆順禁止）

1. migration `0010_pvp_server_authority.sql` 適用
2. 旧 `pvp_submit_move` / `pvp_finalize` が呼べないことを確認
3. Edge Function `pvp` を deploy
4. 新クライアントをデプロイ
5. `VITE_PVP_ENABLED=1`（表示フラグ。実停止は Edge disable / RPC REVOKE）

## Realtime

`pvp_rooms` は production で `supabase_realtime` publication に追加済み（2026-07-17）。
新規環境では Dashboard → Database → Publications に追加すること。
非参加者が購読しても RLS で 0 件になることを #19 で実測する。
