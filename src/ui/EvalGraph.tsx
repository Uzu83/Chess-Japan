import { useMemo, useId } from 'react';
import type { ExplanationContext, MoveRecord } from '../core/types';
import { normalizeEvalToWhiteCp, GRAPH_CLAMP_CP } from '../core/evalUtils';

/*
 * EvalGraph — 評価グラフ
 *
 * 全手の評価推移を折れ線/エリアで描画する。
 * 重いチャートライブラリ不使用 — 素の SVG で実装。
 *
 * ── 座標系 ──────────────────────────────────────────────────
 *   viewBox: 0 0 200 50
 *   Y軸: y=0(上端) = 白優勢 +GRAPH_CLAMP_CP
 *         y=25(中央) = 互角 0
 *         y=50(下端) = 黒優勢 -GRAPH_CLAMP_CP
 *   X軸: ply 0 = 左端 / ply N-1 = 右端
 *
 * ── 描画手順 ─────────────────────────────────────────────────
 *   1. エリアパス(中央ライン ↔ 評価線で囲む領域)を clipPath で
 *      上半分(白優勢)と下半分(黒優勢)に分けて異なる色で塗る
 *   2. 評価折れ線(polyline)を上に重ねる
 *   3. 現在手の縦マーカー(dashed)＋ドットを最前面に描く
 *
 * ── a11y ────────────────────────────────────────────────────
 *   - 外包 div に role="img" + aria-label でグラフの内容を代替テキスト提供
 *   - SVG 要素自体は aria-hidden="true"(代替は外包 div が担う)
 *   - クリックで局面ジャンプ (cursor-pointer)
 *
 * ── 色 ───────────────────────────────────────────────────────
 *   index.css の --graph-* CSS 変数を SVG の style 属性から参照。
 *   これにより Tailwind ユーティリティが届かない SVG 内でも
 *   ライト/ダーク自動切替が機能する。
 *
 * ── clipPath ID ──────────────────────────────────────────────
 *   useId() で生成した一意 ID を使うため、同一ページに複数 EvalGraph が
 *   マウントされても clipPath の衝突が起きない。
 *   (現状アプリでは1インスタンスのみだが、将来の安全性のため)
 */

/** SVG viewBox の幅(単位は SVG ユーザー座標)。 */
const VB_W = 200;
/** SVG viewBox の高さ。 */
const VB_H = 50;
/** 互角ライン(y=0 cp)の Y 座標。 */
const MID = VB_H / 2; // 25

interface EvalGraphProps {
  moves: MoveRecord[];
  /** 解析済みコンテキスト。キー=ply(0始まり)。 */
  contexts: Record<number, ExplanationContext>;
  /**
   * 現在表示中の手番インデックス。
   * 0 = 開始局面、k = k 手目を指した直後。
   */
  currentIndex: number;
  /**
   * グラフをクリックしたときの局面ジャンプコールバック。
   * 引数は currentIndex 相当(ply + 1)。
   */
  onSeek: (index: number) => void;
}

/** ply → SVG X座標。total=1 のとき中央に配置(0除算を避ける)。 */
function plyToX(ply: number, total: number): number {
  if (total <= 1) return VB_W / 2;
  return (ply / (total - 1)) * VB_W;
}

/** 白視点 cp → SVG Y座標。正の値(白優勢)は上に行く(y が小さい)。 */
function cpToY(cp: number): number {
  return MID - (cp / GRAPH_CLAMP_CP) * MID;
}

export function EvalGraph({ moves, contexts, currentIndex, onSeek }: EvalGraphProps) {
  // useId で一意な ID を生成 → 複数インスタンスでの clipPath ID 衝突を防ぐ
  const uid = useId();
  const clipTop = `${uid}-top`;
  const clipBot = `${uid}-bot`;

  const total = moves.length;

  // 解析済みのデータ点を ply 昇順で構築
  const points = useMemo(() => {
    const pts: { ply: number; whiteCp: number }[] = [];
    for (let ply = 0; ply < total; ply++) {
      const ctx = contexts[ply];
      // evalAfter が未定義(解析なし)はスキップ
      if (ctx?.evalAfter !== undefined) {
        pts.push({
          ply,
          whiteCp: normalizeEvalToWhiteCp(ctx.evalAfter, moves[ply].color),
        });
      }
    }
    return pts;
  }, [contexts, moves, total]);

  // polyline の points 属性文字列 "x1,y1 x2,y2 ..."
  const polylinePoints = useMemo(
    () =>
      points
        .map((p) => `${plyToX(p.ply, total).toFixed(2)},${cpToY(p.whiteCp).toFixed(2)}`)
        .join(' '),
    [points, total],
  );

  /*
   * エリアパス: 最初のデータ点の x 位置から中央ラインを起点に
   *   → 各評価値を辿る → 最後の点から再び中央ラインへ → 閉じる
   *
   * この閉じた多角形を clipPath で上半分/下半分に切り取ることで
   * 白優勢エリアと黒優勢エリアを別色で描画する。
   *
   * WHY 中央から始めるか: 左端(x=0)から始めると、解析が ply=0 からでない場合に
   * 左余白の塗りが意図しない場所から始まる。データのある範囲だけ塗るのが自然。
   */
  const areaPath = useMemo(() => {
    if (points.length === 0) return '';
    const first = points[0];
    const last = points[points.length - 1];
    const segments = points
      .map((p) => `L ${plyToX(p.ply, total).toFixed(2)},${cpToY(p.whiteCp).toFixed(2)}`)
      .join(' ');
    return [
      `M ${plyToX(first.ply, total).toFixed(2)},${MID}`, // 中央ラインから開始
      segments, // 評価線を辿る
      `L ${plyToX(last.ply, total).toFixed(2)},${MID}`, // 中央ラインへ戻る
      'Z', // 閉じる
    ].join(' ');
  }, [points, total]);

  // 現在手のマーカー計算
  const currentPly = currentIndex - 1;
  const currentX = currentPly >= 0 && currentPly < total ? plyToX(currentPly, total) : null;
  const currentCtx = currentPly >= 0 ? contexts[currentPly] : undefined;
  const currentY =
    currentCtx?.evalAfter !== undefined && currentX !== null
      ? cpToY(normalizeEvalToWhiteCp(currentCtx.evalAfter, moves[currentPly]?.color ?? 'w'))
      : null;

  const analyzedCount = points.length;

  // 手が1つもない場合は非表示
  if (total === 0) return null;

  // SVGクリック → ply を推定して局面ジャンプ
  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    // クリックX座標を [0,1] に正規化 → ply に変換
    const relX = (e.clientX - rect.left) / rect.width;
    const ply = Math.round(relX * (total - 1));
    // index は ply + 1 (index=0 は開始局面)
    onSeek(Math.max(0, Math.min(total - 1, ply)) + 1);
  };

  return (
    <div
      role="img"
      aria-label={`評価グラフ: ${analyzedCount}/${total}手解析済み。上が白優勢・中央が互角・下が黒優勢。グラフをクリックするとその手へジャンプします。`}
      className="relative"
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        onClick={handleClick}
        className="block w-full cursor-pointer"
        style={{ height: '72px' }}
        aria-hidden="true"
      >
        <defs>
          {/* 上半分クリップ: 中央より上を切り出す(白優勢エリア) */}
          <clipPath id={clipTop}>
            <rect x="0" y="0" width={VB_W} height={MID} />
          </clipPath>
          {/* 下半分クリップ: 中央より下を切り出す(黒優勢エリア) */}
          <clipPath id={clipBot}>
            <rect x="0" y={MID} width={VB_W} height={MID} />
          </clipPath>
        </defs>

        {/*
         * グラフ背景: 未解析エリアの区別のため薄い地色
         * (現時点は省略して CSS の bg-surface-2 に任せる)
         */}

        {/* 白優勢エリア — 評価パスを上半分で切り抜いて塗る */}
        {areaPath && (
          <path
            d={areaPath}
            style={{ fill: 'var(--graph-white-fill)' }}
            clipPath={`url(#${clipTop})`}
          />
        )}

        {/* 黒優勢エリア — 同じパスを下半分で切り抜いて塗る */}
        {areaPath && (
          <path
            d={areaPath}
            style={{ fill: 'var(--graph-black-fill)' }}
            clipPath={`url(#${clipBot})`}
          />
        )}

        {/* 互角ライン(y=25) — 両優勢の境界を細線で示す */}
        <line
          x1="0"
          y1={MID}
          x2={VB_W}
          y2={MID}
          style={{ stroke: 'var(--graph-zero)' }}
          strokeWidth="0.4"
        />

        {/* 評価折れ線 — 2点以上あれば描画 */}
        {points.length >= 2 && (
          <polyline
            points={polylinePoints}
            fill="none"
            style={{ stroke: 'var(--graph-line)' }}
            strokeWidth="1.2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* 現在手の縦マーカー(破線) */}
        {currentX !== null && (
          <line
            x1={currentX}
            y1="0"
            x2={currentX}
            y2={VB_H}
            style={{ stroke: 'var(--graph-marker)' }}
            strokeWidth="0.7"
            strokeDasharray="2,1.5"
          />
        )}

        {/* 現在手のドット — 評価値が分かる手のみ表示 */}
        {currentX !== null && currentY !== null && (
          <circle cx={currentX} cy={currentY} r="2" style={{ fill: 'var(--graph-marker)' }} />
        )}
      </svg>

      {/* 未解析ラベル: 何も解析されていなければ中央に案内テキスト */}
      {analyzedCount === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-subtle">
          解析すると評価推移が表示されます
        </p>
      )}
    </div>
  );
}
