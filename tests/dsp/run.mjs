#!/usr/bin/env node
// 音の処理（src/dsp/）のテスト。node tests/dsp/run.mjs で実行する（npm の依存なし）。
//
// 1. src/dsp/*.um と tests/dsp/dsp_test.um を一時フォルダに写してネイティブでビルドする
//    （UM の import は最初のファイルのフォルダの中しか読めないため、<一時>/dsp/ と <一時>/dsp_test.um に置く）。
// 2. `dsp_test test` の出力（「名前 値」の行）を、許容の範囲や JavaScript で計算した値と比べる。
// 3. Node で s16le の試験のファイルを作り、`dsp_test loudness` / `speech` でファイルからも測る。
//
// オプション:
//   --bench [秒]  速さを測って出す（既定 60 秒の 48 kHz ステレオ）
//   --keep        作業用のフォルダを消さずに残す
//   -v            すべての値を出す
//
// wgpu-native が見つかれば（環境変数 UM_WGPU_HOME か ~/wgpu-native/<版>）、波形の kernel を UM_WGPU=1 でも作り、
// CPU と GPU の結果がビットまで同じことを確かめる（tests/dsp/wave_gpu.um）。見つからなければ飛ばす。
//
// UnifiedMozaic は環境変数 UM_HOME か、このリポジトリの隣（../UnifiedMozaic）から探す。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('-v');
const BENCH = argv.includes('--bench');
const benchArg = BENCH ? argv[argv.indexOf('--bench') + 1] : undefined;
const benchSec = benchArg && /^[0-9.]+$/.test(benchArg) ? benchArg : '60';

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(os.homedir(), 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください');
  process.exit(2);
}

function wgpuHome() {
  if (process.env.UM_WGPU_HOME && fs.existsSync(process.env.UM_WGPU_HOME)) return process.env.UM_WGPU_HOME;
  const base = path.join(os.homedir(), 'wgpu-native');
  if (!fs.existsSync(base)) return undefined;
  const vers = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'include', 'webgpu', 'webgpu.h'))).sort();
  return vers.length ? path.join(base, vers[vers.length - 1]) : undefined;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-dsp-'));
const EXE = path.join(TMP, 'dsp_test' + (process.platform === 'win32' ? '.exe' : ''));

function build() {
  fs.mkdirSync(path.join(TMP, 'dsp'));
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'dsp'))) {
    if (f.endsWith('.um')) fs.copyFileSync(path.join(ROOT, 'src', 'dsp', f), path.join(TMP, 'dsp', f));
  }
  fs.copyFileSync(path.join(HERE, 'dsp_test.um'), path.join(TMP, 'dsp_test.um'));
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', path.join(TMP, 'dsp_test.um'), '--target', 'host', '-o', EXE],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    console.error('ビルドに失敗しました');
    cleanup();
    process.exit(1);
  }
}

function run(args) {
  const r = spawnSync(EXE, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    throw new Error(`dsp_test ${args.join(' ')} が終了コード ${r.status} で終わりました`);
  }
  return r.stdout;
}

function cleanup() {
  if (KEEP) console.log(`作業用のフォルダ: ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
}

// ---- 比べる道具

let passed = 0;
const failures = [];
const vals = new Map();
const strs = new Map();

function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(`${name}: ${detail}`);
}
function num(name) {
  if (!vals.has(name)) {
    failures.push(`${name}: 出力にありません`);
    return NaN;
  }
  return vals.get(name);
}
function near(name, want, tol) {
  const v = num(name);
  check(name, Math.abs(v - want) <= tol, `${v}（期待 ${want} ± ${tol}）`);
}
function below(name, limit) {
  const v = num(name);
  check(name, v <= limit, `${v}（${limit} 以下のはず）`);
}
function above(name, limit) {
  const v = num(name);
  check(name, v >= limit, `${v}（${limit} 以上のはず）`);
}
function rel(name, want, tol) {
  const v = num(name);
  const e = Math.abs(v - want) / Math.max(1e-300, Math.abs(want));
  check(name, e <= tol || Math.abs(v - want) <= 1e-300, `${v}（期待 ${want}、相対誤差 ${e.toExponential(2)} > ${tol}）`);
}
function str(name) {
  if (!strs.has(name)) {
    failures.push(`${name}: 出力にありません`);
    return '';
  }
  return strs.get(name);
}
function json(name) {
  try {
    return JSON.parse(str(name));
  } catch (e) {
    failures.push(`${name}: JSON として読めません: ${str(name)}`);
    return null;
  }
}

// RBJ の式（JavaScript で同じものを計算して比べる）
function rbj(kind, f, q, g, fs) {
  const w0 = 2 * Math.PI * f / fs, cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * q), A = Math.pow(10, g / 40);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'peak') {
    [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A];
  } else if (kind === 'lowshelf') {
    const sa = 2 * Math.sqrt(A) * alpha;
    [b0, b1, b2] = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)];
    [a0, a1, a2] = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa];
  } else {
    const sa = 2 * Math.sqrt(A) * alpha;
    [b0, b1, b2] = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)];
    [a0, a1, a2] = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa];
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function coefs(name, want, tol) {
  const got = str(name).split(',').map(Number);
  const err = Math.max(...want.map((w, i) => Math.abs(w - got[i])));
  check(name, got.length === 5 && err <= tol, `${got.join(',')}（期待 ${want.join(',')}、誤差 ${err}）`);
}

// s16le ステレオのファイルを作る。segs は [信号の関数（秒 → -1..1）, 秒] の並び。
function writeS16(file, rate, segs) {
  const frames = segs.reduce((n, [, sec]) => n + Math.round(sec * rate), 0);
  const buf = Buffer.alloc(frames * 4);
  let pos = 0;
  for (const [fn, sec] of segs) {
    const n = Math.round(sec * rate);
    for (let j = 0; j < n; j++) {
      const v = Math.max(-32768, Math.min(32767, Math.round(fn(j / rate) * 32768)));
      buf.writeInt16LE(v, (pos + j) * 4);
      buf.writeInt16LE(v, (pos + j) * 4 + 2);
    }
    pos += n;
  }
  fs.writeFileSync(file, buf);
}

// ---- 本体

build();
try {
  const t0 = Date.now();
  const outText = run(['test']);
  const elapsed = Date.now() - t0;
  for (const line of outText.split(/\r?\n/)) {
    const m = /^(\S+) (.*)$/.exec(line);
    if (!m) continue;
    strs.set(m[1], m[2]);
    const v = Number(m[2]);
    if (m[2] !== '' && !Number.isNaN(v)) vals.set(m[1], v);
    else if (m[2] === 'NaN') vals.set(m[1], NaN);
  }
  if (VERBOSE) process.stdout.write(outText);
  check('done', num('done') === 1, '最後まで走っていません');

  // 数学: JavaScript の Math と比べる
  for (const [k, v] of vals) {
    let m;
    if ((m = /^exp\((.*)\)$/.exec(k))) rel(k, Math.exp(Number(m[1])), 2e-15);
    else if ((m = /^ln\((.*)\)$/.exec(k))) {
      const x = Number(m[1]);
      const w = Math.log(x);
      if (Math.abs(w) < 1e-6) near(k, w, 1e-17);
      else rel(k, w, 2e-15);
    } else if ((m = /^(sin|cos)\((.*)\)$/.exec(k))) {
      const x = Number(m[2]);
      const w = m[1] === 'sin' ? Math.sin(x) : Math.cos(x);
      // 引数が大きいと、引数の丸め（|x| * 2^-53 程度）の分だけずれる
      near(k, w, 4e-16 + Math.abs(x) * 2.5e-16);
    }
    void v;
  }
  rel('pow(2,0.5)', Math.SQRT2, 2e-15);
  rel('pow(10,-1.15)', Math.pow(10, -1.15), 2e-15);
  rel('dbToGain(-6)', Math.pow(10, -6 / 20), 2e-15);
  rel('gainToDb(0.5)', 20 * Math.log10(0.5), 2e-15);
  rel('log10(2)', Math.log10(2), 2e-15);
  below('err_ln_exp', 1e-14);
  below('err_sin2cos2', 1e-15);
  check('sorted', str('sorted') === '-5.5,-1,0,2,2,3,10,', str('sorted'));
  check('fmt', str('fmt') === '-23|0.3|null', str('fmt'));

  // バイクアッド: 応答の式と、正弦波を通して測った値が合う
  for (let k = 0; k < 8; k++) {
    for (const hz of [100, 1000, 3000]) {
      const mag = num(`bq_${k}_${hz}_mag`);
      const meas = num(`bq_${k}_${hz}_meas`);
      // 深い減衰（ノッチの中心など）は測りにくいので、-40 dB より下は「十分に小さい」ことだけ
      if (mag < -40) check(`bq_${k}_${hz}`, meas < -30, `測定 ${meas} dB（式 ${mag} dB）`);
      else check(`bq_${k}_${hz}`, Math.abs(mag - meas) < 0.05, `測定 ${meas} dB と式 ${mag} dB が合いません`);
    }
  }
  near('bq_4_1000_mag', 6, 1e-9); // ピーク +6 dB の中心
  near('bq_0_1000_mag', 20 * Math.log10(1), 1e-9); // Q=1 の低域通過の遮断周波数は 0 dB
  near('bq_7_1000_mag', 0, 1e-9); // 全域通過
  near('bq_5_100_mag', 6, 0.3); // 低域シェルフの低域
  near('bq_6_3000_mag', 6, 0.5); // 高域シェルフの高域（Q=1 なので少し行き過ぎる）
  coefs('bq_peak_coefs', rbj('peak', 1234, 0.8, -4.5, 48000), 1e-13);
  coefs('bq_lowshelf_coefs', rbj('lowshelf', 150, 0.7071, 5, 44100), 1e-13);
  // K 特性を設計し直したものは、規格の 48 kHz の係数に近い
  coefs('k_s1_coefs', [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585], 1e-4);
  coefs('k_s2_coefs', [1, -2, 1, -1.99004745483398, 0.99007225036621], 1e-4);

  const eq = json('eq_json');
  if (eq) {
    check('eq_json.bands', eq.bands.length === 6, JSON.stringify(eq));
    check('eq_json.band0', eq.bands[0].type === 'highpass' && eq.bands[0].freq === 80, JSON.stringify(eq.bands[0]));
    check('eq_json.band3', eq.bands[3].on === false && eq.bands[3].gainDb === -12, JSON.stringify(eq.bands[3]));
  }
  near('eq_mag_1000', 4, 0.15);
  below('eq_mag_20', -10);
  near('eq_mag_3000', 0, 0.6); // 切った帯（-12 dB）は効かない
  near('eq_curve_n', 64, 0);
  near('eq_curve_f0', 20, 1e-9);
  near('eq_curve_flast', 20000, 1e-6);
  const eq8 = json('eq8_json');
  if (eq8) {
    check('eq8_json', eq8.bands.length === 8 && eq8.bands[0].type === 'lowshelf' && eq8.bands[7].type === 'highshelf', JSON.stringify(eq8));
    const fr = eq8.bands.map((b) => b.freq);
    check('eq8_freqs', fr.slice(1, 7).every((f, i, a) => i === 0 || f > a[i - 1]), fr.join(','));
  }
  below('eq8_flat_maxdiff', 1e-6);

  // コンプレッサー
  near('comp_curve_-30', 0, 1e-12);
  near('comp_curve_-10', -7.5, 1e-12);
  near('compk_curve_-26', 0, 1e-12);
  near('compk_curve_-20', -0.75 * 25 / 20, 1e-12); // (1/4-1) * (5)^2 / (2*10)
  near('compk_curve_-14', -4.5, 1e-12); // ニーの上端は直線と同じ
  near('compk_curve_0', -15, 1e-12);
  near('comp_square_out_db', -17.5 + 3, 0.02);
  near('comp_attack_5ms_gr', -7.5 * (1 - Math.exp(-1)), 0.2);
  const cj = json('comp_json');
  if (cj) check('comp_json', cj.ratio === 4 && cj.makeupDb === 3, JSON.stringify(cj));

  // リミッター
  above('lim_in_truepeak_db', 6.0);
  below('lim_out_samplepeak_db', -1.0 + 1e-6);
  below('lim_out_truepeak_db', -1.0 + 0.3);
  above('lim_out_truepeak_db', -3.0);
  near('lim_latency', 240 + 6, 0);
  near('lim2_latency', 96 + 6, 0);
  near('lim2_impulse', 0.25, 1e-7);
  near('lim2_impulse_r', -0.25, 1e-7);
  below('lim2_rest_peak', 1e-9);

  // ゲート
  below('gate_quiet_db', -120);
  near('gate_open_db', -13.01, 0.1); // -10 dBFS の正弦波の RMS
  below('gate_after_db', -120);

  // パン・フェード
  near('pan0_l', Math.SQRT1_2, 1e-15);
  near('pan0_r', Math.SQRT1_2, 1e-15);
  near('panL_l', 1, 1e-15);
  near('panL_r', 0, 1e-15);
  below('pan_pow_err', 1e-15);
  near('fade_lin_05', 0.5, 0);
  near('fade_pow_05', Math.SQRT1_2, 1e-15);
  near('fade_s_05', 0.5, 1e-15);
  near('fade_s_025', 0.5 - 0.5 * Math.cos(Math.PI / 4), 1e-15);
  near('fade_pow_0', 0, 0);
  near('fade_pow_1', 1, 1e-15);
  below('xfade_pow_err', 1e-15);
  below('xfade_s_err', 1e-15);
  near('gain_-6', Math.pow(10, -6 / 20), 1e-7);
  near('fadein_50', 0, 0);
  near('fadein_150', 0.5, 1e-7);
  near('fadein_250', 1, 0);
  near('panmono_right_l', 0, 1e-7);
  near('panmono_right_r', 1, 1e-7);
  near('balance_05_l', Math.SQRT1_2, 1e-7);
  near('balance_05_r', 1, 0);

  // ラウドネス（EBU Tech 3341 は ±0.1 LU、3342 は ±1 LU が合格）
  near('ebu3341_1_I', -23, 0.1);
  near('ebu3341_1_M', -23, 0.1);
  near('ebu3341_1_S', -23, 0.1);
  near('ebu3341_1_tp', -23, 0.1);
  near('ebu3341_1_lra', 0, 0.1);
  near('ebu3341_2_I', -33, 0.1);
  near('ebu3341_3_I', -23, 0.1);
  near('ebu3341_4_I', -23, 0.1);
  near('ebu3341_5_I', -23, 0.1);
  near('ebu3342_1_lra', 10, 1);
  near('ebu3342_2_lra', 5, 1);
  near('ebu3342_3_lra', 20, 1);
  near('ebu3342_4_lra', 15, 1);
  near('tp_fs4_tp', 0, 0.3);
  near('tp_fs4_sp', -3.01, 0.01);
  near('tp_11025_tp', -6.02, 0.3);
  near('k44_I', -23, 0.15);
  near('mono_I', -26.01, 0.15); // 1 チャンネルなので 3 dB 小さい
  const lj = json('ebu3341_1_json');
  if (lj) check('loud_json', Math.abs(lj.integrated + 23) < 0.1 && typeof lj.truePeak === 'number' && lj.seconds === 20, JSON.stringify(lj));
  const sj = json('silence_json');
  if (sj) check('silence_json', sj.integrated === null && sj.truePeak === null && sj.lra === 0, JSON.stringify(sj));
  near('norm_gain', 9, 0.1); // -23 → -14 LUFS
  near('norm_limited', 0, 0);
  near('norm2_gain', -20 - num('ebu3341_1_tp'), 1e-9); // 真のピーク -20 dBTP で抑える
  near('norm2_limited', 1, 0);

  // 話し声
  near('speech_count', 2, 0);
  near('speech_0_start', 1.0, 0.05);
  near('speech_0_end', 2.5, 0.3);
  near('speech_1_start', 4.0, 0.05);
  near('speech_1_end', 5.2, 0.3);
  const dj = json('duck_json');
  if (dj) check('duck_json', dj.length === 8 && dj[1].db === -12 && dj[0].db === 0, JSON.stringify(dj));
  near('duck_at_0.5', 0, 1e-12);
  near('duck_at_1.5', -12, 1e-12);
  near('duck_at_3.4', 0, 1e-12);
  near('duck_bgm_0.5_db', 0, 0.05);
  near('duck_bgm_2.0_db', -12, 0.05);
  near('duck_near_keys', 4, 0);
  const hj = json('duck_head_json');
  if (hj) check('duck_head_json', hj[0].t === 0 && hj[0].db === -12, JSON.stringify(hj));

  // 波形
  near('wave_kernel_same', 1, 0);
  near('wave_levels', 5, 0);
  near('wave_l0_count', Math.ceil((48000 * 3 + 123) / 256), 0);
  near('wave_q_n', 100, 0);
  near('wave_q_max', 0.5, 0.001);
  near('wave_q_min', -0.5, 0.001);
  near('wave_q_rms', 0.5 * Math.SQRT1_2, 0.01);
  near('wave_qr_max', 0.25, 0.001);
  near('wave_qboth_rms', Math.sqrt((0.125 + 0.03125) / 2), 0.01);
  near('wave_raw_n', 48, 0);
  near('wave_raw_max0', num('wave_raw_max0_ref'), 0);

  // 分け方によらない
  for (const k of ['chunk_eq', 'chunk_comp', 'chunk_lim', 'chunk_gate', 'chunk_fade', 'chunk_loud', 'chunk_speech']) near(k, 1, 0);
  near('chunk_comp_changed', 1, 0);

  // ファイルから: EBU Tech 3341 の 5 番（s16 に丸めても ±0.1 LU）と、話し声
  const f5 = path.join(TMP, 'ebu5.s16');
  const sine = (db) => (t) => Math.pow(10, db / 20) * Math.sin(2 * Math.PI * 1000 * t);
  writeS16(f5, 48000, [[sine(-26), 20], [sine(-20), 20.1], [sine(-26), 20]]);
  const lf = JSON.parse(run(['loudness', f5]));
  check('file_loudness', Math.abs(lf.integrated + 23) <= 0.1 && Math.abs(lf.seconds - 60.1) < 1e-6, JSON.stringify(lf));
  const f44 = path.join(TMP, 'k44.s16');
  writeS16(f44, 44100, [[sine(-23), 10]]);
  const l44 = JSON.parse(run(['loudness', f44, '44100']));
  check('file_loudness_44100', Math.abs(l44.integrated + 23) <= 0.15, JSON.stringify(l44));
  const fv = path.join(TMP, 'voice.s16');
  const voice = (t) => {
    let v = 0;
    for (let h = 1; h <= 20; h++) v += Math.sin(2 * Math.PI * 150 * h * t + h) / h;
    return v * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) * 0.05;
  };
  writeS16(fv, 48000, [[() => 0, 1.5], [voice, 2], [() => 0, 2], [voice, 1]]);
  const sp = JSON.parse(run(['speech', fv]));
  check('file_speech', sp.segments.length === 2 && Math.abs(sp.segments[0].start - 1.5) < 0.05 && Math.abs(sp.segments[1].start - 5.5) < 0.05
    && Math.abs(sp.segments[1].end - 6.5) < 0.05 && sp.duck.length === 8, JSON.stringify(sp));

  // GPU（wgpu-native）
  const wgpu = wgpuHome();
  if (wgpu) {
    fs.copyFileSync(path.join(HERE, 'wave_gpu.um'), path.join(TMP, 'wave_gpu.um'));
    const gexe = path.join(TMP, 'wave_gpu' + (process.platform === 'win32' ? '.exe' : ''));
    const b = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', path.join(TMP, 'wave_gpu.um'), '--target', 'host', '-o', gexe],
      { encoding: 'utf8', env: { ...process.env, UM_WGPU: '1', UM_WGPU_HOME: wgpu }, maxBuffer: 1 << 26 });
    if (b.status !== 0) {
      failures.push(`wave_gpu: UM_WGPU=1 のビルドに失敗しました\n${b.stdout}${b.stderr}`);
    } else {
      const g = spawnSync(gexe, [], { encoding: 'utf8', cwd: TMP });
      const m = /diff (\d+)/.exec(g.stdout || '');
      if (g.status !== 0 && /GPU|adapter|wgpu/i.test(g.stderr || '')) console.log(`GPU が使えないので、GPU の比較は飛ばしました: ${(g.stderr || '').trim()}`);
      else check('wave_gpu', g.status === 0 && m && m[1] === '0', `CPU と GPU の結果が違います: ${g.stdout}${g.stderr}`);
    }
  } else {
    console.log('wgpu-native が見つからないので、GPU の比較は飛ばしました（UM_WGPU_HOME を設定すると行う）');
  }

  console.log(`テストの実行: ${elapsed} ms`);
  if (BENCH) process.stdout.write(run(['bench', benchSec]));
} catch (e) {
  failures.push(String(e && e.message ? e.message : e));
}
cleanup();

if (failures.length) {
  console.log(`\n失敗 ${failures.length} 件（成功 ${passed} 件）:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`音の処理のテスト: ${passed} 件すべて成功`);
