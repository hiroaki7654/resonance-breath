// node app/test/trend.test.js で実行。合成の 14 日分の記録で、7 日平均・基準の帯・外れの印・倍率を確かめる。
'use strict';
const assert = require('assert');
const T = require('../trend.js');

const iso = (i, h) => new Date(2026, 10, 1 + i, h, 0, 0).toISOString(); // 11/1 + i 日（端末のローカル時刻）
const rest = (i, rmssd, extra) => Object.assign({ id: 1000 + i, kind: 'rest', date: iso(i, 7), rmssd, okRatio: 0.95, peakTrough: 4 }, extra);

// 14 日分: 朝は毎日、rmssd は 40 前後。14 日目だけ大きく下げる。練習は偶数日だけ
const vals = [40, 42, 38, 41, 39, 43, 40, 41, 39, 42, 40, 40, 41, 20];
const rests = vals.map((v, i) => rest(i, v));
const sessions = [];
for (let i = 0; i < 14; i += 2) sessions.push({ id: 2000 + i, date: iso(i, 20), peakTrough: 12, rmssd: 50 });
sessions.push({ id: 3000, date: iso(13, 20), peakTrough: 10 }); // 14 日目の練習（朝もある）

(() => {
  assert(Math.abs(T.lnRmssd(Math.E) - 1) < 1e-12);
  assert(Number.isNaN(T.lnRmssd(0)) && Number.isNaN(T.lnRmssd(NaN)));
})();

(() => {
  const rows = T.buildTrend(rests, sessions);
  assert.strictEqual(rows.length, 14);
  // 7 日平均: 3 日目から出る（3 日未満は空）。7 日目は直近 7 日の ln の平均
  assert(Number.isNaN(rows[1].ma7));
  assert(Number.isFinite(rows[2].ma7));
  const m7 = vals.slice(0, 7).reduce((s, v) => s + Math.log(v), 0) / 7;
  assert(Math.abs(rows[6].ma7 - m7) < 1e-9);
  // 基準の帯: 直前の日が 7 日たまってから（8 日目〜）。当日は含めない
  assert.strictEqual(rows[6].band, null);
  assert(rows[7].band && rows[7].band.n === 7);
  const b8 = vals.slice(0, 7).map(Math.log), mu = b8.reduce((s, x) => s + x, 0) / 7;
  assert(Math.abs(rows[7].band.mean - mu) < 1e-9);
  // 基準を大きく下回る 14 日目だけに印。普段の日には付かない
  assert.strictEqual(rows[13].flag, 'low');
  assert(rows.slice(0, 13).every(r => r.flag === null));
  // 倍率: 朝と練習がそろった日だけ（偶数日と 14 日目）。14 日目は練習 2 回の平均ではなく 1 回（10）÷ 朝 4
  assert(Math.abs(rows[0].ratio - 3) < 1e-9);
  assert(Number.isNaN(rows[1].ratio));
  assert(Math.abs(rows[13].ratio - 2.5) < 1e-9);
  assert.strictEqual(rows.filter(r => Number.isFinite(r.ratio)).length, 8);
})();

// 参考値（採用率が低い回）は平均・基準から外れる。朝が無い日の練習は倍率が空
(() => {
  assert(T.isReference(rest(0, 40, { okRatio: 0.6 })));
  assert(T.isReference(rest(0, NaN)));
  assert(!T.isReference(rest(0, 40)));
  const rs = rests.slice(); rs[3] = rest(3, 5, { okRatio: 0.5 }); // 極端に低いが参考値
  const rows = T.buildTrend(rs, sessions);
  assert.strictEqual(rows.length, 13); // 4 日目は参考値だけで練習も無いので日の行ごと無い
  assert(!rows.some(r => r.day === '2026-11-04'));
  assert.strictEqual(rows[12].flag, 'low');
  const only = T.buildTrend([], sessions);
  assert(only.every(r => Number.isNaN(r.ratio) && Number.isNaN(r.ln)));
})();

// 古い記録（rests が無い・kind なしの練習）でも落ちない
(() => {
  assert.deepStrictEqual(T.buildTrend(undefined, undefined), []);
})();

(() => {
  const n = Date.parse(iso(40, 12));
  assert.strictEqual(T.retestDue([], n), 'none');
  assert.strictEqual(T.retestDue([{ date: iso(5, 9) }], n), 35);
  assert.strictEqual(T.retestDue([{ date: iso(20, 9) }], n), null);
})();

// 体調メモ: 空は付けない・不正な値は落とす・要約が出る
(() => {
  assert.strictEqual(T.normalizeMemo(null), null);
  assert.strictEqual(T.normalizeMemo({ sleep: '', alcohol: false, text: '  ' }), null);
  assert.deepStrictEqual(T.normalizeMemo({ sleep: 'bad', alcohol: true, sick: 0, hard: 1, text: ' 遅くまで起きていた ', x: 1 }),
    { sleep: 'bad', alcohol: true, hard: true, text: '遅くまで起きていた' });
  assert.strictEqual(T.memoSummary({ sleep: 'good', sick: true }), '睡眠 良い・体調不良');
  assert.strictEqual(T.memoSummary(undefined), '');
  assert.strictEqual(T.normalizeMemo({ text: 'あ'.repeat(300) }).text.length, 200);
})();

console.log('OK');
