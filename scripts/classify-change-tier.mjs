#!/usr/bin/env node
// ============================================================================
// classify-change-tier.mjs — git diff から品質ゲート Tier (0|1|2) を判定
// 出力: artifacts/review/tier.json + stdout 要約
// ============================================================================
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'main';

const rules = JSON.parse(readFileSync('scripts/gate-tier-rules.json', 'utf8'));

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

function listChangedFiles() {
  const files = new Set();
  const add = (out) => {
    if (out) for (const f of out.split('\n').filter(Boolean)) files.add(f);
  };
  try {
    add(sh(`git diff --name-only origin/${BASE}...HEAD 2>/dev/null`));
  } catch {
    /* branch may not exist on remote */
  }
  try {
    add(sh(`git diff --name-only ${BASE}...HEAD 2>/dev/null`));
  } catch {
    /* ignore */
  }
  // 未コミット（作業ツリー + index）も Tier 判定に含める
  add(sh('git diff --name-only HEAD 2>/dev/null'));
  add(sh('git diff --name-only --cached 2>/dev/null'));
  add(sh('git ls-files --others --exclude-standard 2>/dev/null'));
  return [...files];
}

function globMatch(file, pattern) {
  // simple ** support
  const re = new RegExp(
    '^' +
      pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<GLOBSTAR>>>/g, '.*') +
      '$',
  );
  return re.test(file);
}

function matchesAny(file, patterns) {
  return patterns.some((p) => globMatch(file, p));
}

const files = listChangedFiles();
if (files.length === 0) {
  const tier = { tier: 0, reason: ['no diff vs base — default tier 0'], files: [], base_ref: BASE };
  mkdirSync('artifacts/review', { recursive: true });
  writeFileSync('artifacts/review/tier.json', JSON.stringify(tier, null, 2) + '\n');
  console.log(JSON.stringify(tier, null, 2));
  process.exit(0);
}

const tier2Hits = [];
const tier1Hits = [];

for (const f of files) {
  if (matchesAny(f, rules.tier2_globs)) tier2Hits.push(f);
  for (const rx of rules.tier2_path_regex ?? []) {
    if (f.includes(rx)) tier2Hits.push(f);
  }
  if (matchesAny(f, rules.tier1_only_globs)) tier1Hits.push(f);
}

let tier;
let reason;
if (tier2Hits.length > 0) {
  tier = 2;
  reason = [`tier2 paths: ${[...new Set(tier2Hits)].join(', ')}`];
} else if (tier1Hits.length > 0 || files.some((f) => f.startsWith('src/'))) {
  tier = 1;
  reason = ['src/ changes without auth/db/edge touch'];
} else if (files.every((f) => matchesAny(f, rules.tier0_globs))) {
  tier = 0;
  reason = ['docs/config only'];
} else {
  tier = 1;
  reason = ['default tier 1 for unclassified changes'];
}

const out = {
  tier,
  reason,
  files,
  base_ref: BASE,
  required_perspectives: tier === 2 ? ['authz', 'cost', 'data'] : tier === 1 ? [] : [],
  required_clear_cycles: tier === 2 ? 2 : 0,
  generated_at: new Date().toISOString(),
};

mkdirSync('artifacts/review', { recursive: true });
writeFileSync('artifacts/review/tier.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
