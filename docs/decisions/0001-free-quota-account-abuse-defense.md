# 決定: 無料枠クォータの「アカウント削除→再作成」悪用への防御

- 状態: 提案（Codex ゲート① 対象）。実装は Phase 2C（account quota 導入時・OAuth 解禁後）。
- 日付: 2026-07-09
- 関連: `docs/COST_DEFENSE.md`, `supabase/migrations/0003_rate_check_rpc.sql`, `0004_profiles_owner_scoped.sql`, `docs/PLAN.md`（収益・コスト設計）

## 背景 / 問題

ユーザー要望: 「アカウント削除→新規作成による無料レビューの制限突破を防ぐ」。

現状の事実:
- レート制限は **100% IP ベース**: Edge Function が `min:ip:<ip>`（15/分）・`day:ip:<ip>`（既定 `RATE_PER_DAY`、公開時 50/日）を `rate_check` RPC で原子的にカウント（`0003`・`explain/index.ts:505/514`）。**account 削除では回避不可**（別 IP が要る）。
- Phase 2C で「無料アカウント **100/日**」の **account ベース quota** を導入予定（`PLAN.md` プラン表）。
- `profiles.id` は `references auth.users on delete cascade`（`0004`）＝**退会で account 状態が消える**。
- 悪用ベクトル: account quota を **ephemeral な uid** にキーすると、退会→再登録（新 uid）で日次カウンタがリセットされ、無料枠を実質無限に更新できる。

現時点で account quota は未実装（IP のみ）なので**現状の穴は無い**。本決定は Phase 2C 実装時に悪用を作り込まないための設計規律。

## 決定

account ベースの日次 quota は **uid ではなく「OAuth 検証済み email の keyed hash」にキーする**。

- キー例: `day:acct:<hmac_sha256(SERVER_PEPPER, lower(trim(verified_email)))>`、上限 100、窓 86400 を `rate_check` へそのまま渡す。
  - **生 SHA-256 でなく HMAC（pepper 付き）にする理由（Codex ゲート① F002）**: email は低エントロピーで、生ハッシュが漏れると既知 email 候補を総当りで照合し「そのユーザーが使ったか」を判定できてしまう。サーバ secret を鍵にした HMAC ならば、secret を知らない限りハッシュを再計算できず候補照合が成立しない。`SERVER_PEPPER` は **Supabase secrets** に置き、**未設定なら fail-closed**（account quota を発行せず匿名扱いにフォールバック＝誤って全員無制限にしない）。raw email も HMAC 入力も**ログに出さない**。
- Google OAuth は email を検証するため、退会→同一 Google で再登録 → 同一 email → 同一 HMAC → **同一日次バケット → リセットされない**。
- quota をリセットするには**別の検証済み email（別 Google アカウント）**が要る＝摩擦が高い。
- **IP 日次上限を authenticated でも backstop として維持するが、匿名とはバケットキーを分ける（Codex ゲート① F001）**:
  - 匿名: `day:ip:anon:<ip>` @ 50/日。
  - 認証: `day:ip:auth:<ip>` @（緩い上限、例 300/日）。
  - **WHY 分けるか**: 同一キー `day:ip:<ip>` を両者で共有すると、共有 NAT（学校/職場/家庭）で認証ユーザーの消費が匿名 50/日枠を潰し、逆も起きる（rate_check は p_key が同じなら上限値が違っても同一 count を増やす＝`0003:20-25`）。キーを分ければ相互汚染しない。
  - 既存の `day:ip:<ip>`（`explain/index.ts:514`）は Phase 2C 実装時に `day:ip:anon:<ip>` へ改名する（rate_counters の旧バケットは `expires_at` GC で自然消滅するので移行不要・破壊的でない）。

## なぜ migration 不要か

`rate_counters` / `rate_check` は **任意 text キーの汎用実装**（`bucket_key text`・`0001/0003`）。email ハッシュキーは Edge Function の**キー計算のみ**で実現でき、**スキーマ変更は不要**。email ハッシュは `rate_counters`（RLS 全面ロック・service_role のみ）に載るだけで、**生 email は保存しない**（プライバシー）。

→ 本決定の実装は「migration を伴わない Edge Function 変更」であり、CLAUDE.md の「本番 DB migration=個別 GO」対象**外**（ただし設計が migration を伴う形に化けたら即停止して個別 GO）。

## 実装手順（Phase 2C・OAuth 解禁後）

1. Edge Function が authenticated リクエストで **JWT を検証**し、`email` と `email_verified` を取り出す（Supabase auth。未検証 email は信頼しない）。
2. `day:acct:<hmac(email)>` @ 100 と `day:ip:auth:<ip>` @（authenticated 上限）を **両方** `rate_check`。どちらか超過で拒否（AND 合成）。
3. `email_verified=false` / email 無し provider / `SERVER_PEPPER` 未設定 は account quota を与えず**匿名扱い（`day:ip:anon:<ip>` のみ）**にフォールバック。
4. `min:ip:<ip>` の分次上限は authenticated でも維持（バースト防御。分次はIP単位のバースト防御なので anon/auth 分離は必須でないが、日次と揃えるなら分離してよい）。

## 受入テスト（実装時に追加）

- 匿名が `day:ip:anon` を 50 消費しても、別の認証ユーザーの `day:acct` 100 と `day:ip:auth` は**減らない**（相互汚染しない・F001）。
- 同一 email で退会→再登録しても `day:acct:<hmac(email)>` の当日 count が**維持**される（リセットされない）。
- `SERVER_PEPPER` 未設定時は account quota を発行せず匿名扱い（fail-closed・F002）。全員無制限にならない。
- raw email も HMAC 入力もログ/エラー本文に出ない。

## 代替案と却下理由

- **uid キー**: 退会→再作成でリセット＝そのものが悪用ベクトル。却下。
- **profiles にカウンタ列**: `on delete cascade` で消えるので uid キーと同じ欠陥。かつ RLS/GRANT の追加面が増える（コスト防衛のロック方針に逆行）。却下。
- **tombstone（退会時に email ハッシュ＋消費量を別表へ保存）**: email ハッシュkeyed の rate_counters が既にその役割を果たす（退会しても rate_counters の行は残り expires_at で GC される）ので追加表は不要。過剰。却下。
- **電話番号/決済認証で1人1アカウント強制**: 完全防御に近いが導入コスト・離脱・課金が過大。0→1 段階では過剰。却下。

## 残存リスクと受容

- 複数の Google アカウントを持つユーザーは各 email で 100/日を得られる（完全防御は不可）。**IP backstop**（`day:ip:auth`）と「1解説≈0.25円」の低原価で受容範囲。
- ハッシュ衝突は HMAC-SHA256 で無視できる。email 正規化（lower/trim）でエイリアスの一部（大文字化）は吸収するが、Gmail の `+tag`/ドット違いは別扱いになりうる（必要なら正規化強化は別決定）。
- 共有 NAT では `day:ip:auth` の上限（例 300/日）を複数認証ユーザーで共有するため、同一 IP 上の 4 人目以降が backstop に当たりうる。これは「1 IP からの総量」を縛る意図的な天井で、`day:acct` 個別 quota は各自維持されるため通常利用では問題になりにくい。上限値は実トラフィックで調整。

## Codex ゲート① 裁定（2026-07-09・合意）

Codex 実装前レビュー: medium 2 件。両方採用（設計を強化）:

- **F001（共有 IP バケットの相互汚染）— 採用**: authenticated backstop を匿名と同じ `day:ip:<ip>` にすると共有 NAT で相互に無料枠を潰す。→ `day:ip:anon` / `day:ip:auth` に**キー分離**（上記反映）。既存 `day:ip:<ip>` は Phase 2C で `day:ip:anon` へ改名（GC で自然消滅・非破壊）。受入テスト追加。
- **F002（生 SHA-256 が弱い仮名化）— 採用**: email は低エントロピーで候補照合可能。→ **サーバ pepper による HMAC-SHA256**・secret 未設定 fail-closed・raw email/digest 非ログ化（上記反映）。受入テスト追加。

未対応（意図的スコープ外）: 複数 Google アカウントによる並行取得の完全防御（電話/決済認証は過剰・却下済み）。RLS ロック・rate_check 汎用性・migration 不要の主張は Codex も既存実装と整合と確認。

## 不変条件（違反禁止）

- `explain_cache` / `rate_counters` に anon/authenticated 向けポリシー・GRANT を**足さない**（`COST_DEFENSE.md` 不変。本決定は Edge Function のキー計算のみ）。
- 実装時は Codex ゲート①②必須（auth/コスト防衛に触れる）。migration が発生する設計に化けたら個別 GO。
- 生 email を保存・ログ出力しない（ハッシュのみ）。
