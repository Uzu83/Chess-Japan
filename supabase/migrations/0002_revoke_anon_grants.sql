-- 多層防御(defense in depth): RLS(default deny)に加え、テーブルレベルの GRANT も anon/authenticated から剥奪する。
-- なぜ二重にするか: Supabase は public スキーマの全テーブルに anon/authenticated への GRANT を既定付与する。
--   RLS だけで守る設計でも、将来うっかり許可ポリシーを足すと grant 経由で露出しうる。
--   grant 自体を消しておけば、ポリシー誤追加があっても anon/authenticated は構文上アクセスできない。
-- これらの内部テーブルは Edge Function の service_role からのみ触る前提なので、anon/authenticated の権限は不要。
revoke all on table public.explain_cache from anon, authenticated;
revoke all on table public.rate_counters from anon, authenticated;
-- service_role には引き続き全権限(既定)があり、RLS もバイパスするため Edge Function は問題なく動作する。
