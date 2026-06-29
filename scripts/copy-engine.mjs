// Stockfish(WASM) のエンジンファイルを node_modules から public/engine/ にコピーする。
// 7MB の .wasm を git に入れないため、dev/build 前に実行して同期する(public/engine は gitignore)。
import { mkdir, copyFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', 'stockfish');
const srcDir = join(pkgDir, 'bin');
const outDir = join(root, 'public', 'engine');

// 既定: lite single-threaded(高速・COOP/COEP 不要で最も堅牢)
// [元ディレクトリ, ファイル名]
const files = [
  [srcDir, 'stockfish-18-lite-single.js'],
  [srcDir, 'stockfish-18-lite-single.wasm'],
  [pkgDir, 'Copying.txt'], // GPLv3 ライセンス本文を同梱(再配布要件)
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(srcDir))) {
    console.warn('[copy-engine] stockfish が未インストール。スキップします。');
    return;
  }
  await mkdir(outDir, { recursive: true });
  let copied = 0;
  for (const [dir, name] of files) {
    const from = join(dir, name);
    if (!(await exists(from))) {
      console.warn(`[copy-engine] 見つかりません: ${name}`);
      continue;
    }
    await copyFile(from, join(outDir, name));
    copied++;
  }
  console.log(`[copy-engine] ${copied} ファイルを public/engine/ にコピーしました。`);
}

main().catch((err) => {
  console.error('[copy-engine] 失敗:', err);
  process.exit(1);
});
