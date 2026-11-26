// 信号処理（純関数とストリーム用の拍検出器）。ブラウザでは window.Signal、node では require で使う。
(function (root) {
  'use strict';

  // ---------- 拍検出（カメラ指先 PPG） ----------
  // push(時刻ms, 赤の明るさ) を順に呼ぶと、新しく確定した拍を返す。
  // 約 1 秒遅れで確定する（中央揃えの移動平均を使うため）。
  class PpgBeatDetector {
    constructor(opts) {
      opts = opts || {};
      this.fs = opts.fs || 30;              // 補間後のサンプリング周波数
      this.refractoryMs = opts.refractoryMs || 330; // 180 拍/分まで
      this.reset();
    }
    reset() {
      this.t0 = null;     // 格子の基準時刻
      this.grid = [];     // 一定間隔の値（反転済み）
      this.gridStart = 0; // grid[0] の通し番号
      this.lastRaw = null;
      this.scanFrom = 0;  // 次にピークを探す通し番号
      this.lastBeatT = null;
      this.recentRR = [];
      this.prevOk = null;
      this.beats = [];
    }
    push(t, v) {
      const out = [];
      const dt = 1000 / this.fs;
      if (this.t0 === null) { this.t0 = t; this.lastRaw = { t, v }; this.grid.push(-v); return out; }
      const prev = this.lastRaw;
      if (t <= prev.t) return out;
      if (t - prev.t > 1000) { this.reset(); this.t0 = t; this.lastRaw = { t, v }; this.grid.push(-v); return out; }
      // 前の生サンプルから今のサンプルまでの格子点を線形補間で埋める
      let n = this.gridStart + this.grid.length; // 次の格子点の通し番号
      let tg = this.t0 + n * dt;
      while (tg <= t) {
        const a = (tg - prev.t) / (t - prev.t);
        this.grid.push(-(prev.v + a * (v - prev.v)));
        n++; tg = this.t0 + n * dt;
      }
      this.lastRaw = { t, v };
      this._detect(out);
      // 古い格子を捨てる（12 秒分残す）
      const keep = Math.round(12 * this.fs);
      if (this.grid.length > keep * 2) {
        const drop = this.grid.length - keep;
        this.grid.splice(0, drop);
        this.gridStart += drop;
      }
      return out;
    }
    _detect(out) {
      const fs = this.fs, g = this.grid, base = this.gridStart;
      const wLong = Math.round(1.5 * fs) | 1, wShort = Math.max(3, Math.round(0.12 * fs) | 1);
      const hL = (wLong - 1) / 2, hS = (wShort - 1) / 2;
      const nLast = base + g.length - 1;
      const half = Math.round(0.25 * fs);   // ピークの左右の探索幅
      const end = nLast - hL - half - 1;    // 中央揃えの平均がとれる最後の番号
      const start = Math.max(this.scanFrom, base + hL + half + 1);
      if (end < start) return;
      // 区間 [start-half-1, end+half+1] のフィルタ値を作る
      const lo = start - half - 1, hi = end + half + 1;
      const z = new Float64Array(hi - lo + 1);
      // 累積和で移動平均
      const cs = new Float64Array(g.length + 1);
      for (let i = 0; i < g.length; i++) cs[i + 1] = cs[i] + g[i];
      const ma = (n, h) => { const a = n - base - h, b = n - base + h; return (cs[b + 1] - cs[a]) / (2 * h + 1); };
      for (let n = lo; n <= hi; n++) z[n - lo] = ma(n, hS) - ma(n, hL);
      // 振幅の目安: 直近 5 秒の |z| の 90 パーセンタイル
      const ampWin = [];
      const from = Math.max(base + hL, nLast - hL - Math.round(5 * fs));
      for (let n = from; n <= nLast - hL; n++) ampWin.push(Math.abs(ma(n, hS) - ma(n, hL)));
      ampWin.sort((a, b) => a - b);
      const amp = ampWin.length ? ampWin[Math.floor(ampWin.length * 0.9)] : 0;
      const thr = 0.3 * amp;
      for (let n = start; n <= end; n++) {
        const zi = z[n - lo];
        if (zi <= thr) continue;
        let isMax = true;
        for (let k = 1; k <= half; k++) {
          if (z[n - lo - k] > zi || z[n - lo + k] >= zi) { isMax = false; break; }
        }
        if (!isMax) continue;
        // 放物線補間で時刻を細かくする
        const y0 = z[n - lo - 1], y1 = zi, y2 = z[n - lo + 1];
        const den = y0 - 2 * y1 + y2;
        const off = den !== 0 ? 0.5 * (y0 - y2) / den : 0;
        const tBeat = this.t0 + (n + Math.max(-0.5, Math.min(0.5, off))) * (1000 / fs);
        this._beat(tBeat, out);
      }
      this.scanFrom = end + 1;
    }
    _beat(t, out) {
      // 不応期は拍の間隔に合わせて広げる（指先の脈波の 2 つ目の小さな山を拾わないため）
      const refr = this.recentRR.length >= 3 ? Math.max(this.refractoryMs, 0.5 * median(this.recentRR)) : this.refractoryMs;
      if (this.lastBeatT !== null && t - this.lastBeatT < refr) return;
      let rr = null, ok = false;
      if (this.lastBeatT !== null) {
        rr = t - this.lastBeatT;
        if (rr > 2000) { rr = null; this.prevOk = null; }
        else {
          ok = judgeRR(rr, this.prevOk, this.recentRR);
          this.recentRR.push(rr);
          if (this.recentRR.length > 7) this.recentRR.shift();
          this.prevOk = ok ? rr : null;
        }
      }
      this.lastBeatT = t;
      const b = { t, rr, ok };
      this.beats.push(b);
      out.push(b);
    }
  }

  // RR を採用するか。共鳴呼吸では心拍が ±15 拍/分ほど大きく揺れるので、
  // 長い窓の中央値ではなく「直前のきれいな拍からの変化」で見る（拍の取りこぼしは約 2 倍、余分な拍は約半分になる）。
  // 直前の拍が使えないときだけ中央値で見る（範囲は広め）
  function judgeRR(rr, prevOk, recent) {
    if (rr < 300 || rr > 2000) return false;
    if (prevOk) return Math.abs(rr - prevOk) <= 0.25 * prevOk;
    if (recent.length >= 3) { const md = median(recent); return Math.abs(rr - md) <= 0.4 * md; }
    return true;
  }

  // ---------- 統計 ----------
  function median(a) {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }

  // 採用された拍だけで RMSSD（連続した 2 つの RR が両方採用のときだけ差をとる）
  function rmssd(beats) {
    let s = 0, n = 0;
    for (let i = 1; i < beats.length; i++) {
      const a = beats[i - 1], b = beats[i];
      if (a.ok && b.ok && a.rr && b.rr) { const d = b.rr - a.rr; s += d * d; n++; }
    }
    return n >= 5 ? Math.sqrt(s / n) : NaN;
  }

  // 拍の列 → 4Hz の瞬時心拍（拍/分）。採用された拍だけを結ぶ
  function hrSeries(beats, tStart, tEnd, fs) {
    fs = fs || 4;
    const pts = beats.filter(b => b.ok && b.rr).map(b => ({ t: b.t - b.rr / 2, hr: 60000 / b.rr }));
    const out = { t: [], hr: [], fs };
    if (pts.length < 2) return out;
    const step = 1000 / fs;
    let j = 0;
    for (let t = Math.max(tStart, pts[0].t); t <= Math.min(tEnd, pts[pts.length - 1].t); t += step) {
      while (j < pts.length - 2 && pts[j + 1].t < t) j++;
      const a = pts[j], b = pts[j + 1];
      const w = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      out.t.push(t); out.hr.push(a.hr + w * (b.hr - a.hr));
    }
    return out;
  }

  // 1 呼吸ごとの心拍の山谷差（最大−最小）の平均。呼吸の区切りはガイドの開始時刻と周期から作る
  function peakTrough(series, pacerStart, periodMs, tStart, tEnd) {
    const vals = [];
    let k = Math.ceil((tStart - pacerStart) / periodMs);
    for (; ; k++) {
      const a = pacerStart + k * periodMs, b = a + periodMs;
      if (b > tEnd) break;
      let mx = -Infinity, mn = Infinity, n = 0;
      for (let i = 0; i < series.t.length; i++) {
        const t = series.t[i];
        if (t >= a && t < b) { const h = series.hr[i]; if (h > mx) mx = h; if (h < mn) mn = h; n++; }
      }
      if (n >= periodMs / 1000 * series.fs * 0.8) vals.push(mx - mn);
    }
    return { mean: vals.length ? mean(vals) : NaN, cycles: vals.length };
  }

  // Hann 窓をかけた DFT のパワー（任意の周波数で直接評価するので、ビンの位置による偏りが無い）。
  // 窓をかける前に直線のトレンドを引く（平均心拍のゆっくりした変化が LF に漏れないように）
  function spectrum(x, fs, fLo, fHi, df) {
    const n = x.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += x[i]; sxx += i * i; sxy += i * x[i]; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), icpt = (sy - slope * sx) / n;
    const w = x.map((v, i) => (v - icpt - slope * i) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))));
    const freqs = [], pow = [];
    for (let f = fLo; f <= fHi + 1e-9; f += df) {
      let re = 0, im = 0;
      const c = 2 * Math.PI * f / fs;
      for (let i = 0; i < n; i++) { re += w[i] * Math.cos(c * i); im -= w[i] * Math.sin(c * i); }
      freqs.push(f); pow.push((re * re + im * im) / n);
    }
    return { freqs, pow };
  }

  // 区間の指標をまとめて出す
  function segmentMetrics(beats, opt) {
    // opt: {tStart, tEnd, pacerStart, bpm}
    const inSeg = beats.filter(b => b.t >= opt.tStart && b.t <= opt.tEnd);
    const okBeats = inSeg.filter(b => b.ok && b.rr);
    const periodMs = 60000 / opt.bpm;
    const s = hrSeries(beats, opt.tStart, opt.tEnd, 4);
    const pt = peakTrough(s, opt.pacerStart, periodMs, opt.tStart, opt.tEnd);
    let breathPower = NaN, lfPower = NaN, lfPeakHz = NaN;
    if (s.hr.length >= 4 * 40) {
      const sp = spectrum(s.hr, 4, 0.04, 0.15, 0.0025);
      const fb = opt.bpm / 60;
      lfPower = 0; breathPower = 0;
      let best = -1;
      for (let i = 0; i < sp.freqs.length; i++) {
        lfPower += sp.pow[i];
        if (Math.abs(sp.freqs[i] - fb) <= 0.015) breathPower += sp.pow[i];
        if (sp.pow[i] > best) { best = sp.pow[i]; lfPeakHz = sp.freqs[i]; }
      }
    }
    return {
      bpm: opt.bpm,
      beats: inSeg.length,
      okRatio: inSeg.length ? okBeats.length / inSeg.length : 0,
      meanHr: okBeats.length ? 60000 / mean(okBeats.map(b => b.rr)) : NaN,
      rmssd: rmssd(inSeg),
      peakTrough: pt.mean,
      cycles: pt.cycles,
      breathPower, lfPower,
      breathShare: lfPower > 0 ? breathPower / lfPower : NaN,
      lfPeakBpm: lfPeakHz * 60,
    };
  }

  // 推奨テンポ: 山谷差が最大のもの。信号の悪い区間（採用率 70% 未満・呼吸 3 回未満）は除く
  function recommend(segs) {
    const good = segs.filter(s => s.okRatio >= 0.7 && s.cycles >= 3 && isFinite(s.peakTrough));
    if (!good.length) return { bpm: null, reason: '信号が足りません。指の当て方を見直して、もう一度測ってください。', close: [] };
    const sorted = good.slice().sort((a, b) => b.peakTrough - a.peakTrough);
    const top = sorted[0];
    const close = sorted.slice(1).filter(s => s.peakTrough >= top.peakTrough * 0.9).map(s => s.bpm);
    let reason = `心拍の揺れ（山谷差）が最も大きかったのは ${top.bpm} 回/分（${top.peakTrough.toFixed(1)} 拍/分）。`;
    if (close.length) reason += ` ${close.join('・')} 回/分も差が 1 割以内なので、別の日にもう一度測って確かめると確実です。`;
    return { bpm: top.bpm, reason, close };
  }

  // 呼吸ガイドの位相。size は 0（吐ききり）〜1（吸いきり）
  function pacer(tMs, startMs, bpm, inhaleRatio) {
    const period = 60000 / bpm;
    const e = ((tMs - startMs) % period + period) % period;
    const inMs = period * inhaleRatio;
    if (e < inMs) { const p = e / inMs; return { phase: 'in', progress: p, size: 0.5 - 0.5 * Math.cos(Math.PI * p), remainMs: inMs - e }; }
    const p = (e - inMs) / (period - inMs);
    return { phase: 'out', progress: p, size: 0.5 + 0.5 * Math.cos(Math.PI * p), remainMs: period - e };
  }

  // 心拍ベルト（BLE Heart Rate Measurement 0x2A37）の値を読む
  function parseHeartRateMeasurement(dv) {
    const flags = dv.getUint8(0);
    let i = 1;
    let hr;
    if (flags & 1) { hr = dv.getUint16(i, true); i += 2; } else { hr = dv.getUint8(i); i += 1; }
    if (flags & 8) i += 2; // 消費エネルギー
    const rr = [];
    if (flags & 16) { for (; i + 1 < dv.byteLength; i += 2) rr.push(dv.getUint16(i, true) * 1000 / 1024); }
    return { hr, rr };
  }

  const Signal = { PpgBeatDetector, judgeRR, median, mean, rmssd, hrSeries, peakTrough, spectrum, segmentMetrics, recommend, pacer, parseHeartRateMeasurement };
  if (typeof module !== 'undefined' && module.exports) module.exports = Signal;
  else root.Signal = Signal;
})(typeof self !== 'undefined' ? self : this);
