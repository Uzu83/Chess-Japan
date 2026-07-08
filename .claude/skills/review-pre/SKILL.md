---
name: review-pre
description: 実装前の計画・設計に対する Codex 異モデルレビューを実行し、指摘を項目別に裁定して計画へ反映する。auth/課金/migration/削除系など失敗コストが高い変更の実装開始前に使う。
argument-hint: "[計画ファイルパス]"
disable-model-invocation: true
---

# Review Pre — 実装前レビューと裁定

<!-- テンプレからの読み替え(WHY — /dev-secure scope:agents が Chess-Japan 向けに配置):
     このリポジトリで「失敗コストが高い変更」= CLAUDE.md の不変条件に触れる変更
     （コスト防衛 Edge Function / RLS ロック / validate.ts 信頼境界 / GPL 分離）と
     supabase/migrations/ への変更。これらは実装前に必ずこの skill を通す
     （CLAUDE.md「レビュー方針」と同じ規約）。重点観点は .codex/prompts/pre-review.md に記載。 -->

## 入力（YAML ブロックまたは引数）

- `plan_path`: レビュー対象の計画（省略時は直近の会話で提示された計画。ファイルが必要なら `docs/progress/` の最新ファイル）

## 手順

1. Codex を read-only で起動する:
   ```bash
   mkdir -p artifacts/review
   codex exec --sandbox read-only \
     --output-schema .codex/review-schema.json \
     --output-last-message artifacts/review/pre-review.json \
     "$(cat .codex/prompts/pre-review.md) 対象計画: <plan_path>"
   ```
2. `artifacts/review/pre-review.json` の finding を **1 件ずつ**検証する。Codex の出力は信用せず、cited されたファイル・計画箇所を自分で読み直す（前段出力への盲従禁止）。
3. 各 finding に accept / reject / defer を付け、`artifacts/review/pre-review-adjudication.json` を書く（形式は review-post skill の Output schema と同一）。
4. accept した項目を計画ファイルに反映してから実装に入る。reject には根拠を必ず書く — 「Codex を満たすまで全採用」はしない（合意が目的、承認スタンプは目的ではない）。
5. 収束条件: 反論込みで最大 3 サイクル。未収束の項目は人間に判断を仰ぐ。

## 裁定ルール

| 条件                                                                     | 判定                          |
| ------------------------------------------------------------------------ | ----------------------------- |
| 再現シナリオが具体的で、セキュリティ・データ損失・不可逆性に関わる       | accept                        |
| 指摘は妥当だが今回のスコープ外／影響が限定的                             | defer（期限か Issue 化を必須）|
| 事実誤認・計画の誤読・既存規約との矛盾を見落とした指摘                   | reject（根拠を明記）          |
