# 音の処理（src/dsp/）

M3（音）の部品です。音の効果（EQ、ダイナミクス、パン、フェード）と解析（ラウドネス、話し声の区間、波形）を、UnifiedMozaic で書いています。
使う人向けの説明は README.md、全体の約束ごとは [architecture.md](architecture.md) にあります。

## 約束ごと

- **音の形**: f32 のステレオ（`L, R, L, R, ...` の `f32[]`）。標本化周波数は 48 kHz が基本です（どれも `rate` を受け取るので 44.1 kHz なども使えます）。`src/audio.um` の `mix` と同じ並びです。
- **処理の形**: `dspXxxProcess(mut 状態, mut buf, frame0, frames)`。buf の `frame0` フレーム目から `frames` フレームを、その場で書き換えます。状態（フィルタの記憶など）は struct に持ちます。
- **分け方によらない**: どの処理も 1 標本ずつの決まった順の計算です。何フレームずつに分けて渡しても、結果はビットまで同じです（`tests/dsp` の `chunk_*` で確かめています）。フェードや音量の曲線は、位置を「素材の先頭からのフレーム番号」（`pos0`）で受け取ります。
- **決まった結果**: 指数・対数・三角関数は `math.um` の多項式で計算します（C の libm に頼らないので、どの OS でも同じ値になります）。内部の計算は f64 です。
- **CPU と GPU で同じ結果**: 波形の縮約の最下段は kernel（`dspWaveBlockKernel`）です。`cpu.dispatch` と `gpu.dispatch`（wgpu）の結果がビットまで同じことを `tests/dsp/wave_gpu.um` で確かめています。
- **人にも AI にもわかる**: 設定と結果は `...ToJson`（機械向けの JSON）と `...Describe`（日本語の文）で出せます。
- **名前**: 全ファイルで名前の空間が 1 つなので、すべて `dsp` / `Dsp` / `DSP_` で始めます（ファイルの中だけの補助は `dspm`・`dspl` などの前置き）。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `math.um` | `dspExp` `dspLn` `dspLog10` `dspPow` `dspSin` `dspCos` `dspTan`、`dspDbToGain` `dspGainToDb` `dspPowerToDb`、`dspFmt`（丸めた数の文字列。無音は `null`）、`dspSortF64` |
| `biquad.um` | バイクアッド（RBJ の式）。種類は `DSP_BQ_LOWPASS` `HIGHPASS` `BANDPASS` `NOTCH` `PEAK` `LOWSHELF` `HIGHSHELF` `ALLPASS`。`dspBiquadNew` / `dspBiquadDesign`（動かしながら係数を変えられる）/ `dspBiquadProcess` / `dspBiquadMagDb`（応答の dB） |
| `eq.um` | パラメトリック EQ（1〜8 帯）。`dspEqNew(rate, n)`、`dspEqSetBand`、`dspEqAddBand`、`dspEqProcess`、`dspEqCurve`（画面の曲線。20 Hz〜20 kHz）、`dspEqToJson`、`dspEqDescribe` |
| `truepeak.um` | 真のピークの検出（4 倍オーバーサンプリング、12 タップ × 4 相）。遅れは 6 標本 |
| `dynamics.um` | コンプレッサー（スレッショルド・レシオ・アタック・リリース・ニー・メイクアップ。ステレオ連動、dB の領域で平滑化）、リミッター（先読み、真のピークに近い検出、天井 dBTP、遅れは `dspLimiterLatency`）、ノイズゲート（閾値・ヒステリシス・閉じたときの量・アタック・ホールド・リリース）。メーターは `...TakeMeter` |
| `mix.um` | 音量（dB、直線のランプ）、パン（等パワー、中央で -3 dB。`dspPanMono`）、バランス（ステレオ。中央で 0 dB）、フェードの曲線（`DSP_FADE_LINEAR` / `EQUAL_POWER` / `SCURVE`）、`dspApplyFade`、`dspCrossfade` |
| `loudness.um` | ラウドネスの測定（BS.1770-4 / EBU R128）。統合（ゲートつき）・瞬時・短期・最大、ラウドネスレンジ（Tech 3342）、真のピーク dBTP、標本のピーク。`dspLoudnessNormalizeGain`（目標の LUFS に合わせる音量。真のピークの上限で抑える） |
| `speech.um` | 話し声の区間の検出（10 ms の枠、話し声の帯域の電力・帯域の比・雑音の床）と、自動ダッキングの音量のキーフレーム（`dspDuckKeysFromSegments`、`dspApplyDuck`） |
| `wave.um` | 波形の表示用の縮約。256 フレームのブロックから 4 倍ずつの 5 段のピラミッド（最小・最大・2 乗の和）。`dspWaveBuild` / `dspWaveBuildKernel`、`dspWaveQuery`（画素ごと）、`dspWaveFromSamples`（拡大したとき） |
| `analyze.um` | s16le のステレオのファイル（`mixAudio` や ffmpeg が書く形）を 1 秒ずつ読んで測る。`dspLoudnessOfS16File`、`dspSpeechOfS16File`、`dspS16ToF32` / `dspF32ToS16` |

## 確かめたこと（`node tests/dsp/run.mjs`）

- 数学の関数が JavaScript の `Math` と相対誤差 2e-15 以内で合う。
- バイクアッドの係数が RBJ の式（JavaScript で計算）と合う。応答の式と、正弦波を通して測った値が 0.05 dB 以内で合う。
- ラウドネス: EBU Tech 3341 の 1〜5 番（1 kHz の正弦波 -23 / -33 dBFS、ゲートの試験）が ±0.1 LU、Tech 3342 の 1〜4 番（LRA 10 / 5 / 20 / 15 LU）が ±1 LU で合う。44.1 kHz とモノラル、s16 のファイルからも測れる。
- 真のピーク: fs/4 の正弦波を 45° ずらしたもの（標本は -3 dBFS、山は 0 dBTP）が +0.1 dB 以内。
- リミッター: +7 dBTP の入力が、天井 -1 dBTP 以下になる（標本も真のピークも）。静かな音は遅れだけで、そのまま通る。
- コンプレッサーの静的な特性（ニーの曲線）、アタックの時定数、ゲートの開閉、パンの電力の和、フェードの曲線、クロスフェード。
- 話し声の区間（始まりが ±50 ms）、低音（60 Hz）は話し声と見なさない、ダッキングのキーフレームと BGM の音量。
- 波形の縮約で、普通の関数と kernel、CPU と GPU の結果がビットまで同じ。

`node tests/dsp/run.mjs --bench` で、1 分の 48 kHz ステレオを処理する時間を出します。
