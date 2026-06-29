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
- バックエンド: Supabase Edge Functions（LLM プロキシ・既定 Grok）+ Postgres/Auth
- ホスティング: Cloudflare Pages / Vercel（COOP/COEP ヘッダ付き）

詳細な計画は開発チームの計画ファイルを参照（CI/CD・セキュリティ → PoC → 将棋 の順）。

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

### WASM マルチスレッドの確認

開発/本番とも COOP/COEP ヘッダを付与しているため、ブラウザの DevTools で
`crossOriginIsolated === true` になっていれば WASM マルチスレッドが使えます
（画面フッターにも状態を表示）。

## ドキュメント

- `docs/feedback-form.md`: フィードバック用 Google フォームの作成要件と Gemini プロンプト

## ライセンス / クレジット

- 同梱のチェスエンジン **Stockfish.js（GPLv3）** は `node_modules` から `public/engine/` に
  ビルド時コピーして配信します（`scripts/copy-engine.mjs`）。改変せず、ライセンス本文
  `Copying.txt` も同梱します。アプリ本体は Web Worker のメッセージ（UCI文字列）で
  エンジンと通信する独立プログラムです。
- 盤UI: chessground（lichess, GPLv3）。

## 収益・コスト方針

課金要素なし。サーバ計算はブラウザ WASM で実質ゼロ。LLM コストはキャッシュ＋最安プロバイダ
＋レート制限で最小化し、Ko-fi 支援・将来の広告でサーバ代を賄います。
