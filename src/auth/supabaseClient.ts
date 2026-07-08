/*
 * supabaseClient.ts — supabase-js の遅延シングルトン(auth 専用の入口)
 *
 * ============================================================================
 * 【このプロジェクトでの supabase-js の位置づけ — 未来の担当者へ】
 * Edge Function(explain) の呼び出しは src/explain/client.ts の raw fetch のまま。
 * supabase-js を使うのは「認証まわりだけ」(PKCE / セッション永続化 / 自動リフレッシュ /
 * onAuthStateChange の自作は誤実装＝セキュリティ事故のもと、が Codex ゲート①合意)。
 * explain 経路まで supabase-js に寄せ直さないこと(不要な結合を増やすだけ)。
 *
 * 【バンドル戦略 — 実測前提】
 * supabase-js full client は gzip 約53KB。静的 import するとメインチャンク(約330KB
 * gzip106KB)が肥大するため、動的 import + 遅延シングルトンにする。
 * SDK を読むのは次のときだけ:
 *   - ユーザーがログイン操作をした
 *   - localStorage に既存セッション(sb-*-auth-token)がある
 *   - OAuth リダイレクト直後(URL に ?code= がある)
 * = 未ログインの通りすがり(多数派)は 1 バイトも余計に読まない。
 *
 * 【feature flag: VITE_AUTH_ENABLED】
 * Google OAuth はダッシュボード設定(Supabase の provider 有効化 + Google Cloud の
 * OAuth クライアント)が済むまで動かない。設定前の本番に「押すと壊れるログイン
 * ボタン」を出さないための明示フラグ。'1' のときだけ auth UI が現れる。
 * WHY env 存在チェックでなく '1' 比較か: URL/anon key は explain 機能と共用なので
 * 「設定されている=auth も準備できた」とは言えない。auth の準備完了は独立に宣言させる。
 * ============================================================================
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/*
 * env は「呼び出し時に」読む(モジュールトップで捕獲しない)。
 * WHY: src/explain/client.ts で、トップレベル const に捕獲すると vi.stubEnv が効かず
 * .env.local の有無でテスト結果が変わる事故が実際に起きた(その教訓の踏襲)。
 */
function supabaseUrl(): string | undefined {
  return import.meta.env.VITE_SUPABASE_URL;
}
function supabaseAnon(): string | undefined {
  return import.meta.env.VITE_SUPABASE_ANON_KEY;
}

/** auth 機能一式(ログインボタン等)を有効にするか。3条件すべて必要。 */
export function isAuthConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnon() && import.meta.env.VITE_AUTH_ENABLED === '1');
}

/**
 * ブラウザに supabase-js のセッションが永続化されているか(SDK を読まずに判定)。
 * supabase-js は localStorage キー `sb-<project-ref>-auth-token` にセッションを置く。
 * WHY キー prefix 走査か: 正確なキー名は project-ref 依存で、SDK を import しないと
 * 確実には組めない。「sb- で始まり -auth-token で終わる」で十分に特定できる。
 * WHY window.localStorage でなく素の localStorage 参照か: jsdom(about:blank)では
 * window.localStorage がアクセス不可のことがあり、テストは stubGlobal で差し替える
 * (storage.ts / storage.test.ts と同じ流儀)。
 */
export function hasStoredSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) return true;
    }
  } catch {
    // localStorage 不可(プライベートモード等)は「セッション無し」に倒す
  }
  return false;
}

/**
 * OAuth リダイレクト直後か(PKCE の ?code= が URL に付いている)。
 * このときは SDK を必ず初期化して detectSessionInUrl にコード交換させる必要がある。
 */
export function isOAuthCallback(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('code');
  } catch {
    return false;
  }
}

/*
 * 遅延シングルトン。Promise を保持する WHY: 同時に複数箇所から呼ばれても
 * createClient が一度しか走らないように(2重クライアントは onAuthStateChange の
 * 二重発火・ストレージ競合のもと)。
 */
let clientPromise: Promise<SupabaseClient> | null = null;

/** supabase-js を動的 import してシングルトンを返す。isAuthConfigured() 前提。 */
export function getSupabase(): Promise<SupabaseClient> {
  if (!clientPromise) {
    const url = supabaseUrl();
    const anon = supabaseAnon();
    if (!url || !anon) {
      return Promise.reject(new Error('auth is not configured'));
    }
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(url, anon, {
        auth: {
          // PKCE: SPA の OAuth はこれ一択(implicit は非推奨)。
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          // リダイレクト帰着時に URL の ?code= を自動でセッションに交換する。
          detectSessionInUrl: true,
        },
      }),
    );
    // 失敗したら次回リトライできるように捨てる(ネットワーク一時故障を恒久化しない)
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}
