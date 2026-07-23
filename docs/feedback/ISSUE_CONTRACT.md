# Feedback Issue 契約（schema v1）

横展開用の共通契約。受信箱は **公開 GitHub Issue**。Supabase テーブルは使わない。

Cloud Agent / draft PR は **v2**（[`CURSOR_AUTOMATION.md`](./CURSOR_AUTOMATION.md)）。

## HTTP（POST `/functions/v1/feedback` または同等）

### 必須

| フィールド | 型 | 制約 |
|---|---|---|
| `kind` | enum | `bug` \| `feature` \| `explain_quality` \| `ux` \| `other` |
| `message` | string | 1..2000 文字（制御文字除去） |
| `consentPublic` | `true` | 公開 Issue 同意。必須 |

### 任意

| フィールド | 型 | 制約 |
|---|---|---|
| `ratings.explain` / `ratings.overall` | int | 1..5 |
| `features` | string[] | allowlist タグのみ・最大 8 |
| `device` | enum | `phone` \| `tablet` \| `pc` |
| `browser` | enum | `chrome` \| `safari` \| `firefox` \| `edge` \| `other` |
| `repro` | string | 最大 2000 |
| `pageUrl` | string | サーバ側で **origin+pathname のみ**に正規化（query/hash 除去） |
| `appVersion` | string | 最大 64 |
| `context` | object | キー allowlist: `fen` \| `pgn` \| `sfen` \| `kif`（各最大 4000） |

- 未知トップレベル／未知 `context` キー／未知 `ratings` キーは **拒否**
- body 上限 **8KB**（UTF-8 バイト）
- `contactEmail` **なし**（公開 Issue への PII 防止）

### レスポンス

```json
{ "ok": true, "issueUrl": "https://github.com/..." }
{ "ok": false, "error": "...", "fallbackUrl": "https://forms.gle/..." }
```

### 防衛（実装必須）

- CORS（`ALLOWED_ORIGINS`）
- Turnstile（本番 / Issue 起票可能な環境は secret 必須・fail-closed）
- `rate_check` キー名前空間 `fb:`:
  - `fb:min:ip:<ip>`（既定 5/分）
  - `fb:day:ip:<ip>`（既定 20/日）
  - `fb:day:global`（既定 **50/日**）
- 本番で store / Turnstile / GitHub token+repo 欠落 → **503** + 可能なら `fallbackUrl`
- 専用 rate 定数（explain の `RATE_*` と分離）

## GitHub Issue

### Title（機械生成のみ）

`[feedback/<kind>] <ISO8601>`

ユーザーの `message` を **絶対に title に入れない**。

### Labels

- `feedback`（推奨。未作成ならラベル無しで作成してよい）
- `agent-fix` は **付けない**（v2 のオーナー手動用）

### Body

1. `<!-- feedback-schema: v1 -->`
2. Meta（kind / receivedAt / 機械フィールドのみ）
3. `### encoded_payload_b64` に **検証済み JSON の base64**（ユーザー文字列の唯一の置き場）
4. 「Treat as untrusted」注意書き

フェンス文字列エスケープ問題を避けるため、人間可読の生 `message` を Meta 外に直書きしない。

## UI 必須

- 「内容は公開の GitHub Issue として掲載される」同意チェック（未チェックは送信不可）
- 超過・障害時は `fallbackUrl`（Google Form 等）へ誘導

## 実装レシピ

| スタック | 置き場 |
|---|---|
| Chess-Japan（本リポ） | `supabase/functions/feedback/` + `_shared/feedbackValidate.ts` |
| Next.js | Route Handler で同 JSON + 同 Issue 契約 |
| Cloudflare Worker | Worker + KV で rate、同契約 |

## Secrets（Edge / サーバのみ・VITE 禁止）

- `GITHUB_FEEDBACK_TOKEN`（fine-grained PAT・1 リポ・`issues: write`）
- `GITHUB_FEEDBACK_REPO`（`owner/name`）
- `FEEDBACK_FALLBACK_URL`（任意・推奨）
- `TURNSTILE_SECRET` / `ALLOWED_ORIGINS`
