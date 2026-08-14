# フィードバック運用

アプリ内「フィードバック」→ **Firebase `feedback-adcd2`（非公開 Firestore）**。

手順の正: `~/development/projects/feedback-platform/docs/CONNECT.md`  
分析: `~/development/projects/feedback-platform/docs/ANALYST.md`

旧 Edge `feedback` → 公開 GitHub Issue はフロント導線から外した（関数コードはレガシーとして残置）。

## 初回セットアップ（現行）

1. Firebase コンソール → `feedback-adcd2` → プロジェクトの設定 → マイアプリ（Web）の config を取得
2. Cloudflare Pages（および local `.env.local`）に設定:

```bash
VITE_FEEDBACK_FIREBASE_API_KEY=...
VITE_FEEDBACK_FIREBASE_AUTH_DOMAIN=feedback-adcd2.firebaseapp.com
VITE_FEEDBACK_FIREBASE_PROJECT_ID=feedback-adcd2
VITE_FEEDBACK_FIREBASE_APP_ID=...
VITE_FEEDBACK_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FEEDBACK_FIREBASE_STORAGE_BUCKET=feedback-adcd2.firebasestorage.app
# 本番 Pages のみ:
# VITE_FEEDBACK_TARGET=prod
VITE_FEEDBACK_URL=https://forms.gle/...
```

PR やコミットに生の apiKey を貼らない。`projectId` が `feedback-adcd2` 以外だとクライアントが throw する。

3. preview / local で 1 通送り、コンソールの **`feedback_dev`** に `product=chess-japan` が見えること
4. 本番 GO のあと Pages に `VITE_FEEDBACK_TARGET=prod` を入れて再デプロイ → **`feedback`** へ

## トリアージ

1. Firebase コンソールで `feedback`（または開発時 `feedback_dev`）を `status == new` で見る
2. スパム・秘密混入はコンソール上で status 更新（クライアントからは update 不可）
3. 小さい修正は通常の手動 PR。旧 `agent-fix` Automation は Issue 前提のため現行導線では使わない

## vendor 更新

`vendor/feedback-*` は feedback-platform からのコピー。更新時は CONNECT どおり取り直し、`vendor/FEEDBACK_PLATFORM_COMMIT.txt` を更新。勝手に改変しない。lockfile 変更はオーナー合意。

## 障害時

| 症状 | 確認 |
|---|---|
| 送信失敗 → Form 誘導 | `VITE_FEEDBACK_FIREBASE_*` 欠落 / ネットワーク / rules |
| projectId エラー | `VITE_FEEDBACK_FIREBASE_PROJECT_ID` が `feedback-adcd2` か |
| 本番に書けない | Pages に `VITE_FEEDBACK_TARGET=prod` があるか（無いと feedback_dev） |
| 返信希望が拒否 | 仕様。Spark で TTL 不可のため `wantsReply` は閉じている |

## レガシー（Edge / GitHub Issue）

契約: [`docs/feedback/ISSUE_CONTRACT.md`](../feedback/ISSUE_CONTRACT.md)。  
secrets（`GITHUB_FEEDBACK_*`）の整理・undeploy は別タスク。
