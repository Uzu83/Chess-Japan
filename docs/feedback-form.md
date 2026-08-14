# フィードバック導線

## 正（推奨）: アプリ内送信 → 非公開 Firestore（feedback-adcd2）

- UI: ヘッダー「フィードバック」→ [`FeedbackDialog`](../src/ui/FeedbackDialog.tsx)
- クライアント: [`src/feedback/client.ts`](../src/feedback/client.ts) → `@tosagiken/feedback-web`（[`vendor/`](../vendor/)）
- 手順の正（全プロダクト共通）: `~/development/projects/feedback-platform/docs/CONNECT.md`
- 分析: Firebase コンソール / `feedback-platform/docs/ANALYST.md`

送信内容は **非公開**（オーナーのみ）。返信希望（メール）は当面受け付けない。
局面（FEN/SFEN 等）は対局・レビュー中ならプリフィルされ、本文へ畳んで保存される。

| 環境 | 書き込み先 |
|---|---|
| local / preview（`VITE_FEEDBACK_TARGET` 未設定） | `feedback_dev` |
| Pages 本番（`VITE_FEEDBACK_TARGET=prod`） | `feedback` |

## フォールバック: Google フォーム

Firebase 未設定・ネットワーク障害・rules 拒否時は `VITE_FEEDBACK_URL` の Form へ誘導。

### Gemini プロンプト（フォーム作成用・任意）

```
チェスと将棋の「1手1手をAIが解説するWebアプリ(Chess-Japan)」のユーザーフィードバック用フォームを日本語で作成してください。回答のハードルを下げるため、必須項目は最小限にし、ほとんどを任意にしてください。次の質問を含めてください:

1. フィードバックの種類（ラジオボタン・必須）: バグ報告 / 機能のリクエスト / 解説の品質について / 使いやすさ(UI/UX) / その他
2. 内容を具体的に教えてください（段落・必須）
3. 解説のわかりやすさの満足度（5段階の均等目盛り・任意。1=わかりにくい〜5=とてもわかりやすい）
4. アプリ全体の満足度（5段階の均等目盛り・任意）
5. どの機能についてですか（チェックボックス・任意）: 棋譜の振り返り / AIと対局しながら解説 / 任意局面の解説 / 解説への質問(対話) / 局面から対局を再開(復習) / その他
6. 使用した端末（ラジオボタン・任意）: スマホ / タブレット / PC
7. 使用したブラウザ（ラジオボタン・任意）: Chrome / Safari / Firefox / Edge / その他
8. （バグの場合）再現手順（段落・任意）
9. 該当する局面のFEN/SFENまたは棋譜があれば貼ってください（段落・任意）
10. スクリーンショットがあれば添付してください（ファイルのアップロード・任意・画像のみ）
11. 返信が必要な場合のみメールアドレス（短文・任意。メール形式を検証）

設定: メールアドレスは自動収集しない。1人につき複数回回答できるようにする。確認メッセージは「フィードバックありがとうございます！いただいた内容は今後の改善に役立てます。」にしてください。
```

### アプリ連携

- Firebase Web config を `VITE_FEEDBACK_FIREBASE_*`（フロント・Pages）に設定
- Form URL を `VITE_FEEDBACK_URL` に設定（フォールバック）
- Firestore が使えるときはダイアログが優先。Form のみのときは外部リンク

## レガシー

Edge Function `feedback` → 公開 GitHub Issue は **フロントから呼ばない**。契約文書は [`docs/feedback/ISSUE_CONTRACT.md`](./feedback/ISSUE_CONTRACT.md)。undeploy は別タスク。
