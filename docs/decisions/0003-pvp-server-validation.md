# 0003 — PvP サーバー権威（Edge 着手検証 + DB 終局）

- Status: accepted
- Date: 2026-07-23
- Related: ADR 0002、A0 plan audit

## Context

0007–0009 のカジュアル PvP は「手番ガード + クライアント申告終局」だった。
認証済み攻撃者が非法 SAN や任意勝敗を RPC 直叩きで入れられ、相手盤が desync する。

## Decision

1. 着手は Edge Function `pvp` のみ。JWT→uid、chess.js で合法手検証後、
   `pvp_apply_move`（**service_role 専用**・`FOR UPDATE`・手数一致）で原子更新。
2. `pvp_submit_move` / `pvp_finalize` は exact signature で REVOKE→DROP。
3. 投了は `pvp_resign`（呼び出し者敗北のみ）。履歴は `pvp_record_game`（result/record は
   サーバー生成、`trust_level=verified`）。
4. heartbeat は bearer-session の liveness（人間証明ではない）。手番タイムアウトで固着防止。
5. 公開 Strength の局数は `verified` のみ（ADR 0002 と整合）。

## Deploy order（逆順禁止）

migration 0010 → 旧 RPC 死活確認 → Edge `pvp` deploy → 新 client → `VITE_PVP_ENABLED=1`

## Cutover（0010 適用時の旧部屋）

1. **前提**: `status='active' AND authority_version<1` が 0 件であること。
   1 件でもあれば migration は `0010 refused: …` で失敗（fail-closed）。
2. ops が手動で active を abort/終了させてから再適用。
3. 適用成功時: `waiting` + `authority_version<1` → `aborted`（version は 0 のまま）。
4. 旧 `finished`（`finish_reason` NULL）は verified 記録対象外のまま。

## Consequences

- 案Aの「双方 result 食い違い」は、サーバー確定の room.result により解消方向。
- AI戦は引き続き unverified。クラウドレート GRANT はしない。
- 初回まとめて 0007–0010 を入れる環境では active=0 のためガードは実質 no-op。
