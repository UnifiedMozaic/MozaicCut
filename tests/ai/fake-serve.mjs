// 偽の相手（fake.mjs の startFake）を別のプロセスで立てる。同期で流れる試し（tests/run.mjs）から使う。
//   node tests/ai/fake-serve.mjs <場面> <URL を書くファイル>
// 立ったら URL をファイルに書き、親に止められるまで（長くても 120 秒）待つ。本物の AI の API は呼ばない。
//
// 場面:
//   propose  Claude の形で、文 → op（move b 5、apply=true）を呼ぶ → 文で終わる（編集画面の AI のタブの試し）
import fs from 'node:fs';
import { startFake, claudeSse } from './fake.mjs';

const [scene, urlFile] = process.argv.slice(2);
let queue = [];
if (scene === 'propose') {
  queue = [
    claudeSse([{ type: 'text', text: 'クリップ B の始まりを 5 秒に動かす提案を作ります。' },
      { type: 'tool_use', id: 'toolu_1', name: 'op', input: { ops: ['move b 5'], apply: true } }], 'tool_use'),
    claudeSse([{ type: 'text', text: '提案を出しました。確かめて適用してください。' }], 'end_turn'),
  ];
} else {
  console.error(`知らない場面です: ${scene}`);
  process.exit(2);
}
const fake = await startFake(queue);
fs.writeFileSync(urlFile, fake.url);
setTimeout(() => process.exit(0), 120000);
