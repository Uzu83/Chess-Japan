# 計画: 解説 DATA への手ラベル同梱（LLM に座標変換をさせない）

> Phase 4-2 バックログ④ の消化。状態: 計画 → ゲート①（codex）→ 実装 → ゲート② → PR。
> 作成 2026-07-16。中断時はこのファイルから再開する。

## 背景 / 問題（実バグ）

本番 E2E（2026-07-08・PLAN.md Phase 4-1 記録）で、将棋解説の LLM が指し手を**出発地基準で誤命名**する事例を確認した（正: ▲２二角成 → 出力: ▲８八角成）。現行の Edge Function は system プロンプトで「USI 座標を日本語表記に言い換えよ」と指示しているが、将棋表記への変換は「移動先の座標 + 駒種 + 成/打の判別」という盤面理解を要する処理で、LLM は誤りやすい。**解説文の指し手名が間違うのはコア価値の毀損**。

表示側は PR #16 で解決済み（tsshogi `formatMove` の正確な日本語ラベルを `bestMoveLabel`/`pvLabels` に載せて panel が表示）。しかし **LLM に渡る DATA は生 USI のまま**で、LLM 自身の変換に依存している。

チェスも同型のリスクを持つ（UCI "c8g4" → LLM が駒種を誤ると "Qg4" 等の誤 SAN になる）。変換器（`uciToSan`・chess.js）は既にメインバンドルにある。

## 目標

エンジン由来の**正確な手ラベルを DATA に同梱**し、LLM には座標の「変換」でなく、与えたラベルの「引用」をさせる。将棋（日本語表記）とチェス（SAN）の両方を対称に扱う。

## 変更点（触るファイル）

1. **`src/core/types.ts`**: `ExplanationContext` に `movePlayedLabel?: string` を追加（指された手の表示ラベル。解説の主語なので LLM 同梱の主役。既存の `bestMoveLabel`/`pvLabels` と同族）。
2. **`src/ui/ReviewView.tsx`**: `withShogiMoveLabels` を拡張し `movePlayed` の日本語ラベルも付与。チェス分岐にも `uciToSan`/`uciLineToSan`（既にメインバンドル・同期関数）で SAN ラベルを付与（関数名は `withMoveLabels` 等へ改名）。1 バイト不変条件に影響なし（将棋変換は従来どおり lazy の `shogiNotation` 経由）。
3. **`supabase/functions/_shared/validate.ts`**（信頼境界・ゲート対象の核）:
   - `movePlayedLabel` / `bestMoveLabel` を検証付きで受理: 文字列・1〜40 文字・制御文字除去（`cleanText` 同等）。40 の根拠: 日本語表記は「☗２二角成」等で ≤10 文字、SAN も ≤7 文字。`profileItemMax` と同値の余裕。
   - `pvLabels` を受理: `sanitizeStringArray(pvLabels, pvMaxItems=40, 40)`。
   - 従来これらは allowlist で **drop** されていた（表示専用という前提）。今後「検証して通す」に変わる = 信頼境界の拡張。
4. **`validate.ts` の `cacheKeyInput`/`normalizeContext`**: ラベル 3 フィールドをキーに含める（**「プロンプトに効く要素はすべてキーに含める」不変条件**。含めないと、攻撃者が嘘ラベル付きリクエストでキャッシュを温め、他ユーザーに毒入り解説を配れてしまう＝キャッシュ汚染。キーに含めれば嘘ラベルの影響は本人のリクエストに閉じる）。
   - 形状は**固定順・未指定 null の現行方式を維持**（案A）。既存キャッシュは 1 回割れるが、公開前でトラフィック極小・キャッシュは正確性優先の設計（(a) 厳密キー方針）に沿う。条件付きでフィールドを出し入れする案Bは「足し忘れ＝誤再利用」と同族のバグ源なので採らない。
5. **`buildPrompt` を `supabase/functions/_shared/prompt.ts` へ切り出し**（ゲート① F001 採用・2026-07-16）: 現行 `buildPrompt` は index.ts（Deno 専用・vitest 死角）にあり、notationRule の実装漏れ・フィールド名誤記を本番 E2E まで検出できない。`validate.ts` と同じ「純ロジックを _shared に隔離して vitest + tsc で検証」パターンで切り出し、index.ts は import に置換（挙動同一のリファクタ。レート制限等には触れない）。
   - `notationRule` を更新: 「DATA に `movePlayedLabel`/`bestMoveLabel`/`pvLabels` があれば、指し手はその表記を**そのまま使う**こと（自分で座標から変換しない）。無い手のみ従来規則で言い換える」。system は固定文のみ（ユーザー由来文字列を system に入れない不変条件は不変）。facts は `JSON.stringify(context)` なのでラベルは自動で DATA に載る。
6. **`src/explain/client.ts`**: 変更不要の見込み（`context` をそのまま POST しており、ラベルは既に body に載っている。今はサーバが drop しているだけ）。確認のみ。
7. **テスト**:
   - validate: ラベル受理・長さ上限・制御文字除去・非文字列拒否・（旧テストの「drop される」検証を更新）。
   - cacheKey: ラベル差でキーが割れる / 同値ラベルは同キー。
   - **prompt（ゲート① F001 採用）**: chess/shogi × ラベルあり/なし の 4 象限で、(a) DATA にラベルが同梱される (b) ラベルあり時の system に「原文引用・変換禁止」指示が入る (c) ラベルなし時は従来の言い換え規則になる、を構造化アサーションで固定。
   - ReviewView 系: `movePlayedLabel` 付与（chess=SAN / shogi=日本語）の単体。
   - Edge は `deno check` + 手動 E2E（本番デプロイ後）。

## ゲート①記録（2026-07-16・codex CLI）

- findings 1 件: F001 medium「buildPrompt のプロンプト契約に自動テストがない」→ **accept**（上記 5. と 7. に反映。_shared 切り出し + vitest 契約テスト）。
- リスク評価: medium。信頼境界・キャッシュキー・互換性の方針には不変条件を破る問題なし（codex 評価と当方判断一致）。

## ゲート②記録（2026-07-16・codex CLI 主審 + Claude reviewer 副審の二重レビュー）

- **サイクル1（codex）**: F001 medium「旧バージョンが localStorage に保存した解析キャッシュ（cj:ctx:*）はラベル無しのまま復元され、再解析ガードにより永久にラベルが付かない」→ **チェス側は accept**・「将棋で誤命名が再発」の主張部分は **reject**（将棋は解析キャッシュを永続化しない設計＝復元経路が存在しない。事実誤認）。
  - 修正: `enrichStoredChessContexts`（moveLabels.ts・純関数・冪等）で復元直後に補完。**共有 SCHEMA_VERSION はバンプしない**（session/対局履歴/レートと共有されており、バンプすると Elo と履歴が消える破壊的副作用があるため。裁定で明示的に却下した選択肢）。
- **Claude 副審**: blocker/major 0・nit 2（pv 40要素 vs pvLabels 6要素の非対称は表示との整合で設計意図どおり / system への内部フィールド名露出は固定リテラルで安全）→ 対応不要と裁定。
- **サイクル2（codex）**: findings 空・risk low。「F001 は解消。保存 effect で自己修復される。新たな問題なし」→ **合意成立**。
- 検証: 309 tests 緑・verify/deno check 緑・1バイト不変条件（バンドル実測 0 件）維持。

## 残作業（PR マージ後）

1. Edge Function 再デプロイ（Supabase MCP・v10 → v11 相当。index.ts + _shared/prompt.ts + _shared/validate.ts）
2. 本番 E2E: 将棋の好手/悪手ケースで解説文の指し手名が movePlayedLabel と一致すること（▲２二角成 型の誤命名が消える）・チェス SAN 一致・キャッシュヒット動作
3. 完了後このファイルを削除（docs/progress の一時ファイル規律）

## 不変条件の維持（CLAUDE.md 4 項目に対して）

- **コスト防衛**: レート制限/日次クォータ/Turnstile/キャッシュ本体・16KB body 上限に触れない。追加フィールドは個別長上限で有界（最悪 +40×42 文字 ≈ 1.7KB、16KB 内）。
- **RLS**: 触れない（migration なし）。
- **validate.ts は信頼境界**: 迂回ではなく**拡張**。ユーザー改変可能な値（anon 直叩き前提）として長さ・制御文字を検証して DATA 柵内にのみ展開。嘘ラベルを送っても (a) 命令注入は制御文字除去+DATA柵で従来同等 (b) キャッシュはキーに含めるので他人に配られない (c) 解説品質が壊れるのは本人のリクエストのみ（自己 DoS 相当）。
- **GPL 分離**: 触れない。
- **1 バイト不変条件（バンドル）**: チェス側ラベルは既存メインバンドルの `uciToSan` を使うだけ。将棋側は既存 lazy 経路。build 実測で確認する。

## リスク / ロールバック

- Edge Function 再デプロイが必要（現 v10 → v11 相当）。デプロイは Supabase MCP で実施（v10 と同経路）。切り戻しは旧コードの再デプロイ。
- 旧クライアント（デプロイ済み SPA のキャッシュ残り）はラベル無し body を送る → validate は optional 受理なので互換（ラベル無し = 従来プロンプト動作）。前方・後方互換あり。
- キャッシュ全割れ（案A）は 1 回きり・低トラフィックで許容。

## 検証（受入条件）

1. `npm run verify` + `deno check` 緑。
2. validate 単体: 上記テスト群 緑。
3. build 実測: メインチャンクに tsshogi トークン 0 件（1 バイト不変条件）。
4. 本番 E2E: 将棋の好手/悪手ケースで解説文の指し手名が `movePlayedLabel` と一致（▲２二角成 型の誤命名が消える）。チェスも SAN 一致。
5. キャッシュ動作: 同一リクエスト 2 回目がキャッシュヒット（cached=true 相当の応答）。
