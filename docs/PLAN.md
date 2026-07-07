# 将棋・チェス「1手解説AI」 開発計画

## Context（なぜ作るのか）

既存のオープンソース対局AIを流用し、チェス/将棋の1手1手を丁寧に解説する Web アプリを作りたい。
現状リポジトリは `README.md` のみのグリーンフィールド。本計画は「最初の設計合意」を目的とする。

ユーザーからのヒアリング結果:
- **対象**: まず1ゲームで PoC（実装が軽く資料も豊富なチェス/Stockfish を想定）→ のちに将棋へ展開
- **ユースケース（全部入りが最終ゴール）**:
  1. AIと対局しながら各手をリアルタイム解説
  2. 棋譜（PGN/KIF）の振り返り解説（感想戦）
  3. 任意局面の解説（詰将棋・練習問題）
  4. 振り返った局面から「AI対局で再開して復習」できる
- **解説LLM**: Claude ではなく**コスト重視**。**既定は Grok（最安）**で実装。プロバイダは抽象化し差し替え可能に。
- **対話的解説**: 解説に対し「どういうこと？」「ピンって何？」と聞き返すと、より噛み砕いて答える Q&A を可能にする。
- **知識パーソナライズ**: ユーザーごとに「分かるチェス専門用語」プロパティを持たせ、ピン/フォーク等の理解・未理解を記録。解説を個人に合わせて半パーソナライズ（未知の用語は補足、既知の用語は簡潔に）。
- **スタック**: おまかせだが「Next.js が本当に今ベストか」を調べ直して根拠を持って提案してほしい（Codex とも合意形成したい）。
- **開発順序**: まず **CI/CD とセキュリティ周りをしっかり実装・環境整備してから**機能に着手する。
- **収益モデル**: 課金要素なし。**Ko-fi で任意支援**、将来は**広告**でサーバ代を賄う予定。

設計の鍵となる制約は4つ:
1. 対局エンジンは**ブラウザ内 WASM で動く**（Stockfish / YaneuraOu とも実績あり） → 重い探索はユーザー端末で完結し、**サーバー計算コストが実質ゼロ**。収益ゼロ前提と相性が良い。
2. WASM マルチスレッド版は `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` ヘッダが必須（SharedArrayBuffer）。
3. **COEP ↔ 広告の衝突**: `COEP: require-corp` だとサードパーティ広告スクリプト/iframe が読み込めなくなる。将来の広告収益と両立させるため、`COEP: credentialless`（Chrome系）採用や、エンジンを別オリジン/別iframeに隔離する設計を最初から検討する。
4. **コスト防衛が最重要セキュリティ課題**: 収益なしのため、公開 LLM エンドポイントを叩かれると課金が青天井。レート制限・不正利用対策を必須要件として最初に組み込む。
5. 解説の品質と正確さは「エンジンが出す事実（評価値・最善手・読み筋）」を**ルールで抽出 → LLM で日本語に整文**するハイブリッドが最適（LLM が評価値を幻覚しない）。

---

## 技術スタックの結論（"Next.js が最適か?" への回答）

**結論: Next.js は不適ではないが、このアプリ形には過剰。推奨は Vite + React(SPA) + Supabase。**

理由 — このアプリは「クライアント計算が主、バックエンドは薄い、SEO 不要」という形:
- 重い処理（エンジン探索）は**ブラウザ WASM**で完結。サーバーレンダリングの恩恵がほぼ無い。
- バックエンドが担うのは (a) LLM API のプロキシ（APIキー秘匿＋コスト管理）、(b) 解説キャッシュ/棋譜/ユーザーの永続化 のみ。
- Next.js の App Router / RSC は学習コスト・概念オーバーヘッドの割に、この形では旨味が小さい。

### 推奨スタック（第1候補）
| 層 | 技術 | 役割 |
|---|---|---|
| フロント | **Vite + React + TypeScript（SPA）** | 盤UI・WASMワーカー制御・状態管理。素直で高速イテレーション |
| 盤UI | **chessground**（lichess製・将棋は **shogiground**） | フレームワーク非依存の枯れた盤ライブラリ。React以外でも再利用可 |
| エンジン | **stockfish.js (lite WASM)** → 将棋は **yaneuraou.wasm** | Web Worker 上で UCI/USI を喋らせる |
| バックエンド | **Supabase Edge Functions** | LLMプロキシ・解説生成API。APIキー秘匿 |
| DB/認証 | **Supabase (Postgres + Auth)** | 棋譜・解説キャッシュ・ユーザー |
| ホスティング | **Cloudflare Pages（確定）** | 静的配信。`public/_headers` で COOP/COEP を付与。`vercel.json` は予備 |
| LLM | **プロバイダ抽象レイヤ**（既定 Grok 4.1 / 比較用 Gemini Flash-Lite） | 後述。差し替え可能に |

### 代替案（合意形成の比較材料）
- **TanStack Start**: Vite ネイティブで型安全な server functions を持つ統合フルスタック。将来 SSR/サーバー関数が中心になるなら有力。第1候補の「上位互換」的立ち位置。
- **Next.js**: 実績・エコシステム最大で安全牌。ただし上記理由で本アプリには過剰。Vercel デプロイは最も楽。
- **SvelteKit**: バンドル最小・高速だが React 製チェス/将棋盤コンポーネント資産を捨てることになる。

> 推奨は「Vite + React + Supabase」。SSR/サーバー関数を将来重視するなら TanStack Start に格上げ。この2択で Codex と合意を取るのが良い。

---

## アーキテクチャ（全ユースケース共通の土台）

すべてのユースケースは次の **4つの共通プリミティブ**の組み合わせで実現する:

1. **GameModel**: 局面・指し手の正規モデル（チェス=`chess.js` / 将棋=`tsshogi` 等を利用）。FEN/SFEN、SAN/KIF 変換、合法手生成を担う。
2. **AnalysisService（エンジンラッパ）**: Web Worker 上の WASM エンジンに `position`→`go multipv` を送り、`{評価値, 最善手, 読み筋(PV) 上位K, 深さ}` を返す。指し手前後の評価値差を計算。
3. **MoveClassifier**: 評価値差から手の質を分類（最善/好手/疑問手/悪手/大悪手、lichess 方式）。局面特徴（手番・駒得・フェーズ・戦術モチーフ）も抽出 → **構造化「解説コンテキスト」**を生成。
4. **ExplanationService（LLM）**: 構造化コンテキストを受け取り、ユーザーのレベルに合わせた**日本語の自然な解説**を生成。Edge Function 経由でキーを秘匿（既定 Grok）。
   - **対話モード**: 解説に紐づくスレッドを保持し、「どういうこと？」「ピンって何？」等の追問に、元の局面コンテキスト＋直前解説を踏まえて回答。
5. **UserKnowledgeProfile**: ユーザーごとに既知/未知の専門用語（pin/fork/skewer/discovered attack…）を記録するプロパティ。
   - 解説生成・追問時にプロファイルをプロンプトへ注入 → **未知の用語は補足説明、既知の用語は簡潔に**（半パーソナライズ）。
   - 用語が解説に登場し、ユーザーが追問した／「分かった」操作をした履歴から自動更新。匿名時は localStorage、ログイン時は Supabase に保存。

### UI / レスポンシブ方針（スマホ・タブレット・PC 最適化）
- **モバイルファースト**で設計し、ブレークポイントで 3 レイアウトに最適化:
  - **スマホ（縦）**: 盤を画面幅いっぱい＋解説/対話パネルは下にスタック（タブ or ボトムシート切替）。
  - **タブレット**: 盤と解説を 2 カラム、向きに応じて再配置。
  - **PC**: 盤・評価値グラフ・解説/対話・棋譜リストの多カラムダッシュボード。
  - 盤は `chessground`（レスポンシブ・タッチ操作対応）。タッチとマウス両対応、ドラッグ＆タップ移動。
  - CSS は軽量に（Tailwind 等）。アクセシビリティ（コントラスト・フォーカス・キーボード操作）も配慮。

ユースケースへの写像:
- ②棋譜振り返り = GameModel(棋譜import) → 各手を Analysis+Classify+Explain → 評価値グラフ＋解説で表示
- ①AI対局解説 = エンジンが指す＋各手を Explain（リアルタイム）
- ③任意局面 = FEN/SFEN/盤入力 → Analysis+Explain
- ④復習で再開 = 振り返り中の任意局面を「対局モード」へロード（同じ GameModel を共有するので自然に実現）

### 解説生成パイプライン（コア IP・1手あたり）
```
局面(前) → Engine: 評価値/最善手/PV上位K
指された手 → 局面(後) → Engine: 評価値
→ 評価値差・手の質・局面特徴をルール抽出（決定的・低トークン・正確）
→ 構造化コンテキストを LLM へ → 自然な日本語解説
→ (局面+手) ハッシュでキャッシュ（Supabase）。定跡など頻出局面は2回目以降 LLM 不要
```
キャッシュとルール抽出により、LLM 呼び出し回数とトークンを最小化＝**コスト最小**。

### LLM レイヤ（コスト方針）
- **プロバイダ抽象インターフェース**を Edge Function 側に置き、`provider` を環境変数で切替。**既定は Grok 4.1**（$0.20/$0.50 per 1M、最安）。比較用に Gemini Flash-Lite も差し替え可能に。
- プロンプトは「エンジンの数値事実を渡し、平易に」を固定テンプレ化。レベル（初心者/中級/上級）＋**UserKnowledgeProfile（既知/未知用語）**をパラメータ注入。
- 解説 API と**対話（追問）API** の2系統。対話は局面コンテキスト＋解説スレッドを保持。両系統ともレート制限・キャッシュ対象。

---

## PoC スコープ（チェス先行・最小で価値検証）

目的: **「1手の解説パイプライン」が成立することを最短で実証**する。
PoC で作るもの:
1. Vite+React+TS プロジェクト雛形（COOP/COEP ヘッダ設定込み）
2. chessground 盤 + `chess.js` で局面/手の管理
3. `stockfish.js` lite を Web Worker で起動し、`multipv` 解析を返す AnalysisService
4. MoveClassifier（評価値差→手の質）
5. Supabase Edge Function による ExplanationService（既定 Gemini Flash-Lite、解説キャッシュ付き）
6. **1ユースケースを縦に貫通**: PGN貼付 or 1手ずつ進める「振り返り」で、各手に評価値＋日本語解説を表示

PoC で**作らない**もの（後続フェーズ）: 将棋対応・AI対局/再開・認証・本格UI・複数レベル切替。

## フェーズ計画（CI/CD・セキュリティを最優先）
- **Phase 0a — 基盤整備（最初に着手）**: 後述「CI/CD・セキュリティ基盤」を構築。スタック最終合意（Vite+React+Supabase / Codex 合意）、リポジトリ雛形、CI パイプライン、セキュリティヘッダ、シークレット管理、LLM エンドポイントのレート制限の土台。
- **Phase 0b — 検証**: COOP/COEP＋`crossOriginIsolated` 検証、Edge Function のレート制限が効くこと、CI が緑であることを確認。
- **Phase 1（PoC）**: チェス縦貫通（振り返り1ユースケース）✅ 完了
- **Phase 2**: AI対局モード＋「任意局面解説」＋「局面から再開（復習）」
  - **Phase 2A ✅ 完了（2026-07）**: ローカル Stockfish との AI 対局。
    - 実装: `src/core/playGame.ts`（可変ゲームコントローラ・chess.js ラップ・snapshot 方式）、
      `src/ui/PlayView.tsx`（設定→対局→終局→履歴の状態機械・AI手番の非同期オーケストレーション=turnToken でキャンセル制御）、
      `src/ui/PlayBoard.tsx`（chessground 操作盤・合法手/王手/成りピッカー）、
      `src/engine/*`（`chooseMove` 追加＝Skill Level で弱さ制御・単一worker混線を直列化で防止）、
      `src/core/storage.ts`（対局履歴 localStorage 永続化・上限50件リング）、
      `src/App.tsx`（[対局|レビュー] モード切替・既定=対局）。
    - 難易度4段（Skill 1/6/12/20）・白/黒/ランダム・待った・投了・盤反転。
    - 「この対局を振り返る」で終局 PGN を既存 ReviewView へ受け渡し（④復習で再開の第一歩）。
    - レビュー: Codex 異モデル＋Claude 多観点。検出された競合（bestmove 混線）・終局後着手・keydown 横取りを修正済み。
  - **Phase 2B ✅ 完了（2026-07-07）**: 「復習で再開」の実装。
    - レビュー画面に「▶ この局面から対局」— 表示中の局面 FEN から AI とカジュアル対局（あなたは手番側）。
    - 対局設定に「局面(FEN)から対局する」— 詰将棋・練習問題用途。
    - PlayGame が SetUp/FEN ヘッダ付き PGN を生成し、途中局面対局も ReviewView で振り返れる（往復テスト済み）。
    - 地雷対処: 0手対局（開始即投了）は棋譜が無く振り返れない → 履歴保存スキップ + 振り返る導線非表示。
    - 単独局面（手なし）の解説だけは未対応（ChessGame が手必須のため。「その局面から指して振り返る」で代替可能）。
  - **Phase 2C（設計固定・実装は次弾）**: アカウント＋対人戦(PvP)＋クラウドレート＋有料プラン基盤。
    - **✅ 先行実装済み（2026-07-07）: ローカル内部レート** — `src/core/rating.ts`（標準Elo・K=32・床100・テスト付き）
      + `cj:rating` 永続化。レート戦/カジュアル切替（オーナー構想「カジュアルは変動なし」）、
      待った使用でレート変動なしに降格、AI難度の目安Elo(800/1400/1900/2800)が相手レート。
      終局バナーに「レート 1200 → 1216 (+16)」表示。
    - 実装順序（次弾）: 2C-1 Supabase Auth + profiles（初期Elo入力・ローカルレートの移行）→
      2C-2 対局/レートのクラウド同期 → 2C-3 PvP（Supabase Realtime・マッチメイキング）→
      2C-4 Stripe + 有料プラン（Gemini Pro解禁・サーバー側プラン判定。課金設定は手動承認）。
    - 全段で migration + RLS を伴うため、push 前に Codex 合意ゲート必須（CLAUDE.md の規律）。
- **Phase 3**: LLM プロバイダ実測比較・プロンプト/レベル調整・キャッシュ最適化
  - **✅ 2026-07-07 LLM 実接続完了**: プロバイダ=Gemini（`LLM_PROVIDER=gemini` + `GEMINI_MODEL=gemini-2.5-flash`）。
    Turnstile(Managed)・レート制限・キャッシュ・CORS 全て本番で動作確認済み。
    - 地雷1（解決済み）: `gemini-2.5-flash-lite` は無料枠で断続的に 503（過負荷）→ 無印 flash に切替で解消。
    - 地雷2（解決済み）: Gemini 2.5 系は thinking モデルで**思考トークンが maxOutputTokens に含まれる**→
      500 のままだと本文が数十文字で途切れる。`thinkingConfig: { thinkingBudget: 0 }` で無効化（2.5 Pro は無効化不可）。
    - プロンプト: UCI→SAN/日本語言い換えを system に固定指示（生 "c8g4" が解説に漏れて読めない問題の対処）。
- **Phase 4**: 将棋対応（yaneuraou.wasm + shogiground + tsshogi、KIF/CSA import）。共通プリミティブを将棋実装で差し替え
- **Phase 5**: 認証・棋譜保存・共有・UI 仕上げ
- **Phase 6**: Ko-fi 導線、広告導入（COEP 両立対応）、コスト/収益モニタリング

## 収益・コスト設計（2026-07-07 オーナー決定）

**1解説の原価 ≈ 0.25円**（Gemini 2.5 Flash 有料単価・入力~1.5K+出力≤500トークン。thinking 無効化でこれが上限）。
同一局面+level+語彙はキャッシュで 0 円（人気局面ほど無料化していく構造）。現状は Google 無料枠のため支払いゼロだが、
無料枠は**プロジェクト全体の日次上限**があるため、公開後にトラフィックが立ったら Google 側の課金有効化が必要（単価は上記）。

| プラン | 上限 | モデル | 状態 |
|---|---|---|---|
| 無料(匿名) | **50解説/日/IP**（`RATE_PER_DAY=50`・15/分は維持） | Gemini Flash（~0.25円/解説） | **決定済み**。secrets 変更のみで適用 |
| 無料アカウント | 100/日（案） | Gemini Flash | Phase 2C（Supabase Auth）とセットで実装 |
| 有料 ¥400〜500/月 | 100 Pro解説/日（案） | **Gemini Pro（賢いモデル・~4円/解説）** | Phase 2C+Stripe。課金設定は手動承認領域 |

### 有料プランのモデル戦略（2026-07-07 オーナー決定・Gemini 統一）

- **無料=Flash / 有料=Pro** の Gemini 統一。原資はオーナーの Google AI Ultra 特典の月次 GCP クレジット（$100/月想定）。
  Gemini Developer API は API キーが GCP プロジェクト紐づけで課金されるため、**Vertex 移行不要**で現行実装のまま
  クレジット消化できる見込み（⚠️ クレジットの適用 SKU 条件は付与後に請求画面で要確認）。
- $100 ≈ Pro 3,700解説/月 ≈ 有料ユーザー数人〜十数人を養える。キャッシュキーに model 入り(#3)なので
  Flash/Pro のキャッシュは構造的に混ざらない（有料者に無料品質を返す事故なし）。
- **地雷（実装時に必ず踏む注意）**:
  1. **Gemini Pro は thinking を無効化できない**（`thinkingBudget: 0` 不可・callGemini のコメント参照）。
     Pro 用は `maxOutputTokens` を 2000〜3000 に上げないと、Flash で実際に踏んだ「思考が予算を食い潰して
     本文が途切れる」バグを再発する。
  2. **モデル選択は絶対にサーバー側で解決する**（JWT → プラン判定 → モデル決定）。クライアントから
     モデル指定を受ける API にすると攻撃者が高額モデルを叩き放題になる。validate.ts に model フィールドを
     足してはいけない。

**広告: 入れない（オーナー決定・再検討ライン=月間数千PV）**。理由: ①トラフィック前の広告収益はほぼゼロで UX コストだけ先払い
②COEP: credentialless と AdSense の相性問題（上記 Phase 6 の既知課題）③「静かな日本的モダン」の世界観と不整合。
入れる場合もフッター1枠のみ・盤/解説エリアには置かない。それまでの収益導線は Ko-fi。

## CI/CD・セキュリティ基盤（Phase 0 の中身・最優先）
### CI/CD
- **GitHub Actions** で PR ごとに: 型チェック(`tsc`)・Lint(ESLint)・フォーマット(Prettier)・ユニットテスト(Vitest)・ビルド。
- **依存脆弱性スキャン**: `npm audit` ＋ Dependabot（自動 PR）。
- **シークレットスキャン**: GitHub secret scanning ＋ push 前フック（gitleaks 等）。
- **デプロイ**: main へのマージで自動デプロイ（Cloudflare Pages / Vercel）。プレビューデプロイを PR ごとに。
- ブランチ保護: main 直 push 禁止、CI 必須。

### セキュリティ
- **シークレット管理**: LLM/Supabase のキーは**サーバー側（Edge Function 環境変数）のみ**。フロントに絶対に出さない。`.env` は `.gitignore`、`.env.example` を用意。
- **LLM コスト防衛（最重要）**: Edge Function に
  - 1IP/セッションあたりの**レート制限・日次クォータ**、
  - 1リクエストの**入力サイズ上限**（巨大 PGN 拒否）、
  - 必要に応じ **Cloudflare Turnstile**（無料 CAPTCHA）でbot抑制、
  - 解説**キャッシュ**で同一局面の再課金を防止。
- **入力検証**: FEN/SFEN/PGN/KIF をサーバ側でパース検証（不正入力・インジェクション対策）。
- **セキュリティヘッダ**: COOP/COEP（WASM用）＋ CSP・`X-Content-Type-Options`・Referrer-Policy。CSP は広告導入時に許可ドメインを最小限追加。
- **依存最小化**: WASM/盤ライブラリは実績ある公式系のみ採用。

## 収益・コスト方針（課金なし）
- **課金要素は実装しない**。サーバ計算はブラウザ WASM 採用で実質ゼロに抑える。
- **Ko-fi**: 外部リンク設置のみ（決済連携・PII 取得不要、実装軽量）。
- **フィードバック導線**: アプリ内に「フィードバック」ボタン → 当面は **Google フォーム**（外部リンク）。実装軽量・PII最小。フォームの作成要件と Gemini 生成プロンプトは `docs/feedback-form.md` に用意（ユーザーが作成しリンクを環境変数 `VITE_FEEDBACK_URL` に設定）。
- **広告（将来）**: Google AdSense 等。導入時の課題＝**COEP との両立**（`credentialless` 採用 or エンジン隔離）と CSP/同意管理（個人情報・GDPR/改正個情法）。Phase 6 で対応。
- 主要コスト＝LLM のみ → キャッシュ＋最安プロバイダ＋レート制限で最小化し、Ko-fi/広告で回収。

## 環境変数の設定（スマホ/リモート前提）
`.env` ファイルは git に入れず（gitignore 済み）、本番値は各 Web ダッシュボードで設定する（スマホブラウザで可）。
- **フロント公開変数 `VITE_*`**（`VITE_FEEDBACK_URL` / `VITE_KOFI_URL` / `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`）
  → **Cloudflare Pages → Settings → Environment variables** に設定。**秘密ではない**（公開JSに焼き込まれる）。Supabase anon key/URL は公開前提で可（DB は RLS で保護）。
- **バックエンド秘密 `XAI_API_KEY`(Grok) など**
  → **Supabase の Secrets のみ**（`supabase secrets set` or ダッシュボード）。ブラウザにも git にも出さない。Edge Function プロキシ経由で利用。
- ローカル `.env` は `npm run dev` を動かすマシン上の一時設定のみ。リモートコンテナは使い捨てのため秘密の常設場所にしない。

## 主要オープンソース依存（候補）
- チェス: `stockfish.js`(WASM) / `chess.js` / `chessground`
- 将棋: `yaneuraou.wasm`(mizar版) / `tsshogi` / `shogiground`
- 基盤: Vite, React, TypeScript, Supabase

## 検証方法（PoC 完了の判定）
1. `npm run dev` でローカル起動、ブラウザで盤が表示される。
2. DevTools で `crossOriginIsolated === true`（COOP/COEP 有効＝WASMマルチスレッド可）を確認。
3. サンプル PGN（例: 短い名局）を読み込み、各手で評価値が表示され、Stockfish の最善手と一致/乖離が分かる。
4. 各手に対し日本語解説が生成・表示される。明らかな悪手で「なぜ悪いか」が説明されること。
5. 同一局面を再解析した際、キャッシュヒットで LLM 呼び出しが発生しないこと（コスト検証）。
6. 数十手の棋譜で総 LLM コストを実測し、Grok/Gemini を比較。

## 決定事項 / 未決事項
- ✅ ホスティング: **Cloudflare Pages** に確定。
- ✅ 既定 LLM: ~~Grok~~ → **Gemini に変更（2026-07-07 オーナー決定・上の「収益・コスト設計」が正）**。
  無料=Gemini 2.5 Flash / 有料=Gemini Pro。WHY: Google AI Ultra x20 の月次 $100 GCP クレジット流用。
- ✅ 縦貫通ユースケース: 「振り返り(PGN)」で完了 → その後 AI対局(Phase A)も完了。

## 進捗
- ✅ **Phase 0 完了・push 済み**（雛形 / CI-CD / セキュリティヘッダ / シークレット管理 / LLMプロキシ雛形 / フィードバック仕様）。
- ✅ **Phase 1 実装（チェス縦貫通 PoC）**: GameModel(PGN) / UCIパーサ / Stockfish(WASM)ワーカー＋モックフォールバック / 手の質分類 / 解説クライアント(Grok, ローカルフォールバック) / レスポンシブ振り返りUI（盤+棋譜+解説+対話）。ユニットテスト23件・typecheck/lint/format/build すべて緑。
  - 注: 実ブラウザでの WASM 動作・解説LLMの実呼び出しは dev起動/デプロイ後に要確認（Supabase未設定時はローカル簡易解説で動作）。
- ✅ **Cloudflare Pages 本番公開済み**: https://chess-japan.pages.dev （`.node-version`=22 / `npm run build` / `dist` / `_headers` で COOP/COEP）。
- ✅ **Phase A（AI対局）/ Phase 3（Gemini 実接続）/ Phase 2B（この局面から対局）/ ローカル内部レート(Elo)** — 全て main へマージ済み（PR #2, 2026-07-07）。詳細は各節。
- ✅ **運用整備（2026-07-07・Codex ゲート①合意済み）**: Sentry エラー監視（`src/monitoring/sentry.ts`、DSN 未設定なら完全オフ・遅延 init・起動時白画面は非目標と明記）/ `public/privacy.html` プライバシーポリシー（実データフローに正直: IP は生のまま期限付き保存と記載）/ X 告知下書き `docs/announcements/x-post-draft.md`。
- 📌 **将来の堅牢化（未実装・意図的に見送り）**: rate_counters のバケットキー `day:ip:<ip>` の IP を HMAC/SHA-256 化する（privacy by design）。今回見送った WHY: コスト防衛の心臓部（Edge Function）に触れる変更は単独 PR + Codex ゲート + 再デプロイ承認が必要で、ポリシー文言を現実に合わせる方が安全・低リスクだったため。実施時はポリシー第3節も更新すること。
- ✅ **Phase 2C-1 完了（2026-07-07・PR #8 マージ・本番デプロイ済み）**: Google OAuth 単独(redirect/PKCE)・profiles(owner スコープ RLS + 列 GRANT で rating は RPC 専用)・初期Elo オンボーディング・ローカルレート移行・`VITE_AUTH_ENABLED` フラグで段階公開。migration 3本は**本番適用・ライブ検証済み**（advisor 緑 + RLS スモーク 9/9: anon 遮断・列 GRANT・コスト防衛不変）。ゲート実績: Codex ①(4件)②(blocking 2件) + 5レーン監査ワークフロー(confirmed critical 0)。
  - **2C-1 の意図的制約（未来の担当者へ）**: ①AI戦結果→クラウド反映は 2C-2（PlayView 無改変。クラウドレート表示はアカウントメニュー内のみ = 「表示はクラウド・更新はローカル」の嘘 UX を避けた）②`apply_rated_result` は定義済みだが**誰にも GRANT していない**（REST 直叩きリプレイ対策。2C-2 でレート制限付き再 GRANT — Codex ゲート再審査必須）③ログイン UI はオーナーの OAuth ダッシュボード設定 + `VITE_AUTH_ENABLED=1` ビルドまで非表示。
- 次: 2C-2 クラウド同期（apply_rated_result の配線・双方向同期）→ 2C-3 対人戦 → 2C-4 Stripe+Pro。全段 migration+RLS を伴うため Codex 合意ゲート必須。

### Phase 4-1（将棋振り返りの縦貫通 MVP）— 2026-07-08

**スコープ**: KIF/CSA/SFEN を読み込み → 各手エンジン評価 + 手の質分類 + 日本語1手解説。1アプリに将棋を同居させ、GameKind で分岐する。Phase 4-0 スパイク（`scratchpad/shogi-spike`）の実測に基づく。

**スタック確定（Codex ゲート① 合意）**: `tsshogi`(棋譜/局面/表記・ルール完全性 6/6 PASS) + `@mizarjp/yaneuraou.k-p`(WASM/NNUE 水匠内蔵・GPL-3.0) + `shogiground`(盤UI)。shogiops は千日手/持将棋 API 無しで不採用。

**主要な設計判断（WHY・後任者向け）**:
- **薄い GameModel を今作った（合意 #3）**: `src/core/gameModel.ts`。ChessGame/ShogiGame 共通の読み取り面（kind/startFen/moves{label,engineMove}/fenAt/result）。ChessGame(game.ts) は無改修、`chessGameModel()` で包む。ReviewView を 1 本に保ち二重実装を避けた。MoveRecord は `gameMoveRecords()` で fenAt から機械再構築（チェスは ChessGame.moves と完全一致＝回帰ゼロ）。
- **COEP は (b) credentialless 維持で出荷（合意 (b)）**: やねうら王は SharedArrayBuffer 必須。Chromium は credentialless で coi=true だが **Safari は credentialless 非対応で coi=false → 将棋エンジン不起動**（Phase 4-0 実測）。Safari では「盤の閲覧のみ・解析非対応」の文言を出しフォールバック（チェスは lite-single で SAB 不要なので Safari でも従来どおり動く非対称を許容）。`require-corp` 全面移行(a)は Turnstile の require-corp 互換を実測してから別途判断（コスト防衛の土台なので不用意に触らない）。
- **手の質分類の閾値は GameKind 別（合意 #4）**: `classify.ts` の `LOSS_THRESHOLDS`。chess は現行値を1つも変えず（既存173テスト不変）、shogi は**暫定値** best≤30/good≤120/inaccuracy≤300/mistake≤700。WHY 粗いか: やねうら王の評価は centipawn 相当だが駒価値スケールが違い（歩≈90-100、大駒≈1000+級）1手の振れが大きい。**これは暫定値で、将棋の実棋譜分布が取れ次第の再調整が前提**（確定値ではない）。`classifyByLoss` は後方互換のため第4引数 `kind`(既定 chess) を末尾追加した（3引数の既存テスト呼び出しを壊さないため）。
- **bestmove 結果型を分離（合意 #5）**: `usi.ts` の `UsiBestMove` 判別 union（move/resign/win/none）。USI 特有の投了・入玉宣言勝ちを「実手」と取り違えない。info 行パースは UCI と同型なので `parseInfoLine` を共有。
- **1バイト不変条件（バンドル）**: 将棋一式（tsshogi/shogiground/やねうら王）はチェス利用者に払わせない。すべて動的 import で code-split。build 実測（`dist/assets`）でメインチャンク（index-*.js）に shogi 由来コード（createMoveByUSI/formatMove/sg-board/engine-shogi）が**0件**であることを確認。将棋チャンク: tsshogi≈65KB(gz20) + shogiground≈47KB(gz15) + wrapper類≈7KB + CSS 2.6KB（将棋タブ初回選択時のみ）。

**コスト防衛（不変条件・非緩和）**: backend は `buildPrompt` に chess/shogi の表記指示分岐（将棋は USI 座標でなく日本語表記 ▲７六歩 で駒種・成り・打ちを明示）を足しただけ。rate/validate/Turnstile/キャッシュには一切触れていない（validate.ts は既に shogi 受理済み）。`deno check` 緑。**デプロイは未実施**（Codex ゲート後に呼び出し元が実施）。

**ShogiBoard の実装メモ**: shogiground は CSS も駒画像も npm に同梱していない（examples/assets 前提）。閲覧 MVP には画像アセット 0 で足りるよう、駒を**漢字グリフ**で CSS 描画（`shogiBoard.css`・成駒は略字 と/杏/圭/全/馬/龍）。coordinates は MVP では無効化。将来インタラクティブ化(4-2)で見栄えを上げるならスプライトへ差し替える余地を残した。

**既知の制約 / 未対応（4-2 以降 or 要調整）**:
- shogi 閾値は暫定（要実測調整）。
- ExplanationPanel / EvalGraph は未対応（スコープ外）: 最善手が USI 座標のまま表示され得る／グラフ tooltip の「白/黒」表記が将棋では先手/後手にならない（軽微・盤/MoveList/LLM 解説の日本語表記は正しい）。
- 将棋モードはセッション/解析キャッシュを永続化しない（chess の localStorage 復元を汚さないため。再解析は許容）。
- 将棋の AI 対局・任意局面からの対局は Phase 4-2（別 Codex ゲート）。「この局面から対局」導線は将棋では非表示。
