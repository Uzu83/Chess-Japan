# ARCHITECTURE — 実装の現状（as-built）

> **このファイルの役割**: いま**コードがどう組まれているか**の地図。
> 「なぜこのスタックを選んだか」という設計判断の経緯は [`PLAN.md`](./PLAN.md) が正本（as-designed）。
> 「コスト防衛・セキュリティの不変条件」は [`COST_DEFENSE.md`](./COST_DEFENSE.md)。
> 役割を分けているのは、3つを1ファイルに混ぜると更新が滞って腐るから（PLAN は歴史、ここは現状、COST_DEFENSE は規律）。

このアプリは「クライアント計算が主・バックエンド薄・SEO不要」の形。重い処理（エンジン探索）は
**ブラウザ内 WASM** で完結し、サーバーが担うのは **LLM プロキシ（キー秘匿＋コスト防衛）** と
**解説キャッシュ／レート計数の永続化** だけ。だから Next.js ではなく Vite + React(SPA) + Supabase Edge Functions。

---

## 全体データフロー（1手を解説するまで）

```
[ブラウザ / SPA]
  PGN 貼り付け or 1手進める
    └─ src/core/game.ts        ── PGN → 正規化された棋譜モデル（局面列・指し手列）
        └─ src/engine/*        ── Stockfish(WASM) を Web Worker で起動し multipv 解析
            │                     → {評価値, 最善手, 読み筋PV, 深さ} を取得（端末で完結＝サーバーコスト0）
            └─ src/core/classify.ts ── 評価値差から手の質を分類＋局面特徴を抽出
                │                       → 決定的・低トークン・正確な「構造化コンテキスト」を生成
                │                         （※ 評価値や最善手は“事実”としてここで確定。LLM に幻覚させない）
                └─ src/explain/client.ts ── 構造化コンテキストを Edge Function へ POST
                                            （Supabase 未設定時はローカル簡易解説にフォールバック）
                                              │
                                              ▼  HTTPS（anon key で直叩き可能＝信頼境界はサーバー側）
[Supabase Edge Function]  supabase/functions/explain/index.ts
  CORS → Turnstile → レート制限/日次クォータ → body上限 → 厳格入力検証
    → explain はキャッシュ参照（ヒットなら LLM を呼ばずに返す＝コスト核）
    → buildPrompt（注入対策: ユーザー由来は <<<DATA ... DATA>>> 柵に隔離）
    → callProvider（既定 Claude Sonnet 4.6 / Grok / Gemini を raw HTTP で）
    → 解説をキャッシュに upsert して返す
      │
      ▼  service_role のみ（RLS バイパス。anon からは触れない）
[Postgres]  supabase/migrations/*
  explain_cache（局面+levelハッシュ→解説）/ rate_counters（固定窓カウンタ）
  どちらも RLS有効・ポリシー無し・anon GRANT剥奪の二重ロック
```

ポイント: **「事実はルールで抽出、文章だけ LLM」** のハイブリッド。評価値・最善手・PV はエンジンが出した数値を
`classify.ts` が構造化し、LLM には「この事実を日本語に整文して」としか頼まない。これで LLM が評価値を
幻覚する事故を構造的に防ぎ、同時にトークン（＝コスト）も最小化する。

---

## 4＋1 の共通プリミティブ（PLAN の設計 → 実ファイルへの写像）

全ユースケース（①AI対局解説 ②棋譜振り返り ③任意局面 ④復習で再開）は次の組み合わせで実現する。
現状の実装（PoC）は **②棋譜振り返りの縦貫通**まで。

| # | プリミティブ | 実体 | 役割 |
|---|---|---|---|
| 1 | **GameModel** | `src/core/game.ts`, `src/core/types.ts` | PGN → 局面/指し手の正規モデル。FEN/SAN 変換。フレームワーク非依存 |
| 2 | **AnalysisService** | `src/engine/stockfish.ts`(Workerラッパ), `uci.ts`(UCIパーサ), `factory.ts`(実装切替), `mock.ts`(テスト用) | WASM エンジンに `position`→`go multipv` を送り評価値/最善手/PV を返す |
| 3 | **MoveClassifier** | `src/core/classify.ts` | 評価値差→手の質（最善/好手/疑問手/悪手/大悪手）＋局面特徴 → 構造化コンテキスト |
| 4 | **ExplanationService** | `src/explain/client.ts` ＋ `supabase/functions/explain/index.ts` | 構造化コンテキストを LLM で日本語解説に。explain（キャッシュ対象）と followup（対話・非キャッシュ）の2モード |
| 5 | **UserKnowledgeProfile** | 現状は explain リクエスト body の `profile`（known/unknown/level）として伝播。`buildPrompt` がプロンプトに注入 | 既知/未知の専門用語で半パーソナライズ。**永続化層（localStorage / Supabase）は未実装（後続フェーズ）** |

> なぜ `engine/` と `core/` を分けるか: `core/`（GameModel・Classifier）はエンジン非依存の純ロジックで
> vitest で速くテストできる。`engine/` は WASM/Worker という“重くてモックしたい境界”。`factory.ts` が
> 本物（`stockfish.ts`）とモック（`mock.ts`）を差し替えるので、UI もテストもエンジン実体に縛られない。

---

## UI 層（`src/ui/`）

`src/App.tsx` → `ReviewView.tsx`（振り返り画面の中心）が、上記プリミティブを束ねる。

| ファイル | 役割 |
|---|---|
| `ReviewView.tsx` | 棋譜読込→各手を Analysis+Classify+Explain→評価値と解説を表示する画面の中心 |
| `Board.tsx` | chessground 盤（レスポンシブ・タッチ/マウス両対応） |
| `MoveList.tsx` | 棋譜リスト。手を選ぶと局面ジャンプ |
| `ExplanationPanel.tsx` | 解説表示＋対話（followup）入力 |
| `sample.ts` | デモ用サンプル棋譜 |

レイアウトはモバイルファーストで、スマホ（縦スタック）／タブレット（2カラム）／PC（多カラム）に最適化する方針（PLAN 参照）。

---

## エンジンと WASM（クロスオリジン隔離が必須）

- Stockfish の WASM マルチスレッド版は `SharedArrayBuffer` を使うため、**`crossOriginIsolated === true`** が前提。
  そのために `public/_headers`（Cloudflare Pages）と dev サーバ（`vite.config.ts`）で
  **COOP: `same-origin` / COEP** を付与している。これが無いとエンジンが起動しない。
- WASM 実体は npm に含まれるので、`scripts/copy-engine.mjs` が `node_modules` → `public/engine/` へコピーする
  （`predev` / `prebuild` で自動実行）。**`public/engine/` は生成物**なので手で編集しない。
- **将来の地雷（PLAN 記載）**: 広告（AdSense 等）を入れると `COEP: require-corp` と third-party script が衝突する。
  両立には `COEP: credentialless` 採用 or エンジンを別オリジン/iframe に隔離する設計が要る。Phase 6 の課題。
- Stockfish.js / chessground は **GPLv3**。改変せず Web Worker のメッセージ越しに使う（README 参照）。

---

## バックエンド（Supabase）

| パス | 役割 |
|---|---|
| `supabase/functions/explain/index.ts` | LLM プロキシ Edge Function（Deno）。コスト防衛の心臓部 → 詳細 [`COST_DEFENSE.md`](./COST_DEFENSE.md) |
| `supabase/functions/_shared/validate.ts` | 入力検証/正規化の**純ロジック**（Deno非依存）。Edge とフロント両方から使える信頼境界。vitest でテスト |
| `supabase/migrations/0001_*` | `explain_cache` / `rate_counters` テーブル＋RLS有効化＋ポリシー無し |
| `supabase/migrations/0002_*` | anon/authenticated への GRANT 剥奪（RLS との二重ロック） |
| `supabase/migrations/0003_*` | `rate_check` / `rate_gc` RPC（SECURITY DEFINER, service_role 限定） |

migration は**版管理して追記のみ**。既存 migration を書き換えない（本番適用済みのため履歴が壊れる）。

---

## ビルド/ツールチェーン（要点だけ。コマンド一覧は [`../CLAUDE.md`](../CLAUDE.md)）

- `npm`（pnpm ではない）/ ESLint + Prettier（biome ではない）/ vitest。Edge Function のみ Deno。
- 型検査は2系統: `npm run typecheck`（tsc, src + `_shared`）と `deno check supabase/functions/*/index.ts`
  （Edge Function は Node の tsc では検査されない死角があるため別途）。CI は両方走る。
- フォーマットは Prettier に一本化（`deno fmt` は引用符ルールが衝突するので**使わない**）。
- Node は `.node-version`=22 に固定（Vite 7 要件）。

---

## いまの実装状態（どこまで動くか）

- ✅ Phase 0（基盤）/ Phase 1（チェス振り返りの縦貫通 PoC）実装済み・push 済み。ユニットテスト緑・build 緑。
- ✅ コスト防衛を**本実装**（共有ストアのレート制限/クォータ/キャッシュ、RLS二重ロック、注入対策、既定 Claude）。
- ⏳ **未**: Cloudflare Pages デプロイ＋実機での `crossOriginIsolated` 確認、LLM の実キー接続。
- 🚧 **公開前ブロッカー**（Codex レビュー）: ✅ fail-closed 化（#1・2026-06-30 解決）／ 🚧 IP 信頼境界（#2）／
  🚧 キャッシュキー不一致（#3）。→ 必ず [`COST_DEFENSE.md`](./COST_DEFENSE.md) の「公開前にやること」を満たしてから実キー接続・公開する。
