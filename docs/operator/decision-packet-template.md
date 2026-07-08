# Release Decision Packet（様式の説明）

<!-- /dev-secure scope:gate が docs/operator/ に配置。
     実物は scripts/build-review-packet.mjs が artifacts/audit/ に自動生成する。
     このファイルは「人間が何を見て何を見ないか」の取り決めを残す様式書。 -->

## この文書の位置づけ

人間（オーナー）がマージ・リリース判定で読むのは**この packet だけ**。
ソースコード・diff・生ログは読まない。読みたくなった時点で「packet に載るべき情報が欠けている」と考え、packet 側（= build-review-packet.mjs と裁定 JSON）を直す。

## 記載項目と判断基準

| 項目 | 出どころ | 人間の判断基準 |
|---|---|---|
| 判定（承認可能/ブロック） | risk-gate.json（機械判定） | ブロックなら理由を読むだけ。覆すには waiver（期限必須） |
| 変更要約 | review-adjudication.json の summary | 「何のための変更か」が 3 文で分かるか |
| テスト統計 | JUnit XML 集計 | failures + errors = 0 以外は承認しない |
| 脆弱性集計 | Trivy JSON | CRITICAL は無条件ブロック。HIGH は waiver 検討 |
| Secret 検出 | gitleaks / Trivy | 1 件でも無条件ブロック（waiver 不可） |
| Codex 裁定統計 | review-adjudication.json | reject が多い場合は理由の質を抜き取りで見る（盲目的 reject の検知） |
| SBOM | Trivy CycloneDX | 未生成はブロック（fail-closed） |

## waiver（例外承認）のルール

- **期限必須**。期限なし waiver は発行しない（期限切れ waiver 残数 0 が KPI）
- waiver は `docs/decisions/` に 1 件 1 ファイルで記録: 対象 / 理由 / 補償コントロール / 期限
- Secret 検出と必須テスト失敗には waiver を発行できない

## Chess-Japan での適用範囲

この packet が必須になるのは、CLAUDE.md の不変条件（コスト防衛 Edge Function / RLS ロック /
validate.ts 信頼境界）・auth・migration に触れる PR のみ。日常の小改修は
`npm run verify` + CI（ci.yml / security.yml）の green で足りる（過剰運用しない）。
