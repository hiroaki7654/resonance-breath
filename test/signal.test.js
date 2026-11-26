// node app/test/signal.test.js で実行。合成した指先 PPG から拍と共鳴周波数を正しく出せるかを見る。
'use strict';
const assert = require('assert');
const S = require('../signal.js');

let seed = 12345;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function gauss() { let u = 0; for (let i = 0; i < 6; i++) u += rand(); return u - 3; }

// 呼吸テンポごとの心拍の揺れ幅（片振幅）。5.5 回/分で最大になる人を想定
const AMP = { 6.5: 4, 6: 6, 5.5: 9, 5: 6.5, 4.5: 5 };

// 心拍 hr(t) を積分して拍の時刻を作り、拍ごとに脈波を重ねた明るさの列を返す
function synth(segments, opts) {
  opts = opts || {};
  const fsCam = 30, noise = opts.noise ?? 0.6;
  const beatsTrue = [];
  let t = 0, phase = 0; // phase: 拍の位相（1 で次の拍）
  const total = segments.reduce((s, g) => s + g.sec, 0) * 1000;
  const samples = [];
  const dtFine = 5;
  const hrAt = (tm) => {
    let acc = 0;
    for (const g of segments) {
      if (tm < acc + g.sec * 1000) {
        const fb = g.bpm / 60;
        return 65 + AMP[g.bpm] * Math.sin(2 * Math.PI * fb * (tm - acc) / 1000) + 1.5 * Math.sin(2 * Math.PI * 0.013 * tm / 1000);
      }
      acc += g.sec * 1000;
    }
    return 65;
  };
  for (t = 0; t < total; t += dtFine) {
    phase += hrAt(t) / 60 * dtFine / 1000;
    if (phase >= 1) { phase -= 1; beatsTrue.push(t); }
  }
  const pulse = (dtMs) => { // 1 拍の脈波（収縮期の山＋重複切痕の小さな山）
    const x = dtMs / 1000;
    return Math.exp(-((x - 0.12) ** 2) / (2 * 0.045 ** 2)) + 0.35 * Math.exp(-((x - 0.38) ** 2) / (2 * 0.06 ** 2));
  };
  let bi = 0;
  for (let ts = 0; ts < total; ts += 1000 / fsCam + (rand() - 0.5) * 8) {
    while (bi < beatsTrue.length - 1 && beatsTrue[bi + 1] <= ts) bi++;
    let p = 0;
    for (let k = Math.max(0, bi - 1); k <= Math.min(beatsTrue.length - 1, bi + 1); k++) if (ts >= beatsTrue[k]) p += pulse(ts - beatsTrue[k]);
    const drift = 6 * Math.sin(2 * Math.PI * 0.05 * ts / 1000) + 2 * Math.sin(2 * Math.PI * opts.breathHz * ts / 1000 || 0);
    samples.push({ t: ts, v: 200 - 4 * p + drift + noise * gauss() });
  }
  return { samples, beatsTrue };
}

function run(samples) {
  const d = new S.PpgBeatDetector();
  for (const s of samples) d.push(s.t, s.v);
  return d.beats;
}

// 1. 拍の時刻の精度
(() => {
  const { samples, beatsTrue } = synth([{ bpm: 6, sec: 120 }]);
  const beats = run(samples);
  const ok = beats.filter(b => b.ok);
  let errs = [];
  for (const b of beats) {
    let best = Infinity;
    for (const tt of beatsTrue) best = Math.min(best, Math.abs(tt + 120 - b.t)); // 脈波の山は拍の 120ms 後
    errs.push(best);
  }
  errs.sort((a, b) => a - b);
  const p95 = errs[Math.floor(errs.length * 0.95)];
  console.log(`拍: 真 ${beatsTrue.length} / 検出 ${beats.length} / 採用 ${ok.length}、時刻誤差 95% 点 ${p95.toFixed(1)}ms`);
  assert(Math.abs(beats.length - beatsTrue.length) <= 3, '拍数が真の値と合わない');
  assert(ok.length / beats.length > 0.95, '採用率が低い');
  assert(p95 < 15, '時刻誤差が大きい');
  const r = S.rmssd(beats);
  assert(isFinite(r) && r > 5 && r < 80, 'RMSSD が範囲外: ' + r);
})();

// 2. 共鳴周波数テスト: 5.5 回/分が推奨になる
(() => {
  const order = [6.5, 6, 5.5, 5, 4.5];
  const segs = order.map(bpm => ({ bpm, sec: 120 }));
  const { samples } = synth(segs);
  const beats = run(samples);
  let acc = 0;
  const results = segs.map(g => {
    const start = acc; acc += g.sec * 1000;
    return S.segmentMetrics(beats, { tStart: start + 20000, tEnd: acc, pacerStart: start, bpm: g.bpm });
  });
  for (const r of results) console.log(`${r.bpm} 回/分: 山谷差 ${r.peakTrough.toFixed(1)} 呼吸帯 ${(r.breathShare * 100).toFixed(0)}% 採用 ${(r.okRatio * 100).toFixed(0)}% 呼吸 ${r.cycles} 回 LFピーク ${r.lfPeakBpm.toFixed(1)}`);
  const rec = S.recommend(results);
  console.log('推奨:', rec.bpm, rec.reason);
  assert.strictEqual(rec.bpm, 5.5);
  // 山谷差はおよそ 2×片振幅
  const r55 = results.find(r => r.bpm === 5.5);
  assert(Math.abs(r55.peakTrough - 18) < 4, '山谷差がずれている: ' + r55.peakTrough);
  // LF のピークは呼吸のテンポに出る
  for (const r of results) assert(Math.abs(r.lfPeakBpm - r.bpm) <= 0.6, 'LF ピークが呼吸と合わない ' + r.bpm);
})();

// 2b. 大きな揺れ（±15 拍/分）でも拍を捨てない（共鳴しているときこそ揺れが大きい）
(() => {
  const saved = AMP[6]; AMP[6] = 15;
  const { samples, beatsTrue } = synth([{ bpm: 6, sec: 120 }]);
  AMP[6] = saved;
  const beats = run(samples);
  const m = S.segmentMetrics(beats, { tStart: 20000, tEnd: 120000, pacerStart: 0, bpm: 6 });
  console.log(`±15: 真 ${beatsTrue.length} 検出 ${beats.length} 採用 ${(m.okRatio * 100).toFixed(0)}% 山谷差 ${m.peakTrough.toFixed(1)}`);
  assert(m.okRatio > 0.95, '大きな揺れで拍を捨てている');
  assert(Math.abs(m.peakTrough - 30) < 5, '山谷差が真の 30 からずれている');
})();

// 2c. 同じ揺れ幅なら、テンポが違っても呼吸帯の割合と山谷差に大きな差が出ない
(() => {
  const keep = { ...AMP }; AMP[6] = 7; AMP[4.5] = 7;
  const a = synth([{ bpm: 6, sec: 120 }]), b = synth([{ bpm: 4.5, sec: 120 }]);
  Object.assign(AMP, keep);
  const ma = S.segmentMetrics(run(a.samples), { tStart: 20000, tEnd: 120000, pacerStart: 0, bpm: 6 });
  const mb = S.segmentMetrics(run(b.samples), { tStart: 20000, tEnd: 120000, pacerStart: 0, bpm: 4.5 });
  console.log(`同振幅: 6 → 山谷差 ${ma.peakTrough.toFixed(1)} 呼吸帯 ${(ma.breathShare * 100).toFixed(0)}% / 4.5 → ${mb.peakTrough.toFixed(1)} ${(mb.breathShare * 100).toFixed(0)}%`);
  assert(Math.abs(ma.peakTrough - mb.peakTrough) / ma.peakTrough < 0.12, 'テンポで山谷差に偏り');
})();

// 2d. 拍の取りこぼし（脈波が 1 拍ぶん消える）は採用されず、RMSSD が跳ねない
(() => {
  const { samples } = synth([{ bpm: 6, sec: 90 }]);
  const clean = S.rmssd(run(samples));
  // 30 秒・60 秒あたりの 1 拍ぶん（0.9 秒）を平らにする
  const holed = samples.map(s => ((s.t > 30000 && s.t < 30900) || (s.t > 60000 && s.t < 60900)) ? { t: s.t, v: 200 } : s);
  const r = S.rmssd(run(holed));
  console.log(`取りこぼし: RMSSD ${clean.toFixed(1)} → ${r.toFixed(1)}`);
  assert(Math.abs(r - clean) / clean < 0.15, '取りこぼしで RMSSD が跳ねた');
})();

// 3. 指を離した区間（雑音だけ）は採用されない
(() => {
  const samples = [];
  for (let t = 0; t < 30000; t += 33) samples.push({ t, v: 120 + 3 * gauss() });
  const beats = run(samples);
  const m = S.segmentMetrics(beats, { tStart: 0, tEnd: 30000, pacerStart: 0, bpm: 6 });
  const rec = S.recommend([m]);
  console.log(`雑音のみ: 検出 ${beats.length}、採用率 ${(m.okRatio * 100).toFixed(0)}%、推奨 ${rec.bpm}`);
  assert.strictEqual(rec.bpm, null);
})();

// 4. 心拍ベルトの値の読み取り
(() => {
  const buf = new DataView(new Uint8Array([0x10, 72, 0x00, 0x04, 0x20, 0x03]).buffer);
  const r = S.parseHeartRateMeasurement(buf);
  assert.strictEqual(r.hr, 72);
  assert.deepStrictEqual(r.rr.map(x => Math.round(x)), [1000, 781]);
})();

// 5. ガイドの位相
(() => {
  const p = S.pacer(0, 0, 6, 0.4);
  assert.strictEqual(p.phase, 'in'); assert(p.size < 0.01);
  const q = S.pacer(4000, 0, 6, 0.4);
  assert.strictEqual(q.phase, 'out'); assert(q.size > 0.99);
})();

console.log('OK');
