# フィードバック導線（v1）

## 正（推奨）: アプリ内送信 → 公開 GitHub Issue

- UI: ヘッダー「フィードバック」→ [`FeedbackDialog`](../src/ui/FeedbackDialog.tsx)
- API: Edge Function `feedback`（契約: [`docs/feedback/ISSUE_CONTRACT.md`](./feedback/ISSUE_CONTRACT.md)）
- 運用: [`docs/operator/feedback-runbook.md`](./operator/feedback-runbook.md)
- 自動 PR: **v2 予定**（[`docs/feedback/CURSOR_AUTOMATION.md`](./feedback/CURSOR_AUTOMATION.md)）

送信前に「公開 GitHub Issue になる」同意が必須。メールアドレス欄は無い。

## フォールバック: Google フォーム

Edge 未設定・レート超過・GitHub 障害時は `VITE_FEEDBACK_URL` / `FEEDBACK_FALLBACK_URL` の Form へ誘導。

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

- Form URL を `VITE_FEEDBACK_URL`（フロント）と `FEEDBACK_FALLBACK_URL`（Edge secret）に設定
- Edge が使えるときはダイアログが優先。Form のみのときは従来どおり外部リンク
