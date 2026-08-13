import { describe, it, expect } from 'vitest';
import {
  buildShogiReviewConfig,
  buildShogiPlayConfig,
  SHOGIGROUND_VISUAL_INVARIANTS,
} from './shogigroundConfig';

/*
 * 将棋盤の shogiground 設定の回帰テスト（閲覧盤 ShogiBoard・対局盤 ShogiPlayBoard の両方）。
 *
 * WHY（2026-07-08 本番で発覚した見た目バグの再発防止 / Codex ゲート②合意）:
 *   shogiground のデフォルトは scaleDownPieces:true（公式サンプルが駒スプライトを 2マス幅で
 *   用意し scale(0.5) で 1マスに収める前提）。本プロジェクトの shogiBoard.css は駒を 1マス幅
 *   (width:11.111%)の漢字グリフで描くため、true のままだと駒が半分サイズ＋translate 半分刻みで
 *   盤の左上 1/4 に凝縮される。棋譜/手番などの「状態」は正常なので状態検証だけでは気づけず、
 *   getBoundingClientRect の実測で判明した。
 *   Phase 4-1 では両盤とも scaleDownPieces を付け忘れて出荷したため、片方だけでなく **両盤**の
 *   設定値を CI で固定する（jsdom はレイアウト非計算なので描画自体はテスト不能。設定値の回帰だけ守る）。
 */

const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

describe('将棋盤 見た目バグ回帰ガード', () => {
  describe('共有不変条件 SHOGIGROUND_VISUAL_INVARIANTS', () => {
    it('scaleDownPieces は false（デフォルト true では駒が半サイズで凝縮する）', () => {
      expect(SHOGIGROUND_VISUAL_INVARIANTS.scaleDownPieces).toBe(false);
    });
    it('coordinates は無効（自前 CSS が座標配置を持たず、有効だと盤左上に積み上がる）', () => {
      expect(SHOGIGROUND_VISUAL_INVARIANTS.coordinates.enabled).toBe(false);
    });
  });

  describe('閲覧盤 buildShogiReviewConfig', () => {
    it('共有不変条件を反映する（scaleDownPieces:false / coordinates 無効）', () => {
      const cfg = buildShogiReviewConfig({ sfen: START_SFEN });
      expect(cfg.scaleDownPieces).toBe(false);
      expect(cfg.coordinates?.enabled).toBe(false);
    });
    it('orientation 省略時は先手下（sente）', () => {
      expect(buildShogiReviewConfig({ sfen: START_SFEN }).orientation).toBe('sente');
    });
  });

  describe('対局盤 buildShogiPlayConfig', () => {
    const params = {
      sfen: START_SFEN,
      orientation: 'sente' as const,
      turnColor: 'sente' as const,
      inCheck: false,
      lastMoveUsi: null,
      legalDests: new Map<string, string[]>(),
      dropDests: new Map<string, string[]>(),
      movable: true,
      withEvents: false,
      onMoveAfter: () => {},
      onDropAfter: () => {},
    };

    it('共有不変条件を反映する（scaleDownPieces:false / coordinates 無効）', () => {
      const cfg = buildShogiPlayConfig(params);
      expect(cfg.scaleDownPieces).toBe(false);
      expect(cfg.coordinates?.enabled).toBe(false);
    });

    /*
     * 2026-08-13 の「駒が空振りする」修正の回帰ガード。
     * ドラッグを戻すと (1) shogiground 0.10.3 の translateAbs バグでゴーストが固定表示され、
     * (2) 押した瞬間のドラッグ扱い + 1マス跨ぎで選択が取り消される（空振り）に戻る。
     * 上流が直るまで false を維持する。理由の全文は shogigroundConfig.ts のコメント。
     */
    it('ドラッグは無効（タップ選択のみ。上流のドラッグ表示バグと空振りを避ける）', () => {
      expect(buildShogiPlayConfig(params).draggable?.enabled).toBe(false);
    });

    it('選択と行き先表示は有効（CSS の .selected / .dest が出る前提）', () => {
      const cfg = buildShogiPlayConfig(params);
      expect(cfg.selectable?.enabled).toBe(true);
      expect(cfg.movable?.showDests).toBe(true);
      expect(cfg.droppable?.showDests).toBe(true);
    });

    it('movable=false のとき activeColor を外して盤をロックする', () => {
      expect(buildShogiPlayConfig({ ...params, movable: false }).activeColor).toBeUndefined();
      expect(buildShogiPlayConfig({ ...params, movable: true }).activeColor).toBe('sente');
    });

    it('withEvents=true のときだけ着手/打ちの events.after が付く', () => {
      expect(
        buildShogiPlayConfig({ ...params, withEvents: false }).movable?.events,
      ).toBeUndefined();
      expect(
        buildShogiPlayConfig({ ...params, withEvents: true }).movable?.events?.after,
      ).toBeTypeOf('function');
    });
  });
});
