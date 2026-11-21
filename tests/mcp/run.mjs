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
