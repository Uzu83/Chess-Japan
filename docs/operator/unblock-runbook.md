# オペレーター手順書: 保留タスクのアンブロック（#24 Sentry / #25 Google OAuth）

> このファイルの目的: 本番監視（Sentry）とログイン（Google OAuth）は、コードは実装済みだが
> **人間しか触れないダッシュボード設定**が終わるまで有効化できない（AI は Cloudflare / Google /
> Supabase のコンソールに入れない）。その「あなたが数分でやる操作」を、再導出せずコピペで
> 実行できるようここに固定する。設定が終わったら本番は自動で再ビルド→再デプロイされ、機能が点く。
>
> 前提となる固定値（このプロジェクト実測・2026-07-11）:
> - Cloudflare Pages 本番 URL: `https://chess-japan.pages.dev`
> - Supabase プロジェクト ref: `vpbixcwxjhmapcyaarbq`（公開値。OAuth リダイレクト URI に出る）
> - フロントの `VITE_*` は **ビルド時に焼き込まれる** → 値を変えたら必ず再ビルド＋再デプロイが要る。
>   `VITE_*` は Cloudflare Pages の「Settings → Environment variables → Production」で設定する。

---

## タスク #24 — Sentry 監視を点ける（DSN 設定）

**なぜ止まっているか**: `src/monitoring/sentry.ts` は `VITE_SENTRY_DSN` 未設定なら SDK ごとビルドから
除去される（＝監視オフが既定・実測済み）。DSN を入れて再デプロイすると監視が点く。DSN は公開値なので
第三者が偽イベントを投げて無料枠 quota を消費できる → **Allowed Domains の設定が必須**（Codex ゲート①指摘）。

手順（所要 5〜10 分）:

1. **Sentry プロジェクト作成**
   - <https://sentry.io> → Projects → **Create Project**
   - Platform = **React** / Alert = 既定 / Project name = `chess-japan`
   - 作成後に表示される **DSN** をコピー（形: `https://<key>@o<org>.ingest.sentry.io/<projectid>`）

2. **【必須】偽イベント対策（Allowed Domains）**
   - Sentry → Settings → Projects → `chess-japan` → **Security & Privacy** → *Inbound Filters* /
     *Allowed Domains* に `chess-japan.pages.dev` を追加（プレビューも見たいなら `*.chess-japan.pages.dev` も）
   - これで他ドメイン発のイベントを弾き、公開 DSN への spam で無料枠が溶けるのを防ぐ。

3. **Cloudflare Pages に環境変数を設定**
   - Cloudflare ダッシュボード → Pages → `chess-japan` → Settings → **Environment variables** → *Production*
   - `VITE_SENTRY_DSN` = 手順1の DSN を追加（公開値なので露出 OK）

4. **再デプロイ**
   - Cloudflare Pages → Deployments → 最新の本番デプロイの **Retry deployment**（または `main` に空コミット push）
   - Vite がビルド時に DSN を焼き込み、Sentry チャンクが生成されて監視が有効化される。

5. **検証**
   - 本番を開き DevTools → Network に `ingest.sentry.io` への送信が出るか、
     もしくは意図的にエラーを起こして Sentry の Issues に届くか確認。

> 完了したら私（AI）に「Sentry 点いた」と一言。#24 を完了にし、必要なら DSN 焼き込み確認の
> スモークを回します（DSN 自体は Cloudflare 側の値なのでコードコミットは不要）。

---

## タスク #25 — Google ログインを点ける（OAuth 有効化）

**なぜ止まっているか**: ログインボタンは `VITE_AUTH_ENABLED='1'` のときだけ本番に出る（`.env.example` の
WHY 参照）。Google 側・Supabase 側の設定が終わる**前**にフラグを立てると「押すと壊れるログインボタン」が
本番に出るので、**設定 → 最後にフラグ**の順を厳守する。

手順（所要 10〜15 分。**1→2→3 を終えてから 4**）:

1. **Google Cloud Console で OAuth クライアント作成**
   - <https://console.cloud.google.com> → APIs & Services → **Credentials**
   - 初回のみ先に **OAuth consent screen**: User Type = External / アプリ名 `Chess-Japan` /
     サポートメール / スコープは `openid` `email` `profile`（既定で足りる）
   - **Create Credentials → OAuth client ID** → Application type = **Web application** → 名前 `Chess-Japan`
   - **Authorized JavaScript origins**:
     - `https://chess-japan.pages.dev`
     - `http://localhost:5173`（ローカル開発も試すなら）
   - **Authorized redirect URIs**（← ここが要。Supabase の callback を入れる）:
     - `https://vpbixcwxjhmapcyaarbq.supabase.co/auth/v1/callback`
   - 作成後の **Client ID** と **Client secret** をコピー

2. **Supabase に Google プロバイダを登録**
   - Supabase ダッシュボード（プロジェクト `chess-japan` / ref `vpbixcwxjhmapcyaarbq`）→
     **Authentication → Providers → Google** → *Enable* → 手順1の Client ID / Client secret を貼って保存

3. **Supabase の URL 設定**
   - Supabase → Authentication → **URL Configuration**
   - **Site URL** = `https://chess-japan.pages.dev`
   - **Redirect URLs**（許可リスト）に追加:
     - `https://chess-japan.pages.dev/**`
     - `https://*.chess-japan.pages.dev/**`（プレビュー環境も許すなら）
     - `http://localhost:5173/**`（ローカル開発を許すなら）

4. **【最後に】Cloudflare Pages でフラグを立てて再デプロイ**
   - Cloudflare Pages → `chess-japan` → Settings → Environment variables → *Production* →
     `VITE_AUTH_ENABLED` = `1`（**ちょうど `1`**。`true` 等は無効 — `supabaseClient.test.ts` の門）
   - Deployments → **Retry deployment**（再ビルドで焼き込み）

5. **E2E 検証（ログイン一周）**
   - 本番でヘッダーに **ログイン** が出る → クリック → Google 同意 → 本番へ戻ってサインイン状態
   - 初回のみ **初期レート設定ダイアログ**（`OnboardingRatingDialog`）が出る → 値を決めると
     `profile.rating_initialized=true` になり二度と出ない
   - レート戦を1局終える → レートが RPC 経由で上下すれば配線 OK

> 完了したら「OAuth 点いた」と一言。#25 を完了にし、E2E スモーク（サインイン→初期レート→レート更新）を
> 私が本番で確認します。

---

## この後に解禁される作業（依存関係メモ）

- **#25 OAuth ライブ化が済むと**、`docs/decisions/0001-free-quota-account-abuse-defense.md` の
  「アカウント削除→再作成で無料枠リセット」防御が**実装可能**になる（前提＝OAuth 検証済み email が取れること）。
  ただし account ベース quota 自体は Phase 2C（無料100/日の導入）とセット。OAuth 単体では穴は開かない
  （現状 100% IP ベースで、退会では回避不可）。
- **棋譜の保存・共有（Phase 5 機能）** のうち「アカウントに保存」は #25 のログインが前提。
  「共有 URL」だけなら認証非依存で先行実装できる（別途 Codex ゲート①で設計合意予定）。

## 補足: なぜ AI が代行しないのか
Cloudflare / Google Cloud / Supabase の各コンソールは人間ログイン前提で、AI セッションには認証情報が無い
（＆課金・本番設定に直結するため意図的に人間承認領域）。値はすべて上に固定したので、コンソールで貼るだけで済む。
