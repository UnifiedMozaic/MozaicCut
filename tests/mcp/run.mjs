#!/usr/bin/env node
// MCP サーバー（tools/mcp-server.mjs）のテスト。node tests/mcp/run.mjs で流す。npm の依存はない。
//
// サーバーを子プロセスで起動し、initialize → tools/list → 各ツールを呼んで、期待どおりの結果になるかを確かめる。
// 作業はすべて一時フォルダの demo/demo.mzc の写しで行う（リポジトリの demo/demo.mzc は書き換えない。最後に確かめる）。
// 素材は demo/media にあればそれを写し、なければ ffmpeg で一時フォルダに作る（tools/demo-media.mjs と同じ合成素材）。
// ffmpeg がなければ、素材の要るテスト（check / show / op / preview / render）は飛ばす。
//
// オプション:
//   --keep   作業用のフォルダを消さずに残す
//   -v       サーバーの標準エラーも出す
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'tools', 'mcp-server.mjs');
const DEMO = path.join(ROOT, 'demo', 'demo.mzc');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('-v');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-mcp-tests-')));
const PROJ_DIR = path.join(TMP, 'proj'); // 許したフォルダ（--root）
const OUTSIDE = path.join(TMP, 'outside'); // 許したフォルダの外
fs.mkdirSync(PROJ_DIR, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });

let passed = 0;
let skipped = 0;
const failures = [];

class Fail extends Error {}
function assert(cond, msg) {
  if (!cond) throw new Fail(msg);
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function test(name, fn, { skip = false } = {}) {
  if (skip) {
    skipped++;
    console.log(`  - ${name}（飛ばしました: ffmpeg がありません）`);
    return;
  }
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  NG ${name}: ${e instanceof Fail ? e.message : e.stack}`);
  }
}

// ---- 素材の用意 ----

function haveFfmpeg() {
  const r = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function prepareMedia() {
  const dst = path.join(PROJ_DIR, 'media');
  fs.mkdirSync(dst, { recursive: true });
  const names = ['clip_a.mp4', 'clip_b.mp4', 'logo.png', 'bgm.wav'];
  const src = path.join(ROOT, 'demo', 'media');
  if (names.every((n) => fs.existsSync(path.join(src, n)))) {
    for (const n of names) fs.copyFileSync(path.join(src, n), path.join(dst, n));
    return true;
  }
  if (!haveFfmpeg()) return false;
  const jobs = [
    ['clip_a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
    ['clip_b.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=size=960x540:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100',
      '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
    ['logo.png', ['-f', 'lavfi', '-i', "color=c=0x00000000:size=200x200,format=rgba,geq=r='255':g='180':b='40':a='if(lt(hypot(X-100,Y-100),90),255,0)'",
      '-frames:v', '1']],
    ['bgm.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-filter_complex', 'amix=inputs=2', '-t', '20']],
  ];
  for (const [n, a] of jobs) {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...a, path.join(dst, n)], { stdio: 'inherit' });
    if (r.error || r.status !== 0) return false;
  }
  return true;
}

// ---- MCP のクライアント ----

class Client {
  constructor(args) {
    this.child = spawn(process.execPath, [SERVER, ...args], { cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.raw = [];
    this.nextId = 1;
    this.stderr = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      this.stderr += d;
      if (VERBOSE) process.stderr.write(d);
    });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.raw.push({ bad: line });
        return;
      }
      this.raw.push(msg);
      const list = Array.isArray(msg) ? msg : [msg];
      for (const m of list) {
        const key = m.id === null || m.id === undefined ? 'null' : String(m.id);
        const p = this.pending.get(key);
        if (p) {
          this.pending.delete(key);
          p(m);
        }
      }
    });
  }
  writeLine(s) {
    this.child.stdin.write(s + '\n');
  }
  // 応答を待つ（id が null の応答は 'null' で待つ）
  wait(key, ms = 600000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(key); reject(new Fail(`応答が来ません（id ${key}）`)); }, ms);
      this.pending.set(key, (m) => { clearTimeout(t); resolve(m); });
    });
  }
  request(method, params) {
    const id = this.nextId++;
    const p = this.wait(String(id));
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }));
    return p;
  }
  notify(method, params) {
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }));
  }
  async call(name, args) {
    const m = await this.request('tools/call', { name, arguments: args });
    assert(!m.error, `${name}: JSON-RPC の誤り ${JSON.stringify(m.error)}`);
    return m.result;
  }
  close() {
    return new Promise((resolve) => {
      this.child.on('close', (code) => resolve(code));
      this.child.stdin.end();
    });
  }
}

const textOf = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

function pngSize(buf) {
  assert(buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47, 'PNG ではありません');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---- テスト ----

async function main() {
  const demoHash = sha(DEMO);
  const project = path.join(PROJ_DIR, 'demo.mzc');
  fs.copyFileSync(DEMO, project);
  const media = prepareMedia();
  if (!media) console.log('ffmpeg がないので、素材の要るテストは飛ばします');

  // 許したフォルダの外のプロジェクトと、外の素材を指すプロジェクト
  fs.copyFileSync(DEMO, path.join(OUTSIDE, 'outside.mzc'));
  fs.writeFileSync(path.join(OUTSIDE, 'secret.mp4'), 'not a video');
  fs.writeFileSync(path.join(PROJ_DIR, 'escape.mzc'), 'project size=1280x720 fps=30\nvideo "../outside/secret.mp4" id=a dur=1\n');
  fs.writeFileSync(path.join(PROJ_DIR, 'escape-out.mzc'), 'project size=1280x720 fps=30 output=../outside/x.mp4\ncolor 000000 dur=1\n');
  fs.mkdirSync(path.join(PROJ_DIR, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, 'sub', 'small.mzc'), 'project size=320x180 fps=30\ncolor 336699 id=bg dur=1\n');

  const c = new Client(['--root', PROJ_DIR]);
  console.log('MCP サーバー');

  await test('initialize: 版・サーバーの情報・ツールの能力を返す', async () => {
    const m = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0' } });
    assert(m.result, `result がありません: ${JSON.stringify(m)}`);
    assert(m.result.protocolVersion === '2025-06-18', `protocolVersion: ${m.result.protocolVersion}`);
    assert(m.result.serverInfo?.name === 'mozaiccut', 'serverInfo.name');
    assert(m.result.capabilities?.tools, 'capabilities.tools');
    assert(typeof m.result.instructions === 'string' && m.result.instructions.includes('dry_run'), 'instructions');
    c.notify('notifications/initialized');
  });

  await test('initialize: 知らない版にはいちばん新しい版を返す', async () => {
    const m = await c.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
    assert(m.result.protocolVersion === '2025-06-18', `protocolVersion: ${m.result.protocolVersion}`);
  });

  await test('ping', async () => {
    const m = await c.request('ping');
    assert(m.result && Object.keys(m.result).length === 0, JSON.stringify(m));
  });

  await test('tools/list: すべてのツールに日本語と英語の説明と inputSchema がある', async () => {
    const m = await c.request('tools/list', {});
    const tools = m.result.tools;
    const names = tools.map((t) => t.name);
    for (const n of ['schema', 'check', 'show', 'op', 'preview', 'render', 'render_status', 'list_projects']) assert(names.includes(n), `${n} がありません`);
    for (const t of tools) {
      assert(/[぀-ヿ]/.test(t.description), `${t.name}: 日本語の説明がありません`);
      assert(/[A-Za-z]{4,} [a-z]{3,}/.test(t.description), `${t.name}: 英語の説明がありません`);
      assert(t.inputSchema?.type === 'object', `${t.name}: inputSchema`);
      assert(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', `${t.name}: annotations`);
    }
    const op = tools.find((t) => t.name === 'op');
    assert(op.annotations.readOnlyHint === false && op.inputSchema.required.includes('ops'), 'op の形');
  });

  await test('JSON-RPC: 壊れた JSON は -32700、知らないメソッドは -32601、知らないツールは -32602', async () => {
    const p = c.wait('null', 10000);
    c.writeLine('{ this is not json');
    const bad = await p;
    assert(bad.error?.code === -32700, JSON.stringify(bad));
    const m = await c.request('no/such/method', {});
    assert(m.error?.code === -32601, JSON.stringify(m));
    const t = await c.request('tools/call', { name: 'nosuch', arguments: {} });
    assert(t.error?.code === -32602, JSON.stringify(t));
  });

  await test('schema: キー・効果・操作を JSON で返す。section で絞れる', async () => {
    const r = await c.call('schema', {});
    assert(!r.isError, textOf(r));
    const s = r.structuredContent;
    assert(Array.isArray(s.keys) && s.keys.length > 10, 'keys');
    assert(Array.isArray(s.effects) && s.effects.some((e) => e.name === 'vignette'), 'effects に vignette');
    assert(s.ops.some((o) => o.name === 'move'), 'ops に move');
    const r2 = await c.call('schema', { section: 'ops' });
    assert(r2.structuredContent.ops && !r2.structuredContent.keys, 'section=ops');
    const r3 = await c.call('schema', { format: 'text' });
    assert(!r3.isError && textOf(r3).length > 100, 'format=text');
  });

  await test('schema: M6 の機能の早見（features）と blend を返す。keyOps で key の操作の可否が分かる', async () => {
    const r = await c.call('schema', { section: 'features' });
    assert(!r.isError, textOf(r));
    const f = r.structuredContent.features;
    assert(Array.isArray(f) && !r.structuredContent.keys, 'section=features');
    for (const name of ['keyframes', 'blend', 'shape', 'textanim']) {
      const e = f.find((x) => x.name === name);
      assert(e && e.label && e.doc && e.check && e.ops.length && e.examples.length, `features に ${name}: ${JSON.stringify(e)}`);
    }
    assert(f.find((x) => x.name === 'textanim').values.includes('rise'), 'textanim のプリセット');
    const b = await c.call('schema', { section: 'blend' });
    assert(!b.isError && b.structuredContent.blend.modes.some((m) => m.name === 'screen'), 'section=blend');
    const k = (await c.call('schema', { section: 'keys' })).structuredContent.keys;
    const key = (name, kind) => k.find((x) => x.name === name && x.kinds.includes(kind));
    assert(key('x', 'text').animatable && key('x', 'text').keyOps, 'x は key の操作で動かせる');
    assert(key('trimend', 'shape').animatable && key('trimend', 'shape').keyOps, 'shape の trimend は key の操作で動かせる');
    assert(key('anim.start', 'text').animatable && key('anim.start', 'text').keyOps, 'anim.start は値@時刻 で書け、key の操作でも動かせる');
    assert(!key('dur', 'text').animatable, 'dur は動かせない');
    const bad = await c.call('schema', { section: 'nosuch' });
    assert(bad.isError && bad.structuredContent.code === 'bad-args' && textOf(bad).includes('features'), textOf(bad));
    const tx = await c.call('schema', { format: 'text' });
    assert(textOf(tx).includes('機能の早見'), '人向けの schema に機能の早見');
  });

  await test('op: M6 の機能（キーフレーム・シェイプ・マスク・描画モード・テキストアニメーター）を足し、check で読める', async () => {
    const f = path.join(PROJ_DIR, 'm6ops.mzc');
    fs.writeFileSync(f, 'project size=640x360 fps=30 bg=101018\ncolor 204060 id=bg dur=3\ncolor ff8000 id=box track=1 at=0 dur=3 w=80 h=80 x=20 y=20\ntext "Hello World" id=title track=2 at=0 dur=3 size=48 y=280\n');
    const ops = [
      'key add box x 0 20',
      'key add box x 2 520 ease',
      'set box opacity="0@0 1@0.5"',
      'add shape star id=star points=5 r=60 inner=25 pos=320,150 fill=ffd040 at=0 dur=3 track=3',
      'key add star rotation 0 0',
      'key add star rotation 3 144 ease',
      'set box blend=screen',
      'add mask ellipse to=box units=norm x=0 y=0 w=1 h=1 feather=0.1',
      'set title anim=rise anim.by=word anim.stagger=0.2',
    ];
    const dry = await c.call('op', { project: f, ops });
    assert(!dry.isError && dry.structuredContent.results.every((x) => x.ok), JSON.stringify(dry.structuredContent.results?.filter((x) => !x.ok)));
    const ap = await c.call('op', { project: f, ops, apply: true });
    assert(!ap.isError && ap.structuredContent.saved === true, textOf(ap));
    const text = fs.readFileSync(f, 'utf8');
    assert(text.includes('x="20@0 520@2:ease"') && text.includes('rotation="0@0 144@3:ease"'), text);
    const ck = (await c.call('check', { project: f })).structuredContent;
    assert(ck.ok, JSON.stringify(ck.diagnostics));
    const clip = (id) => ck.clips.find((x) => x.id === id);
    const xk = clip('box').anims.x.keys;
    assert(xk.length === 2 && xk[1].t === 2 && xk[1].value === 520, JSON.stringify(xk));
    assert(clip('box').anims.opacity.keys.length === 2, 'opacity のキー');
    assert(clip('box').blend.mode === 'screen' && clip('box').masks.length === 1, JSON.stringify(clip('box').blend));
    assert(clip('star').shape.shape === 'star' && clip('star').anims.rotation.keys[1].value === 144, JSON.stringify(clip('star').shape));
    assert(clip('title').textanim.length === 1 && clip('title').textanim[0].doc.includes('rise'), JSON.stringify(clip('title').textanim));
    // 動かせないキーは key-not-animatable で断り、何も書かない
    const before = sha(f);
    for (const o of ['key add box dur 1 2']) {
      const r = await c.call('op', { project: f, ops: o, apply: true });
      assert(r.isError && r.structuredContent.results[0].code === 'key-not-animatable', `${o}: ${JSON.stringify(r.structuredContent.results)}`);
    }
    // テキストアニメーターの時間の値は set で値@時刻 を書く
    const ta = await c.call('op', { project: f, ops: 'set title anim.mode=range anim.start="0@0 100@1:ease"' });
    assert(!ta.isError, textOf(ta));
    assert(sha(f) === before, '断った操作・dry_run でファイルが変わりました');
  });

  await test('preview: キーフレームで動く四角は時刻で絵が変わり、同じ時刻なら同じ絵', async () => {
    const f = path.join(PROJ_DIR, 'm6anim.mzc');
    fs.writeFileSync(f, 'project size=320x180 fps=30 bg=000000\ncolor ffffff id=box dur=2 w=40 h=40 x="0@0 280@2" y=70\n');
    const shot = async (t) => {
      const r = await c.call('preview', { project: f, time: t, max_width: 0 });
      assert(!r.isError, textOf(r));
      return r.content.find((x) => x.type === 'image').data;
    };
    const a = await shot(0.2);
    const b = await shot(1.5);
    assert(a !== b, '0.2 秒と 1.5 秒の絵が同じです（キーフレームが効いていません）');
    assert((await shot(0.2)) === a, '同じ時刻の絵が違います');
  });

  await test('op: schema の features の例は、そのまま流せる（dry_run）', async () => {
    const f = path.join(PROJ_DIR, 'm6feat.mzc');
    fs.writeFileSync(f, [
      'project size=1280x720 fps=30 bg=101018',
      'video "media/clip_a.mp4" id=bgclip dur=4',
      'image "media/logo.png" id=logo track=1 at=0 dur=4 w=96 x=24 y=24',
      'video "media/clip_a.mp4" id=pip track=2 at=0 dur=4 w=640 h=360 x=40 y=40',
      'color ffb040 id=glow track=3 at=0 dur=4 w=400 h=400 x=820 y=20',
      'text "MATTE" id=word track=4 at=0 dur=4 size=200 y=440',
      'video "media/clip_a.mp4" id=fill track=5 at=0 dur=4',
      'text "MozaicCut" id=title track=6 at=0 dur=4 size=96',
      'text "SALE 50% OFF" id=sale track=7 at=0 dur=4 size=96 y=600',
      '',
    ].join('\n'));
    const before = sha(f);
    const feats = (await c.call('schema', { section: 'features' })).structuredContent.features;
    for (const ft of feats) {
      const r = await c.call('op', { project: f, ops: ft.examples });
      assert(!r.isError && r.structuredContent.results.every((x) => x.ok), `${ft.name}: ${JSON.stringify(r.structuredContent.results?.filter((x) => !x.ok) ?? textOf(r))}`);
    }
    assert(sha(f) === before, 'dry_run でファイルが変わりました');
  }, { skip: !media });

  await test('list_projects: 許したフォルダの .mzc を探す。外は断る', async () => {
    const r = await c.call('list_projects', {});
    assert(!r.isError, textOf(r));
    const rels = r.structuredContent.projects.map((p) => p.relative);
    for (const n of ['demo.mzc', 'escape.mzc', 'sub/small.mzc']) assert(rels.includes(n), `${n} がありません: ${rels}`);
    assert(!rels.some((n) => n.includes('outside')), '外のファイルが出ています');
    const flat = await c.call('list_projects', { recursive: false });
    assert(!flat.structuredContent.projects.some((p) => p.relative.includes('/')), 'recursive=false');
    const out = await c.call('list_projects', { folder: OUTSIDE });
    assert(out.isError && out.structuredContent.code === 'outside-root', textOf(out));
    const up = await c.call('list_projects', { folder: '..' });
    assert(up.isError && up.structuredContent.code === 'outside-root', textOf(up));
  });

  await test('安全: 許したフォルダの外のプロジェクトと、外を指すパスは断る', async () => {
    for (const p of [path.join(OUTSIDE, 'outside.mzc'), '../outside/outside.mzc']) {
      const r = await c.call('check', { project: p });
      assert(r.isError && r.structuredContent.code === 'outside-root', `${p}: ${textOf(r)}`);
    }
    const esc = await c.call('check', { project: 'escape.mzc' });
    assert(esc.isError && esc.structuredContent.code === 'outside-root', `escape.mzc: ${textOf(esc)}`);
    const escOut = await c.call('render', { project: 'escape-out.mzc' });
    assert(escOut.isError && escOut.structuredContent.code === 'outside-project', `escape-out.mzc: ${textOf(escOut)}`);
    const none = await c.call('check', { project: 'nosuch.mzc' });
    assert(none.isError && none.structuredContent.code === 'not-found', textOf(none));
    const notMzc = await c.call('check', { project: 'media/logo.png' });
    assert(notMzc.isError && notMzc.structuredContent.code === 'bad-args', textOf(notMzc));
  });

  await test('check: 誤りのない demo は ok で、クリップ 10 個', async () => {
    const r = await c.call('check', { project: 'demo.mzc' });
    assert(!r.isError, textOf(r));
    assert(r.structuredContent.ok === true, JSON.stringify(r.structuredContent.diagnostics));
    assert(r.structuredContent.clips.length === 10, `clips ${r.structuredContent.clips.length}`);
    assert(textOf(r).includes('問題はありません'), textOf(r));
    // 絶対パスでも同じ
    const r2 = await c.call('check', { project });
    assert(r2.structuredContent.ok === true, 'absolute path');
  }, { skip: !media });

  await test('check: 誤りのあるプロジェクトは ok=false と診断を返す（ツールの失敗ではない）', async () => {
    fs.writeFileSync(path.join(PROJ_DIR, 'bad.mzc'), 'project size=1280x720 fps=30\ncolor 202040 id=bg dur=2 colr=ff0000\n');
    const r = await c.call('check', { project: 'bad.mzc' });
    assert(!r.isError, textOf(r));
    assert(r.structuredContent.ok === false, 'ok');
    const d = r.structuredContent.diagnostics.find((x) => x.code === 'unknown-key');
    assert(d && d.line === 2, JSON.stringify(r.structuredContent.diagnostics));
    assert(textOf(r).includes('unknown-key'), textOf(r));
  });

  await test('show: タイムラインの図と一覧', async () => {
    const r = await c.call('show', { project: 'demo.mzc', width: 80 });
    assert(!r.isError, textOf(r));
    const t = textOf(r);
    for (const s of ['V0', 'A0', 'clip_b', 'caption_a']) assert(t.includes(s), `${s} がありません\n${t}`);
  }, { skip: !media });

  await test('op: 既定は dry_run で、差分を返し、ファイルは変わらない', async () => {
    const before = sha(project);
    const r = await c.call('op', { project: 'demo.mzc', ops: 'move clip_b 5.5' });
    assert(!r.isError, textOf(r));
    const s = r.structuredContent;
    assert(s.ok === true && s.saved === false && s.dryRun === true, JSON.stringify(s).slice(0, 300));
    assert(s.diff.includes('+ ') && s.diff.includes('at=5.5'), s.diff);
    assert(s.results[0].moved.some((m) => m.id === 'caption_b'), 'moved に caption_b');
    assert(textOf(r).includes('dry_run'), textOf(r));
    assert(sha(project) === before, 'dry_run でファイルが変わりました');
  }, { skip: !media });

  await test('op: apply=true で保存する', async () => {
    const r = await c.call('op', { project: 'demo.mzc', ops: 'move clip_b 5.5', apply: true });
    assert(!r.isError, textOf(r));
    assert(r.structuredContent.saved === true && r.structuredContent.dryRun === false, JSON.stringify(r.structuredContent).slice(0, 300));
    assert(fs.readFileSync(project, 'utf8').includes('vignette=0.4 fadeout=1 at=5.5'), 'at=5.5 が書かれていません');
    const ck = await c.call('check', { project: 'demo.mzc' });
    const clip = ck.structuredContent.clips.find((x) => x.id === 'clip_b');
    assert(clip.start === 5.5, `clip_b.start ${clip.start}`);
  }, { skip: !media });

  await test('op: 保存したら <名前>.mzc.history に操作の記録を 1 行書き足す（dry_run では書かない）', async () => {
    const hist = project + '.history';
    const lines = fs.readFileSync(hist, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert(last.via === 'mcp' && last.who === 'ai' && last.client !== '' && last.tool === 'op', JSON.stringify(last));
    assert(JSON.stringify(last.ops) === JSON.stringify(['move clip_b 5.5']), JSON.stringify(last.ops));
    assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(last.t), last.t);
    assert(last.desc.includes('clip_b') && last.changes.some((ch) => ch.after.includes('at=5.5')), JSON.stringify(last));
    const n = lines.length;
    await c.call('op', { project: 'demo.mzc', ops: 'move clip_b 6' });
    assert(fs.readFileSync(hist, 'utf8').trim().split('\n').length === n, 'dry_run で記録が増えました');
  }, { skip: !media });

  await test('op: 配列のバッチ（split → set → add）を試す', async () => {
    const before = sha(project);
    const r = await c.call('op', { project: 'demo.mzc', ops: ['split clip_b 7', 'set clip_b_2 sat=0.5', 'add text "つづく" at=clip_b_2.start dur=2 size=64 after clip_b_2'] });
    assert(!r.isError, textOf(r));
    assert(r.structuredContent.results.length === 3 && r.structuredContent.results.every((x) => x.ok), JSON.stringify(r.structuredContent.results));
    assert(r.structuredContent.results[2].newId, 'newId');
    assert(sha(project) === before, 'dry_run でファイルが変わりました');
  }, { skip: !media });

  await test('op: 失敗する操作は isError で code / hint を返し、何も書かない', async () => {
    const before = sha(project);
    const r = await c.call('op', { project: 'demo.mzc', ops: 'move nosuch 1', apply: true });
    assert(r.isError, 'isError');
    assert(r.structuredContent.results[0].code === 'unknown-clip', JSON.stringify(r.structuredContent.results));
    assert(textOf(r).includes('unknown-clip'), textOf(r));
    const r2 = await c.call('op', { project: 'demo.mzc', ops: 'set clip_b blur=999', apply: true });
    assert(r2.isError && r2.structuredContent.results[0].code === 'out-of-range', JSON.stringify(r2.structuredContent.results));
    assert(sha(project) === before, '失敗した操作でファイルが変わりました');
  }, { skip: !media });

  await test('op: 許したフォルダの外の素材を足す・指す操作は断る', async () => {
    const before = sha(project);
    for (const ops of ['add video "../outside/secret.mp4" dur=1', 'add video ../outside/secret.mp4 dur=1', `set clip_a src=${path.join(OUTSIDE, 'secret.mp4')}`]) {
      const r = await c.call('op', { project: 'demo.mzc', ops, apply: true });
      assert(r.isError && r.structuredContent.code === 'outside-root', `${ops}: ${textOf(r)}`);
    }
    assert(sha(project) === before, '断った操作でファイルが変わりました');
  });

  await test('op: 引数の誤り（ops がない・空）は bad-args', async () => {
    const r = await c.call('op', { project: 'demo.mzc', ops: '  \n' });
    assert(r.isError && r.structuredContent.code === 'bad-args', textOf(r));
    const r2 = await c.call('op', { project: 'demo.mzc' });
    assert(r2.isError && r2.structuredContent.code === 'bad-args', textOf(r2));
  });

  await test('preview: 1 コマを PNG の画像として返す。max_width で縮める。save_as はプロジェクトのフォルダの中だけ', async () => {
    const r = await c.call('preview', { project: 'demo.mzc', time: 3.5 });
    assert(!r.isError, textOf(r));
    const img = r.content.find((x) => x.type === 'image');
    assert(img && img.mimeType === 'image/png', 'image がありません');
    const size = pngSize(Buffer.from(img.data, 'base64'));
    assert(size.width === 1280 && size.height === 720, `大きさ ${size.width}x${size.height}`);
    assert(r.structuredContent.file.startsWith(path.join(PROJ_DIR, 'demo.cache')), r.structuredContent.file);

    const r2 = await c.call('preview', { project: 'demo.mzc', time: '0:01.0', max_width: 320, save_as: 'shots/one.png' });
    assert(!r2.isError, textOf(r2));
    const s2 = pngSize(Buffer.from(r2.content.find((x) => x.type === 'image').data, 'base64'));
    assert(s2.width === 320 && s2.height === 180, `縮めた大きさ ${s2.width}x${s2.height}`);
    assert(fs.existsSync(path.join(PROJ_DIR, 'shots', 'one.png')), 'save_as に書かれていません');

    const r3 = await c.call('preview', { project: 'demo.mzc', time: 1, save_as: '../outside/x.png' });
    assert(r3.isError && r3.structuredContent.code === 'outside-project', textOf(r3));
    assert(!fs.existsSync(path.join(OUTSIDE, 'x.png')), '外に書かれました');
    const r4 = await c.call('preview', { project: 'demo.mzc', time: 'abc' });
    assert(r4.isError && r4.structuredContent.code === 'bad-args', textOf(r4));
  }, { skip: !media });

  await test('render: 範囲の書き出しを始め、render_status で終わりを待つ', async () => {
    const out = await c.call('render', { project: 'demo.mzc', output: '../outside/x.mp4' });
    assert(out.isError && out.structuredContent.code === 'outside-project', textOf(out));
    const bad = await c.call('render', { project: 'bad.mzc' });
    assert(bad.isError && bad.structuredContent.started === false, textOf(bad));

    const r = await c.call('render', { project: 'demo.mzc', output: 'renders/part.mp4', from: 6, to: '0:06.5' });
    assert(!r.isError, textOf(r));
    const id = r.structuredContent.job_id;
    assert(id && r.structuredContent.state === 'running', JSON.stringify(r.structuredContent));
    const busy = await c.call('render', { project: 'demo.mzc', output: 'renders/b.mp4' });
    assert(busy.isError && busy.structuredContent.code === 'busy', textOf(busy));
    const st = await c.call('render_status', { job_id: id, wait_seconds: 300 });
    assert(st.structuredContent.state === 'done', `state ${st.structuredContent.state}\n${(st.structuredContent.log || []).join('\n')}`);
    const file = path.join(PROJ_DIR, 'renders', 'part.mp4');
    assert(fs.existsSync(file) && fs.statSync(file).size > 1000, 'part.mp4 がありません');
    const list = await c.call('render_status', {});
    assert(list.structuredContent.jobs.some((j) => j.job_id === id), '一覧にありません');
    const unk = await c.call('render_status', { job_id: 'zzz' });
    assert(unk.isError && unk.structuredContent.code === 'unknown-job', textOf(unk));
  }, { skip: !media });

  // ---- 指摘を受けて足したテスト ----

  await test('安全: 色の語（#ff8000）の後ろに書いた外の素材もすり抜けない（check・preview）', async () => {
    fs.writeFileSync(path.join(PROJ_DIR, 'hash.mzc'), 'project size=320x180 fps=30\nvideo #ff8000 src=../outside/secret.mp4 id=leak dur=2\n');
    for (const [tool, extra] of [['check', {}], ['preview', { time: 0.5 }], ['show', {}], ['render', { output: 'renders/hash.mp4' }]]) {
      const r = await c.call(tool, { project: 'hash.mzc', ...extra });
      assert(r.isError && r.structuredContent.code === 'outside-root', `${tool}: ${textOf(r)}`);
    }
  });

  await test('安全: エスケープ（\\.）で組み立てた外の素材もすり抜けない', async () => {
    // エンジンは "\." を "." と読むので、sub/ から ../../outside/secret.mp4 になる
    fs.writeFileSync(path.join(PROJ_DIR, 'sub', 'esc.mzc'), 'project size=320x180 fps=30\nvideo "../.\\./outside/secret.mp4" id=a dur=1\n');
    for (const tool of ['check', 'preview']) {
      const r = await c.call(tool, { project: 'sub/esc.mzc', time: tool === 'preview' ? 0.5 : undefined });
      assert(r.isError && ['outside-root', 'bad-escape'].includes(r.structuredContent.code), `${tool}: ${textOf(r)}`);
    }
    // 知らないエスケープのない、ふつうの \\ や \" はエスケープとして読み、エンジンと同じパスで確かめる
    fs.writeFileSync(path.join(PROJ_DIR, 'sub', 'esc2.mzc'), 'project size=320x180 fps=30\nvideo "..\\\\..\\\\outside\\\\secret.mp4" id=a dur=1\n');
    const r2 = await c.call('check', { project: 'sub/esc2.mzc' });
    assert(r2.isError && r2.structuredContent.code === 'outside-root', textOf(r2));
  });

  await test('引数: 知らない引数は bad-args（op の dry_run・save には apply を案内する）', async () => {
    const r = await c.call('check', { project: 'sub/small.mzc', extra: 1 });
    assert(r.isError && r.structuredContent.code === 'bad-args' && r.structuredContent.unknown.includes('extra'), textOf(r));
    const before = sha(project);
    const r2 = await c.call('op', { project: 'demo.mzc', ops: 'move clip_b 6', dry_run: false });
    assert(r2.isError && r2.structuredContent.code === 'bad-args' && textOf(r2).includes('apply=true'), textOf(r2));
    assert(sha(project) === before, 'ファイルが変わりました');
  });

  await test('時刻: エンジンの書き方に合わないもの（1:75、1:2:3:4、1e21）は bad-args', async () => {
    for (const time of ['1:75', '1:2:3:4', 1e21, 1.79e308, '-1', '1e3']) {
      const r = await c.call('preview', { project: 'sub/small.mzc', time });
      assert(r.isError && r.structuredContent.code === 'bad-args', `${time}: ${textOf(r)}`);
    }
    const r = await c.call('render', { project: 'sub/small.mzc', from: '0:99' });
    assert(r.isError && r.structuredContent.code === 'bad-args', textOf(r));
  });

  await test('preview: 全体の長さより後ろは beyondEnd、時:分:秒も読める', async () => {
    const r = await c.call('preview', { project: 'sub/small.mzc', time: '0:00:05' });
    assert(!r.isError, textOf(r));
    assert(r.structuredContent.beyondEnd === true && r.structuredContent.time === 5, JSON.stringify(r.structuredContent));
    const r2 = await c.call('preview', { project: 'sub/small.mzc', time: 0.5 });
    assert(!r2.isError && r2.structuredContent.beyondEnd === false, JSON.stringify(r2.structuredContent));
  }, { skip: !media });

  await test('preview: 既定で 1280 画素まで縮め、max_width=0 で元の大きさ。キャッシュは新しい 20 枚だけ残す', async () => {
    fs.writeFileSync(path.join(PROJ_DIR, 'big.mzc'), 'project size=1920x1080 fps=30\ncolor 336699 id=bg dur=1\n');
    const r = await c.call('preview', { project: 'big.mzc', time: 0 });
    assert(!r.isError, textOf(r));
    const s = pngSize(Buffer.from(r.content.find((x) => x.type === 'image').data, 'base64'));
    assert(s.width === 1280 && s.height === 720, `既定の大きさ ${s.width}x${s.height}`);
    const r2 = await c.call('preview', { project: 'big.mzc', time: 0, max_width: 0 });
    const s2 = pngSize(Buffer.from(r2.content.find((x) => x.type === 'image').data, 'base64'));
    assert(s2.width === 1920, `max_width=0 の大きさ ${s2.width}`);
    for (let i = 0; i < 12; i++) await c.call('preview', { project: 'big.mzc', time: 0.01 * i, max_width: 64 });
    const left = fs.readdirSync(path.join(PROJ_DIR, 'big.cache', 'mcp')).filter((n) => n.startsWith('preview-'));
    assert(left.length <= 20, `キャッシュの画像 ${left.length} 枚`);
  }, { skip: !media });

  await test('preview: save_as は既にあれば overwrite が要る。素材には書かない', async () => {
    const shot = path.join(PROJ_DIR, 'shots', 'one.png');
    const before = sha(shot);
    const r = await c.call('preview', { project: 'demo.mzc', time: 2, save_as: 'shots/one.png' });
    assert(r.isError && r.structuredContent.code === 'output-exists', textOf(r));
    assert(sha(shot) === before, '断ったのに書き換わりました');
    const r2 = await c.call('preview', { project: 'demo.mzc', time: 2, save_as: 'shots/one.png', overwrite: true });
    assert(!r2.isError, textOf(r2));
    const logo = path.join(PROJ_DIR, 'media', 'logo.png');
    const logoSha = sha(logo);
    const r3 = await c.call('preview', { project: 'demo.mzc', time: 2, save_as: 'media/logo.png', overwrite: true });
    assert(r3.isError && r3.structuredContent.code === 'output-is-source', textOf(r3));
    assert(sha(logo) === logoSha, '素材が書き換わりました');
  }, { skip: !media });

  await test('render: 素材・.mzc を書き出し先にすると断り、素材は変わらない。既にある書き出し先は overwrite が要る', async () => {
    const clip = path.join(PROJ_DIR, 'media', 'clip_b.mp4');
    const before = sha(clip);
    for (const output of ['media/clip_b.mp4', './media/../media/clip_b.mp4']) {
      for (const overwrite of [false, true]) {
        const r = await c.call('render', { project: 'demo.mzc', output, to: 1, overwrite });
        assert(r.isError && r.structuredContent.code === 'output-is-source', `${output} ${overwrite}: ${textOf(r)}`);
      }
    }
    fs.writeFileSync(path.join(PROJ_DIR, 'srcout.mzc'), 'project size=320x180 fps=30 output=media/clip_b.mp4\nvideo media/clip_b.mp4 id=a dur=1\n');
    const r2 = await c.call('render', { project: 'srcout.mzc', overwrite: true });
    assert(r2.isError && r2.structuredContent.code === 'output-is-source', textOf(r2));
    const r3 = await c.call('render', { project: 'demo.mzc', output: 'demo.cache/x.mp4' });
    assert(r3.isError && r3.structuredContent.code === 'output-is-source', textOf(r3));
    assert(sha(clip) === before, '素材が書き換わりました');
    const r4 = await c.call('render', { project: 'demo.mzc', output: 'renders/part.mp4', from: 6, to: 6.5 });
    assert(r4.isError && r4.structuredContent.code === 'output-exists', textOf(r4));
    const tools = (await c.request('tools/list', {})).result.tools;
    assert(tools.find((t) => t.name === 'render').annotations.destructiveHint === true, 'render の destructiveHint');
    assert(tools.find((t) => t.name === 'preview').annotations.readOnlyHint === false, 'preview の readOnlyHint');
  }, { skip: !media });

  await test('render: from が全体の長さ以上なら job を作らずに bad-args', async () => {
    const n = (await c.call('render_status', {})).structuredContent.jobs.length;
    const r = await c.call('render', { project: 'demo.mzc', output: 'renders/none.mp4', from: 999 });
    assert(r.isError && r.structuredContent.code === 'bad-args' && !r.structuredContent.started, textOf(r));
    assert((await c.call('render_status', {})).structuredContent.jobs.length === n, 'job ができました');
  }, { skip: !media });

  await test('render: 書き出し中の同じプロジェクトへの preview・op・check は busy（キャッシュと .mzc がぶつからない）', async () => {
    fs.rmSync(path.join(PROJ_DIR, 'demo.cache'), { recursive: true, force: true }); // キャッシュを空にして、展開とぶつかりやすくする
    const before = sha(project);
    const r = await c.call('render', { project: 'demo.mzc', output: 'renders/busy.mp4', from: 4, to: 5.5 });
    assert(!r.isError, textOf(r));
    const id = r.structuredContent.job_id;
    const pv = await c.call('preview', { project: 'demo.mzc', time: 5 });
    assert((pv.isError && pv.structuredContent.code === 'busy') || !pv.isError, `preview: ${textOf(pv)}`);
    const op = await c.call('op', { project: 'demo.mzc', ops: 'move clip_b 6', apply: true });
    assert((op.isError && op.structuredContent.code === 'busy') || !op.isError, `op: ${textOf(op)}`);
    if (!op.isError) throw new Fail('書き出し中に op が通りました');
    const ck = await c.call('check', { project: 'demo.mzc' });
    assert(ck.isError && ck.structuredContent.code === 'busy', `check: ${textOf(ck)}`);
    assert(sha(project) === before, '書き出し中に .mzc が変わりました');
    // ほかのプロジェクトは書き出し中でも使える
    const other = await c.call('check', { project: 'sub/small.mzc' });
    assert(!other.isError, textOf(other));
    const st = await c.call('render_status', { job_id: id, wait_seconds: 300 });
    assert(st.structuredContent.state === 'done', `state ${st.structuredContent.state}\n${(st.structuredContent.log || []).join('\n')}`);
    const pv2 = await c.call('preview', { project: 'demo.mzc', time: 5 });
    assert(!pv2.isError, `書き出しの後の preview: ${textOf(pv2)}`);
  }, { skip: !media });

  await test('render: cancel は子のプロセスが終わるまで待ち、途中のファイル（*.tmp、out.y4m）を残さない', async () => {
    fs.rmSync(path.join(PROJ_DIR, 'demo.cache'), { recursive: true, force: true });
    const r = await c.call('render', { project: 'demo.mzc', output: 'renders/cancel.mp4' });
    assert(!r.isError, textOf(r));
    await new Promise((res) => setTimeout(res, 1500));
    const st = await c.call('render_status', { job_id: r.structuredContent.job_id, cancel: true });
    assert(st.structuredContent.state === 'cancelled' && st.structuredContent.exitCode !== null, JSON.stringify(st.structuredContent));
    const cache = path.join(PROJ_DIR, 'demo.cache');
    const left = fs.existsSync(cache) ? fs.readdirSync(cache).filter((n) => n.endsWith('.tmp') || n === 'out.y4m' || n === 'out.pcm') : [];
    assert(left.length === 0, `残ったファイル: ${left.join(', ')}`);
    assert(!fs.existsSync(path.join(PROJ_DIR, 'renders', 'cancel.mp4')), '途中までの書き出し先が残りました');
  }, { skip: !media });

  await test('font: 相対パスはプロジェクトのフォルダから探す（サーバーを起動したフォルダに左右されない）', async () => {
    // サーバーの起動したフォルダ（TMP。許したフォルダの外）にだけ fonts/a.ttf を置く
    fs.mkdirSync(path.join(TMP, 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'fonts', 'a.ttf'), 'not a font');
    fs.writeFileSync(path.join(PROJ_DIR, 'fontcwd.mzc'), 'project size=320x180 fps=30 font=fonts/a.ttf\ncolor 336699 id=bg dur=1\n');
    const r = await c.call('check', { project: 'fontcwd.mzc' });
    assert(!r.isError, textOf(r));
    assert(r.structuredContent.diagnostics.some((d) => d.code === 'font-not-found'), `外のフォントを読みました: ${JSON.stringify(r.structuredContent.diagnostics)}`);
    fs.mkdirSync(path.join(PROJ_DIR, 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(PROJ_DIR, 'fonts', 'a.ttf'), 'not a font');
    // 中身はフォントではないので「読めません」の警告は出てよい。「見つかりません」でないこと（プロジェクトのフォルダで見つけた）を見る
    const r2 = await c.call('check', { project: 'fontcwd.mzc' });
    assert(!r2.structuredContent.diagnostics.some((d) => d.code === 'font-not-found' && d.message.includes('見つかりません')), JSON.stringify(r2.structuredContent.diagnostics));
  });

  await test('font: OS のフォントは読むだけで使える。外のフォントは check・show では警告、preview では断る', async () => {
    const cands = process.platform === 'win32'
      ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf'), path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'YuGothM.ttc')]
      : ['/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
    const sysFont = cands.find((f) => fs.existsSync(f));
    if (sysFont) {
      fs.writeFileSync(path.join(PROJ_DIR, 'sysfont.mzc'), `project size=320x180 fps=30 font="${sysFont.split(path.sep).join('/')}"\ncolor 336699 id=bg dur=1\n`);
      const r = await c.call('check', { project: 'sysfont.mzc' });
      assert(!r.isError && r.structuredContent.ok === true && !r.structuredContent.serverWarnings, textOf(r));
      const s = await c.call('show', { project: 'sysfont.mzc' });
      assert(!s.isError, textOf(s));
    } else console.log('    （OS のフォントが見つからないので、その部分は飛ばしました）');
    fs.writeFileSync(path.join(OUTSIDE, 'x.ttf'), 'not a font');
    fs.writeFileSync(path.join(PROJ_DIR, 'outfont.mzc'), `project size=320x180 fps=30 font="${path.join(OUTSIDE, 'x.ttf').split(path.sep).join('/')}"\ncolor 336699 id=bg dur=1\n`);
    const r = await c.call('check', { project: 'outfont.mzc' });
    assert(!r.isError && Array.isArray(r.structuredContent.serverWarnings) && textOf(r).includes('サーバーの警告'), textOf(r));
    const s = await c.call('show', { project: 'outfont.mzc' });
    assert(!s.isError && textOf(s).includes('サーバーの警告'), textOf(s));
    const p = await c.call('preview', { project: 'outfont.mzc', time: 0 });
    assert(p.isError && p.structuredContent.code === 'outside-root', textOf(p));
  });

  await test('バッチの要求（配列）にも答える', async () => {
    const p1 = c.wait('901', 20000);
    const p2 = c.wait('902', 20000);
    c.writeLine(JSON.stringify([{ jsonrpc: '2.0', id: 901, method: 'ping' }, { jsonrpc: '2.0', id: 902, method: 'tools/list' }]));
    const [a, b] = await Promise.all([p1, p2]);
    assert(a.result && b.result.tools, 'バッチ');
  });

  await test('標準出力には JSON-RPC のメッセージだけが出る', async () => {
    const bad = c.raw.filter((m) => m.bad !== undefined);
    assert(bad.length === 0, `JSON でない行: ${bad.map((b) => b.bad).join(' / ')}`);
    for (const m of c.raw.flatMap((x) => (Array.isArray(x) ? x : [x]))) assert(m.jsonrpc === '2.0', JSON.stringify(m).slice(0, 200));
  });

  const code = await c.close();
  await test('標準入力を閉じると終わる', async () => {
    assert(code === 0, `終了コード ${code}`);
  });

  await test('リポジトリの demo/demo.mzc は書き換えていない', async () => {
    assert(sha(DEMO) === demoHash, 'demo/demo.mzc が変わりました');
  });
}

try {
  await main();
} catch (e) {
  failures.push({ name: '（テストの準備）', e });
  console.log(e.stack);
} finally {
  if (KEEP) console.log(`作業用のフォルダ: ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passed} 個成功、${failures.length} 個失敗${skipped ? `、${skipped} 個飛ばしました` : ''}`);
process.exit(failures.length ? 1 : 0);
