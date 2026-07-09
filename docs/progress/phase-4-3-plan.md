# Phase 4-3 実装計画 — 将棋の局面から対局（PROGRESS / Codex ゲート① 対象）

状態: 計画（実装前）。チェス Phase 2B（「この局面から対局」）の将棋写像。
関連: `docs/PLAN.md` line 121-137（Phase 2B）, line 277/295（4-3 は 4-2 スコープ外と明記）, CLAUDE.md 不変条件。

## スコープ（受入条件）

将棋にも 2 つの入口を追加する（チェスと 1:1 対応）:

- **入口A（レビューから）**: 将棋レビュー画面の「▶ この局面から対局」— 表示中の局面 SFEN からカジュアル対局。あなた=その局面の手番側、AI=相手。現状 `kind === 'chess'` 限定で将棋は導線ごと非表示（`ReviewView.tsx:960`）。
- **入口B（設定で貼付）**: 将棋対局設定に「局面(SFEN)から対局する」折りたたみ — 詰将棋・練習・途中局面用。チェス `PlayView.tsx:925-954` の `<details>` イディオム写像。

受入:
1. 入口A: 将棋棋譜を読み込み→レビュー→任意の途中局面で「この局面から対局」→ その局面から対局開始（手番側=あなた・カジュアル）。
2. 入口B: 設定で有効な SFEN を貼付→「この局面から開始」→ その局面から対局。不正 SFEN / 片玉は開始不可＋理由表示。
3. **1 手以上指してから**「この対局を振り返る」を押すと、**開始局面（非平手含む）から全手順**が KIF でレビューに載り、同じ盤が再現される。0 手（開始即投了）はチェス Phase 2B（`docs/PLAN.md:137`「単独局面（手なし）の解説だけは未対応」）と同様レビュー対象外＝静的局面の閲覧は ReviewView の SFEN import（Phase 4-1）が担う。
4. チェス側の「この局面から対局」は 1 挙動も変えない。
5. 1 バイト不変条件維持（shogi ライブラリはメインエントリに 0 バイト）。

## 事前実測（node スパイク・de-risk 済み）

`scratchpad/sfen-kif-spike.mjs`（tsshogi 直叩き）で確認:
- `Position.newBySFEN(sfen)` は非平手（詰将棋風・中盤）を正しくパースし、**不正 SFEN は null**（`'not a sfen'` / 段数不足 / 手番文字 `x` / 空 → 全て null）。→ バリデーション根拠。
- **`exportKIF` は開始局面（非平手）を KIF に保存**し、`importKIF` で `re.position.sfen === 開始 sfen` が一致。→ 「振り返る」接続は任意局面で壊れない（受入3の根拠）。tsshogi は SFEN 手数カウンタを 1 に正規化するが局面同一性には無影響。
- **`Position.newBySFEN` は玉なし局面も通す**（`[noKingsAtAll] => OK` / `[片玉] => OK`）。→ やねうら王は両玉のある合法局面を前提とするため、**UI 層で両玉présence を必須化**する（下記 validateStartSfen）。攻方玉を省く純詰将棋は本 MVP では非対応（チェス側 chess.js が両玉必須なのと対称）。

## コアは対応済み（確認）

`ShogiPlayGame` の constructor は既に `startSfen` を受ける（`src/core/shogiPlayGame.ts:171`、不正時は STANDARD へ自衛フォールバック）。コアのゲームロジック変更は不要。Phase 4-3 は **UI 配線 + 純粋バリデーション追加**が主。

## 変更ファイルと差分

### 1. `src/core/shogiPlayGame.ts`（純粋関数 1 個 追加・既存挙動不変）

- 新規 export:
  ```ts
  export function validateStartSfen(sfen: string):
    | { ok: true; turn: ShogiColor }
    | { ok: false; reason: string }
  ```
  - `Position.newBySFEN(sfen.trim())` が null → `{ ok:false, reason:'SFEN を解釈できませんでした' }`
  - 盤面トークン（`sfen.split(/\s+/)[0]`）の先手玉 `K` と後手玉 `k` が**それぞれちょうど 1 個**でなければ → `{ ok:false, reason:'先手玉・後手玉がそれぞれ 1 枚ずつ必要です' }`（王は成れないので盤トークンの K/k は玉のみ＝誤検出なし。持ち駒トークンは別なので巻き込まない）。**存在チェックでは不十分**（Codex F002・実測: `Position.newBySFEN` は重複玉 SFEN を null にせず通すため、2 枚玉がやねうら王へ渡ると非合法局面で異常応手）。個数で弾く。
  - OK なら `{ ok:true, turn }`（`fromTsColor(pos.color)`）。UI が「あなた=先手/後手」を開始前に出せる。
- **constructor の自衛フォールバック（:173-174）は維持**（堅牢性。UI 検証を通った SFEN が来る前提だが二段防御）。
- WHY 純粋関数を core に置くか: validate.ts と同じ「テスト可能な信頼境界」思想。UI から呼ぶが tsshogi 依存はこのファイル（=lazy チャンク）に留め、PlayView（メインチャンク）へ tsshogi を漏らさない（1 バイト不変条件）。

### 2. `src/ui/ShogiPlaySession.tsx`（対局セッション・入口B UI + startGame 拡張 + 入口A effect）

- Props に入口A用 `playFrom?: { sfen: string; nonce: number } | null` 追加。
- `startGame(choice, diff, rated)` → `startGame(choice, diff, opts?: { startSfen?: string; rated?: boolean })`（チェス `PlayView.tsx:328` と同型）:
  - `const startSfen = opts?.startSfen; const game = new ShogiPlayGame(startSfen);`
  - `const color = startSfen ? game.turn : resolveColor(choice);`（SFEN 指定時は手番側をあなたに＝色選択を無視。チェス `:338-339` と対称）
  - `activeRatedRef.current = Boolean(opts?.rated) && !startSfen;`（SFEN 対局は強制カジュアル。チェス `:346` と対称）
- 入口A effect（PlayView `:468-476` と同型・nonce ガード）:
  - `if (!playFrom) return; if (lastRef.current === playFrom.nonce) return; lastRef.current = playFrom.nonce;`
  - `if (!COI_ENABLED) return;`（非対応環境では開始せず、既存の unsupported 設定画面に留めて理由を見せる）
  - 防御バリデーション: `const v = validateStartSfen(playFrom.sfen); if (!v.ok) return;`（レビュー由来は常に有効だが二段防御）
  - `startGame(colorChoice, difficulty, { startSfen: playFrom.sfen, rated: false });`
- 入口B UI（`ShogiSetupScreen` に `<details>` 追加。チェス `:925-954` 写像）:
  - SFEN テキスト入力（placeholder に平手 SFEN 例）。`validateStartSfen(text)` の結果で「この局面から開始」ボタン活性＋`!ok` の reason を inline 表示。
  - `disabled = !engineReady || !valid`（coi=false / エンジン未準備でも封じる）。
  - onClick: `onStartFromSfen(text.trim())` → `startGame(colorChoice, difficulty, { startSfen })`。
  - 注記「あなたは手番側を持ちます（カジュアル）」。

### 3. `src/ui/PlayView.tsx`（共通シェル・入口A を将棋へ振り分け）

- `playFrom` prop 型を `{ fen: string; nonce: number }` → `{ fen: string; nonce: number; kind: GameKind }` に拡張。
  - **フィールド名 `fen` は維持**（将棋時は SFEN を格納・コメント明記）。storage.ts が KIF を `pgn` フィールドに載せて「フィールド名の負債を許容」した前例に倣い、チェス経路の diff を最小化して回帰を避ける。
- playFrom effect（`:468-476`）を kind 分岐:
  - `kind === 'shogi'` → `switchKind('shogi')`（shogiMounted + 表示切替）。**開始は ShogiPlaySession 側 effect に委譲**（下の prop 伝播）。
  - `kind === 'chess'` → 既存どおり `startGame(colorChoice, difficulty, { startFen: playFrom.fen, rated: false })`。
- `<ShogiPlaySession onReview={onReview} playFrom={shogiPlayFrom} />`。
  - `const shogiPlayFrom = playFrom?.kind === 'shogi' ? { sfen: playFrom.fen, nonce: playFrom.nonce } : null;`
- WHY 開始を ShogiPlaySession に委譲するか: 将棋の対局開始ロジック（エンジン・レート・turnToken）は ShogiPlaySession に閉じており、PlayView から呼べない。PlayView は kind を切り替えて SFEN を渡すだけ（責務分離・コヒーレンス）。

### 4. `src/App.tsx`（橋渡し）

- `playFrom` state を `{ fen: string; nonce: number; kind: GameKind }` に。
- `handlePlayFrom(fen: string, kind: GameKind)` に拡張:
  `setPlayFrom((prev) => ({ fen, kind, nonce: (prev?.nonce ?? 0) + 1 })); setMode('play');`

### 5. `src/ui/ReviewView.tsx`（入口A 導線・将棋解禁）

- `onPlayFrom` prop 型 `(fen: string) => void` → `(fen: string, kind: GameKind) => void`。
- 「▶ この局面から対局」表示条件（`:960`）:
  `onPlayFrom && (kind === 'chess' || (kind === 'shogi' && COI_ENABLED))`
  - WHY `COI_ENABLED` を将棋のみ足すか: 将棋対局は SharedArrayBuffer 必須。coi=false（Safari）で導線を出しても対局できないので、将棋のときだけ環境で封じる（チェスは常時可）。ReviewView は既に `COI_ENABLED` を参照（`:218`）。
- onClick: `onPlayFrom(model.fenAt(index), kind)`（`fenAt` は shogi で現ノード SFEN を返す＝`shogiGame.ts:149`）。
- コメント（`:955-959`）の「将棋の対局は Phase 4-2 で別途／将棋では導線ごと隠す」を 4-3 解禁に書き換え。

## 不変条件・地雷対処

- **1 バイト不変条件**: `validateStartSfen` は tsshogi 依存の `shogiPlayGame.ts`（lazy チャンク）に置く。PlayView / App / ReviewView には tsshogi import を**足さない**（SFEN 文字列を素通しするだけ）。build 後にメインエントリへ shogi トークン 0 件を grep で実測。
- **0 手対局**: 既存の `snap.moveCount > 0` 保存スキップ（`ShogiPlaySession.tsx:373`）がそのまま効く（SFEN 対局で即投了も棋譜なしなので保存しない）。
- **開始局面が既に終局**: 詰み局面を貼ると `outcome.over=true` で終局表示になる。MVP は両玉ガードのみ。「手番側に合法手が無い SFEN を弾く」は nice-to-have（過剰スコープを避ける）。
- **チェス回帰ゼロ**: App/PlayView の `playFrom` は `kind` フィールド追加のみ（`fen` はリネームしない）。チェス経路の startGame 呼び出しは不変。
- **RLS / コスト防衛 / validate.ts / GPL**: 本変更は**バックエンド・Edge Function・DB・エンジン WASM に一切触れない**（フロント UI 配線 + 純粋関数のみ）。コスト防衛線・RLS・信頼境界・GPL 分離は無関係（緩和・迂回なし）。

## テスト計画

- `src/core/shogiPlayGame.test.ts` に `validateStartSfen` の単体テスト追加:
  - 有効: 平手 / 中盤 SFEN → ok・turn 正しい（`b`→sente / `w`→gote）
  - 不正文字列 / 段数不足 / 空 → `ok:false`（reason: 解釈不可）
  - 片玉（先手玉のみ）/ 両玉なし / **重複玉（先手玉 2 枚）** → `ok:false`（reason: 各 1 枚必要。Codex F002）
  - 詰将棋風・両玉あり中盤 → ok
- 既存テストは不変（コア挙動・storage・rating に変更なし）。
- **実ブラウザ E2E**（getBoundingClientRect 実測込み・将棋盤描画は必ず bounding box 実測＝再発防止規律）:
  - 入口B: 中盤 SFEN 貼付→開始→盤が正しい局面・駒 55px=マス幅・盤いっぱい→1 手→AI 応手→投了→振り返るで同一開始局面。
  - 入口A: 将棋棋譜→レビュー→途中局面で導線→その局面から開始（手番側=あなた）。
  - 不正 SFEN・片玉のエラー表示。
  - チェス回帰: チェス「この局面から対局」が従来どおり。
- 検証コマンド: `npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build`＋ build 後の 1 バイト grep。

## Codex ゲート① 裁定（2026-07-09・合意）

Codex 実装前レビュー: medium 2 件。裁定:

- **F001（0 手対局とレビュー接続の矛盾）— 指摘採用 / 修正案却下**: 受入条件3の文言が「投了→振り返る」と読め地雷対処の「0 手スキップ」と矛盾。→ 受入条件3を「1 手以上でレビュー可・0 手は対象外」に明確化（上記反映）。Codex の修正案（`hasCustomStartSfen` で 0 手カスタム開始をレビュー可能化）は却下: ①チェス Phase 2B が「単独局面（手なし）未対応」（`docs/PLAN.md:137`）で対称性を崩す ②静的局面閲覧は ReviewView の SFEN import（Phase 4-1）が担い、入口A はレビュー画面そのものなので 0 手レビューは冗長 ③将棋レビューモデルの手なし KIF 受理は未検証。`moveCount > 0` スキップは維持。
- **F002（玉検証が重複玉を通す）— 全面採用・深部は MVP 外**: 玉の presence では不十分（実測で重複玉 SFEN が newBySFEN を通る）→ K/k 各ちょうど 1 個を必須化（上記反映）。追加提案（隣接玉・玉取り可能の合法性チェック）は MVP 外: 主入口A は常に合法局面・既存 graceful エラー処理（aiError/null→AI 投了）が backstop・完全合法性検証はエンジン重複で合法エッジを誤弾くリスク。将来の nice-to-have として記録。

## Codex ゲート② 裁定（2026-07-09・合意）

Codex 実装後 diff レビュー: medium 1 + low 1。両方採用:

- **F001（medium・実バグ）— 採用**: チェスの playFrom 経路で `switchKind('chess')` を呼んでいなかった。直前に将棋タブを開いていたユーザーがレビュー→チェスの「この局面から対局」を押すと、チェス対局は作られるが画面は将棋のまま（kind='shogi'）で到達不能（Phase 4-2 からの潜在バグを本変更が顕在化）。→ チェス分岐に `switchKind('chess')` を追加（`PlayView.tsx`）。実ブラウザで再現→修正確認済み（下記 E2E）。
- **F002（low・堅牢化）— 採用**: `validateStartSfen` が駒種別の総数上限（歩18・香桂銀金4・角飛2）を検査せず、`b 99P` 等の物理的に不可能な持ち駒を通していた。→ `exceedsPieceLimits`（盤＋持ち駒を base 種で集計し上限超過を弾く）を追加。成駒は base 種で数える。詰将棋・練習で駒を減らすのは合法なので「以下」で判定。テスト4件追加。

## 実ブラウザ E2E 結果（2026-07-09・dev・crossOriginIsolated=true）

すべて getBoundingClientRect 実測込み（将棋盤描画の視覚検証＝再発防止規律）:

- **入口B バリデーション**: 不正 SFEN→「SFEN を解釈できませんでした」、片玉→「先手玉・後手玉がそれぞれ 1 枚ずつ必要です」、いずれも開始ボタン disabled。
- **入口B 有効 SFEN（後手番 `w`）**: 開始→盤 500px・マス幅56px・駒55px・40駒・transform `translate(100%刻み) scale(1)`（scaleDownPieces バグなし）・orientation-gote（手番導出）・0手・あなたの番。
- **入口A（将棋レビュー→対局）**: レビュー(将棋・1/4=後手番)に「▶ この局面から対局」表示（COI_ENABLED 解禁）→クリック→対局モード・将棋タブ・orientation-gote（局面の手番継承）・0手（新規）・駒55px。
- **F001 修正**: 対局を将棋タブにした状態→レビュー(チェス)→「この局面から対局」→対局モードで**チェスタブに復帰**・チェス盤可視・将棋盤非表示（未修正なら将棋のまま到達不能だった）。
- **振り返り接続（カスタム開始）**: 単体テストで exportKif→shogiGameModel→`fenAt(0)` がカスタム開始局面に一致することを固定（node 実測 exportKIF/importKIF 往復＋本アプリ経路の両方で担保）。move→AI→resign→review の機構は Phase 4-2 で E2E 済み・本変更は開始局面のみ差分。
- **コンソールエラー 0 件**。1バイト不変条件維持（メインエントリに shogi/validateStartSfen/exceedsPieceLimits 0 件・345KB で Phase 4-3 前と同水準）。

## レビュー姿勢

Codex ゲート①②で合意 → E2E → PR（自動生成マーク）。反論込み最大 3 サイクル・未収束は人間へ。両ゲートとも 1〜2 サイクルで合意（① medium2 / ② medium1+low1、全て採用または反論付き明確化）。
