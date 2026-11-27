// 変えたファイルから、流すテストの名前（tests/run.mjs の群と tests/*/run.mjs の部品）を選ぶ。
// tests/all.mjs --changed [比べる元] が使う。比べる元を省いたら、いちばん新しい版のタグ（v*）。
//
// 決まり
// - 下の表で、ファイルの頭が合う行の名前を全部足す。
// - 編集画面（src/editor/・src/editor.um・src/ui/）のファイルは、表で edit2-* の群に 1 つも当たらなければ、
//   edit2-* の群を全部流す（WIDE。配置・状態・コマンドの表・部品の土台のような、どの群にも効く所）。
// - 名前の束（edit2 なら edit2-* の群、m6 なら m6-* の部品）は、それで始まる名前を全部流す。
// - 説明書（docs/・*.md）と CI の設定（.github/）は、何も流さない。
// - 表にないファイルと、多くの所が使う土台（project.um・render.um・src/gen/・plugins/・tools/ など）を
//   変えたときは、全部を流す（null を返す）。見落とすより、流しすぎるほうにする。
// - 作業ツリーのまだコミットしていない変更も入れる。
import { spawnSync } from 'node:child_process';

// [ファイルの頭, 名前...]。上から順に見て、合ったものを全部足す
const MAP = [
  ['src/editor/', 'ui', 'edit2_audio'],
  ['src/editor.um', 'ui'],
  ['src/ui/', 'ui'],
  // 編集画面の中身ごとの群（tests/run.mjs の edit2-*）
  ['src/editor/upd_', 'update'],
  ['src/editor/wire_update.um', 'update'],
  ['src/editor/wup_state.um', 'update'],
  ['src/editor/e2_seqdlg.um', 'edit2-shell'],
  ['src/editor/wsq_state.um', 'edit2-shell'],
  ['src/editor/e2_dpi.um', 'edit2-shell'],
  ['src/editor/e2_dialog.um', 'edit2-files', 'edit2-start', 'edit2-rail', 'edit2-wire'],
  ['src/editor/wdl_state.um', 'edit2-files', 'edit2-start', 'edit2-rail', 'edit2-wire'],
  ['src/editor/e2_drop.um', 'edit2-pool', 'edit2-start', 'media'],
  ['src/editor/e2_macmenu.um', 'edit2-timeline'],
  ['src/editor/e2_scrub.um', 'edit2-timeline', 'edit2-monitor'],
  ['src/editor/e2c_clip.um', 'edit2-timeline', 'edit2-pool', 'edit2-comp', 'edit2-motion'],
  ['src/editor/e2c_edit.um', 'edit2-timeline', 'edit2-pool', 'edit2-comp', 'edit2-motion'],
  ['src/editor/e2c_marker.um', 'edit2-timeline', 'edit2-monitor'],
  ['src/editor/e2c_seq.um', 'edit2-timeline', 'edit2-shell'],
  ['src/editor/e2c_file.um', 'edit2-files', 'edit2-start', 'edit2-pool', 'edit2-wire'],
  ['src/editor/e2c_help.um', 'edit2-timeline'],
  ['src/editor/e2c_view.um', 'edit2-shell', 'edit2-monitor', 'edit2-text', 'edit2-timeline'],
  ['src/editor/wmn_', 'edit2-timeline'],
  ['src/editor/start.um', 'edit2-start', 'edit2-files'],
  ['src/editor/wmisc_keys.um', 'edit2-start'],
  ['src/editor/wmisc_path.um', 'edit2-wire'],
  ['src/editor/rail_ai.um', 'edit2-ai'],
  ['src/editor/wag_state.um', 'edit2-ai'],
  ['src/editor/wire_ai.um', 'edit2-ai'],
  ['src/editor/rail_audio.um', 'edit2-wire'],
  ['src/editor/rail_fx.um', 'edit2-rail'],
  ['src/editor/rail_problems.um', 'edit2-rail'],
  ['src/editor/rail_text', 'edit2-rail', 'edit2-shell'],
  ['src/editor/rail_source.um', 'edit2-text'],
  ['src/editor/wsrc_', 'edit2-text'],
  ['src/editor/rail_frame.um', 'edit2-rail', 'edit2-text', 'edit2-wire', 'edit2-ai'],
  ['src/editor/rail_ui.um', 'edit2-rail', 'edit2-text', 'edit2-wire', 'edit2-ai'],
  ['src/editor/wrl_state.um', 'edit2-rail', 'edit2-text', 'edit2-wire', 'edit2-ai'],
  ['src/editor/rail_settings.um', 'edit2-rail', 'edit2-ai', 'update'],
  ['src/editor/wire_inspector.um', 'edit2-inspector', 'edit2-wire', 'edit2-motion'],
  ['src/editor/wi_state.um', 'edit2-inspector', 'edit2-wire', 'edit2-motion'],
  ['src/editor/wcp_pick.um', 'edit2-inspector'],
  ['src/editor/wire_monitor.um', 'edit2-monitor', 'edit2-motion', 'edit2-comp'],
  ['src/editor/wm_state.um', 'edit2-monitor', 'edit2-motion', 'edit2-comp'],
  ['src/editor/wire_motion.um', 'edit2-motion'],
  ['src/editor/wmo_state.um', 'edit2-motion'],
  ['src/editor/wire_pool.um', 'edit2-pool'],
  ['src/editor/wire_pthumb.um', 'edit2-pool'],
  ['src/editor/wp_', 'edit2-pool'],
  ['src/editor/wpt_state.um', 'edit2-pool'],
  ['src/editor/wire_timeline.um', 'edit2-timeline', 'edit2-motion'],
  ['src/editor/ws_audio.um', 'edit2-shell'],
  ['src/editor/wau_state.um', 'edit2-shell'],
  ['src/editor/ws_color.um', 'ws_color', 'edit2-color', 'edit2-shell', 'edit2-wire'],
  ['src/editor/wcl_state.um', 'ws_color', 'edit2-color', 'edit2-shell', 'edit2-wire'],
  ['src/editor/ws_comp.um', 'edit2-comp', 'edit2-shell'],
  ['src/editor/wcomp_', 'edit2-comp', 'edit2-shell'],
  ['src/editor/ws_export.um', 'ws_export', 'edit2-wire', 'edit2-shell'],
  ['src/editor/wex_state.um', 'ws_export', 'edit2-wire', 'edit2-shell'],
  ['src/ui/kit/', 'uikit'],
  ['src/ui/timeline/', 'edit2-timeline', 'edit2-motion', 'edit2-shell'],
  ['src/ui/monitor/', 'edit2-monitor', 'edit2-motion', 'edit2-shell'],
  ['src/ui/pool/', 'edit2-pool', 'edit2-shell'],
  ['src/ui/inspector/', 'edit2-inspector', 'edit2-wire', 'edit2-motion', 'edit2-shell'],
  ['src/ui/keymap/', 'edit2-timeline'],
  ['src/ui/mixer/', 'edit2_audio', 'edit2-shell'],
  ['src/ui/color/', 'ws_color', 'edit2-color'],
  ['src/ui/export/', 'ws_export', 'edit2-wire'],
  ['src/workspaces/audio/', 'edit2_audio', 'edit2-shell'],
  ['src/workspaces/color/', 'ws_color', 'color', 'edit2-color'],
  ['src/workspaces/export/', 'ws_export', 'renderqueue', 'edit2-wire'],
  ['src/workspaces/motion/', 'ws-motion', 'edit2-motion', 'edit2-comp'],
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

// 編集画面の土台: 上の表で edit2-* の群に当たらなければ、edit2-* の群を全部流す
const WIDE = ['src/editor/', 'src/editor.um', 'src/ui/'];

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
    const add = hit.flatMap(([, ...ns]) => ns);
    if (WIDE.some((pre) => f.startsWith(pre)) && !add.some((n) => n.startsWith('edit2-'))) add.push('edit2');
    for (const n of add) names.add(n);
  }
  // 名前の束（edit2 → edit2-*、m6 → m6-*）を、それで始まる名前に広げる
  for (const n of [...names]) {
    if (known.includes(n)) continue;
    const parts = known.filter((k) => k.startsWith(`${n}-`));
    if (parts.length) {
      names.delete(n);
      for (const k of parts) names.add(k);
    }
  }
  const lost = [...names].filter((n) => !known.includes(n));
  if (lost.length) {
    return { base, files: [...files], names: null, why: `表の名前 ${lost.join(', ')} がテストにない（表を直してください）` };
  }
  return { base, files: [...files], names: [...names].sort(), why: '' };
}
