#!/usr/bin/env node
// 説明書（docs/manual/*.md）を、ブラウザで読める HTML にする。npm の依存はない。
//
//   node tools/gen-manual.mjs [-o <フォルダ>]     既定は dist/manual/
//
// 出来るもの: index.html（docs/manual/README.md）、章ごとの <名前>.html、images/。見た目（CSS）は各ページの中に入れる
// （1 つのページだけを写しても、ファイルとして開いても崩れないように）。
// 配布の形（tools/package.mjs）は、これを MozaicCut.exe の隣の manual/（Mac は Contents/Resources/manual/）に入れる。
//
// md の書き方は、説明書で使っているものだけを読む: 見出し（# 〜 ###）、段落、**太字**、`コード`、リンク、画像、
// 表、``` の囲み、> の引用、- と 1. の箇条（入れ子と、項目の中の表・囲みも）、---。HTML のタグはすべて文字として出す。
// リンクは、説明書の中の x.md を x.html に、README.md を index.html に直す。説明書の外（../ で始まるもの）は、
// GitHub のリポジトリの同じファイルを指す（配布の形には入っていないため）。
// 見出しの id は GitHub と同じ作り方なので、md のまま書いた #アンカー がそのまま使える。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs', 'manual');
const REPO_URL = 'https://github.com/UnifiedMozaic/MozaicCut/blob/main/';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GitHub の見出しのアンカーと同じ（小文字にし、文字・数字・空白・_ と - のほかを消し、空白を - に）
export function slug(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

// md の中のリンク先を、HTML の置き場での先に直す。
export function linkTarget(url, fromDir = SRC) {
  if (/^[a-z]+:/i.test(url) || url.startsWith('#')) return url;
  const [p, hash] = url.split('#');
  const abs = path.resolve(fromDir, p);
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  const tail = hash !== undefined ? `#${hash}` : '';
  if (rel.startsWith('..')) {
    // 説明書の外: リポジトリの同じファイル（GitHub）
    const repoRel = path.relative(ROOT, abs).split(path.sep).join('/');
    // リポジトリの外（隣の UnifiedMozaic など）は、同じ組織の同じ名前のリポジトリ
    if (repoRel.startsWith('../')) return `https://github.com/UnifiedMozaic/${repoRel.slice(3)}${tail}`;
    return REPO_URL + repoRel + tail;
  }
  if (rel === 'README.md') return `index.html${tail}`;
  if (rel.endsWith('.md')) return rel.slice(0, -3) + '.html' + tail;
  return rel + tail;
}

// 行の中（コードの中は触らない）。
export function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${esc(linkTarget(src))}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const href = linkTarget(u.replace(/&amp;/g, '&'));
    const ext = /^https?:/.test(href) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${esc(href)}"${ext}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

const indentOf = (l) => l.match(/^ */)[0].length;
const isFence = (l) => /^ *```/.test(l);
const listMark = (l) => l.match(/^( *)([-*]|\d+\.) +/);
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

// 行の並びを HTML のかたまりにする。
export function blocks(lines) {
  const out = [];
  let i = 0;
  const startsBlock = (l, next) => l.trim() === '' || /^#{1,6} /.test(l) || isFence(l) || /^ *> ?/.test(l) || listMark(l) ||
    l.trim() === '---' || (l.trim().startsWith('|') && next !== undefined && /^ *\|[ :|-]+\|? *$/.test(next));
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '') { i++; continue; }
    let m;
    if (isFence(l)) {
      const ind = indentOf(l);
      const lang = l.trim().slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !(isFence(lines[i]) && lines[i].trim() === '```')) {
        body.push(lines[i].slice(Math.min(ind, indentOf(lines[i]))));
        i++;
      }
      i++;
      out.push(`<pre${lang ? ` class="lang-${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
    } else if ((m = l.match(/^(#{1,6}) +(.*)$/))) {
      const n = m[1].length;
      out.push(`<h${n} id="${esc(slug(m[2].replace(/`/g, '')))}">${inline(m[2])}</h${n}>`);
      i++;
    } else if (l.trim() === '---') {
      out.push('<hr>');
      i++;
    } else if (l.trim().startsWith('|') && /^ *\|[ :|-]+\|? *$/.test(lines[i + 1] || '')) {
      const head = splitRow(l);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>');
    } else if (/^ *> ?/.test(l)) {
      const body = [];
      while (i < lines.length && /^ *> ?/.test(lines[i])) body.push(lines[i++].replace(/^ *> ?/, ''));
      out.push(`<blockquote>${blocks(body)}</blockquote>`);
    } else if ((m = listMark(l))) {
      const base = m[1].length;
      const ordered = /\d/.test(m[2]);
      const start = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const mm = listMark(lines[i]);
        if (!mm || mm[1].length !== base || /\d/.test(mm[2]) !== ordered) break;
        const w = mm[0].length;
        const body = [lines[i].slice(w)];
        i++;
        // 項目の続き: 字下げした行（間の空行も含める。字下げのない行か次の項目で終わる）
        while (i < lines.length) {
          const t = lines[i];
          if (t.trim() === '') {
            let j = i;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j < lines.length && indentOf(lines[j]) > base && !(listMark(lines[j]) && indentOf(lines[j]) === base)) {
              while (i < j) { body.push(''); i++; }
              continue;
            }
            break;
          }
          if (indentOf(t) <= base) break;
          body.push(t.slice(Math.min(w, indentOf(t))));
          i++;
        }
        items.push(body);
      }
      const tag = ordered ? 'ol' : 'ul';
      const attr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${attr}>` + items.map((b) => {
        const html = blocks(b);
        // 段落 1 つだけの項目は <p> で包まない（間が空きすぎないように）
        const one = html.match(/^<p>([\s\S]*)<\/p>$/);
        return `<li>${one && !one[1].includes('<p>') ? one[1] : html}</li>`;
      }).join('') + `</${tag}>`);
    } else {
      const para = [];
      while (i < lines.length && !(para.length > 0 && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join('\n'))}</p>`);
    }
  }
  return out.join('\n');
}

// 目次（README.md の「目次」の番号つきの箇条）から、章の並び（ファイルと題）を読む。
function chapters(readme) {
  const list = [];
  for (const l of readme.split(/\r?\n/)) {
    const m = l.match(/^(\d+)\. \[([^\]]+)\]\(([^)#]+\.md)\)/);
    if (m) list.push({ n: m[1], title: m[2], file: m[3] });
  }
  return list;
}

function page({ title, body, nav, current }) {
  const items = nav.map((c) => {
    const href = c.file === 'README.md' ? 'index.html' : c.file.replace(/\.md$/, '.html');
    const cls = c.file === current ? ' class="current"' : '';
    const label = c.n === undefined ? esc(c.title) : `<span class="n">${c.n}</span>${esc(c.title)}`;
    return `<li><a href="${href}"${cls}>${label}</a></li>`;
  }).join('\n');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title === 'MozaicCut 使い方の説明書' ? title : `${title} — MozaicCut 使い方の説明書`)}</title>
<style>
${CSS}</style>
</head>
<body>
<nav class="side">
<a class="brand" href="index.html">MozaicCut<small>使い方の説明書</small></a>
<ul>
${items}
</ul>
</nav>
<main>
${body}
</main>
</body>
</html>
`;
}

const CSS = `:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d8dee4; --soft: #f6f8fa; --accent: #2f6fde; --side: #f6f8fa;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #16181c; --fg: #e6e8eb; --muted: #9aa3ad; --line: #30363d; --soft: #1f2329; --accent: #6ea2ff; --side: #1b1e23; }
}
* { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0; background: var(--bg); color: var(--fg); display: flex; min-height: 100vh;
  font-family: "Yu Gothic UI", "Yu Gothic", "Hiragino Sans", "Noto Sans JP", Meiryo, system-ui, sans-serif; line-height: 1.8;
}
.side {
  position: sticky; top: 0; align-self: flex-start; height: 100vh; overflow: auto; flex: 0 0 260px;
  background: var(--side); border-right: 1px solid var(--line); padding: 20px 12px;
}
.brand { display: block; font-weight: 700; font-size: 1.15rem; color: var(--fg); text-decoration: none; padding: 0 10px 16px; }
.brand small { display: block; font-weight: 400; font-size: .8rem; color: var(--muted); }
.side ul { list-style: none; margin: 0; padding: 0; }
.side a:not(.brand) { display: flex; gap: 8px; padding: 6px 10px; border-radius: 6px; color: var(--fg); text-decoration: none; font-size: .92rem; line-height: 1.5; }
.side a:not(.brand):hover { background: var(--soft); }
.side a.current { background: var(--accent); color: #fff; }
.side .n { flex: 0 0 1.2em; text-align: right; opacity: .7; }
main { flex: 1; min-width: 0; max-width: 920px; padding: 32px 48px 80px; }
h1 { font-size: 1.9rem; line-height: 1.35; margin: 0 0 16px; }
h2 { font-size: 1.4rem; margin: 40px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.15rem; margin: 28px 0 8px; }
h1, h2, h3 { scroll-margin-top: 16px; }
a { color: var(--accent); }
p, ul, ol, blockquote, .table, pre { margin: 0 0 14px; }
ul, ol { padding-left: 1.6em; }
li > ul, li > ol, li > .table, li > pre, li > p { margin-top: 6px; margin-bottom: 6px; }
code { font-family: "Cascadia Mono", Consolas, "BIZ UDGothic", monospace; font-size: .88em; background: var(--soft); border: 1px solid var(--line); border-radius: 4px; padding: 0 .3em; }
pre { background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow: auto; line-height: 1.5; }
pre code { background: none; border: 0; padding: 0; font-size: .85rem; }
.table { overflow-x: auto; }
table { border-collapse: collapse; font-size: .93rem; line-height: 1.6; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--soft); }
blockquote { border-left: 4px solid var(--accent); background: var(--soft); margin-left: 0; padding: 10px 16px; border-radius: 0 6px 6px 0; }
blockquote p:last-child { margin-bottom: 0; }
img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
@media (max-width: 800px) {
  body { display: block; }
  .side { position: static; height: auto; flex: none; border-right: 0; border-bottom: 1px solid var(--line); }
  main { padding: 20px 18px 60px; }
}
@media print { .side { display: none; } main { max-width: none; padding: 0; } }
`;

// docs/manual を outDir に HTML にして書く。書いたファイルの数を返す。
export function makeManualHtml(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const readme = fs.readFileSync(path.join(SRC, 'README.md'), 'utf8');
  const nav = [{ title: '目次', file: 'README.md' }, ...chapters(readme)];
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const md = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^﻿/, '');
    const h1 = md.match(/^# +(.*)$/m);
    const title = h1 ? h1[1].replace(/`/g, '') : f;
    const html = page({ title, body: blocks(md.split(/\r?\n/)), nav, current: f });
    fs.writeFileSync(path.join(outDir, f === 'README.md' ? 'index.html' : f.replace(/\.md$/, '.html')), html);
  }
  fs.cpSync(path.join(SRC, 'images'), path.join(outDir, 'images'), { recursive: true });
  return files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const k = a.indexOf('-o');
  const out = path.resolve(k >= 0 && a[k + 1] ? a[k + 1] : path.join(ROOT, 'dist', 'manual'));
  const n = makeManualHtml(out);
  console.log(`説明書を HTML にしました（${n} ページ）: ${path.join(out, 'index.html')}`);
}
