/*
 * strengthAggregator.ts — 対局全体の得意/苦手分析(純関数・LLM不使用)
 *
 * WHY LLM を使わず集計だけで作るか:
 *   「得意/苦手」の素材(quality・phase・tags)は既に決定論的に確定済み(classify.ts /
 *   phase.ts / playstyle.ts)。ここでの仕事は単純な頻度・平均の集計であり、LLM を
 *   挟むと非決定論・レイテンシ・コストが乗るだけ。日本語の短い説明文もテンプレート
 *   合成(TAG_LABEL_JA)で済ませ、自然文の生成自体は解説パネル側(explain/client.ts)の
 *   役割に残す(責務分離)。
 */

import type { MoveQuality } from './types';
import type { GamePhase } from './phase';
import type { PlaystyleTag } from './playstyle';

export interface AnalyzedPly {
  ply: number;
  color: 'w' | 'b';
  isUserMove: boolean;
  quality: MoveQuality;
  phase: GamePhase;
  tags: PlaystyleTag[];
  evalBefore?: number;
  evalAfter?: number;
}

export interface PhaseStats {
  moveCount: number;
  blunderRate: number;
  accuracyScore: number;
}

export interface TagStat {
  tag: PlaystyleTag;
  count: number;
  successRate: number;
  kind: 'strength' | 'weakness' | 'neutral';
}

export interface StrengthReport {
  userMoveCount: number;
  qualityCounts: Record<MoveQuality, number>;
  blunderRate: number;
  accuracyScore: number;
  byPhase: Record<GamePhase, PhaseStats>;
  tagStats: TagStat[];
  strengths: string[];
  weaknesses: string[];
}

/** quality → 簡易採点(0-100)。best/good に高得点、blunder は 0。 */
const QUALITY_SCORE: Record<MoveQuality, number> = {
  best: 100,
  good: 80,
  inaccuracy: 50,
  mistake: 20,
  blunder: 0,
};

const PHASES: GamePhase[] = ['opening', 'middlegame', 'endgame'];

/**
 * タグを strength/weakness と判定するための閾値。
 *
 * WHY count(頻度)を先に見るか: 1〜2回しか出ていないタグの successRate は
 * ノイズが大きく(1回失敗しただけで 0%)、「苦手」と結論づけるには根拠が薄い。
 * 「頻度高」の最低ラインとして 2 回以上の出現を要求する(仕様「頻度高+成功率」の
 * “頻度高”をこの固定閾値で具体化)。
 */
const MIN_TAG_COUNT_FOR_SIGNAL = 2;
/** この成功率以上で strength。 */
const STRENGTH_SUCCESS_RATE = 0.6;
/** この成功率以下で weakness。 */
const WEAKNESS_SUCCESS_RATE = 0.4;

const TAG_LABEL_JA: Record<PlaystyleTag, string> = {
  castle: '早めの入城(キャスリング)による玉の安全確保',
  exchange: '駒交換の見極め',
  sacrifice: '駒を捨てて攻める手筋',
  fork: 'フォーク(両取り)',
  pin: 'ピン(釘付け)の活用',
  skewer: 'スキュア(串刺し)の活用',
  pawn_break: 'ポーンブレイク(歩の突き崩し)',
  endgame_technique: '終盤の技術',
  drop: '駒打ちの判断',
  promotion: '成りの判断',
  fork_like: '両取り筋の活用',
  entering_king: '入玉の判断',
  defense: '受け(防御)',
};

function emptyQualityCounts(): Record<MoveQuality, number> {
  return { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
}

function isSuccess(quality: MoveQuality): boolean {
  return quality === 'best' || quality === 'good';
}

/** blunderRate/accuracyScore を 1 群のplyから計算する(空なら 0 で安全側)。 */
function statsOf(plies: AnalyzedPly[]): {
  moveCount: number;
  blunderRate: number;
  accuracyScore: number;
} {
  const moveCount = plies.length;
  if (moveCount === 0) return { moveCount: 0, blunderRate: 0, accuracyScore: 0 };
  const blunders = plies.filter((p) => p.quality === 'blunder').length;
  const totalScore = plies.reduce((sum, p) => sum + QUALITY_SCORE[p.quality], 0);
  return {
    moveCount,
    blunderRate: blunders / moveCount,
    accuracyScore: totalScore / moveCount,
  };
}

function classifyTagKind(count: number, successRate: number): TagStat['kind'] {
  if (count < MIN_TAG_COUNT_FOR_SIGNAL) return 'neutral';
  if (successRate >= STRENGTH_SUCCESS_RATE) return 'strength';
  if (successRate <= WEAKNESS_SUCCESS_RATE) return 'weakness';
  return 'neutral';
}

/** タグごとの出現数と成功率(quality が best/good だった割合)を集計する。 */
function buildTagStats(plies: AnalyzedPly[]): TagStat[] {
  const counts = new Map<PlaystyleTag, { count: number; successes: number }>();
  for (const p of plies) {
    for (const tag of p.tags) {
      const entry = counts.get(tag) ?? { count: 0, successes: 0 };
      entry.count++;
      if (isSuccess(p.quality)) entry.successes++;
      counts.set(tag, entry);
    }
  }
  const stats: TagStat[] = [];
  for (const [tag, { count, successes }] of counts) {
    const successRate = count > 0 ? successes / count : 0;
    stats.push({ tag, count, successRate, kind: classifyTagKind(count, successRate) });
  }
  // 頻出タグを先頭に(結果の安定した並び順・テスト容易性のため)。
  stats.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return stats;
}

/** 得意/苦手分析レポートを組み立てる(isUserMove のみ集計対象)。 */
export function aggregateStrength(plies: AnalyzedPly[]): StrengthReport {
  const userPlies = plies.filter((p) => p.isUserMove);

  const qualityCounts = emptyQualityCounts();
  for (const p of userPlies) qualityCounts[p.quality]++;

  const overall = statsOf(userPlies);

  const byPhase = PHASES.reduce(
    (acc, phase) => {
      acc[phase] = statsOf(userPlies.filter((p) => p.phase === phase));
      return acc;
    },
    {} as Record<GamePhase, PhaseStats>,
  );

  const tagStats = buildTagStats(userPlies);
  const strengths = tagStats
    .filter((t) => t.kind === 'strength')
    .map((t) => `${TAG_LABEL_JA[t.tag]}が得意です`);
  const weaknesses = tagStats
    .filter((t) => t.kind === 'weakness')
    .map((t) => `${TAG_LABEL_JA[t.tag]}が苦手です`);

  return {
    userMoveCount: userPlies.length,
    qualityCounts,
    blunderRate: overall.blunderRate,
    accuracyScore: overall.accuracyScore,
    byPhase,
    tagStats,
    strengths,
    weaknesses,
  };
}
