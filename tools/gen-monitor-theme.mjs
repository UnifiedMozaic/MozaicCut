// モニターの部品のテーマ（src/gen/monitor_theme.um）を docs/design/tokens.json から作る。
//
//   node tools/gen-monitor-theme.mjs [--check] [tokens.json] [出力]
//
// 既定の入力は docs/design/tokens.json、出力は src/gen/monitor_theme.um。
//   --check  書かずに、いまの出力が tokens.json と合っているかだけ確かめる（違えば終了コード 1）。tests/ui が流す。
//
// tokens.json の値を、モニターが使う名前（MonTheme の欄）に写すだけ。値は書き換えない。
// tokens.json にまだない値（再生の帯の高さなど）は EXTRA に置き、出力にも「tokens にない」と書く。
// 実行時に tokens.json を読み直すときは、生成した monThemeFromTokens（道筋の対応は同じ表から作る monThemeSetPath）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const checkOnly = process.argv.includes("--check");
const pos = process.argv.slice(2).filter((a) => a !== "--check");
const src = pos[0] ?? join(root, "docs/design/tokens.json");
const out = pos[1] ?? join(root, "src/gen/monitor_theme.um");
const tok = JSON.parse(readFileSync(src, "utf8"));

// [MonTheme の欄, tokens.json の道筋]
export const COLORS = [
  ["bg1", "color.dark.bg.1"],
  ["bg2", "color.dark.bg.2"],
  ["bg3", "color.dark.bg.3"],
  ["bg4", "color.dark.bg.4"],
  ["bgViewer", "color.dark.bg.viewer"],
  ["bgPopover", "color.dark.bg.popover"],
  ["viewerBlack", "color.dark.viewerChoices.black"],
  ["viewerMidGray", "color.dark.viewerChoices.midGray"],
  ["viewerUi", "color.dark.viewerChoices.ui"],
  ["line", "color.dark.line.default"],
  ["lineStrong", "color.dark.line.strong"],
  ["lineControl", "color.dark.line.control"],
  ["text1", "color.dark.text.1"],
  ["text2", "color.dark.text.2"],
  ["text3", "color.dark.text.3"],
  ["textDis", "color.dark.text.disabled"],
  ["textOnDark", "color.dark.text.onDark"],
  ["textOnRipple", "color.dark.text.onRipple"],
  ["textOnOverwrite", "color.dark.text.onOverwrite"],
  ["accent", "color.dark.accent.default"],
  ["accentHover", "color.dark.accent.hover"],
  ["playhead", "color.dark.semantic.playhead"],
  ["playheadEdge", "color.dark.semantic.playheadEdge"],
  ["ripple", "color.dark.semantic.ripple"],
  ["rippleTint", "color.dark.semantic.rippleTint"],
  ["overwrite", "color.dark.semantic.overwrite"],
  ["overwriteTint", "color.dark.semantic.overwriteTint"],
  ["ok", "color.dark.semantic.ok"],
  ["warn", "color.dark.semantic.warn"],
  ["error", "color.dark.semantic.error"],
  ["inOut", "color.dark.semantic.inOut"],
  ["focusOuter", "color.dark.semantic.focusOuter"],
  ["kVideo", "color.dark.clip.video.mark"],
  ["kAudio", "color.dark.clip.audio.mark"],
  ["kText", "color.dark.clip.text.mark"],
  ["kImage", "color.dark.clip.image.mark"],
  ["kColor", "color.dark.clip.color.mark"],
];

export const SIZES = [
  ["panelHeader", "size.panelHeader"],
  ["btnSm", "size.button.sm"],
  ["iconBtnSm", "size.iconButton.sm"],
  ["iconBtnMd", "size.iconButton.md"],
  ["iconSm", "size.icon.sm"],
  ["hitMin", "size.hitTargetMin"],
  ["sp1", "space.1"],
  ["sp2", "space.2"],
  ["sp3", "space.3"],
  ["sp4", "space.4"],
  ["radiusSm", "radius.sm"],
  ["radiusMd", "radius.md"],
  ["hairline", "border.hairline"],
  ["focusW", "border.focus"],
  ["fsXs", "font.size.xs.size"],
  ["fsSm", "font.size.sm.size"],
  ["fsMd", "font.size.md.size"],
  ["fsTcM", "font.size.tcM.size"],
];

// tokens.json にまだない値（ui.md とモックアップ edit.html の CSS から。tokens.json に足すことを報告に書く）
export const EXTRA_COLORS = [
  ["ovlBg", "#0000008C", "重ねる表示の地（edit.html の .ovl の rgba(0,0,0,.55)）"],
  ["guide", "#FFFFFF59", "安全領域・グリッドの線（ui.md 9 章「無彩色」。白 35%）"],
  ["kbdEdgeBtn", "#00000040", "ボタンの中のキーの札の縁（edit.html の .btn .kbd の rgba(0,0,0,.25)）"],
];
export const EXTRA_SIZES = [
  ["transportH", 40, "再生の帯の高さ（ui.md 9 章）"],
  ["scrubH", 4, "スクラブの帯の高さ（edit.html の .scrub。ui.md 9 章は 6）"],
  ["iconXs", 12, "山形などの小さなアイコン（edit.html の .ic.sm）"],
  ["chipH", 20, "札の高さ（edit.html の .chip）"],
  ["kbdH", 18, "キーの札の高さ（edit.html の .kbd）"],
  ["tcW", 130, "再生の帯の時刻の欄の幅（edit.html の .transport .tc）"],
  ["sepH", 20, "縦の区切りの線の高さ（edit.html の .sep-v）"],
  ["ovlPadX", 6, "重ねる表示の札の左右の余白（edit.html の .ovl）"],
  ["ovlPadY", 2, "重ねる表示の札の上下の余白（edit.html の .ovl）"],
  ["tabMaxW", 280, "見出しのタブの文字の最大の幅（「ソース: 素材名」を省く幅）"],
  ["menuW", 220, "重ねる表示のメニューの幅"],
  ["chipPadX", 7, "札の左右の余白（edit.html の .chip）"],
  ["kbdPadX", 5, "キーの札の左右の余白（edit.html の .kbd の padding 0 5px。縁の線は別）"],
  ["kbdGap", 6, "ボタンの文字とキーの札の間（edit.html の .btn の gap）"],
  ["kbdOpacity", 0.8, "ボタンの中のキーの札の不透明度（edit.html の .btn .kbd の opacity）"],
  ["headerPadR", 6, "見出しの帯の右の余白（edit.html の .vhead の padding-right）"],
  ["popupGap", 2, "札・ボタンとその下に開くメニューの間"],
];

function get(path) {
  let v = tok;
  for (const k of path.split(".")) {
    if (v == null || !(k in v)) throw new Error(`tokens.json に ${path} がありません`);
    v = v[k];
  }
  return v;
}

function argb(hex) {
  const h = hex.replace("#", "");
  const rgb = h.slice(0, 6).toUpperCase();
  const a = h.length === 8 ? h.slice(6, 8).toUpperCase() : "FF";
  return `0x${a}${rgb}`;
}

let s = "";
s += "// 生成したファイル。手で直さない。元は docs/design/tokens.json（node tools/gen-monitor-theme.mjs で作り直す）。\n";
s += `// tokens.json の version ${tok.version}。\n`;
s += 'import { MonTheme, monClampScale, monTokensFlatten } from "../ui/monitor/theme.um";\n\n';
s += "// tokens.json の既定の値（倍率 1.0）でテーマを作る。scale は UI の倍率。\n";
s += "export function monThemeTokens(scale: f32): MonTheme {\n";
s += "  let t: MonTheme = {\n";
s += "    scale: 1.0,\n";
for (const [k, p] of COLORS) s += `    ${k}: ${argb(get(p))}, // ${p}\n`;
for (const [k, v, note] of EXTRA_COLORS) s += `    ${k}: ${argb(v)}, // tokens にない: ${note}\n`;
s += "    // 大きさ（倍率を掛ける前の論理 px）\n";
for (const [k, p] of SIZES) s += `    ${k}: ${Number(get(p)).toFixed(1)}, // ${p}\n`;
for (const [k, v, note] of EXTRA_SIZES) s += `    ${k}: ${Number(v).toFixed(1)}, // tokens にない: ${note}\n`;
s += "  };\n";
s += "  t.scale = monClampScale(scale);\n";
s += "  return t;\n";
s += "}\n\n";
s += "// tokens.json の道筋（\"color.dark.bg.viewer\" など）で 1 つの値を入れる。モニターが使わない道筋なら false。\n";
s += "export function monThemeSetPath(t: mut MonTheme, path: string, color: u32, num: f32, isColor: bool): bool {\n";
s += "  if (isColor) {\n";
s += "    switch (path) {\n";
for (const [k, p] of COLORS) s += `      case "${p}": t.${k} = color; return true;\n`;
s += "    }\n";
s += "    return false;\n";
s += "  }\n";
s += "  switch (path) {\n";
for (const [k, p] of SIZES) s += `    case "${p}": t.${k} = num; return true;\n`;
s += "  }\n";
s += "  return false;\n";
s += "}\n\n";
s += "// tokens.json（の中身）を読み直して t に入れる。入れた値の数を返す。\n";
s += "export function monThemeFromTokens(t: mut MonTheme, json: string): i32 {\n";
s += "  let n = 0;\n";
s += "  for (const v of monTokensFlatten(json)) {\n";
s += "    if (monThemeSetPath(mut t, v.path, v.color, v.num, v.isColor)) {\n";
s += "      n++;\n";
s += "    }\n";
s += "  }\n";
s += "  return n;\n";
s += "}\n";
const old = existsSync(out) ? readFileSync(out, "utf8") : null;
if (checkOnly) {
  if (old !== s) {
    console.error(`${relative(root, out)} が tokens.json と合っていません。node tools/gen-monitor-theme.mjs で作り直してください。`);
    process.exit(1);
  }
  console.log(`${relative(root, out)} は tokens.json と合っています。`);
} else {
  writeFileSync(out, s);
  console.log(`書きました: ${relative(root, out)}`);
}
