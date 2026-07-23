# 決定: 欠落 finished PvP room の保持期限（180d + アーカイブ）

- 状態: 採用（score-loop owner lock / Tier2 cost↔data 振動の裁定）
- 日付: 2026-07-24
- 関連: `supabase/migrations/0018_*.sql`, `0019_pvp_record_retry_and_archive.sql`, `docs/COST_DEFENSE.md`

## 背景

欠落（片方または両方の `games` 行が未作成）の `pvp_rooms` について:

- **cost**: 無期限保持は日次保存クォータ迂回によるストレージ蓄積を許す
- **data**: 期限削除は権威棋譜の回復不能な喪失になる

同一 finding がサイクル間で振動し、2連続クリーン不能になった。

## 決定

1. **payload（moves）付き `pvp_rooms` は期限で退役**する（無期限の棋譜蓄積は採用しない）
   - 両席記録済み: **90 日**
   - 欠落 finished: **180 日**
2. **退役前に `pvp_room_archives` へ権威データを退避**（RLS ON・ポリシー無し・anon/authenticated GRANT 無し）
3. **`games.pvp_room_id` が残っている間は DELETE せず stub 化**（moves を空配列にして FK を維持）
4. **日次40の bypass は置かない**（未保存席の回復元は archive）
5. 通常の欠落回収は **`record_retry_after` バックオフ**（クォータ超過時 +1h）
6. **archives**: 730 日で materialize 試行（**日次40厳守**）。揃ったら削除。未完了は最大 **1095 日**で絶対削除。参照 games の無い stub は archive 消化後に削除

## なぜこうするか

- cost の「絶対上限」と data の「棋譜消滅禁止」を同時に満たす唯一の小さな解が「部屋は消すがアーカイブに残す」
- 公開クライアントからは archives を読めない（信頼境界を広げない）
- 運用復旧は service_role / 手動 SQL に限定（収益ゼロ前提の防衛線と整合）

## 却下した案

- **無期限 `pvp_rooms` 保持**: cost high が消えない
- **アーカイブ無し 180d 削除**: data high が消えない
- **旧8引数 save 互換の復活**: 冪等衝突と重複の両高指摘（0018 で fail-closed 済み）
