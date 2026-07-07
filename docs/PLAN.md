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
  - **Phase 2B（未）**: 「任意局面解説」＋振り返り局面から AI 対局で再開（同一 GameModel 共有）。
  - **Phase 2C（未・要設計）**: アカウント＋対人戦(PvP)＋内部レーティング(Elo)・カジュアル/ランク。realtime 基盤が要るため別フェーズ。
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
- ✅ 既定 LLM: **Grok** に確定。
- 未決: PoC の最初の縦貫通ユースケースは「振り返り(PGN)」を既定とする（AI対局を先にしたい場合は要相談）。

## 進捗
- ✅ **Phase 0 完了・push 済み**（雛形 / CI-CD / セキュリティヘッダ / シークレット管理 / LLMプロキシ雛形 / フィードバック仕様）。
- ✅ **Phase 1 実装（チェス縦貫通 PoC）**: GameModel(PGN) / UCIパーサ / Stockfish(WASM)ワーカー＋モックフォールバック / 手の質分類 / 解説クライアント(Grok, ローカルフォールバック) / レスポンシブ振り返りUI（盤+棋譜+解説+対話）。ユニットテスト23件・typecheck/lint/format/build すべて緑。
  - 注: 実ブラウザでの WASM 動作・解説LLMの実呼び出しは dev起動/デプロイ後に要確認（Supabase未設定時はローカル簡易解説で動作）。
- 次: **Cloudflare Pages デプロイ**（実機確認）。デプロイ準備として Node を `.node-version`=22 に固定（Vite7 要件）。ビルドコマンド `npm run build` / 出力 `dist` / `public/_headers` で COOP/COEP。→ その後 Grok 実接続 → Phase 2。
