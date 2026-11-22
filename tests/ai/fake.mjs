// AI の層の試しの道具: 手元に立てる偽の相手（node の http サーバー）と、試しのプログラムの HTTP の中継と、記録した形の応答。
// 本物の AI の API（api.anthropic.com など）は呼ばない。中継は 127.0.0.1 の相手だけに頼み、ほかは断る。
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// 偽の相手
// ---------------------------------------------------------------------------

// queue: 返す応答の列（{status, headers, chunks}）。頼みが来るたびに先頭から返す。
// GET の /api/tags と /v1/models は列を使わず tags を返す。
// 返り値: { url, requests, close() }。requests には届いた頼み（method・url・headers・body・json）が入る。
export async function startFake(queue, { tags = null, delayMs = 2 } = {}) {
  const requests = [];
  const left = [...queue];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { json = null; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, json });
      if (req.method === 'GET' && (req.url === '/api/tags' || req.url === '/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(tags ?? {}));
        return;
      }
      const r = left.shift();
      if (!r) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: '偽の相手: 返す応答がもうありません' } }));
        return;
      }
      const headers = {};
      for (const h of r.headers || []) {
        const k = h.indexOf(':');
        headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
      }
      res.writeHead(r.status ?? 200, headers);
      for (const c of r.chunks || []) {
        res.write(c);
        // 少し待って、別々の分として届くようにする
        await new Promise((ok) => setTimeout(ok, delayMs));
      }
      res.end();
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    left,
    close: () => new Promise((ok) => server.close(ok)),
  };
}

// 使っていない口（つながらない相手を試す）。
export async function deadUrl() {
  const s = http.createServer();
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const { port } = s.address();
  await new Promise((ok) => s.close(ok));
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// 中継: 試しのプログラムの "@@http {...}" を受けて HTTP で頼み、届いた分を 1 行の JSON で標準入力に返す
// ---------------------------------------------------------------------------

function allowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// exe を args で動かし、終わるまで中継する。返り値: { code, lines（@@http 以外の標準出力の行）, stderr, relayed（中継した頼みの URL） }
export function runRelay(exe, args, { env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    const relayed = [];
    const live = new Map();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.on('error', () => {});
    const send = (obj) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(obj) + '\n');
    };
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (line.startsWith('@@cancel ')) {
        const { id } = JSON.parse(line.slice(9));
        live.get(id)?.destroy();
        live.delete(id);
        return;
      }
      if (!line.startsWith('@@http ')) {
        lines.push(line);
        return;
      }
      const q = JSON.parse(line.slice(7));
      relayed.push(q.url);
      if (!allowed(q.url)) {
        send({ id: q.id, error: `試しの中継は 127.0.0.1 の相手だけに頼みます（${q.url} は断りました）` });
        return;
      }
      const headers = {};
      for (const h of q.headers) {
        const k = h.indexOf(':');
        headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
      }
      const req = http.request(q.url, { method: q.method, headers }, (res) => {
        const hs = Object.entries(res.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        res.setEncoding('utf8');
        res.on('data', (c) => send({ id: q.id, status: res.statusCode, headers: hs, data: c, done: false }));
        res.on('end', () => {
          live.delete(q.id);
          send({ id: q.id, status: res.statusCode, headers: hs, data: '', done: true });
        });
      });
      live.set(q.id, req);
      req.on('error', (e) => {
        live.delete(q.id);
        send({ id: q.id, error: e.code || e.message });
      });
      if (q.body) req.write(q.body);
      req.end();
    });
    child.on('close', (code) => resolve({ code, lines, stderr, relayed }));
  });
}

// 出力の行から、印（@@ev など）の JSON を取り出す。
export function pick(lines, tag) {
  return lines.filter((l) => l.startsWith(tag + ' ')).map((l) => JSON.parse(l.slice(tag.length + 1)));
}

// ---------------------------------------------------------------------------
// 記録した形の応答
// ---------------------------------------------------------------------------

// 文字列を n 文字ずつに分ける（行の途中で切れる分を作る）。
export function split(s, n = 37) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

let msgN = 0;
// Claude の Messages API の stream。blocks: {type:'text',text} / {type:'tool_use',id,name,input} / {type:'thinking',thinking,signature}
export function claudeSse(blocks, stopReason, { stopDetails = null, cacheRead = 0, cacheWrite = 0, pieces = 7 } = {}) {
  let s = sse('message_start', {
    message: {
      id: `msg_fake_${++msgN}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null,
      usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
    },
  });
  s += sse('ping', {});
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      s += sse('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const p of split(b.text, 3)) s += sse('content_block_delta', { index, delta: { type: 'text_delta', text: p } });
    } else if (b.type === 'thinking') {
      s += sse('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
      if (b.thinking) s += sse('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      s += sse('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'tool_use') {
      s += sse('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const json = typeof b.input === 'string' ? b.input : JSON.stringify(b.input);
      for (const p of split(json, pieces)) s += sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: p } });
    }
    s += sse('content_block_stop', { index });
  });
  const delta = { stop_reason: stopReason, stop_sequence: null };
  if (stopDetails) delta.stop_details = stopDetails;
  s += sse('message_delta', { delta, usage: { output_tokens: 42 } });
  s += sse('message_stop', {});
  return { status: 200, headers: ['content-type: text/event-stream'], chunks: split(s) };
}

export function claudeError(status, type, message, extraHeaders = []) {
  return {
    status,
    headers: ['content-type: application/json', ...extraHeaders],
    chunks: [JSON.stringify({ type: 'error', error: { type, message } })],
  };
}

// OpenAI 互換の stream。text と toolCalls（{id,name,args}。args は分けて送る）。
export function openaiSse(text, toolCalls = []) {
  const ev = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: 'local-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let s = ev({ role: 'assistant', content: '' });
  for (const p of split(text, 4)) if (p) s += ev({ content: p });
  toolCalls.forEach((tc, index) => {
    s += ev({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] });
    for (const p of split(JSON.stringify(tc.args), 6)) s += ev({ tool_calls: [{ index, function: { arguments: p } }] });
  });
  s += ev({}, toolCalls.length ? 'tool_calls' : 'stop');
  s += 'data: [DONE]\n\n';
  return { status: 200, headers: ['content-type: text/event-stream'], chunks: split(s, 50) };
}

// Ollama の /api/chat の stream（行区切りの JSON）。
export function ollamaNdjson(text, toolCalls = []) {
  const lines = [];
  const base = { model: 'llama3.2', created_at: '2026-11-22T00:00:00Z' };
  for (const p of split(text, 4)) if (p) lines.push({ ...base, message: { role: 'assistant', content: p }, done: false });
  if (toolCalls.length) {
    lines.push({ ...base, message: { role: 'assistant', content: '', tool_calls: toolCalls.map((t) => ({ function: { name: t.name, arguments: t.args } })) }, done: false });
  }
  lines.push({ ...base, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 30 });
  const s = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return { status: 200, headers: ['content-type: application/x-ndjson'], chunks: split(s, 45) };
}
