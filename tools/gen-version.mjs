// アプリの版（src/gen/version.um）を作る。編集画面の「MozaicCut について」と、自動更新が今の版を知るのに使う。
//
//   node tools/gen-version.mjs [--check] [出力]
//
// 既定の出力は src/gen/version.um。版は次の順に決める（resolveVersion）。
//   1. 環境変数 MOZCUT_VERSION（1.2.3 か 1.2.3-rc.1。CI はタグ v1.2.3 から v を除いて渡す）
//   2. `git describe --tags` が vX.Y.Z ちょうど（タグの付いたコミットそのもの）なら X.Y.Z
//   3. 既定の DEFAULT_VERSION
// コミット（MOZCUT_COMMIT）は環境変数 MOZCUT_COMMIT、なければ GITHUB_SHA の先頭 7 文字、なければ空。
// 手元では空なので、コミットごとにファイルが変わってビルドし直しになることはない。
// 中身が同じなら書かない（mtime が変わらないので、エンジンと編集画面を作り直さない）。
// リポジトリに入れておくのは既定の版（環境変数なし・タグなし）で作ったもの。
//   --check  書かずに、いまの出力が、そこに書かれた版とコミットから作り直したものと同じかだけ確かめる（違えば終了コード 1）。
//            版は環境やタグで変わるので、環境からは比べない（タグのコミットで手元でビルドしても落ちない）。tests/ui が流す。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export const DEFAULT_VERSION = '0.2.0';
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const COMMIT_RE = /^[0-9a-f]{0,40}$/;

// 版を決める。環境変数の値がおかしければ例外。
export function resolveVersion(env = process.env, cwd = root) {
  if (env.MOZCUT_VERSION) {
    if (!VERSION_RE.test(env.MOZCUT_VERSION)) throw new Error(`MOZCUT_VERSION が 1.2.3 の形ではありません: ${env.MOZCUT_VERSION}`);
    return env.MOZCUT_VERSION;
  }
  const r = spawnSync('git', ['describe', '--tags'], { cwd, encoding: 'utf8' });
  const m = r.status === 0 ? /^v(\d+\.\d+\.\d+)$/.exec(r.stdout.trim()) : null;
  return m ? m[1] : DEFAULT_VERSION;
}

export function resolveCommit(env = process.env) {
  const c = (env.MOZCUT_COMMIT || (env.GITHUB_SHA || '').slice(0, 7)).toLowerCase();
  if (!COMMIT_RE.test(c)) throw new Error(`MOZCUT_COMMIT が 16 進のコミットではありません: ${c}`);
  return c;
}

export function versionSource(version, commit) {
  return [
    '// 生成したファイル。手で直さない。node tools/gen-version.mjs が作る（ビルドのたびに作り直す）。',
    '// 版は MOZCUT_VERSION、なければ git describe --tags の vX.Y.Z、なければ既定。リポジトリには既定の版を入れておく。',
    '',
    '// アプリの版（1.2.3 の形）。GitHub Releases のタグ v1.2.3 と同じ',
    `export const MOZCUT_VERSION: string = ${JSON.stringify(version)};`,
    '// 作ったコミット（16 進の先頭 7 文字）。CI のときだけ入り、手元のビルドでは空',
    `export const MOZCUT_COMMIT: string = ${JSON.stringify(commit)};`,
    '',
  ].join('\n');
}

// 書いたものから版とコミットを読む（--check 用）。読めなければ null
export function parseVersionSource(text) {
  const v = /export const MOZCUT_VERSION: string = "([^"]*)";/.exec(text);
  const c = /export const MOZCUT_COMMIT: string = "([^"]*)";/.exec(text);
  return v && c ? { version: v[1], commit: c[1] } : null;
}

// out を作る（中身が同じなら書かない）。書いたら true
export function generateVersion(out = join(root, 'src/gen/version.um'), env = process.env) {
  const text = versionSource(resolveVersion(env), resolveCommit(env));
  if (existsSync(out) && readFileSync(out, 'utf8') === text) return false;
  writeFileSync(out, text);
  return true;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes('--check');
  const pos = process.argv.slice(2).filter((a) => a !== '--check');
  const out = pos[0] ?? join(root, 'src/gen/version.um');
  const rel = relative(root, out).replaceAll('\\', '/');
  try {
    if (checkOnly) {
      const cur = existsSync(out) ? readFileSync(out, 'utf8') : '';
      const p = parseVersionSource(cur);
      if (!p || !VERSION_RE.test(p.version) || !COMMIT_RE.test(p.commit) || versionSource(p.version, p.commit) !== cur) {
        console.error(`${rel} が gen-version.mjs の出力の形ではありません。node tools/gen-version.mjs で作り直してください`);
        process.exit(1);
      }
      console.log(`${rel} は生成器の出力と同じです（版 ${p.version}）`);
    } else {
      const wrote = generateVersion(out);
      const p = parseVersionSource(readFileSync(out, 'utf8'));
      console.log(`${rel}: 版 ${p.version}${p.commit ? `（${p.commit}）` : ''}${wrote ? ' を書きました' : '（変わりなし）'}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
