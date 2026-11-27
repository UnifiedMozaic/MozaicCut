// 変えたファイルから、流すテストの名前（tests/run.mjs の群と tests/*/run.mjs の部品）を選ぶ。
// tests/all.mjs --changed [比べる元] が使う。比べる元を省いたら、いちばん新しい版のタグ（v*）。
//
// 決まり
// - 下の表で、ファイルの頭が合う行の名前を全部足す。
// - 説明書（docs/・*.md）と CI の設定（.github/）は、何も流さない。
// - 表にないファイルと、多くの所が使う土台（project.um・render.um・src/gen/・plugins/・tools/ など）を
//   変えたときは、全部を流す（null を返す）。見落とすより、流しすぎるほうにする。
// - 作業ツリーのまだコミットしていない変更も入れる。
import { spawnSync } from 'node:child_process';

// [ファイルの頭, 名前...]。上から順に見て、合ったものを全部足す
const MAP = [
  ['src/editor/upd_', 'update', 'ui'],
  ['src/editor/', 'edit2', 'ui', 'edit2_audio'],
  ['src/editor.um', 'edit2', 'ui'],
  ['src/ui/kit/', 'uikit', 'edit2', 'ui'],
  ['src/ui/mixer/', 'edit2_audio', 'edit2'],
  ['src/ui/color/', 'ws_color', 'edit2'],
  ['src/ui/export/', 'ws_export', 'edit2'],
  ['src/ui/', 'edit2', 'ui'],
  ['src/workspaces/audio/', 'edit2_audio', 'edit2'],
  ['src/workspaces/color/', 'ws_color', 'color', 'edit2'],
  ['src/workspaces/export/', 'ws_export', 'renderqueue', 'edit2'],
  ['src/workspaces/motion/', 'ws-motion', 'edit2'],
  ['src/engine/audioplay.um', 'play', 'edit2'],
  ['src/engine/playback.um', 'play', 'edit2'],
  ['src/engine/audio.um', 'dsp', 'play', 'golden', 'edit2_audio'],
  ['src/engine/audiomix/', 'dsp', 'play', 'edit2_audio'],
  ['src/engine/audioreact.um', 'dsp', 'golden'],
  ['src/engine/ops.um', 'ops', 'edit2'],
  ['src/engine/report.um', 'report'],
  ['src/engine/keymap.um', 'ui', 'edit2'],
  ['src/engine/keys.um', 'ui', 'edit2'],
  ['src/engine/i18n.um', 'ui', 'edit2'],
  ['src/engine/lineedit.um', 'uikit', 'edit2'],
  ['src/engine/mcp.um', 'mcp'],
  ['src/engine/presets.um', 'presets'],
  ['src/engine/renderqueue.um', 'renderqueue'],
  ['src/engine/subtitle.um', 'subtitle'],
  ['src/engine/transcribe.um', 'edit2'],
  ['src/engine/media.um', 'media', 'golden'],
  ['src/engine/ffmpeg', 'media', 'golden'],
  ['src/engine/encode.um', 'media', 'golden'],
  ['src/engine/aiguide.um', 'ai'],
  ['src/ai/', 'ai'],
  ['src/azmain.um', 'analyze'],
  ['src/effects/analyze/', 'analyze'],
  ['src/effects/dsp/', 'dsp'],
  ['src/effects/color/', 'color', 'fx', 'golden'],
  ['src/effects/anim/', 'm6-anim', 'm6'],
  ['src/effects/blend/', 'm6-blend', 'm6'],
  ['src/effects/expr/', 'm6-expr', 'm6'],
  ['src/effects/particles/', 'm6-particles', 'm6'],
  ['src/effects/shape/', 'm6-shape', 'm6'],
  ['src/effects/text/', 'm6-textanim', 'fx', 'golden'],
  ['src/effects/textanim/', 'm6-textanim', 'm6'],
  ['src/effects/threed/', 'm6-threed', 'm6'],
  ['src/effects/track/', 'm6-track', 'm6'],
  ['src/effects/xform/', 'm6-xform', 'm6'],
  ['src/main.um', 'cli', 'diag'],
];

// 流さなくてよいもの
// （src/gen/version.um はビルドのたびに書き換わる版の番号。tests/ の直下の all.mjs・changed.mjs・parallel.mjs は
// テストを流す道具で、製品は変わらない。tests/run.mjs はテストの中身なので、ここには入れない）
const SKIP = [
  /^docs\//, /\.md$/, /^\.github\//, /^demo\//, /^src\/gen\/version\.um$/,
  /^tests\/(all|changed|parallel)\.mjs$/,
];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} が失敗しました\n${r.stderr}`);
  }
  return r.stdout;
}

// base（省いたら最新の v* タグ）からの変更で流す名前の一覧。全部を流すなら null。
// known はあり得る名前（表の名前が群・部品から消えていたら、全部を流す）。
export function changedNames(root, base, known) {
  if (!base) {
    base = git(['describe', '--tags', '--abbrev=0', '--match', 'v*'], root).trim();
  }
  const files = new Set();
  for (const l of git(['diff', '--name-only', base], root).split('\n')) {
    if (l.trim()) files.add(l.trim());
  }
  for (const l of git(['ls-files', '--others', '--exclude-standard'], root).split('\n')) {
    if (l.trim()) files.add(l.trim());
  }
  const names = new Set();
  for (const f of [...files].sort()) {
    if (SKIP.some((re) => re.test(f))) continue;
    // tests/<部品>/ の中はその部品
    const m = /^tests\/([^/]+)\//.exec(f);
    if (m && known.includes(m[1])) {
      names.add(m[1]);
      continue;
    }
    const hit = MAP.filter(([pre]) => f.startsWith(pre));
    if (hit.length === 0) {
      return { base, files: [...files], names: null, why: `${f} は表にない（または土台の）ファイル` };
    }
    for (const [, ...ns] of hit) {
      for (const n of ns) names.add(n);
    }
  }
  const lost = [...names].filter((n) => !known.includes(n));
  if (lost.length) {
    return { base, files: [...files], names: null, why: `表の名前 ${lost.join(', ')} がテストにない（表を直してください）` };
  }
  return { base, files: [...files], names: [...names].sort(), why: '' };
}
