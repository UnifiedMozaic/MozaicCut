#!/usr/bin/env node
// AI の層（src/ai/）のテスト。node tests/ai/run.mjs で流す（-v、--keep）。npm の依存はない。
//
// tests/ai/agent_test.um をビルドし、手元に立てた node の偽の相手（tests/ai/fake.mjs）に、標準入出力の中継で本当に HTTP で頼ませる。
// 本物の AI の API は呼ばない（中継は 127.0.0.1 の相手だけに頼む）。API キーは偽の値だけを使う。
// 確かめること:
//   - Claude の SSE（文字、ツールの入力の分割、thinking の返し方、refusal、429・5xx の再試行、401 の言葉）と頼みの形
//   - Ollama と OpenAI 互換の頼みと応答の形、モデルの一覧
//   - エージェントが偽の応答に従って check → op の提案を出し、適用で .mzc を書き換えること（取り消し 1 つ分の元の中身、history）
//   - 本物の HTTP の口（AG_HTTP_REAL。UnifiedMozaic の HTTP の組み込み）で、中継なしに偽の相手（http://127.0.0.1）へ
//     Claude の SSE（文字とツールの往復）・Ollama の行区切りの JSON・OpenAI 互換を最後まで流せること
//   - 設定の保存（伏せたキー、ANTHROPIC_API_KEY）、Claude Code の編集を拾う口
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTool, TMP, VERBOSE } from '../umtest.mjs';
import { startFake, deadUrl, runRelay, pick, claudeSse, claudeError, openaiSse, ollamaNdjson } from './fake.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.argv.includes('--keep');
const EXE = buildTool('agent_test', path.join(HERE, 'agent_test.um'));

const EV_TEXT = 1, EV_TOOL = 2, EV_PROPOSAL = 3, EV_ERROR = 4, EV_DONE = 5, EV_RETRY = 6, EV_REFUSAL = 7;
const FAKE_KEY = 'dummy-not-a-real-key';
const PROJECT = 'project size=320x180 fps=30\ncolor red id=a dur=3\ncolor blue id=b dur=2\n';

class Fail extends Error {}
const assert = (c, m) => { if (!c) throw new Fail(m); };
const eq = (a, e, m) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(e);
  if (x !== y) throw new Fail(`${m}\n    期待: ${y}\n    実際: ${x}`);
};

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    if (VERBOSE) console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  NG  ${name}\n    ${e instanceof Fail ? e.message : e.stack}`);
  }
}

let fileN = 0;
function put(name, data) {
  const f = path.join(TMP, `${++fileN}-${name}`);
  fs.writeFileSync(f, data);
  return f;
}
const childEnv = (extra = {}) => {
  const env = { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy', MOZCUT_AI_CONFIG: path.join(TMP, 'none', 'ai.json'), ...extra };
  if (!('ANTHROPIC_API_KEY' in extra)) delete env.ANTHROPIC_API_KEY;
  return env;
};
const cfg = (obj) => put('cfg.json', JSON.stringify({ apiKey: FAKE_KEY, retryBaseSec: 0.01, ...obj }));
async function chat(config, project, prompts, cmd = 'chat') {
  const r = await runRelay(EXE, [cmd, config, project, ...prompts], { env: childEnv(), cwd: TMP });
  if (r.code !== 0) throw new Fail(`agent_test が終了コード ${r.code} で終わりました\n${r.stderr}`);
  return { ...r, ev: pick(r.lines, '@@ev'), done: pick(r.lines, '@@done')[0], apply: pick(r.lines, '@@apply'), panel: pick(r.lines, '@@panel'), usage: pick(r.lines, '@@usage')[0] };
}
const texts = (ev) => ev.filter((e) => e.kind === EV_TEXT).map((e) => e.text).join('');
const kinds = (ev, k) => ev.filter((e) => e.kind === k);
const findBlocks = (json, type) => (json.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === type);

// エージェントの筋書き: check → op を試す（入力は細かく分けて届く）→ op を提案にする → まとめの文
function agentScript() {
  return [
    claudeSse([{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'text', text: 'まず配置を確かめます。' }, { type: 'tool_use', id: 'toolu_1', name: 'check', input: {} }], 'tool_use'),
    claudeSse([{ type: 'tool_use', id: 'toolu_2', name: 'op', input: { ops: ['move b 5'] } }], 'tool_use', { pieces: 3 }),
    claudeSse([{ type: 'tool_use', id: 'toolu_3', name: 'op', input: { ops: ['move b 5'], apply: true } }], 'tool_use'),
    claudeSse([{ type: 'text', text: 'b を 5 秒に動かす提案を出しました。' }], 'end_turn', { cacheRead: 5000 }),
  ];
}

// ---- Claude ----

await test('Claude: 頼みの形（モデル・adaptive thinking・effort・fallbacks・キャッシュ・strict なツール・ヘッダー）', async () => {
  const fake = await startFake([claudeSse([{ type: 'text', text: 'こんにちは。' }], 'end_turn')]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['こんにちは']);
    eq(fake.requests.length, 1, '頼みの数');
    const q = fake.requests[0];
    eq([q.method, q.url], ['POST', '/v1/messages'], 'URL');
    eq(q.headers['x-api-key'], FAKE_KEY, 'x-api-key');
    eq(q.headers['anthropic-version'], '2026-10-21', 'anthropic-version');
    eq(q.headers['anthropic-beta'], 'server-side-fallback-2026-07-01', 'anthropic-beta');
    eq(q.headers['content-type'], 'application/json', 'content-type');
    const j = q.json;
    eq([j.model, j.stream, j.thinking, j.output_config, j.fallbacks], ['claude-opus-5-5', true, { type: 'adaptive' }, { effort: 'medium' }, 'default'], '本文の設定');
    assert(!('temperature' in j) && !('top_p' in j), 'temperature や top_p は送らない');
    eq(j.tool_choice, { type: 'auto' }, 'tool_choice は auto');
    eq(j.tools.map((t) => t.name), ['check', 'show', 'schema', 'op', 'preview', 'analyze_audio', 'transcribe', 'list_media', 'inspect_media'], 'ツールの名前と順');
    assert(j.tools.every((t) => t.strict === true && t.eager_input_streaming === true && t.input_schema.additionalProperties === false), 'strict と eager_input_streaming');
    eq(j.tools.map((t) => !!t.cache_control), [false, false, false, false, false, false, false, false, true], '最後のツールにキャッシュの区切り');
    eq(j.system[0].cache_control, { type: 'ephemeral' }, 'system にキャッシュの区切り');
    assert(j.system[0].text.includes('# schema') && j.system[0].text.includes('"keys"'), 'system に要点と schema が入る');
    eq(texts(r.ev), 'こんにちは。', '届いた文字');
    eq(kinds(r.ev, EV_DONE).map((e) => e.text), ['こんにちは。'], '終わりの出来事');
  } finally {
    await fake.close();
  }
});

await test('Claude: system とツールは呼ぶたびに同じ（キャッシュが効く）。thinking の塊は受け取ったまま返す', async () => {
  const fake = await startFake([
    claudeSse([{ type: 'thinking', thinking: '', signature: 'sig-keep-me' }, { type: 'text', text: '一つ目' }], 'end_turn'),
    claudeSse([{ type: 'text', text: '二つ目' }], 'end_turn', { cacheRead: 4096 }),
  ]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['一つ目', '二つ目']);
    eq(fake.requests.length, 2, '頼みの数');
    const [a, b] = fake.requests.map((q) => q.json);
    eq(JSON.stringify(b.system), JSON.stringify(a.system), 'system が同じ');
    eq(JSON.stringify(b.tools), JSON.stringify(a.tools), 'ツールの定義が同じ');
    eq(b.messages.map((m) => m.role), ['user', 'assistant', 'user'], '会話の履歴');
    eq(b.messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig-keep-me' }, 'thinking を返す');
    eq(b.messages[2].content.at(-1).cache_control, { type: 'ephemeral' }, '最後の user の塊にキャッシュの区切り');
    assert(!a.messages[0].content.some((x) => x.cache_control) || a.messages.length === 1, '');
    eq(r.done.cacheRead, 4096, 'キャッシュから読んだ量を受け取る');
  } finally {
    await fake.close();
  }
});

await test('使った量: キャッシュの読み書き・fallback の iterations・Haiku の長い頼みを、モデルごとに数えて料金を付ける', async () => {
  const near = (a, e, m) => assert(Math.abs(a - e) < 1e-9, `${m}: 期待 ${e}、実際 ${a}`);
  const fake = await startFake([
    // 1: Opus 5.5。入力 1200・出力 42・キャッシュの書き込み 3000 → (1200×4 + 42×20 + 3000×5) / 1M
    claudeSse([{ type: 'text', text: '一つ目' }], 'end_turn', { cacheWrite: 3000 }),
    // 2: fallback で Sonnet 5.5 も答えた（iterations のモデルごとの量で数える）
    claudeSse([{ type: 'text', text: '二つ目' }], 'end_turn', {
      cacheRead: 2000, input: 2500, output: 80,
      iterations: [
        { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
        { model: 'claude-sonnet-5-5', input_tokens: 1500, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    }),
    // 3: Haiku 5.5 の 10 万トークンを超える頼み（入力 0.50・出力 2.50）
    claudeSse([{ type: 'text', text: '三つ目' }], 'end_turn', { model: 'claude-haiku-5-5', input: 150000, output: 1000 }),
    // 4: 表にないモデル（量だけ）
    claudeSse([{ type: 'text', text: '四つ目' }], 'end_turn', { model: 'claude-mystery-9', input: 100, output: 10 }),
  ]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url, yenPerUsd: '150' }), put('p.mzc', PROJECT), ['一つ目', '二つ目', '三つ目', '四つ目']);
    const u = r.usage;
    const by = Object.fromEntries(u.chat.map((x) => [x.model, x]));
    eq(Object.keys(by), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-mystery-9'], 'モデルごと');
    eq([by['claude-opus-5-5'].in, by['claude-opus-5-5'].out, by['claude-opus-5-5'].cr, by['claude-opus-5-5'].cw], [2200, 42, 2000, 3000], 'Opus の量');
    near(by['claude-opus-5-5'].usd, (1200 * 4 + 42 * 20 + 3000 * 5 + 1000 * 4 + 2000 * 0.2) / 1e6, 'Opus の料金');
    near(by['claude-sonnet-5-5'].usd, (1500 * 2 + 80 * 10) / 1e6, 'Sonnet の料金');
    near(by['claude-haiku-5-5'].usd, (150000 * 0.5 + 1000 * 2.5) / 1e6, 'Haiku の長い頼みの料金');
    eq(by['claude-mystery-9'].priced, false, '表にないモデルは料金が分からない');
    eq(u.turnLine, '入力 100・出力 10・料金が分かりません', '最後の頼みの 1 行');
    // 合計 0.02504 + 0.0038 + 0.0775 = 0.10634 ドル → 約 $0.11（150 円で約 ¥16）
    eq(u.chatLine, '入力 159k・出力 1.1k・約 $0.11（約 ¥16）＋料金の分からない分', '会話の合計の 1 行');
    eq(u.month, new Date().toISOString().slice(0, 7), '月は応答の Date の見出しから');
    near(u.bookUsd, 0.10634, '月ごとの記録（書いて読み直す）');
  } finally {
    await fake.close();
  }
});

await test('使った量: Ollama は 0 円、OpenAI 互換は設定の料金（空なら量だけ）', async () => {
  const fo = await startFake([ollamaNdjson('はい。')]);
  try {
    const r = await chat(put('cfg.json', JSON.stringify({ provider: 'ollama', ollamaUrl: fo.url, ollamaModel: 'llama3.2' })), put('p.mzc', PROJECT), ['こんにちは']);
    eq(r.usage.turnLine, '入力 900・出力 30・$0（手元の AI）', 'Ollama');
  } finally {
    await fo.close();
  }
  const fa = await startFake([openaiSse('はい。', [], { prompt_tokens: 20000, completion_tokens: 5000 }), openaiSse('はい。', [], { prompt_tokens: 20000, completion_tokens: 5000 })]);
  try {
    const base = { provider: 'openai', openaiUrl: fa.url + '/v1', openaiModel: 'local-model' };
    const r = await chat(put('cfg.json', JSON.stringify({ ...base, openaiPriceIn: '1', openaiPriceOut: '2' })), put('p.mzc', PROJECT), ['こんにちは']);
    eq(fa.requests[0].json.stream_options, { include_usage: true }, '量を返すように頼む');
    eq(r.usage.turnLine, '入力 20.0k・出力 5.0k・約 $0.03', 'OpenAI 互換（料金あり）');
    const r2 = await chat(put('cfg.json', JSON.stringify(base)), put('p.mzc', PROJECT), ['こんにちは']);
    eq(r2.usage.turnLine, '入力 20.0k・出力 5.0k・料金が分かりません', 'OpenAI 互換（料金なし）');
  } finally {
    await fa.close();
  }
});

await test('エージェント: 偽の応答に従って check → op（分かれて届く入力）→ 提案を出す。ファイルは変わらない', async () => {
  const fake = await startFake(agentScript());
  const proj = put('p.mzc', PROJECT);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), proj, ['b を 5 秒に動かして']);
    eq(fake.requests.length, 4, '頼みの数（ツールの往復 3 回 + まとめ）');
    const q2 = fake.requests[1].json;
    const tr = findBlocks(q2, 'tool_result');
    eq(tr.map((b) => b.tool_use_id), ['toolu_1'], 'check の結果を返す');
    assert(tr[0].content[0].text.includes('"clips"') && !tr[0].is_error, 'check の JSON');
    eq(findBlocks(q2, 'thinking'), [{ type: 'thinking', thinking: '', signature: 'sig-1' }], 'ツールの往復でも thinking を返す');
    const q3 = fake.requests[2].json;
    const tr2 = findBlocks(q3, 'tool_result').at(-1);
    eq(tr2.tool_use_id, 'toolu_2', 'op（試し）の結果');
    assert(tr2.content[0].text.includes('dry_run') && tr2.content[0].text.includes('b を 3 秒から 5 秒に動かしました'), `試しの結果: ${tr2.content[0].text.slice(0, 200)}`);
    eq(findBlocks(q3, 'tool_use').find((b) => b.id === 'toolu_2').input, { ops: ['move b 5'] }, '分かれて届いた入力を JSON として読む');
    const tr3 = findBlocks(fake.requests[3].json, 'tool_result').at(-1);
    assert(tr3.content[0].text.startsWith('提案 p1:'), '提案にしたことを AI に返す');
    eq(kinds(r.ev, EV_TOOL).map((e) => e.name), ['check', 'op', 'op'], 'ツールの出来事');
    eq(kinds(r.ev, EV_PROPOSAL).map((e) => e.text), ['p1'], '提案の出来事');
    eq(r.done.proposals, [{ id: 'p1', ops: ['move b 5'], state: 0 }], '提案');
    eq(texts(r.ev), 'まず配置を確かめます。b を 5 秒に動かす提案を出しました。', '返事の文字');
    eq(fs.readFileSync(proj, 'utf8'), PROJECT, '提案だけでは .mzc は変わらない');
  } finally {
    await fake.close();
  }
});

await test('エージェント: ［適用］で .mzc を書き換え、取り消し 1 つ分の元の中身と history の 1 行を返す。次の頼みで AI に知らせる', async () => {
  const fake = await startFake([...agentScript(), claudeSse([{ type: 'text', text: 'はい。' }], 'end_turn')]);
  const proj = put('p.mzc', PROJECT);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), proj, ['b を 5 秒に動かして', '!apply 0', 'ありがとう']);
    eq(r.panel[0].ops, 1, '画面の提案の形（ui_ai の AiProposal）');
    const a = r.apply[0];
    assert(a.ok, `適用できる: ${a.error}`);
    eq(a.before, PROJECT, '元の中身（取り消し 1 つ分）');
    eq(fs.readFileSync(proj, 'utf8'), a.after, '書いた中身');
    assert(a.after.includes('color blue id=b dur=2 at=5'), `b が 5 秒に動く: ${a.after}`);
    eq(a.desc, 'AI の提案（1 操作）', '取り消しの説明');
    const hist = fs.readFileSync(proj + '.history', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    eq(hist.length, 1, 'history の行');
    eq([hist[0].who, hist[0].ops, hist[0].applied, hist[0].via, hist[0].provider, hist[0].t], ['ai', ['move b 5'], true, 'app', 'claude', '2026-11-22T10:00:00+09:00'], 'history の中身');
    eq(r.done.proposals[0].state, 1, '提案は適用済み');
    const last = fake.requests.at(-1).json.messages.at(-1);
    assert(last.content[0].text.includes('提案 p1 を利用者が適用しました'), '次の頼みで適用を知らせる');
  } finally {
    await fake.close();
  }
});

await test('エージェント: 提案の後にファイルが変わって当てはまらなければ、適用せずに理由を返す', async () => {
  const fake = await startFake(agentScript());
  const proj = put('p.mzc', PROJECT);
  const other = put('other.mzc', PROJECT.replace('color blue id=b dur=2\n', ''));
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), proj, ['b を 5 秒に動かして', `!replace ${other}`, '!apply 0']);
    const a = r.apply[0];
    eq(a.ok, false, '適用しない');
    assert(a.error.includes('もう当てはまりません'), a.error);
    eq(fs.readFileSync(proj, 'utf8'), fs.readFileSync(other, 'utf8'), 'ファイルはそのまま');
    assert(!fs.existsSync(proj + '.history'), 'history に書かない');
    eq(r.done.proposals[0].state, 0, '提案は残る');
  } finally {
    await fake.close();
  }
});

await test('Claude: ツールの入力がスキーマに合わなければ実行せず、is_error の結果を返して続ける', async () => {
  const fake = await startFake([
    claudeSse([{ type: 'tool_use', id: 'toolu_bad', name: 'op', input: { ops: 'move b 5' } }], 'tool_use'),
    claudeSse([{ type: 'tool_use', id: 'toolu_cut', name: 'op', input: '{"ops":["move b' }], 'tool_use'),
    claudeSse([{ type: 'text', text: '直しました。' }], 'end_turn'),
  ]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['動かして']);
    const tr = findBlocks(fake.requests[1].json, 'tool_result').at(-1);
    eq(tr.is_error, true, 'is_error');
    assert(tr.content[0].text.includes('スキーマに合いません') && tr.content[0].text.includes('input.ops'), tr.content[0].text);
    const tr2 = findBlocks(fake.requests[2].json, 'tool_result').at(-1);
    assert(tr2.is_error && tr2.content[0].text.includes('JSON として読めません'), `途中で切れた入力: ${tr2.content[0].text}`);
    eq(r.done.proposals, [], '提案はない');
    eq(kinds(r.ev, EV_DONE).length, 1, '最後まで進む');
  } finally {
    await fake.close();
  }
});

await test('Claude: refusal は分かる言葉で出し、断られた頼みは会話に残さない', async () => {
  const fake = await startFake([
    claudeSse([], 'refusal', { stopDetails: { type: 'refusal', category: 'cyber', explanation: '偽の説明' } }),
  ]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['危ない頼み']);
    const ref = kinds(r.ev, EV_REFUSAL);
    eq(ref.length, 1, 'refusal の出来事');
    assert(ref[0].text.includes('断りました') && ref[0].text.includes('cyber') && ref[0].text.includes('偽の説明'), ref[0].text);
    eq([r.done.phase, r.done.msgs], [0, 0], '待ちに戻り、会話は空');
  } finally {
    await fake.close();
  }
});

await test('Claude: ツールの往復の途中で断られても、次の頼みは結果のない tool_use を含まない', async () => {
  const fake = await startFake([
    claudeSse([{ type: 'tool_use', id: 'toolu_c', name: 'check', input: {} }], 'tool_use'),
    claudeSse([], 'refusal', { stopDetails: { type: 'refusal', category: null, explanation: '' } }),
    claudeSse([{ type: 'text', text: 'はい。' }], 'end_turn'),
  ]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['一つ目', '二つ目']);
    eq(kinds(r.ev, EV_REFUSAL).length, 1, 'refusal の出来事');
    const m = fake.requests[2].json.messages;
    eq(m.map((x) => x.role), ['user'], '断られた頼みの往復をまとめて取り下げる');
    eq(m[0].content.at(-1).text, '二つ目', '次の頼み');
    eq(texts(r.ev), 'はい。', '次の頼みは通る');
  } finally {
    await fake.close();
  }
});

await test('Claude: 429（retry-after）と 5xx は待って頼み直す', async () => {
  const fake = await startFake([
    claudeError(429, 'rate_limit_error', '偽: 多すぎます', ['retry-after: 0']),
    claudeError(529, 'overloaded_error', '偽: 混んでいます'),
    claudeSse([{ type: 'text', text: '通りました' }], 'end_turn'),
  ]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['こんにちは']);
    eq(fake.requests.length, 3, '頼みの数');
    eq(kinds(r.ev, EV_RETRY).length, 2, '頼み直しの出来事');
    assert(kinds(r.ev, EV_RETRY)[0].text.includes('429'), kinds(r.ev, EV_RETRY)[0].text);
    eq(texts(r.ev), '通りました', '最後は通る');
    eq(JSON.stringify(fake.requests[2].json.messages), JSON.stringify(fake.requests[0].json.messages), '同じ頼みを送り直す');
  } finally {
    await fake.close();
  }
});

await test('Claude: 頼み直しの回数を超えたら、分かる言葉で止まる', async () => {
  const fake = await startFake([claudeError(500, 'api_error', '偽: 壊れています'), claudeError(500, 'api_error', '偽: 壊れています')]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url, maxRetries: 1 }), put('p.mzc', PROJECT), ['こんにちは']);
    eq(fake.requests.length, 2, '頼みの数');
    const err = kinds(r.ev, EV_ERROR);
    assert(err.length === 1 && err[0].text.includes('相手の側で誤り') && err[0].text.includes('偽: 壊れています'), JSON.stringify(err));
    eq(r.done.phase, 3, '誤りで止まる');
  } finally {
    await fake.close();
  }
});

await test('Claude: 401 は頼み直さず、キーを確かめる言葉を出す。キーは記録に残さない', async () => {
  const fake = await startFake([claudeError(401, 'authentication_error', 'invalid x-api-key')]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['こんにちは']);
    eq(fake.requests.length, 1, '頼みの数');
    const err = kinds(r.ev, EV_ERROR);
    assert(err[0].text.startsWith('API キーが正しくありません'), err[0].text);
    assert(!r.lines.join('\n').includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), 'キーを出力に書かない');
  } finally {
    await fake.close();
  }
});

await test('Claude: キーがなければ頼まずに、入れ方を言う', async () => {
  const r = await chat(put('cfg.json', JSON.stringify({ provider: 'claude', claudeUrl: 'http://127.0.0.1:9' })), put('p.mzc', PROJECT), ['こんにちは']);
  eq(r.relayed.length, 0, '頼まない');
  assert(kinds(r.ev, EV_ERROR)[0].text.includes('ANTHROPIC_API_KEY'), kinds(r.ev, EV_ERROR)[0].text);
});

await test('偽の実装（記録した応答を返す AG_HTTP_FAKE）: 中継なしで check → 提案。記録した頼みのキーは伏せる', async () => {
  const f = put('fixture.json', JSON.stringify(agentScript()));
  const r = await runRelay(EXE, ['fake', cfg({ provider: 'claude' }), f, put('p.mzc', PROJECT), 'b を 5 秒に動かして'], { env: childEnv(), cwd: TMP });
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  eq(r.relayed.length, 0, '中継していない');
  const done = pick(r.lines, '@@done')[0];
  eq(done.proposals, [{ id: 'p1', ops: ['move b 5'], state: 0 }], '提案');
  const reqs = pick(r.lines, '@@req');
  eq(reqs.length, 4, '頼みの数');
  eq(reqs[0].url, 'https://api.anthropic.com/v1/messages', '既定の URL（偽物なので呼ばない）');
  assert(reqs[0].headers.includes('x-api-key: (伏せた値)') && !reqs[0].headers.join().includes(FAKE_KEY), 'キーを伏せる');
});

// ---- Ollama と OpenAI 互換 ----

await test('Ollama: /api/chat の形（stream・tools・tool の結果）と、check → op の提案', async () => {
  const fake = await startFake([
    ollamaNdjson('見ます。', [{ name: 'check', args: {} }]),
    ollamaNdjson('', [{ name: 'op', args: { ops: ['move b 5'], apply: true } }]),
    ollamaNdjson('提案しました。'),
  ]);
  try {
    const r = await chat(put('cfg.json', JSON.stringify({ provider: 'ollama', ollamaUrl: fake.url, ollamaModel: 'llama3.2' })), put('p.mzc', PROJECT), ['b を 5 秒に']);
    eq(fake.requests.map((q) => q.url), ['/api/chat', '/api/chat', '/api/chat'], 'URL');
    const j = fake.requests[0].json;
    eq([j.model, j.stream], ['llama3.2', true], '本文');
    eq(j.messages[0].role, 'system', 'system は最初の発言');
    eq(j.tools.map((t) => [t.type, t.function.name]), [['function', 'check'], ['function', 'show'], ['function', 'schema'], ['function', 'op'], ['function', 'preview'], ['function', 'analyze_audio'], ['function', 'transcribe'], ['function', 'list_media'], ['function', 'inspect_media']], 'ツール');
    const m2 = fake.requests[1].json.messages;
    eq(m2.at(-2).tool_calls, [{ function: { name: 'check', arguments: {} } }], 'ツールの呼び出しを返す');
    eq([m2.at(-1).role, m2.at(-1).tool_name], ['tool', 'check'], 'ツールの結果');
    assert(m2.at(-1).content.includes('"clips"'), 'check の JSON');
    eq(r.done.proposals, [{ id: 'p1', ops: ['move b 5'], state: 0 }], '提案');
    eq(texts(r.ev), '見ます。提案しました。', '文字');
  } finally {
    await fake.close();
  }
});

await test('Ollama: /api/tags でモデルの一覧を取る', async () => {
  const fake = await startFake([], { tags: { models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] } });
  try {
    const r = await runRelay(EXE, ['models', put('cfg.json', JSON.stringify({ provider: 'ollama', ollamaUrl: fake.url }))], { env: childEnv(), cwd: TMP });
    eq(pick(r.lines, '@@models')[0], { names: ['llama3.2:latest', 'qwen2.5:7b'] }, '一覧');
    eq([fake.requests[0].method, fake.requests[0].url], ['GET', '/api/tags'], '頼み');
  } finally {
    await fake.close();
  }
});

await test('Ollama: 起動していなければ、起動を促す言葉を出す', async () => {
  const url = await deadUrl();
  const r = await chat(put('cfg.json', JSON.stringify({ provider: 'ollama', ollamaUrl: url, ollamaModel: 'llama3.2' })), put('p.mzc', PROJECT), ['こんにちは']);
  const err = kinds(r.ev, EV_ERROR);
  assert(err.length === 1 && err[0].text.startsWith(`Ollama（${url}）につながりません`), JSON.stringify(err));
});

await test('OpenAI 互換: /chat/completions の形（stream・tools・tool_call_id）と、分かれて届く引数から提案', async () => {
  const fake = await startFake([
    openaiSse('確かめます。', [{ id: 'call_a', name: 'check', args: {} }]),
    openaiSse('', [{ id: 'call_b', name: 'op', args: { ops: ['move b 5'], apply: true } }]),
    openaiSse('提案しました。'),
  ], { tags: { data: [{ id: 'local-model' }] } });
  try {
    const conf = put('cfg.json', JSON.stringify({ provider: 'openai', openaiUrl: fake.url + '/v1', openaiModel: 'local-model' }));
    const r = await chat(conf, put('p.mzc', PROJECT), ['b を 5 秒に']);
    eq(fake.requests.map((q) => q.url), ['/v1/chat/completions', '/v1/chat/completions', '/v1/chat/completions'], 'URL');
    const j = fake.requests[0].json;
    eq([j.model, j.stream, j.tool_choice], ['local-model', true, 'auto'], '本文');
    assert(!fake.requests[0].headers.authorization, 'キーがなければ authorization を送らない');
    const m2 = fake.requests[1].json.messages;
    eq(m2.at(-2).tool_calls, [{ id: 'call_a', type: 'function', function: { name: 'check', arguments: '{}' } }], 'ツールの呼び出しを返す');
    eq([m2.at(-1).role, m2.at(-1).tool_call_id], ['tool', 'call_a'], 'ツールの結果');
    eq(r.done.proposals, [{ id: 'p1', ops: ['move b 5'], state: 0 }], '提案');
    const models = await runRelay(EXE, ['models', conf], { env: childEnv(), cwd: TMP });
    eq(pick(models.lines, '@@models')[0], { names: ['local-model'] }, 'モデルの一覧（/v1/models）');
  } finally {
    await fake.close();
  }
});

// ---- 本物の HTTP の口（AG_HTTP_REAL） ----
// 試しのプログラムが自分で http://127.0.0.1 の偽の相手に頼む（標準入出力の中継は使わない）。

await test('本物の口: Claude の SSE で check → op（分かれて届く入力）→ 提案まで流す。頼みのヘッダーと会話の形', async () => {
  const fake = await startFake(agentScript());
  const proj = put('p.mzc', PROJECT);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), proj, ['b を 5 秒に動かして'], 'chat-real');
    eq(r.relayed.length, 0, '中継していない');
    eq(fake.requests.length, 4, '頼みの数（ツールの往復 3 回 + まとめ）');
    const q = fake.requests[0];
    eq([q.method, q.url, q.headers['x-api-key'], q.headers['anthropic-version'], q.headers['content-type']], ['POST', '/v1/messages', FAKE_KEY, '2026-10-21', 'application/json'], '頼みの形');
    eq(q.json.stream, true, 'stream');
    eq(findBlocks(fake.requests[1].json, 'tool_result').map((b) => b.tool_use_id), ['toolu_1'], 'check の結果を返す');
    eq(findBlocks(fake.requests[2].json, 'tool_use').find((b) => b.id === 'toolu_2').input, { ops: ['move b 5'] }, '分かれて届いた入力');
    eq(kinds(r.ev, EV_TOOL).map((e) => e.name), ['check', 'op', 'op'], 'ツールの出来事');
    eq(r.done.proposals, [{ id: 'p1', ops: ['move b 5'], state: 0 }], '提案');
    eq(texts(r.ev), 'まず配置を確かめます。b を 5 秒に動かす提案を出しました。', '返事の文字');
    eq([r.done.phase, r.done.cacheRead], [0, 5000], '待ちに戻り、使った量を受け取る');
    eq(kinds(r.ev, EV_ERROR), [], '誤りはない');
  } finally {
    await fake.close();
  }
});

await test('本物の口: Claude の 429 は頼み直し、401 はキーを確かめる言葉で止まる', async () => {
  const fake = await startFake([
    claudeError(429, 'rate_limit_error', '偽: 多すぎます', ['retry-after: 0']),
    claudeSse([{ type: 'text', text: '通りました' }], 'end_turn'),
    claudeError(401, 'authentication_error', 'invalid x-api-key'),
  ]);
  try {
    const r = await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['一つ目', '二つ目'], 'chat-real');
    eq(fake.requests.length, 3, '頼みの数');
    eq(kinds(r.ev, EV_RETRY).length, 1, '頼み直しの出来事');
    eq(kinds(r.ev, EV_TEXT).map((e) => e.text).join(''), '通りました', '一つ目は通る');
    assert(kinds(r.ev, EV_ERROR)[0]?.text.startsWith('API キーが正しくありません'), JSON.stringify(kinds(r.ev, EV_ERROR)));
  } finally {
    await fake.close();
  }
});

await test('本物の口: Ollama の行区切りの JSON で check → op の提案。/api/tags の一覧', async () => {
  const fake = await startFake([
    ollamaNdjson('見ます。', [{ name: 'check', args: {} }]),
    ollamaNdjson('', [{ name: 'op', args: { ops: ['move b 5'], apply: true } }]),
    ollamaNdjson('提案しました。'),
  ], { tags: { models: [{ name: 'llama3.2:latest' }] } });
  try {
    const conf = put('cfg.json', JSON.stringify({ provider: 'ollama', ollamaUrl: fake.url, ollamaModel: 'llama3.2' }));
    const r = await chat(conf, put('p.mzc', PROJECT), ['b を 5 秒に'], 'chat-real');
    eq(r.relayed.length, 0, '中継していない');
    eq(fake.requests.map((q) => q.url), ['/api/chat', '/api/chat', '/api/chat'], 'URL');
    const m2 = fake.requests[1].json.messages;
    eq([m2.at(-1).role, m2.at(-1).tool_name], ['tool', 'check'], 'ツールの結果');
    eq(r.done.proposals, [{ id: 'p1', ops: ['move b 5'], state: 0 }], '提案');
    eq(texts(r.ev), '見ます。提案しました。', '文字');
    const models = await runRelay(EXE, ['models-real', conf], { env: childEnv(), cwd: TMP });
    eq(pick(models.lines, '@@models')[0], { names: ['llama3.2:latest'] }, 'モデルの一覧');
  } finally {
    await fake.close();
  }
});

await test('本物の口: Ollama が起動していなければ、起動を促す言葉を出す', async () => {
  const url = await deadUrl();
  const r = await chat(put('cfg.json', JSON.stringify({ provider: 'ollama', ollamaUrl: url, ollamaModel: 'llama3.2' })), put('p.mzc', PROJECT), ['こんにちは'], 'chat-real');
  const err = kinds(r.ev, EV_ERROR);
  assert(err.length === 1 && err[0].text.startsWith(`Ollama（${url}）につながりません`), JSON.stringify(err));
  eq(r.done.phase, 3, '誤りで止まる');
});

await test('本物の口: OpenAI 互換の SSE で、分かれて届く引数から提案。/v1/models の一覧', async () => {
  const fake = await startFake([
    openaiSse('確かめます。', [{ id: 'call_a', name: 'check', args: {} }]),
    openaiSse('', [{ id: 'call_b', name: 'op', args: { ops: ['move b 5'], apply: true } }]),
    openaiSse('提案しました。'),
  ], { tags: { data: [{ id: 'local-model' }] } });
  try {
    const conf = put('cfg.json', JSON.stringify({ provider: 'openai', openaiUrl: fake.url + '/v1', openaiModel: 'local-model' }));
    const r = await chat(conf, put('p.mzc', PROJECT), ['b を 5 秒に'], 'chat-real');
    eq(r.relayed.length, 0, '中継していない');
    eq(fake.requests.map((q) => q.url), ['/v1/chat/completions', '/v1/chat/completions', '/v1/chat/completions'], 'URL');
    const m2 = fake.requests[1].json.messages;
    eq([m2.at(-1).role, m2.at(-1).tool_call_id], ['tool', 'call_a'], 'ツールの結果');
    eq(r.done.proposals, [{ id: 'p1', ops: ['move b 5'], state: 0 }], '提案');
    eq(texts(r.ev), '確かめます。提案しました。', '文字');
    const models = await runRelay(EXE, ['models-real', conf], { env: childEnv(), cwd: TMP });
    eq(pick(models.lines, '@@models')[0], { names: ['local-model'] }, 'モデルの一覧');
  } finally {
    await fake.close();
  }
});

// ---- ツール ----

await test('ツール: preview は PNG を返し、Claude には画像として渡す', async () => {
  const fake = await startFake([
    claudeSse([{ type: 'tool_use', id: 'toolu_p', name: 'preview', input: { time: 1, max_width: 64 } }], 'tool_use'),
    claudeSse([{ type: 'text', text: '赤い画面です。' }], 'end_turn'),
  ]);
  try {
    await chat(cfg({ provider: 'claude', claudeUrl: fake.url }), put('p.mzc', PROJECT), ['見て']);
    const tr = findBlocks(fake.requests[1].json, 'tool_result')[0];
    eq(tr.content.map((c) => c.type), ['text', 'image'], '文と画像');
    eq(tr.content[1].source.media_type, 'image/png', 'PNG');
    const png = Buffer.from(tr.content[1].source.data, 'base64');
    eq([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG', 'PNG の印');
    eq([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 36], '縮めた大きさ');
  } finally {
    await fake.close();
  }
});

await test('ツール: check・show・schema・op の誤り（MCP サーバーと同じ中身）', async () => {
  const proj = put('p.mzc', PROJECT);
  const tool = async (name, input) => pick((await runRelay(EXE, ['tools', proj, name, JSON.stringify(input)], { env: childEnv(), cwd: TMP })).lines, '@@tool')[0];
  const c = await tool('check', {});
  const cj = JSON.parse(c.text);
  eq([cj.ok, cj.clips.map((x) => x.id)], [true, ['a', 'b']], 'check');
  assert((await tool('show', { width: 60 })).text.includes('b'), 'show');
  eq(Object.keys(JSON.parse((await tool('schema', { section: 'ops' })).text)), ['ops'], 'schema の section');
  const bad = await tool('op', { ops: ['move zzz 5'] });
  assert(bad.isError && bad.text.includes('"ok":false'), 'op の失敗');
  const unknown = await tool('show', { width: 60, extra: 1 });
  assert(unknown.isError && unknown.text.includes('知らないキー extra'), unknown.text);
});

// ---- 設定 ----

await test('設定: %APPDATA%/MozaicCut/ai.json に置き、キーは伏せて見せる。ANTHROPIC_API_KEY も使える', async () => {
  const appdata = path.join(TMP, 'appdata');
  const env = { APPDATA: appdata, MOZCUT_AI_CONFIG: '' };
  const saved = pick((await runRelay(EXE, ['config-save', 'claude', 'claude-opus-5-5', 'dummy-key-abcd1234'], { env: childEnv(env), cwd: TMP })).lines, '@@saved')[0];
  eq(path.resolve(saved.path), path.resolve(appdata, 'MozaicCut', 'ai.json'), '置き場所');
  eq([saved.ok, saved.same, saved.safe.apiKey, saved.safe.keySource], [true, true, '••••••••1234', '設定'], '保存と読み直し・伏せたキー');
  const onDisk = JSON.parse(fs.readFileSync(path.join(appdata, 'MozaicCut', 'ai.json'), 'utf8'));
  eq([onDisk.provider, onDisk.claudeModel], ['claude', 'claude-opus-5-5'], 'ファイルの中身');
  // キーのない設定 + 環境変数
  const env2 = { MOZCUT_AI_CONFIG: put('nokey.json', JSON.stringify({ provider: 'claude' })), ANTHROPIC_API_KEY: 'dummy-env-value' };
  const shown = pick((await runRelay(EXE, ['config'], { env: childEnv(env2), cwd: TMP })).lines, '@@config')[0];
  eq([shown.safe.apiKey, shown.safe.keySource, shown.safe.claudeModel], ['', '環境変数 ANTHROPIC_API_KEY', 'claude-opus-5-5'], '環境変数のキー');
});

// ---- Claude Code（外の AI） ----

await test('Claude Code: MCP サーバーの記録（.mzc.history の via:mcp）と .mzc の変化を拾い、履歴の行にする', async () => {
  const proj = put('ext.mzc', PROJECT.replace('dur=2', 'dur=2 at=5'));
  const own = put('own.mzc', PROJECT);
  fs.writeFileSync(proj + '.history', [
    JSON.stringify({ t: '2026-11-22T09:00:00+09:00', who: 'ai', via: 'app', ops: ['move a 1'], desc: 'アプリの行' }),
    JSON.stringify({ t: '2026-11-22T09:01:00+09:00', who: 'ai', via: 'mcp', client: 'claude-code', tool: 'op', ops: ['move b 5'], desc: 'b を 3 秒から 5 秒に動かしました', changes: [{ kind: 'edit', line: 3, before: 'color blue id=b dur=2', after: 'color blue id=b dur=2 at=5' }] }),
  ].join('\n') + '\n');
  const r = await runRelay(EXE, ['watch', proj, own, '0'], { env: childEnv(), cwd: TMP });
  const w = pick(r.lines, '@@watch')[0];
  eq(w.changed, true, '変化を拾う');
  eq(w.items, [{ who: 1, desc: 'Claude Code: b を 3 秒から 5 秒に動かしました', ops: ['move b 5'], changes: 1, t: '2026-11-22T09:01:00+09:00' }], 'MCP の行だけを履歴にする');
  eq(pick(r.lines, '@@watch2')[0], { changed: false, items: 0 }, '同じものは二度返さない');
  const line = pick((await runRelay(EXE, ['mcp-line'], { env: childEnv(), cwd: TMP })).lines, '@@mcp')[0];
  eq(line.line, 'claude mcp add mozaiccut -- mozcut mcp --root C:/Videos/projects', '登録の 1 行');
});

if (KEEP) console.log(`作業用のフォルダ: ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true });
console.log(`ai: ${passed} 件通過、${failures.length} 件失敗`);
process.exit(failures.length ? 1 : 0);
