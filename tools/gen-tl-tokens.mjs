// タイムラインの部品が使うトークンの定数（src/gen/tl_tokens.um）を docs/design/tokens.json から作る。
//
//   node tools/gen-tl-tokens.mjs [--check] [tokens.json] [出力]
//
// 既定の入力は docs/design/tokens.json、出力は src/gen/tl_tokens.um。
// tokens.json の値が変わったら、これを流し直す（手で tl_tokens.um を直さない）。
//   --check  書かずに、いまの出力が tokens.json と合っているかだけ確かめる（違えば終了コード 1）。tests/ui が流す。
// 色は color.dark の下のすべての葉（"#RRGGBB" / "#RRGGBBAA" → 0xAARRGGBB）、
// 数は size / space / radius / border / opacity / pattern / motion.duration / font.size（の size と lineHeight）/ z の葉。
// フィールドの名前は、キーの道筋をキャメルケースでつないだもの（color.dark.semantic.playhead → semanticPlayhead、
// size.trackHeight.small → sizeTrackHeightSmall、font.size.tcL.size → fontTcL）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const checkOnly = process.argv.includes("--check");
const pos = process.argv.slice(2).filter((a) => a !== "--check");
const input = pos[0] || resolve(root, "docs/design/tokens.json");
const output = pos[1] || resolve(root, "src/gen/tl_tokens.um");
const tok = JSON.parse(readFileSync(input, "utf8"));

const cap = (s) => s.length ? s[0].toUpperCase() + s.slice(1) : s;
const camel = (parts) => parts.map((p, i) => (i == 0 ? p : cap(p))).join("").replace(/[^A-Za-z0-9_]/g, "_");

function hexToArgb(s) {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(s);
  if (!m) return null;
  const rgb = m[1].toUpperCase();
  const a = (m[2] || "FF").toUpperCase();
  return "0x" + a + rgb;
}

const colors = []; // [name, path, value]
const nums = [];   // [name, path, value]

function walkColors(obj, path) {
  for (const [k, v] of Object.entries(obj)) {
    if (k === "note") continue;
    if (typeof v === "string") {
      const c = hexToArgb(v);
      if (c) colors.push([camel(path.slice(2).concat([k])), path.concat([k]).join("."), c]);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      walkColors(v, path.concat([k]));
    }
  }
}
walkColors(tok.color.dark, ["color", "dark"]);

function walkNums(obj, path, nameParts) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") {
      nums.push([camel(nameParts.concat([k])), path.concat([k]).join("."), v]);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      walkNums(v, path.concat([k]), nameParts.concat([k]));
    }
  }
}
for (const sec of ["size", "space", "radius", "border", "opacity", "pattern", "z"]) {
  if (tok[sec]) walkNums(tok[sec], [sec], [sec]);
}
if (tok.motion && tok.motion.duration) walkNums(tok.motion.duration, ["motion", "duration"], ["ms"]);
if (tok.font && tok.font.size) {
  for (const [k, v] of Object.entries(tok.font.size)) {
    if (v && typeof v.size === "number") nums.push([camel(["font", k]), `font.size.${k}.size`, v.size]);
    if (v && typeof v.lineHeight === "number") nums.push([camel(["lh", k]), `font.size.${k}.lineHeight`, v.lineHeight]);
  }
}

// 影の色と大きさ（shadow.popover.css の "0 4px 12px rgba(0,0,0,.5)"）。
if (tok.shadow && tok.shadow.popover && typeof tok.shadow.popover.css === "string") {
  const m = /(-?[\d.]+)(?:px)?\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(tok.shadow.popover.css);
  if (m) {
    const hx = (n) => Number(n).toString(16).padStart(2, "0").toUpperCase();
    const a = Math.round(Number(m[7]) * 255);
    colors.push(["shadowPopover", "shadow.popover.css", "0x" + hx(a) + hx(m[4]) + hx(m[5]) + hx(m[6])]);
    nums.push(["shadowPopoverY", "shadow.popover.css.y", Number(m[2])]);
    nums.push(["shadowPopoverBlur", "shadow.popover.css.blur", Number(m[3])]);
  }
}

// tokens.json にまだない、タイムラインの値（デザインに足してもらうもの）。tokens.json に同じ道筋ができたらその値を使う。
// 値は ui.md と mockups の CSS のもの（ロックの縞 4.3、フェード 4.4、点線の影 6 章、スナップと刃の線 4.6）。
const pendingColors = [
  ["color.dark.timeline.lockStripe", "#FFFFFF06"],   // ロックの斜めの縞（白 2.5%。4.3）
  ["color.dark.timeline.fadeShade", "#00000061"],    // フェードの三角（黒 38%。4.4）
  ["color.dark.timeline.fadeLine", "#FFFFFF"],       // フェードの斜めの線とつまみ（白）
  ["color.dark.timeline.knobEdge", "#000000"],       // フェードのつまみの縁（黒）
  ["color.dark.timeline.guide", "#FFFFFF"],          // スナップの線と三角・刃の線（白 1px。4.6）
  ["color.dark.timeline.ghostLine", "#FFFFFFB3"],    // 動く前の位置の点線の影（白 70%。6 章）
  ["color.dark.timeline.noteBg", "#0000008C"],       // クリップの上に直接書く文の地（「ロック中のため動きません」。黒 55%）
];
const pendingNums = [
  ["pattern.lockStripe.period", 12],   // ロックの縞の周期（CSS の 0 6px, transparent 6px 12px）
  ["pattern.lockStripe.on", 6],
];
const getPath = (path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), tok);
for (const [path, def] of pendingColors) {
  const v = getPath(path);
  const c = hexToArgb(typeof v === "string" ? v : def);
  colors.push([camel(path.split(".").slice(2)), path, c]);
}
for (const [path, def] of pendingNums) {
  const v = getPath(path);
  nums.push([camel(path.split(".")), path, typeof v === "number" ? v : def]);
}

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
let out = "";
out += "// tokens.json から作った定数（tools/gen-tl-tokens.mjs が書く。手で直さない）。\n";
out += `// 元: docs/design/tokens.json（version ${tok.version ?? "?"}）。色は 0xAARRGGBB、数は倍率 1.0 の論理 px・ms・割合。\n`;
out += "// 名前の空間は全ファイルで 1 つなので、型と関数は Tl / tl で始める。\n\n";
out += "export struct TlTok {\n";
for (const [n] of colors) out += `  ${n}: u32;\n`;
for (const [n] of nums) out += `  ${n}: f32;\n`;
out += "}\n\n";
out += "export function tlTokDefault(): TlTok {\n  return {\n";
for (const [n, , v] of colors) out += `    ${n}: ${v},\n`;
for (const [n, , v] of nums) out += `    ${n}: ${f(v)},\n`;
out += "  };\n}\n\n";
out += "// tokens.json の道筋（color.dark.semantic.playhead など）で 1 つの値を設定する。分からない道筋なら false。\n";
out += "export function tlTokSet(t: mut TlTok, path: string, color: u32, num: f32, isColor: bool): bool {\n";
out += "  if (isColor) {\n    switch (path) {\n";
for (const [n, p] of colors) out += `      case "${p}": t.${n} = color; return true;\n`;
out += "    }\n    return false;\n  }\n  switch (path) {\n";
for (const [n, p] of nums) out += `    case "${p}": t.${n} = num; return true;\n`;
out += "  }\n  return false;\n}\n";
const old = existsSync(output) ? readFileSync(output, "utf8") : null;
if (checkOnly) {
  if (old !== out) {
    console.error(`${relative(root, output)} が tokens.json と合っていません。node tools/gen-tl-tokens.mjs で作り直してください。`);
    process.exit(1);
  }
  console.log(`${relative(root, output)} は tokens.json と合っています（色 ${colors.length}・数 ${nums.length}）。`);
} else {
  writeFileSync(output, out);
  console.log(`書きました: ${relative(root, output)}（色 ${colors.length}・数 ${nums.length}）`);
}
