# 0002 — AI戦クラウド履歴は unverified、クラウドレートは延期

- Status: accepted
- Date: 2026-07-17
- Codex findings: F001, F002（account + strength plan review）

## Context

公開 SPA では anon key で REST/RPC を直叩きできる。クライアントが作った対局行や解析値を
「サーバーに保存された＝信頼できる」と扱うと、架空対局・捏造精度・レート不正が成立する。

既存 `apply_rated_result`（migration 0005）は定義済みだが **誰にも GRANT していない**。
再 GRANT 条件は「サーバー主導の game_id 発行 + 冪等キー検証」とコメントされている。

## Decision

1. AI戦のクラウド保存は `trust_level = 'unverified'` の自己用履歴のみ。
2. 書き込み口は `save_unverified_ai_game` SECURITY DEFINER RPC のみ（テーブル INSERT GRANT なし）。
3. `apply_rated_result` への GRANT は行わない（現状維持）。クラウドレートはサーバー発行
   challenge + 棋譜合法性検証 + 未消費消費が揃うまで独立計画。
4. 公開プロフィール・競争的表示は `trust_level = 'verified'` のみ（AI・旧自己申告は対象外）。
5. **PvP（2026-07-23・ADR 0003 / migration 0010）**: 着手は Edge+chess.js、終局はサーバー導出。
   `pvp_record_game` が本人 `games` に **verified** で冪等保存（クライアントは result/record を送らない）。
   旧 `pvp_finalize` / `pvp_submit_move` は DROP。0008 案Aの「後追い不一致許容」は **廃止**
   （finished 後は room.result が唯一の正）。

## Consequences

- ログインユーザーは端末をまたいで「自分の分析メモ」を持てるが、AI戦は改ざん可能と UI で明示する。
- Elo クラウド同期（旧 2C-2）は本決定により AI戦直結では出荷しない。
- 公開集計・将来レートは verified（サーバー権威 PvP）のみ。AI は unverified のまま遡及昇格しない。
