# オペレーター手順書: 保留タスクのアンブロック（#24 Sentry / #25 Auth）

> このファイルの目的: 本番監視（Sentry）とログイン（多方式 Auth）は、コードは実装済みだが
> **人間しか触れないダッシュボード設定**が終わるまで有効化できない（AI は Cloudflare / Google /
> Apple / Supabase のコンソールに入れない）。その「あなたが数分でやる操作」を、再導出せずコピペで
> 実行できるようここに固定する。設定が終わったら本番は自動で再ビルド→再デプロイされ、機能が点く。
>
> 前提となる固定値（このプロジェクト実測・2026-07-11）:
> - Cloudflare Pages 本番 URL: `https://chess-japan.pages.dev`
> - Supabase プロジェクト ref: `vpbixcwxjhmapcyaarbq`（公開値。OAuth リダイレクト URI に出る）
> - フロントの `VITE_*` は **ビルド時に焼き込まれる** → 値を変えたら必ず再ビルド＋再デプロイが要る。
>   `VITE_*` は Cloudflare Pages の「Settings → Environment variables → Production」で設定する。
>
> **Auth 拡張（2026-07-17）**: Google に加え Apple / メール(+パスワード) / メール OTP を UI に追加。
> パスキー・Manual Linking は **後続・未実施**（誤って Dashboard で有効化しないこと — 下記「後続」節）。

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

## タスク #25 — 多方式ログインを点ける（Auth 有効化）

**なぜ止まっているか**: ログイン UI は `VITE_AUTH_ENABLED='1'` のときだけ本番に出る（`.env.example` の
WHY 参照）。プロバイダ設定が終わる**前**にフラグを立てると「押すと壊れるログインボタン」が
本番に出るので、**設定 → 最後にフラグ**の順を厳守する。

初版で有効化する方式: **Google / Apple / Email(パスワード) / Email OTP(マジックリンク)**。
パスキー・Manual Linking は下の「後続・未実施」を参照（**今は有効化しない**）。

手順（所要 20〜30 分。**1→2→3→4 を終えてから 5**）:

### 1. Google Cloud Console で OAuth クライアント作成

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

### 2. Apple Sign In（任意だが UI にボタンあり）

- Apple Developer → Certificates, Identifiers & Profiles → **Identifiers** で Services ID 作成
- Return URL = `https://vpbixcwxjhmapcyaarbq.supabase.co/auth/v1/callback`
- 鍵（.p8）・Team ID・Key ID・Services ID を用意
- Supabase → Authentication → Providers → **Apple** → Enable → 上記を貼って保存
- Apple 設定を後回しにする場合: UI の Apple ボタンは失敗メッセージになる。Google/メールで先にライブ化可

### 3. Supabase Email + Confirm Email（**必須**）

- Supabase → Authentication → Providers → **Email** → Enable
- **Confirm email = ON**（必須。未確認ユーザーの JWT でクラウド保存 RPC を通さない運用と揃える）
- Authentication → **URL Configuration**:
  - **Site URL** = `https://chess-japan.pages.dev`
  - **Redirect URLs**:
    - `https://chess-japan.pages.dev/**`
    - `https://*.chess-japan.pages.dev/**`（プレビューも許すなら）
    - `http://localhost:5173/**`（ローカルを許すなら）
- メールテンプレート（Confirm / Magic Link）が本番ドメインを指すことを確認

### 4. Supabase に Google プロバイダを登録

- Supabase → Authentication → Providers → **Google** → Enable → 手順1の Client ID / secret を保存

### 5. 【最後に】Cloudflare Pages でフラグを立てて再デプロイ

- Cloudflare Pages → `chess-japan` → Settings → Environment variables → *Production* →
  `VITE_AUTH_ENABLED` = `1`（**ちょうど `1`**。`true` 等は無効 — `supabaseClient.test.ts` の門）
- OAuth ボタン出し分け（任意）: `VITE_OAUTH_GOOGLE_ENABLED` / `VITE_OAUTH_APPLE_ENABLED` = `1`
  （**表示のみ**。実停止は Supabase → Providers で Google/Apple を無効化すること）
- **入れない**: `VITE_PASSKEY_ENABLED`（未実装・後続）
- Deployments → **Retry deployment**（再ビルドで焼き込み）

### 6. E2E 検証（ログイン一周）

- 本番でヘッダーに **ログイン** → ダイアログで Google / Apple / メール / マジックリンク
- 初回のみ **初期レート設定ダイアログ**（`OnboardingRatingDialog`）
- メール新規登録: 確認メール前はクラウド対局保存 RPC が失敗すること（サーバー側 `email_confirmed_at` 検査）
- AI戦1局終了（ログイン済み）→ 自己用クラウド履歴に載ること（レートのクラウド反映は**未配線・意図的**）

> 完了したら「Auth 点いた」と一言。

---

## 後続・未実施（誤って有効化しないこと）

| 項目 | 状態 | 有効化前提 |
|---|---|---|
| **Passkeys (WebAuthn)** | コード未配線・別フラグ予定 | 独自ドメイン確定 + 安定 RP ID + `experimental.passkey` opt-in + 代替ログイン必須。`pages.dev` を RP ID にしない |
| **Manual Linking** | 無効のまま | 再認証・連携通知・全セッション失効・復旧手順の実装後。Dashboard の *Enable Manual Linking* を今は **OFF** |
| **クラウドレート `apply_rated_result` GRANT** | **GRANT しない**（0005 どおり） | サーバー発行 challenge + 棋譜検証 + 冪等消費が揃うまで |
| **公開プロフィール** | 仕様・RPC あり／UI は段階公開 | 最小局数・バケット化・列挙防止の受入を満たしてから |
| **PvP タブ** | `VITE_PVP_ENABLED='1'` で表示のみ | 実停止は Edge Function disable / RPC `REVOKE` |

> **表示フラグと実停止の区別**: `VITE_OAUTH_*` / `VITE_PVP_ENABLED` は UI 出し分けのみ。
> 本番で機能を止めるには Auth Provider 無効化・Edge disable・RPC REVOKE を使う（再ビルド不要）。

---

## この後に解禁される作業（依存関係メモ）

- **#25 Auth ライブ化が済むと**、`docs/decisions/0001-free-quota-account-abuse-defense.md` の
  「アカウント削除→再作成で無料枠リセット」防御が**実装可能**になる（前提＝検証済み email）。
  ただし account ベース quota 自体は Phase 2C（無料100/日の導入）とセット。
- **AI戦の自己用クラウド履歴 + 非公開 Strength UI** は #25 + migration `0006` 適用後に動く。
- **PvP / クラウドレート / パスキー** は独立リリース（Codex ゲート必須）。

## 補足: なぜ AI が代行しないのか
Cloudflare / Google Cloud / Apple / Supabase の各コンソールは人間ログイン前提で、AI セッションには認証情報が無い
（＆課金・本番設定に直結するため意図的に人間承認領域）。値はすべて上に固定したので、コンソールで貼るだけで済む。
