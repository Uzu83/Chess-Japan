#!/usr/bin/env node
// ============================================================================
// run-quality-gate.mjs — 品質ゲートオーケストレータ
//
// サブコマンド:
//   classify [--base main]     Tier 判定
//   review [--base main]       Tier>=2 なら3観点 Codex を並列起動
//   status                     gate-state 評価
//   help
//
// 前提: `codex` CLI が PATH にあること（Tier 2 review 時）
// ============================================================================
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PERSPECTIVES = [
  { id: 'authz', prompt: '.codex/prompts/post-review-authz.md' },
  { id: 'cost', prompt: '.codex/prompts/post-review-cost.md' },
  { id: 'data', prompt: '.codex/prompts/post-review-data.md' },
];

const cmd = process.argv[2] ?? 'help';
const baseIdx = process.argv.indexOf('--base');
const BASE = baseIdx >= 0 ? process.argv[baseIdx + 1] : 'main';
const modelIdx = process.argv.indexOf('--model');
const MODEL = modelIdx >= 0 ? process.argv[modelIdx + 1] : null;
const RETRIES = 2; // capacity エラー等の一過性失敗に対する再試行回数

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function nextCycleNumber(perspectiveId) {
  const dir = `artifacts/review/perspectives/${perspectiveId}`;
  if (!existsSync(dir)) return 1;
  const nums = readdirSync(dir)
    .map((f) => /^cycle-(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function runCodexPerspective(perspective, cycle, baseRef) {
  return new Promise((resolve, reject) => {
    const outPath = `artifacts/review/perspectives/${perspective.id}/cycle-${cycle}.json`;
    mkdirSync(`artifacts/review/perspectives/${perspective.id}`, { recursive: true });
    const prompt = readFileSync(perspective.prompt, 'utf8');
    // レビュー対象の決定（WHY）: このリポジトリは main 上に未コミットで作業してから
    // PR ブランチを切る運用もあるため、コミット済み差分（origin/base...HEAD）だけ見ると
    // 未コミット/未追跡の変更を取りこぼす。base に対する「コミット済み + 作業ツリー +
    // 未追跡」を対象にするよう Codex に明示する（Codex は read-only sandbox で git 実行可）。
    const fullPrompt =
      `${prompt}\n\n` +
      `## レビュー対象の取得手順（この順で全て見る）\n` +
      `1. コミット済み差分: \`git diff ${baseRef}...HEAD\`\n` +
      `2. 未コミット変更: \`git diff ${baseRef}\`（作業ツリー vs ${baseRef}）\n` +
      `3. 未追跡ファイル: \`git ls-files --others --exclude-standard\` の各ファイルを読む\n` +
      `いずれかが空でも残りは必ず確認すること。差分が全く無い場合のみ findings 空で良い。`;

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-schema',
      '.codex/review-schema.json',
      '--output-last-message',
      outPath,
    ];
    if (MODEL) args.push('--model', MODEL);
    args.push(fullPrompt);

    const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.slice(-300).replace(/\s+/g, ' ').trim();
        reject(new Error(`codex ${perspective.id} exit ${code}: ${tail}`));
        return;
      }
      resolve({ perspective: perspective.id, path: outPath, cycle });
    });
  });
}

async function runWithRetry(perspective, cycle, baseRef) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await runCodexPerspective(perspective, cycle, baseRef);
    } catch (e) {
      lastErr = e;
      const transient = /at capacity|rate limit|timeout|temporarily/i.test(e.message ?? '');
      if (attempt < RETRIES && transient) {
        const waitMs = 3000 * (attempt + 1);
        console.log(
          `  retry ${perspective.id} (attempt ${attempt + 2}/${RETRIES + 1}) after ${waitMs}ms — ${e.message}`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

async function doReview() {
  if (!existsSync('artifacts/review/tier.json')) {
    execSync(`node scripts/classify-change-tier.mjs --base ${BASE}`, { stdio: 'inherit' });
  }
  const tierInfo = JSON.parse(readFileSync('artifacts/review/tier.json', 'utf8'));
  if (tierInfo.tier < 2) {
    console.log(
      `tier=${tierInfo.tier}: parallel Codex not required. Run optional single /review-post.`,
    );
    process.exit(0);
  }

  try {
    sh('codex --version');
  } catch {
    console.error('codex CLI not found. Install or skip review subcommand.');
    process.exit(1);
  }

  const cycle = Math.max(...PERSPECTIVES.map((p) => nextCycleNumber(p.id)));
  console.log(
    `Starting Tier 2 parallel review — cycle ${cycle}, base ${BASE}${MODEL ? `, model ${MODEL}` : ''}`,
  );

  const settled = await Promise.allSettled(PERSPECTIVES.map((p) => runWithRetry(p, cycle, BASE)));
  const failed = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') console.log(`  ok ${s.value.perspective} → ${s.value.path}`);
    else {
      failed.push(PERSPECTIVES[i].id);
      console.error(`  FAIL ${PERSPECTIVES[i].id}: ${s.reason?.message ?? s.reason}`);
    }
  });
  if (failed.length) {
    console.error(
      `\n${failed.length}/${PERSPECTIVES.length} perspectives failed (${failed.join(', ')}). ` +
        `Re-run: node scripts/run-quality-gate.mjs review --base ${BASE}` +
        (MODEL ? '' : ' [--model <slug>]') +
        `\nAll perspectives must complete before a cycle counts (evaluate-gate-state treats missing as non-clean).`,
    );
  }

  // evaluate-gate-state は未合格時に exit 1 を返す（CI ゲート用）。
  // ここでは状態表示が目的なので、その非ゼロ終了でオーケストレータを落とさない。
  try {
    execSync('node scripts/evaluate-gate-state.mjs', { stdio: 'inherit' });
  } catch {
    /* verdict != passed の非ゼロ終了は想定内。gate-state.json に記録済み */
  }
}

function doClassify() {
  execSync(`node scripts/classify-change-tier.mjs --base ${BASE}`, { stdio: 'inherit' });
}

function doStatus() {
  execSync('node scripts/evaluate-gate-state.mjs', { stdio: 'inherit' });
}

function help() {
  console.log(`Usage:
  node scripts/run-quality-gate.mjs classify [--base main]
  node scripts/run-quality-gate.mjs review [--base main]
  node scripts/run-quality-gate.mjs status

See docs/QUALITY_GATE.md`);
}

try {
  if (cmd === 'classify') doClassify();
  else if (cmd === 'review') doReview();
  else if (cmd === 'status') doStatus();
  else help();
} catch (e) {
  console.error(e.message ?? e);
  process.exit(1);
}
