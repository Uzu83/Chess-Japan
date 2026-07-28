# Quality Gate — Chess-Japan 品質保証ゲート

> **目的**: 変更の危険度に応じてレビュー強度を変え、高リスク領域だけ「多観点・多モデル・合意形成」をかける。
> **正**: 手順の機械部分は `scripts/`、エージェント向け入口は `.agents/skills/quality-gate/SKILL.md`。

## なぜ段階制か

- **全面2連続クリーン並列**は、ノイズ指摘の reject 待ちやモデル揺らぎでコストだけ増える（レビュー劇場化）。
- **GHAS（CodeQL / Dependabot / secret scanning）**は依存・典型脆弱性・秘密漏えいの床だが、**RLS/GRANT/RPC 信頼境界**や **Edge コスト防衛**は拾えない。
- よって **Tier 0〜2** で強度を変え、Tier 2 だけ観点分割＋2連続クリーンを要求する。

## Tier 定義（自動分類: `node scripts/classify-change-tier.mjs`）

| Tier | 典型変更 | 必須ゲート |
|------|----------|------------|
| **0** | lint / 型 / コメント / Prettier のみ | `npm run verify` |
| **1** | 通常 UI・純ロジック（auth/DB/Edge 非接触） | `npm run verify` + （推奨）単一 Codex `/review-post` |
| **2** | `src/auth/**` / `supabase/migrations/**` / `supabase/functions/**` / コスト防衛・RLS・validate 境界 | 下記 **Tier 2 フルゲート** |

Tier 2 の自動判定パターンは `scripts/gate-tier-rules.json` を正とする。

## Tier 2 フルゲート（高リスク）

### 1. 機械ゲート（常に先）

```bash
npm run verify
# supabase/functions に触れたら
deno check supabase/functions/*/index.ts
# PR 前推奨（CI と同契約）
bash scripts/security-scan.sh
node scripts/build-review-packet.mjs   # fail-closed
```

**絶対ブロック**（severity 無関係）: テスト失敗 / secret 検出 / 必須成果物欠損 / 未修正の accept(high/critical)。

### 2. 並列 Codex 観点（1観点 = 1セッション）

| 観点 ID | プロンプト | 担当モデル | 見るもの |
|---------|------------|------------|----------|
| `authz` | `.codex/prompts/post-review-authz.md` | Codex (GPT) | RLS / GRANT / SECURITY DEFINER / RPC 入口 / 他人データ |
| `cost` | `.codex/prompts/post-review-cost.md` | Codex (GPT) | explain コスト防衛 / validate 境界 / 秘密 / レート |
| `data` | `.codex/prompts/post-review-data.md` | Codex (GPT) | migration 破壊 / 冪等 / 履歴破壊 / 件数上限 |

起動:

```bash
node scripts/run-quality-gate.mjs review --base main
```

出力: `artifacts/review/perspectives/<id>/cycle-<n>.json`

### 3. 副審（推奨・Tier 2 のみ）

| 役割 | モデル | タイミング |
|------|--------|------------|
| 認可の独立検証 | Claude `reviewer` | `authz` 観点に high/critical が出たとき、または migration 変更時 |
| 敵対シナリオ | Claude `red-team` | 新規 RPC / 公開 API / PvP 終局経路 |

副審は **裁定権なし**。finding はメインエージェントが accept/reject/defer する。

### 4. 裁定（メインエージェント）

- Codex 出力は **untrusted**。`file:line` を自分で読み直す。
- 1 finding ずつ `artifacts/review/review-adjudication.json` に記録。
- **reject はゲート抜けに寄与しない**（下記ファール）。
- **accept した high/critical は修正してから次サイクル**。

### 5. 合意条件（2連続クリーン）

**クリーンサイクル** = 次をすべて満たす:

1. 必須観点（authz / cost / data）の raw レビューで **severity high/critical の findings が 0**
2. 裁定 JSON に **status=accept の項目が 0**（修正済み or 指摘なし）
3. `npm run verify`（+ 該当時 `deno check`）が緑

**ゲート合格**: 上記クリーンサイクルが **2回連続**（最大 **3サイクル**、未収束は人間へ。Loop-Until-Dry 禁止）。

状態評価:

```bash
node scripts/evaluate-gate-state.mjs
```

### 6. ファール（野球ルール・監査用）

| イベント | カウント | ゲートへの効果 |
|----------|----------|----------------|
| high/critical を **reject**（根拠付き） | ファール +1 | **抜けられない**（クリーンに寄与しない） |
| high/critical を **accept** したまま次サイクル | ブロック | 修正必須 |
| **defer** | ファールなし | 人間 or 期限付き Issue。2連続クリーンには含めない |
| 同一 finding を **2サイクル連続 reject** | `human_required` フラグ | 人間が最終裁定 |

ファールは **エスケープ手段ではない**。監査ログと「reject しすぎ／甘すぎ」検知用。

## GHAS の位置づけ

- **常時 ON**（`.github/workflows/security.yml`）: CodeQL / Trivy / gitleaks / SBOM。
- **Tier 2 では不足**: DB 信頼境界・RPC-only 書き込み・クライアント申告モデルは Codex 観点 + 副審が担当。
- `build-review-packet.mjs` が機械成果物を fail-closed 集約。人間は `artifacts/audit/release-decision-packet.md` のみ見る。

## 成果物一覧

| パス | 内容 |
|------|------|
| `artifacts/review/tier.json` | 自動 Tier 判定 |
| `artifacts/review/perspectives/*/cycle-*.json` | 観点別 Codex 生出力 |
| `artifacts/review/review-adjudication.json` | 裁定（risk-gate 入力） |
| `artifacts/review/gate-state.json` | 連続クリーン数・ファール・合格判定 |
| `artifacts/audit/risk-gate.json` | 機械ゲート集約 |
| `artifacts/audit/release-decision-packet.md` | 人間向け承認票 |

## PR 運用との対応

| 変更種類（AGENTS.md） | Tier 目安 | PR |
|------------------------|-----------|-----|
| lint/型/パッチ/コメント | 0 | main 直可 |
| 機能・UI・ロジック | 1〜2 | PR 推奨 |
| auth / migration / Edge | 2 | PR 必須 + Tier 2 フルゲート |

## 変更時の同期義務

不変条件（`CLAUDE.md`）を変えるときは、次を同じ PR で更新する:

- `.codex/prompts/post-review-*.md` の重点リスト
- `scripts/gate-tier-rules.json`（該当パスがあれば）
