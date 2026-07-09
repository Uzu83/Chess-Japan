import { useMemo, useId, useState } from 'react';
import type { ExplanationContext, GameKind, MoveRecord } from '../core/types';
import { normalizeEvalToWhiteCp, GRAPH_CLAMP_CP, formatEvalCp } from '../core/evalUtils';
import { qualityLabelJa } from '../core/classify';

/*
 * EvalGraph — 評価グラフ
 *
 * 全手の評価推移を折れ線/エリアで描画する。
 * 重いチャートライブラリ不使用 — 素の SVG で実装。
 *
 * 強化点(2025-07以降):
 *   - ホバーでツールチップ: 手数・評価値・手の質を表示（マウスのみ。キーボード利用者へは
 *     外包 div の role="img"+aria-label でグラフ全体の要約を代替提供する。reviewer L-3 で
 *     「フォーカスで表示」という当初コメントが実装と乖離していたため訂正）。
 *     マウス位置を fraction (0..1) で保持し CSS % で tooltip を配置。右端近く(fraction > 0.65)では左へ反転。
 *   - 詰み終端の修正: エンジンが詰み局面(合法手なし)で cp:0 を返すと
 *     グラフが中央に戻る問題を修正。最終 ply が false-zero の場合は
 *     evalBefore(指す前の優位)を代わりに使ってグラフを端に張り付かせる。
 *     既知の偽陽性(reviewer L-1): ステイルメイト(引分=0.0)も終局で cp:0 を返すため、直前が大優勢だと
 *     「優勢側の勝ち」に誤って張り付く。厳密化するには game 側から checkmate/stalemate 種別を渡す必要がある(将来)。
 *   - 現在手マーカー強化: ドットに白ストロークリングを追加して視認性向上。
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

/** ツールチップのホバー状態。 */
interface TooltipState {
  /** カーソルの SVG 幅に対する割合(0..1)。CSS % で tooltip を配置するのに使う。 */
  fraction: number;
  /** カーソルの SVG 高さに対する割合(0..1)。tooltip の上端位置に使う。 */
  yFraction: number;
  ply: number;
  whiteCp: number;
  quality: ExplanationContext['quality'];
}

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
  /** ゲーム種別。ツールチップの手番ラベル（チェス=白/黒 / 将棋=先手/後手）に使う。既定 chess で従来挙動。 */
  game?: GameKind;
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

export function EvalGraph({
  moves,
  contexts,
  currentIndex,
  onSeek,
  game = 'chess',
}: EvalGraphProps) {
  // 手番ラベル: チェス=白/黒、将棋=先手/後手（tooltip とグラフ aria-label で共用）。
  const firstLabel = game === 'shogi' ? '先手' : '白';
  const secondLabel = game === 'shogi' ? '後手' : '黒';
  // useId で一意な ID を生成 → 複数インスタンスでの clipPath ID 衝突を防ぐ
  const uid = useId();
  const clipTop = `${uid}-top`;
  const clipBot = `${uid}-bot`;

  // ── ツールチップ状態 ──────────────────────────────────────
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const total = moves.length;

  // 解析済みのデータ点を ply 昇順で構築。
  // whiteCp = 描画座標用にクランプ(±GRAPH_CLAMP_CP)した白視点 cp。
  // whiteCpRaw = ツールチップ表示用の生の白視点 cp（クランプしない＝詰み値 ±99999 や大きな評価を保持）。
  // WHY 2 値を持つか（Codex ゲート② F001）: 以前は tooltip もクランプ済み whiteCp を表示していたため、
  //   詰み(99999)が +M でなく +10.0/+1000、大きな将棋評価(2500)が +1000 に化けていた（将棋の生値化で顕在化）。
  //   座標はクランプが必要だが表示は生値であるべきなので分離する。
  const points = useMemo(() => {
    const pts: { ply: number; whiteCp: number; whiteCpRaw: number }[] = [];
    for (let ply = 0; ply < total; ply++) {
      const ctx = contexts[ply];
      // evalAfter が未定義(解析なし)はスキップ
      if (ctx?.evalAfter !== undefined) {
        let whiteCp = normalizeEvalToWhiteCp(ctx.evalAfter, moves[ply].color);
        // 生値（クランプなし）。normalizeEvalToWhiteCp と同じ符号変換だがクランプしない。
        let whiteCpRaw = moves[ply].color === 'w' ? ctx.evalAfter : -ctx.evalAfter;

        // ── 詰み終端の false-zero 修正 ──────────────────────
        // 問題: エンジンが詰み後の局面(合法手なし)を解析すると cp:0 を返すことがあり、
        //       グラフの最終点が中央(互角)に戻ってしまう見た目上の誤りが生じる。
        // 修正: 最終 ply だけを対象に、whiteCp が 0 かつ evalBefore が
        //       大きな優勢を示している場合は evalBefore の符号で端に張り付かせる。
        //
        // WHY evalBefore > 800 の閾値:
        //   通常の終盤では 800cp の優位は滅多にない(ほぼ詰み・駒大損の局面のみ)。
        //   この閾値を超えているならエンジンの false-zero と判断して安全。
        const isLastPly = ply === total - 1;
        if (
          isLastPly &&
          whiteCp === 0 &&
          ctx.evalBefore !== undefined &&
          Math.abs(ctx.evalBefore) > 800
        ) {
          // evalBefore は「指したプレイヤー視点」なので白視点に変換。座標はクランプ、tooltip は生値。
          const evalBeforeWhite = moves[ply].color === 'w' ? ctx.evalBefore : -ctx.evalBefore;
          whiteCp = Math.max(-GRAPH_CLAMP_CP, Math.min(GRAPH_CLAMP_CP, evalBeforeWhite));
          whiteCpRaw = evalBeforeWhite;
        }

        pts.push({ ply, whiteCp, whiteCpRaw });
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

  // ── SVGイベントハンドラ ──────────────────────────────────

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

  // マウス移動 → 最近傍解析点のツールチップを表示
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const yFraction = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    // 割合から ply を推定
    const targetPly = Math.round(fraction * (total - 1));

    // 最近傍の解析済み点を探す
    const nearest = points.reduce((a, b) =>
      Math.abs(a.ply - targetPly) <= Math.abs(b.ply - targetPly) ? a : b,
    );

    setTooltip({
      fraction,
      yFraction,
      ply: nearest.ply,
      // tooltip のラベルは生値を表示（クランプ済 whiteCp だと詰み +M や大評価が化ける・F001）。
      whiteCp: nearest.whiteCpRaw,
      quality: contexts[nearest.ply]?.quality,
    });
  };

  const handleMouseLeave = () => setTooltip(null);

  // ── ツールチップのコンテンツ ────────────────────────────────
  // 手番号: 1始まり(e.g. ply=3 → "2...d5 (黒)")
  const tooltipContent = tooltip
    ? {
        // 手番ラベルは color で正確に判定（ply%2 は custom 開始局面で崩れる）。first=white=先手。
        moveLabel: `${Math.floor(tooltip.ply / 2) + 1}${tooltip.ply % 2 === 1 ? '...' : '.'} ${moves[tooltip.ply]?.san ?? ''} (${
          moves[tooltip.ply]?.color === 'b' ? secondLabel : firstLabel
        })`,
        evalLabel: formatEvalCp(tooltip.whiteCp, game),
        qualityLabel: tooltip.quality ? qualityLabelJa(tooltip.quality) : null,
      }
    : null;

  return (
    <div
      role="img"
      aria-label={`評価グラフ: ${analyzedCount}/${total}手解析済み。上が${firstLabel}優勢・中央が互角・下が${secondLabel}優勢。グラフをクリックするとその手へジャンプします。`}
      className="relative"
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
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

        {/* 現在手のドット
            WHY 白ストロークリング:
              ダーク/ライト両モードで点がグラフ線と紛れないよう白ハロを付ける。
              r=2.5 + strokeWidth=1 = 実効半径 3.5 程度で十分に視認できる。 */}
        {currentX !== null && currentY !== null && (
          <>
            {/* 外側リング(白) — 背景に溶け込まないためのコントラスト補助 */}
            <circle
              cx={currentX}
              cy={currentY}
              r="3"
              fill="white"
              fillOpacity="0.6"
              aria-hidden="true"
            />
            {/* 内側ドット(マーカー色) */}
            <circle cx={currentX} cy={currentY} r="2" style={{ fill: 'var(--graph-marker)' }} />
          </>
        )}
      </svg>

      {/* ── ツールチップ ──────────────────────────────────────
          pointer-events-none でマウスイベントを素通しにし、SVG の onMouseMove を妨げない。
          fraction に基づく % 位置で配置。右寄り(fraction > 0.65)なら translateX(-100%) で
          tooltip 本体を左に反転させ右端からの overflow を回避する。              */}
      {tooltip && tooltipContent && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 w-28 rounded border border-border bg-surface px-2 py-1 text-[10px] shadow-md"
          style={{
            left: `${tooltip.fraction * 100}%`,
            // 上端への過剰な重なりを避けるため yFraction で調整
            top: tooltip.yFraction < 0.5 ? '50%' : '0%',
            transform: tooltip.fraction > 0.65 ? 'translateX(-100%)' : 'translateX(6px)',
          }}
        >
          {/* 手表記: "2. Nf3 (白)" */}
          <div className="truncate font-mono font-medium text-on-surface">
            {tooltipContent.moveLabel}
          </div>
          {/* 評価値 · 手の質 */}
          <div className="mt-0.5 text-muted">
            {tooltipContent.evalLabel}
            {tooltipContent.qualityLabel && (
              <span className="text-subtle"> · {tooltipContent.qualityLabel}</span>
            )}
          </div>
        </div>
      )}

      {/* 未解析ラベル: 何も解析されていなければ中央に案内テキスト */}
      {analyzedCount === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-subtle">
          解析すると評価推移が表示されます
        </p>
      )}
    </div>
  );
}
