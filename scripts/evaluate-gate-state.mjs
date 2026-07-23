#!/usr/bin/env node
// ============================================================================
// evaluate-gate-state.mjs — 連続クリーンサイクル・ファール・合格判定
// 入力: artifacts/review/perspectives/*/cycle-*.json
//       artifacts/review/review-adjudication.json (任意)
//       artifacts/review/tier.json (任意)
// 出力: artifacts/review/gate-state.json
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';

const REQUIRED = ['authz', 'cost', 'data'];
const REQUIRED_CLEAR = 2;
const MAX_CYCLES = 3;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function countHighCritical(review) {
  return (review.findings ?? []).filter((f) => f.severity === 'high' || f.severity === 'critical')
    .length;
}

function loadPerspectiveCycles() {
  const byCycle = new Map();
  for (const id of REQUIRED) {
    const dir = `artifacts/review/perspectives/${id}`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^cycle-(\d+)\.json$/.exec(f);
      if (!m) continue;
      const n = Number(m[1]);
      if (!byCycle.has(n)) byCycle.set(n, {});
      byCycle.get(n)[id] = readJson(`${dir}/${f}`);
    }
  }
  return byCycle;
}

const tier = existsSync('artifacts/review/tier.json')
  ? readJson('artifacts/review/tier.json')
  : { tier: 0, required_clear_cycles: 0 };

if (tier.tier < 2) {
  const state = {
    verdict: 'not_required',
    tier: tier.tier,
    message: 'Tier < 2: parallel consensus gate not required',
    generated_at: new Date().toISOString(),
  };
  mkdirSync('artifacts/review', { recursive: true });
  writeFileSync('artifacts/review/gate-state.json', JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify(state, null, 2));
  process.exit(0);
}

const adjudication = existsSync('artifacts/review/review-adjudication.json')
  ? readJson('artifacts/review/review-adjudication.json')
  : null;

const byCycle = loadPerspectiveCycles();
const cycleNumbers = [...byCycle.keys()].sort((a, b) => a - b);

let totalFouls = 0;
const suspiciousRejectIds = new Set();
const cycleSummaries = [];

for (const n of cycleNumbers) {
  const perspectives = byCycle.get(n);
  const missing = REQUIRED.filter((id) => !perspectives[id]);
  let rawHighCritical = 0;
  const perPerspective = {};
  for (const id of REQUIRED) {
    const review = perspectives[id];
    if (!review) continue;
    const hc = countHighCritical(review);
    rawHighCritical += hc;
    perPerspective[id] = { raw_high_critical: hc, findings: (review.findings ?? []).length };
  }

  const acceptCount = adjudication
    ? (adjudication.items ?? []).filter((i) => i.status === 'accept').length
    : 0;

  let fouls = 0;
  if (adjudication) {
    for (const item of adjudication.items ?? []) {
      if (item.status !== 'reject') continue;
      const sev = item.severity ?? '';
      if (sev === 'high' || sev === 'critical' || /high|critical/i.test(item.reason ?? '')) {
        fouls += 1;
        if (item.prior_reject) suspiciousRejectIds.add(item.id);
      }
    }
  }
  totalFouls += fouls;

  const clear = missing.length === 0 && rawHighCritical === 0 && acceptCount === 0;

  cycleSummaries.push({
    cycle: n,
    missing_perspectives: missing,
    raw_high_critical: rawHighCritical,
    accept_open: acceptCount,
    fouls,
    clear,
  });
}

let consecutiveClear = 0;
for (let i = cycleSummaries.length - 1; i >= 0; i--) {
  if (cycleSummaries[i].clear) consecutiveClear += 1;
  else break;
}

let verdict = 'in_progress';
let message = '';

if (cycleNumbers.length === 0) {
  verdict = 'in_progress';
  message = 'No perspective reviews yet. Run: node scripts/run-quality-gate.mjs review';
} else if (consecutiveClear >= REQUIRED_CLEAR) {
  verdict = 'passed';
  message = `${REQUIRED_CLEAR} consecutive clean cycles achieved`;
} else if (cycleNumbers.length >= MAX_CYCLES && consecutiveClear < REQUIRED_CLEAR) {
  verdict = 'human_required';
  message = `Max ${MAX_CYCLES} cycles without ${REQUIRED_CLEAR} consecutive clean`;
} else if (suspiciousRejectIds.size > 0) {
  verdict = 'human_required';
  message = 'Same high/critical finding rejected in multiple cycles — human adjudication';
} else {
  verdict = 'in_progress';
  message = `Need ${REQUIRED_CLEAR} consecutive clean cycles (have ${consecutiveClear})`;
}

const state = {
  generated_at: new Date().toISOString(),
  tier: tier.tier,
  required_clear_cycles: REQUIRED_CLEAR,
  max_cycles: MAX_CYCLES,
  consecutive_clear_cycles: consecutiveClear,
  total_fouls: totalFouls,
  cycles: cycleSummaries,
  verdict,
  message,
};

mkdirSync('artifacts/review', { recursive: true });
writeFileSync('artifacts/review/gate-state.json', JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify(state, null, 2));
process.exit(verdict === 'passed' ? 0 : verdict === 'not_required' ? 0 : 1);
