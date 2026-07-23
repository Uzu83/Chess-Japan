# .agents/skills/ — ポータブルskill（canonical）

このディレクトリが **canonical source**。`.claude/skills/` は Claude Code 用の同期コピーであり、直接編集しない（編集したらこちらに反映して `.claude/skills/` へコピーし直す）。

- Codex / Cursor はこのディレクトリを読む
- Claude Code は `.claude/skills/` を読む
- 引数はツール間の互換性のため **skill 名 + YAML 入力ブロック**で渡す（Claude 固有の `$ARGUMENTS` 展開に依存しない）

```text
/review-post
base_ref: main

/quality-gate
classify
```

## セキュリティ注意（必読）

リポジトリ内の AI 設定ファイルは**権限境界**になり得る。fork や信頼できないブランチをチェックアウトした状態では、この配下の skill を実行しないこと。skill の `allowed-tools` を広げる変更は、通常のコード変更と同じレビューを通すこと。
