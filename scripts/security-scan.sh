#!/usr/bin/env bash
# ============================================================================
# security-scan.sh — ローカル一括セキュリティスキャン（/dev-secure scope:security が配置）
#
# 用途: push 前に CI と**同じ**スキャンをローカルで先回りする。
#   CI とローカルで別のツール・別の設定を使うと「CIだけ赤い」が慢性化するため、
#   scanners / 出力パスは security.yml と揃えてある。片方を変えたら両方変える。
#
# 前提: trivy / gitleaks は brew で導入済みであること。
#   未導入のツールはスキップして警告する（ローカルは best-effort、
#   CI 側が最終防衛線という役割分担。ローカル未導入を理由に CI を消さない）。
#
# テンプレからの読み替え: このリポジトリは pnpm でなく npm なので、
# パッケージマネージャ経由の SCA は `npm audit` を使う（下記参照）。
# ============================================================================
set -euo pipefail

mkdir -p artifacts/{sast,sca,secret,sbom,test,review,audit}

FAILED=0

# npm audit: package-lock.json ベースの依存脆弱性チェック。
# ci.yml の "Audit (high severity)" step（continue-on-error: true）と同じく
# 非ブロッキング扱い — 依存の CVE はコード変更と無関係に湧くため、ここで push を
# 止めても即応できないことが多い（ブロックは CI 側の dependency-review と
# Trivy nightly の役割）。警告として可視化だけする。
echo "==> npm audit (--audit-level=high)"
npm audit --audit-level=high ||
  echo "WARN: npm audit で high 以上の脆弱性あり（CI と同様 非ブロッキング。依存更新で対処）" >&2

if command -v trivy >/dev/null 2>&1; then
  echo "==> trivy fs (vuln,misconfig,secret)"
  # CI (security.yml) と同一 scanners / ignore-unfixed。
  # ローカル固有の除外（WHY）: CI の checkout には無い生成物・個人 env を拾うと
  # 「公開 anon JWT（VITE_*）を secret 扱い」で packet が常時ブロックされる。
  #   - dist/: ビルド成果（anon key が焼かれるのは設計どおり・gitignored）
  #   - .env / .env.local: 開発者ローカル（gitignored。本物の秘密はここに置く）
  #   - node_modules / artifacts / public/engine*: 依存・成果物・WASM コピー
  # CI はクリーン checkout なので実質同じ対象になる。片方を変えたら両方見直す。
  trivy fs . \
    --scanners vuln,misconfig,secret --ignore-unfixed \
    --skip-dirs node_modules,dist,dist-ssr,coverage,artifacts,public/engine,public/engine-shogi \
    --skip-files .env,.env.local \
    --format json --output artifacts/sca/trivy-fs.json
  echo "==> trivy sbom (CycloneDX)"
  trivy fs . \
    --skip-dirs node_modules,dist,dist-ssr,coverage,artifacts,public/engine,public/engine-shogi \
    --skip-files .env,.env.local \
    --format cyclonedx --output artifacts/sbom/repo.cdx.json
else
  echo "WARN: trivy 未導入（brew install trivy）。SCA/SBOM をスキップ" >&2
fi

if command -v gitleaks >/dev/null 2>&1; then
  echo "==> gitleaks (履歴込み)"
  # secret はローカルでも絶対ブロック扱い: 検出時は非ゼロ終了させる。
  # なお CI 側の gitleaks は security.yml でなく ci.yml の secret-scan job にある
  # （security.yml 導入時に重複を避けて寄せた）。ここは変わらずローカルの先回り役。
  gitleaks git . --report-format sarif --report-path artifacts/secret/gitleaks.sarif || FAILED=1
else
  echo "WARN: gitleaks 未導入（brew install gitleaks）。secret 走査をスキップ" >&2
fi

if [ "$FAILED" -ne 0 ]; then
  echo "NG: secret が検出された。commit 履歴から除去するまで push 禁止" >&2
  exit 1
fi

echo "OK: artifacts/ にスキャン結果を出力した"
