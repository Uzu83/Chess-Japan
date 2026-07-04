<!-- notion-page: (未連携) — このプロジェクトは daily-idea-pipeline 由来ではなくオーナー手動作成。
     Notion アイデアDBと未連携のため weekly-project-maintenance の対象外（規約どおり）。
     連携する場合はここに Vercel管理ページ ID を入れる。 -->

# Chess-Japan — AI/開発者向けプロジェクトガイド

> **このファイルの目的**: 人間にも AI にも「どこに何があるか」「何を壊してはいけないか」を最短で伝える。
> 詳細設計は `docs/` を参照。実装の WHY は各ファイルの厚いコメントに埋め込んである（このリポジトリは
> 「コメント:実コード 最大10:1」方針＝未来の担当者が同じ過ちを繰り返さないための文脈永続化）。

既存のオープンソースAI（Stockfish / やねうら王）を流用し、チェス/将棋の1手1手を LLM で解説する Web アプリ。

## どこに何があるか（リポジトリ地図）

| パス | 役割 |
|---|---|
| `src/core/` | ドメインロジック（フレームワーク非依存）。`game.ts`=PGN→棋譜モデル(**不変・振り返り用**), `playGame.ts`=**対局用の可変ゲームコントローラ**(AI戦。着手/合法手dests/勝敗/成り/投了/待った/PGN生成・snapshot方式), `classify.ts`=手の質分類＋解説コンテキスト生成, `storage.ts`=localStorage永続化(セッション＋解析キャッシュ＋**対局履歴cj:games**), `types.ts`=共通型, `uci.ts`は engine 配下 |
| `src/engine/` | Stockfish(WASM) エンジン制御。`stockfish.ts`=Web Workerラッパ(`analyze`=解析／`chooseMove`=対局着手・Skill Levelで弱さ制御・**直列化で単一worker混線を防止**), `uci.ts`=UCIパーサ, `mock.ts`=テスト用モック, `factory.ts`=実装切替 |
| `src/explain/` | 解説クライアント。`client.ts`=Edge Function 呼び出し（未設定時ローカル簡易解説にフォールバック） |
| `src/ui/` | React UI。`PlayView.tsx`=**対局画面(AI戦・履歴)**, `PlayBoard.tsx`=**操作可能な chessground 盤(合法手/王手/成りピッカー)**, `ReviewView.tsx`=振り返り画面の中心, `Board.tsx`=閲覧専用 chessground盤, `MoveList.tsx`, `ExplanationPanel.tsx`。**App.tsx で [対局\|レビュー] 切替(既定=対局)** |
| `supabase/functions/explain/index.ts` | **LLMプロキシ Edge Function（Deno）**。コスト防衛の心臓部。APIキー秘匿・レート制限・キャッシュ・Turnstile・注入対策 |
| `supabase/functions/_shared/validate.ts` | **入力検証/正規化の純ロジック**（Deno非依存）。Edge とフロント両方から使える信頼境界。vitestでテスト |
| `supabase/migrations/` | DBスキーマ（RLSロック済みテーブル＋rate_check RPC）。版管理。本番へはMCPで適用済み |
| `scripts/copy-engine.mjs` | Stockfish WASM を node_modules → public/engine/ にコピー（predev/prebuild で自動） |
| `docs/ARCHITECTURE.md` | 全体像・データフロー・4プリミティブ |
| `docs/COST_DEFENSE.md` | コスト防衛の設計と「壊してはいけない不変条件」 |
| `docs/PLAN.md` | 開発計画の全文（設計判断・フェーズ・進捗） |

## 技術スタック（と、なぜ projects 既定の Next.js でないか）

Vite + React 19 + TypeScript（SPA）/ Tailwind v4 / chessground / Stockfish(WASM) / Supabase(Edge Functions + Postgres) / Cloudflare Pages。
- **Next.js を採らない理由**（PLAN.md 記載・意図的逸脱）: このアプリは「クライアント計算が主・バックエンド薄・SEO不要」。
  重い処理（エンジン探索）はブラウザWASMで完結し、SSR/RSC の旨味が小さく概念オーバーヘッドだけ増える。
- ツールチェーン: `npm`（pnpm ではない）/ ESLint + Prettier（biome ではない）/ vitest。Edge Function のみ Deno。

## 開発コマンド

```bash
npm install            # predev で Stockfish を public/engine/ へ自動コピー
npm run dev            # http://localhost:5173 （COOP/COEP 付与済み→WASMマルチスレッド可）
npm run typecheck      # tsc -b（src + supabase/functions/_shared を型検査）
npm run lint           # ESLint（supabase/functions/** は除外）
npm run format         # Prettier 整形（supabase含む全体。deno fmt は使わない＝衝突回避）
npm run test           # vitest（src + _shared の純ロジック）
npm run build          # 本番ビルド（dist）
deno check supabase/functions/*/index.ts   # Edge Function の型検査（Node では検査されない死角）
```

## 壊してはいけない不変条件（CRITICAL — 違反は事故に直結）

1. **コスト防衛**: `supabase/functions/explain/index.ts` は収益ゼロ前提の防衛線。レート制限/日次クォータ/入力上限/
   キャッシュ/Turnstile を**外したり緩めたりしない**。Grok/Claude を実接続して公開するなら、共有ストアの
   レート制限が効いていることを必ず確認（詳細 `docs/COST_DEFENSE.md`）。
2. **RLS ロック**: `explain_cache` / `rate_counters` は **RLS有効・ポリシー無し・anon GRANT剥奪**で、公開anon key
   から触れない。ここに anon/authenticated 向けポリシーや GRANT を**足さない**。Edge の service_role のみが入口。
3. **入力検証は信頼境界**: ブラウザに焼かれる anon key で Edge を直叩きできる前提。`validate.ts` の厳格検証を
   迂回して LLM にデータを渡さない。ユーザー由来文字列は system ではなく user の `<<<DATA ... DATA>>>` 柵に隔離する。
4. **エンジンは GPLv3**: Stockfish.js / chessground は GPLv3。改変せず Web Worker のメッセージ越しに使う（README 参照）。

## 触ってよい / 注意

- 触ってよい: `src/**`, `supabase/functions/**`, `supabase/migrations/**`(追記), `docs/**`, 設定ファイル, `scripts/**`。
- 注意: `.env*`（秘密。git に入れない）, 課金が走る接続（Claude/Grok の実キー）, DB の破壊的変更。
- 秘密の置き場所: フロント公開変数は `VITE_*`（Cloudflare Pages の env）、バックエンド秘密（`ANTHROPIC_API_KEY` 等）は
  **Supabase secrets のみ**。詳細は `.env.example` と `docs/COST_DEFENSE.md`。

## レビュー方針

このフォルダ配下の Claude Code は、品質重視タスクで **Codex 異モデルレビュー＋Claude 多観点レビュー（敵対検証）** を
回し「承認」でなく「合意」を目指す（親フォルダ `~/development/projects/CLAUDE.md` の規律に従う）。
コスト防衛・RLS・migration に触れる変更は push 前にレビューゲートを通すこと。
