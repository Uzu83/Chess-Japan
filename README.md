# Chess-Japan

既存のオープンソースAI（Stockfish / やねうら王）を流用し、チェス/将棋の1手1手を
LLM で丁寧に解説してくれる Web アプリです。スマホ・タブレット・PC に最適化します。

## 特長（目標）

- 棋譜（PGN/KIF）の振り返り解説、AIと対局しながらの解説、任意局面の解説
- 振り返った局面から「AI対局で再開して復習」
- 解説への追問（「どういうこと？」「ピンって何？」）に答える対話
- 専門用語の理解度を記録して解説を半パーソナライズ

## 技術スタック

- フロント: Vite + React + TypeScript（SPA）, Tailwind CSS v4
- 盤UI: chessground（将棋は shogiground 予定）
- エンジン: Stockfish (WASM) → 将棋は yaneuraou.wasm（Web Worker 上で動作）
- バックエンド: Supabase Edge Functions（LLM プロキシ・既定 Claude Sonnet 4.6／Grok・Gemini に差替可）+ Postgres/Auth
- ホスティング: Cloudflare Pages / Vercel（COOP/COEP ヘッダ付き）

詳細な計画は開発チームの計画ファイルを参照（CI/CD・セキュリティ → PoC → 将棋 の順）。

## ローカルPC（自宅）で続きを開発する

スマホ/クラウドからローカルPCへ移っても、リポジトリだけで完全に再現できます。

前提: **Node 22**（または 20.19+）と git。

```bash
git clone https://github.com/Uzu83/Chess-Japan.git
cd Chess-Japan
git checkout claude/chess-shogi-ai-explainer-r7c4m8   # 作業ブランチ
npm install
npm run dev   # http://localhost:5173 をブラウザで開く
```

- `npm install` 後、`predev` が Stockfish エンジンを `public/engine/` へ自動コピーします。
- ローカル開発サーバも COOP/COEP を付与するので、ブラウザ内 Stockfish がそのまま動きます。
- 解説は Supabase 未設定ならローカル簡易版。本物の LLM 解説（既定 Claude Sonnet 4.6）は `.env` に
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を設定（Edge Function デプロイ後）。
- 開発計画の全文は **`docs/PLAN.md`** にあります（このリポジトリに同梱済み）。

## 開発

```bash
npm install
# dev/build 時に Stockfish エンジンを public/engine/ へ自動コピー(predev/prebuild)。
# 手動で実行する場合: npm run copy-engine
npm run dev        # 開発サーバ(http://localhost:5173)
npm run typecheck  # 型チェック
npm run lint       # ESLint
npm run format     # Prettier 整形
npm run test       # Vitest
npm run build      # 本番ビルド
```

### 環境変数

`.env.example` をコピーして `.env` を作成。`VITE_` 付きはブラウザに露出するため秘密情報を入れないこと。
LLM のキーは Supabase の secrets にのみ設定する（`docs/` 参照）。
`VITE_SENTRY_DSN`（エラー監視、公開値）は任意 — 未設定なら Sentry は完全オフ。設定する場合は
Sentry 側で Allowed Domains を必ず絞ること（`.env.example` の運用メモ参照）。

### WASM マルチスレッドの確認

開発/本番とも COOP/COEP ヘッダを付与しているため、ブラウザの DevTools で
`crossOriginIsolated === true` になっていれば WASM マルチスレッドが使えます
（画面フッターにも状態を表示）。

## ドキュメント

- `CLAUDE.md`: AI/開発者向けガイド（リポジトリ地図・壊してはいけない不変条件・開発コマンド）
- `docs/ARCHITECTURE.md`: 実装の現状（データフロー・4プリミティブ・ファイル対応）
- `docs/COST_DEFENSE.md`: コスト防衛の設計・RLS二重ロック・**公開前ブロッカー（要対応）**
- `docs/PLAN.md`: 開発計画の全文（設計判断・フェーズ・進捗）
- `docs/feedback-form.md`: フィードバック用 Google フォームの作成要件と Gemini プロンプト

## ライセンス / クレジット

- 同梱のチェスエンジン **Stockfish.js（GPLv3）** は `node_modules` から `public/engine/` に
  ビルド時コピーして配信します（`scripts/copy-engine.mjs`）。改変せず、ライセンス本文
  `Copying.txt` も同梱します。アプリ本体は Web Worker のメッセージ（UCI文字列）で
  エンジンと通信する独立プログラムです。
- 同梱の将棋エンジン **やねうら王（[@mizarjp/yaneuraou.k-p](https://github.com/mizar/YaneuraOu)・GPL-3.0、
  NNUE 評価関数 内蔵）** も同様に `public/engine-shogi/` にビルド時コピーして配信します
  （`scripts/copy-engine.mjs`）。改変せず、ライセンス本文 `LICENSE.md`（GPL-3.0）も同梱します。
  アプリ本体は USI 文字列のメッセージでエンジンと通信する独立プログラムです。ソース入手先は
  上記リポジトリ（および同梱ライセンス）を参照してください。
- 盤UI: chessground / shogiground（lichess・WandererXII, GPLv3）。

## 収益・コスト方針

課金要素なし。サーバ計算はブラウザ WASM で実質ゼロ。LLM コストはキャッシュ＋最安プロバイダ
＋レート制限で最小化し、Ko-fi 支援・将来の広告でサーバ代を賄います。
