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

// ── 将棋エンジン(やねうら王 k-p / GPL-3.0) ────────────────────────────
// WHY 別ディレクトリ public/engine-shogi/ か:
//   glue(yaneuraou.k-p.js)は同ディレクトリから worker.js / wasm を _scriptDir で解決する。
//   Stockfish と混ぜず専用ディレクトリに置くことで locateFile の基点が明快になる。
// WHY 3ファイル + LICENSE か（GPL 再配布要件・Stockfish と同型）:
//   実行に必要な js(glue) / wasm(本体) / worker.js(pthread) を配布し、GPL 本文(LICENSE.md)を同梱する。
//   .br/.gz の事前圧縮版はホスティング側(Cloudflare Pages 等)が透過圧縮するので配布不要。
const shogiPkgDir = join(root, 'node_modules', '@mizarjp', 'yaneuraou.k-p');
const shogiLibDir = join(shogiPkgDir, 'lib');
const shogiOutDir = join(root, 'public', 'engine-shogi');
const shogiFiles = [
  [shogiLibDir, 'yaneuraou.k-p.js'],
  [shogiLibDir, 'yaneuraou.k-p.wasm'],
  [shogiLibDir, 'yaneuraou.k-p.worker.js'],
  [shogiPkgDir, 'LICENSE.md'], // GPL-3.0 本文(再配布要件)
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** [元ディレクトリ, ファイル名] のリストを出力ディレクトリへコピーし、コピー数を返す。 */
async function copyAll(fileList, dest, labelForMissing) {
  await mkdir(dest, { recursive: true });
  let copied = 0;
  for (const [dir, name] of fileList) {
    const from = join(dir, name);
    if (!(await exists(from))) {
      console.warn(`[copy-engine] 見つかりません: ${labelForMissing}/${name}`);
      continue;
    }
    await copyFile(from, join(dest, name));
    copied++;
  }
  return copied;
}

async function main() {
  // チェス(Stockfish)
  if (await exists(srcDir)) {
    const n = await copyAll(files, outDir, 'stockfish');
    console.log(`[copy-engine] ${n} ファイルを public/engine/ にコピーしました。`);
  } else {
    console.warn('[copy-engine] stockfish が未インストール。スキップします。');
  }

  // 将棋(やねうら王)。未インストールでもチェス側を止めない（将棋は任意機能）。
  if (await exists(shogiLibDir)) {
    const n = await copyAll(shogiFiles, shogiOutDir, 'yaneuraou.k-p');
    console.log(`[copy-engine] ${n} ファイルを public/engine-shogi/ にコピーしました。`);
  } else {
    console.warn('[copy-engine] yaneuraou.k-p が未インストール。将棋エンジンをスキップします。');
  }
}

main().catch((err) => {
  console.error('[copy-engine] 失敗:', err);
  process.exit(1);
});
