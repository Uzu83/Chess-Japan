---
name: risk-gate
description: CI 成果物（テスト・SAST・SCA・SBOM）と review-adjudication を束ねて、人間がコードを読まずに承認判断できる release-decision-packet を生成する。マージ・リリース判定の直前に使う。
argument-hint: "[artifacts-dir]"
disable-model-invocation: true
---

# Risk Gate — 承認票の組み立て

<!-- テンプレからの読み替え(WHY — Chess-Japan での成果物の生成元。集約契約は scripts/build-review-packet.mjs 側が正):
     - JUnit:        ci.yml が `npm run test -- --reporter=default --reporter=junit --outputFile.junit=artifacts/test/junit.xml`
                     で生成（ローカルで欠けていれば同コマンドで先に生成する）
     - Trivy JSON / SBOM / gitleaks: security.yml（CI）または `bash scripts/security-scan.sh`（ローカル先回り。CI と同一パス契約）
     - review-adjudication: /review-post skill が artifacts/review/review-adjudication.json に生成
     このリポジトリのツールチェーンは npm + ESLint + Prettier + vitest（AGENTS.md / CLAUDE.md 参照）。 -->

## 前提

このskillは**新しい分析をしない**。既に生成された機械可読成果物を集約するだけ（分析と承認材料の生成を分離することで、ゲート自体が恣意的にならないようにする）。

## 手順

1. 集約スクリプトを実行する:
   ```bash
   node scripts/build-review-packet.mjs
   ```
   生成物: `artifacts/audit/risk-gate.json` と `artifacts/audit/release-decision-packet.md`
2. packet の「欠損成果物」欄を確認する。**必須成果物（JUnit / trivy JSON / review-adjudication）が欠けたまま「承認可」と書いてはいけない** — 欠損は fail-closed（ブロック）として扱われているか検証する。
3. packet を人間に提示する。提示するのは packet のみ。コード本文・diff・生ログは求められない限り出さない。

## ブロック条件（スクリプトが機械判定。severity 無関係）

- secret 検出が 1 件でもある
- 必須テストの失敗
- review-adjudication に未裁定の critical/high finding が残っている
- SBOM が生成されていない

## 人間が見る packet の構成

変更要約 / リスクレベル / テスト結果統計 / 脆弱性 severity 集計 / Codex 裁定統計（accept・reject・defer 件数と理由要約）/ SBOM・attestation の有無 / ブロック判定と根拠 / 承認・却下の記入欄
