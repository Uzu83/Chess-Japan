import { describe, it, expect } from 'vitest';
import { buildConfig } from './ShogiBoard';

/*
 * ShogiBoard の shogiground 設定の回帰テスト。
 *
 * WHY（2026-07-08 本番で発覚した見た目バグの再発防止）:
 *   shogiground のデフォルトは scaleDownPieces:true（公式サンプルが駒スプライトを 2マス幅で
 *   用意し scale(0.5) で 1マスに収める前提）。本プロジェクトの shogiBoard.css は駒を 1マス幅
 *   (width:11.111%)の漢字グリフで描くため、true のままだと駒が半分サイズ＋translate 半分刻みで
 *   盤の左上 1/4 に凝縮される。棋譜/手番などの「状態」は正常なので状態検証だけでは気づけず、
 *   getBoundingClientRect の実測で判明した。ここは設定値を固定して、誰かが scaleDownPieces を
 *   消したり true に戻したら CI で落とす（jsdom はレイアウト非計算なので描画自体はテスト不能）。
 *   対局盤 ShogiPlayBoard.tsx も同じ不変条件を持つ（config は component 内 closure のため本テストの
 *   対象外だが、同ファイルの厚いコメントと実ブラウザ E2E で担保）。
 */

const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

describe('ShogiBoard buildConfig（見た目バグ回帰ガード）', () => {
  it('scaleDownPieces は必ず false（デフォルト true では駒が半サイズで凝縮する）', () => {
    const cfg = buildConfig({ sfen: START_SFEN });
    expect(cfg.scaleDownPieces).toBe(false);
  });

  it('閲覧盤は座標を無効化する（自前 CSS が座標配置を持たないため）', () => {
    const cfg = buildConfig({ sfen: START_SFEN });
    expect(cfg.coordinates?.enabled).toBe(false);
  });

  it('orientation を渡さなければ先手下（white 相当）になる', () => {
    const cfg = buildConfig({ sfen: START_SFEN });
    expect(cfg.orientation).toBe('sente');
  });
});
