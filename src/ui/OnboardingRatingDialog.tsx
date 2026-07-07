/*
 * OnboardingRatingDialog.tsx — 初回サインイン時の初期レート設定(1回だけ)
 *
 * 表示条件は親(App)が判定: signedIn かつ profile.rating_initialized === false。
 * 確定/スキップで submitInitialRating(RPC) → rating_initialized=true になり
 * 以後二度と出ない(サーバー側 set_initial_rating の「未初期化のみ」門と対応)。
 *
 * 選択肢の構成(Codex ゲート①合意の決定3・4):
 *   - ローカルレートがあれば「引き継ぐ」を第一選択肢に(決定4)
 *   - 自己申告プリセット 初心者1200/中級1500/上級1800(決定3)
 *   - 数値直接入力(chess.com / lichess のレートを想定)
 *   - スキップ = default 1200
 * プリセット値は自己申告のアンカーであり、AI 難度の目安 Elo(800-2800)とは独立。
 * chess.com(≈800始まり)と lichess(≈1500始まり)のスケール差は補足文のみで
 * 換算はしない(必要十分 — 内部レートは対AI戦の飾りで厳密性より摩擦の低さ優先)。
 */
import { useState } from 'react';
import { decideMigrationOffer } from '../auth/localMigration';
import type { RatingSource } from '../auth/profile';
import { loadRating } from '../core/storage';
import { RATING_CEILING, RATING_FLOOR } from '../core/rating';

interface Props {
  /** 確定/スキップ時に呼ぶ(AuthContext.submitInitialRating を渡す)。 */
  onSubmit: (rating: number, source: RatingSource) => Promise<void>;
}

/** 自己申告プリセット。value はサーバーの check 範囲 [100,3000] 内であること。 */
const PRESETS: { label: string; note: string; value: number; source: RatingSource }[] = [
  { label: '初心者', note: 'ルールを覚えたて〜', value: 1200, source: 'self_beginner' },
  { label: '中級者', note: '定跡や戦術を学習中', value: 1500, source: 'self_intermediate' },
  { label: '上級者', note: '大会・レート戦の経験あり', value: 1800, source: 'self_advanced' },
];

export function OnboardingRatingDialog({ onSubmit }: Props) {
  // ローカルレートの移行提案(純関数)。マウント時に1回だけ評価すれば十分。
  const [offer] = useState(() => decideMigrationOffer(loadRating()));
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (rating: number, source: RatingSource) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(rating, source);
      // 成功すると親の profile.rating_initialized が true になり自然にアンマウントされる
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const customValue = Number(custom);
  const customValid =
    custom.trim() !== '' &&
    Number.isFinite(customValue) &&
    customValue >= RATING_FLOOR &&
    customValue <= RATING_CEILING;

  return (
    /* PlayBoard の成りピッカーと同じモーダルイディオム(バックドロップ + role=dialog)。
       ただしバックドロップクリックで閉じない: 初期レートは決めてもらう必要があり、
       「知らないうちに閉じて二度と出ない」より「スキップを明示」の方が事故が少ない。 */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="初期レートの設定"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <div>
          <h2 className="text-base font-semibold text-ai">あなたの実力は？</h2>
          <p className="mt-1 text-xs text-muted">
            内部レートの初期値を決めます(あとからレート戦の結果で上下します)。
          </p>
        </div>

        {/* ローカルレートの引き継ぎ(あれば第一選択肢) */}
        {offer.kind === 'migrate' && (
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={() => submit(offer.clampedRating, 'local_migrated')}
            className="focus-ai rounded-xl border border-ai bg-ai-bg px-4 py-3 text-left transition-colors hover:bg-ai hover:text-white disabled:opacity-50"
          >
            <span className="block text-sm font-semibold">
              この端末のレート {offer.localRating} を引き継ぐ
            </span>
            <span className="block text-xs opacity-80">
              これまでのレート戦 {offer.games} 局の結果を反映
            </span>
          </button>
        )}

        {/* 自己申告プリセット */}
        <div className="flex flex-col gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.source}
              type="button"
              autoFocus={offer.kind !== 'migrate' && p.source === 'self_beginner'}
              disabled={busy}
              onClick={() => submit(p.value, p.source)}
              className="focus-ai flex items-baseline justify-between rounded-xl border border-border bg-surface-2 px-4 py-3 text-left transition-colors hover:border-ai hover:bg-ai-bg disabled:opacity-50"
            >
              <span className="text-sm font-medium text-on-surface">
                {p.label}
                <span className="ml-2 text-xs text-muted">{p.note}</span>
              </span>
              <span className="text-xs text-muted">~{p.value}</span>
            </button>
          ))}
        </div>

        {/* 数値直接入力 */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="custom-rating" className="text-xs text-muted">
            chess.com / lichess などのレートがあれば直接入力({RATING_FLOOR}〜{RATING_CEILING})
          </label>
          <div className="flex gap-2">
            <input
              id="custom-rating"
              type="number"
              inputMode="numeric"
              min={RATING_FLOOR}
              max={RATING_CEILING}
              value={custom}
              disabled={busy}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="例: 1350"
              className="focus-ai min-h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-on-surface"
            />
            <button
              type="button"
              disabled={busy || !customValid}
              onClick={() => submit(Math.round(customValue), 'self_custom')}
              className="focus-ai min-h-11 shrink-0 rounded-xl bg-ai px-4 text-sm font-semibold text-white shadow-btn hover:bg-ai-hover disabled:cursor-not-allowed disabled:opacity-50 dark:bg-ai-dim dark:hover:bg-ai"
            >
              決定
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            設定に失敗しました: {error} — 通信環境を確認して再度お試しください。
          </p>
        )}

        {/* スキップ = default 1200。毎ログインで再表示しない(サーバー側で初期化済み扱い) */}
        <button
          type="button"
          disabled={busy}
          onClick={() => submit(1200, 'default')}
          className="focus-ai min-h-9 self-center rounded px-3 py-1 text-xs text-muted transition-colors hover:text-on-surface disabled:opacity-50"
        >
          スキップ(1200 で始める)
        </button>
      </div>
    </div>
  );
}
