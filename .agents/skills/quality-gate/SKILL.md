---
name: quality-gate
description: Chess-Japan の段階制品質ゲート。Tier 判定 →（Tier2）3観点並列 Codex → 裁定 → 2連続クリーン評価 → risk-gate 承認票。PR/本番 merge 前に使う。
argument-hint: "[classify|review|status|packet] [--base main]"
disable-model-invocation: true
---

# Quality Gate — 品質保証ゲート（統合入口）

全文: `docs/QUALITY_GATE.md`

## クイックフロー

```bash
# 1. 変更の Tier 判定
node scripts/run-quality-gate.mjs classify --base main

# 2. 機械検証（常に）
npm run verify
# Edge 触ったら: deno check supabase/functions/*/index.ts

# 3. Tier 2 のみ — 3観点 Codex 並列
node scripts/run-quality-gate.mjs review --base main

# 4. メインエージェントが finding を検証し artifacts/review/review-adjudication.json を書く
#    accept → 修正 → verify → 次サイクル review

# 5. 合意状態
node scripts/run-quality-gate.mjs status
# consecutive_clear_cycles >= 2 で passed

# 6. 承認票（人間はこれだけ見る）
bash scripts/security-scan.sh   # ローカル先回り（任意だが Tier2 推奨）
node scripts/build-review-packet.mjs
```

## Tier 概要

| Tier | 並列 Codex | 2連続クリーン |
|------|------------|---------------|
| 0 | 不要 | 不要 |
| 1 | 任意（単一 `/review-post`） | 不要 |
| 2 | **authz + cost + data** | **必須** |

## 副審（推奨・Tier 2）

- migration / 新規 RPC: Claude `reviewer` で authz 残存確認
- 公開 API / PvP 終局: Claude `red-team` で悪用シナリオ

副審は裁定権なし。メインが accept/reject/defer。

## ファール規則

- high/critical を **reject** → ファール +1、**ゲートは抜けない**
- **2連続クリーン**（全観点 raw high/critical=0 かつ accept=0）でのみ passed
- 最大 3 サイクル → 未収束は `human_required`

## 裁定 JSON（review-adjudication.json）

`review-post` skill と同 schema。Tier 2 では各 item に `perspective`（authz|cost|data）と `severity` を付けると `evaluate-gate-state` がファール集計できる。

## 禁止

- Codex 指摘の無検証一括適用
- reject だけでゲート合格扱い
- Loop-Until-Dry（指摘ゼロまで無限ループ）
