// テストを子プロセスで同時に流すための小さな道具（tests/run.mjs と tests/all.mjs が使う）。npm の依存はない。
//
// - jobsFromArgs(argv): -j N / --jobs N / --jobs=N を読む（なければ CPU の数）。
// - runParallel(jobs, n, onDone): jobs（{ name, cmd, args, env?, weight? }）を n 個ずつ同時に流す（weight の大きいものから始める）。出力（標準出力と標準エラー）は
//   1 つの job ごとにまとめてためておき、終わったら onDone(job, result) を呼ぶ。onDone は並べた順に呼ぶ
//   （前の job がまだなら、終わるまで待ってから）ので、画面の出力が job の間で混ざらず、毎回同じ順になる。
// - SUMMARY_TAG: 子が最後に出す集計の行の印（「@@mozcut-summary {JSON}」）。
import { spawn } from 'node:child_process';
import os from 'node:os';

export const SUMMARY_TAG = '@@mozcut-summary ';

export function cpuCount() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

export function jobsFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v = null;
    if (a === '-j' || a === '--jobs') v = argv[i + 1];
    else if (a.startsWith('--jobs=')) v = a.slice(7);
    else if (/^-j\d+$/.test(a)) v = a.slice(2);
    else continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`-j / --jobs には 1 以上の整数を書いてください（'${v}'）`);
      process.exit(2);
    }
    return n;
  }
  return cpuCount();
}

// -j N の N も含めて、オプションを外した名前だけを返す。
export function positionalArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-j' || a === '--jobs') {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

// 子の出力から集計の行を抜き出す。{ text: 集計の行を除いた出力, summary: JSON か null }
export function takeSummary(text) {
  let summary = null;
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(SUMMARY_TAG)) {
      try {
        summary = JSON.parse(line.slice(SUMMARY_TAG.length));
      } catch {
        kept.push(line);
      }
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join('\n').replace(/\s+$/, ''), summary };
}

function runOne(job) {
  return new Promise((resolve) => {
    const start = Date.now();
    let out = '';
    let child;
    try {
      child = spawn(job.cmd, job.args, { cwd: job.cwd, env: job.env || process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: null, out: `起動できません: ${e.message}`, ms: 0 });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => (out += `\n起動できません: ${e.message}`));
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - start }));
  });
}

export async function runParallel(jobs, n, onDone) {
  const results = new Array(jobs.length);
  const settled = new Array(jobs.length).fill(false);
  // 始める順は重い（weight の大きい）ものから。いちばん長い job が最後に始まって全体を待たせないように
  const order = jobs.map((_, i) => i).sort((a, b) => (jobs[b].weight || 0) - (jobs[a].weight || 0) || a - b);
  let next = 0;
  let reported = 0;
  const flush = () => {
    while (reported < jobs.length && settled[reported]) {
      onDone(jobs[reported], results[reported]);
      reported++;
    }
  };
  const worker = async () => {
    while (next < jobs.length) {
      const k = order[next++];
      results[k] = await runOne(jobs[k]);
      settled[k] = true;
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker));
  flush();
  return results;
}
