# Repository Working Agreements

<!-- /dev-secure scope:docs が配置。Codex / Cursor が最初に読むファイル。
     短く保つ: 地図・不変条件の全文・レビュー方針・背景は CLAUDE.md と docs/ に逃がす。
     テンプレからの読み替え(WHY): このリポジトリは npm（pnpm ではない）/ ESLint + Prettier
     （biome ではない）/ vitest。Edge Functions のみ Deno のため、Node 側の型検査に
     含まれない死角として deno check を検証入口に併記している。 -->

既存のオープンソースAI（Stockfish / やねうら王）を流用し、チェス/将棋の1手1手を LLM で
解説する Web アプリ（Vite + React SPA / Supabase Edge Functions = Deno / Cloudflare Pages）。

## 検証の単一入口

- 変更後は必ず: `npm run verify`（typecheck → lint → format:check → test → build を一括実行）
- Edge Function（Deno）は上記で検査されない死角のため別途: `deno check supabase/functions/*/index.ts`

## 壊してはいけない不変条件（見出しのみ・全文は CLAUDE.md）

1. **コスト防衛**: `supabase/functions/explain/index.ts` のレート制限/日次クォータ/入力上限/キャッシュ/Turnstile を外さない・緩めない
2. **RLS ロック**: `explain_cache` / `rate_counters` に anon/authenticated 向けポリシーや GRANT を足さない（入口は Edge の service_role のみ）
3. **validate.ts は信頼境界**: `supabase/functions/_shared/validate.ts` の厳格検証を迂回してユーザー由来データを LLM に渡さない
4. **GPL 分離**: Stockfish.js / やねうら王(WASM) / chessground / shogiground（GPL系）は改変せず Worker・メッセージ越しに使う

## 詳細

リポジトリ地図・不変条件の全文・レビュー方針・秘密の置き場所は `CLAUDE.md` と `docs/`
（`ARCHITECTURE.md` / `COST_DEFENSE.md` / `PLAN.md` / `decisions/`）を読むこと。
