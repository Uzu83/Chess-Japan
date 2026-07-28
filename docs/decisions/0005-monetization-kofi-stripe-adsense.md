# 決定: 収益化の順番（Ko-fi → Stripe → AdSense 後回し）

- 状態: **決定済み**（オーナー合意 2026-07-26）
- 日付: 2026-07-26
- 関連: `docs/PLAN.md`（収益・コスト設計）, `docs/COST_DEFENSE.md`, `docs/operator/monetization-runbook.md`, `src/App.tsx`（支援するリンク）

## 背景

収益手段として AdSense / Stripe サブスク / Ko-fi が候補。リポジトリを private にして独占販売する案は
GPL（Stockfish / やねうら王 / chessground 等）と相性が悪く不採用。SaaS 課金＋任意支援が本筋。

## 決定（順番固定）

| 順 | 手段 | いつ | 備考 |
|---|---|---|---|
| 1 | **Ko-fi（任意支援）** | **いま** | UI 済み（`VITE_KOFI_URL`）。決済連携・PII 不要。Cloudflare Pages に URL を入れるだけ |
| 2 | **Stripe サブスク** | 次（設計→手動承認→実装） | 有料プランで Pro 解説枠。モデル選択は**サーバー側のみ**。課金キーは手動承認領域 |
| 3 | **Google AdSense** | **後回し** | 再検討ライン＝月間数千 PV。COEP と third-party 広告の衝突・世界観・同意管理のコストが先に来る |

## Stripe 導入時の不変条件（実装前に再確認）

1. **クライアントから model を受け取らない**（`validate.ts` に model フィールドを足さない）。JWT → プラン → サーバーがモデル決定。
2. **無料枠の IP / account 防衛**は [0001](0001-free-quota-account-abuse-defense.md) に従う。
3. **コスト防衛を緩めない**（レート制限・日次・Turnstile・キャッシュ）。有料でも濫用防壁は残す。
4. Stripe の webhook / Customer Portal / 価格 ID は **人間がダッシュボードで作成**し、secrets にだけ入れる。

## AdSense を後回しにする理由（再掲）

- 本番は WASM 用 COOP/COEP。広告 script/iframe と衝突しやすい。
- トラフィック前は収益ほぼゼロで UX・CSP・同意管理のコストだけ先払い。
- 入れる場合もフッター1枠のみ（盤・解説エリア禁止）。

## やらないこと

- リポジトリを private にして「ソース非公開＝収益化」とみなすこと
- AdSense を Stripe より先に入れること
- 自動で Stripe 本番キーを AI が設定すること（手動承認）
