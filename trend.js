// 日ごとの推移の計算（純関数）。朝の安静時 HRV（ln RMSSD）の 7 日移動平均・28 日の基準の帯・外れ判定と、練習の振れ幅倍率。
// ブラウザでは window.Trend、node では require で使う。表示は事実の値まで（評価や診断の言葉は付けない）。
(function (root) {
  'use strict';

  const REF_OK_RATIO = 0.8;   // 採用率がこれ未満の朝の測定は「参考値」にして平均から外す
  const MIN_MA = 3;           // 7 日平均を出すのに要る日数
  const MIN_BASE = 7;         // 基準の帯を出すのに要る日数（直前 28 日の中で）
  const BASE_DAYS = 28;
  const LOW_SD = 1.5;         // 基準の平均からこの標準偏差分以上外れたら印

  const lnRmssd = (v) => (Number.isFinite(v) && v > 0 ? Math.log(v) : NaN);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  function sd(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  }

  // 端末のローカル日付 'YYYY-MM-DD'
  function dayKey(iso) {
    const d = new Date(iso), z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  const dayNum = (key) => { const [y, m, d] = key.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };

  // 朝の測定が参考値か（採用率が低い・RMSSD が出ていない）
  const isReference = (r) => !(Number.isFinite(r.okRatio) && r.okRatio >= REF_OK_RATIO && Number.isFinite(r.rmssd) && r.rmssd > 0);

  // rests: 朝の測定の記録、sessions: 練習の記録。日ごとにまとめて返す（日付の昇順）
  // 各要素: {day, n, ln, ma7, band:{mean,sd,n}|null, flag:'low'|null（下回りだけに印）, ptRest, ptPractice, ratio}
  //   ln/ptRest は参考値でない朝の測定だけの平均。ratio は朝と練習がそろった日だけ
  function buildTrend(rests, sessions) {
    const days = new Map();
    const get = (k) => { if (!days.has(k)) days.set(k, { day: k, ln: [], pr: [], pp: [] }); return days.get(k); };
    for (const r of rests || []) {
      if (!r || isReference(r)) continue;
      const l = Number.isFinite(r.lnRmssd) ? r.lnRmssd : lnRmssd(r.rmssd);
      const e = get(dayKey(r.date));
      if (Number.isFinite(l)) e.ln.push(l);
      if (Number.isFinite(r.peakTrough)) e.pr.push(r.peakTrough);
    }
    for (const s of sessions || []) {
      if (!s || !Number.isFinite(s.peakTrough)) continue;
      get(dayKey(s.date)).pp.push(s.peakTrough);
    }
    const rows = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(e => ({
      day: e.day, num: dayNum(e.day), ln: mean(e.ln), ptRest: mean(e.pr), ptPractice: mean(e.pp),
    }));
    const lnRows = rows.filter(r => Number.isFinite(r.ln));
    for (const r of rows) {
      r.ma7 = NaN; r.band = null; r.flag = null; r.ratio = NaN;
      if (Number.isFinite(r.ln)) {
        const w = lnRows.filter(x => x.num > r.num - 7 && x.num <= r.num).map(x => x.ln);
        if (w.length >= MIN_MA) r.ma7 = mean(w);
        const b = lnRows.filter(x => x.num >= r.num - BASE_DAYS && x.num < r.num).map(x => x.ln);
        if (b.length >= MIN_BASE) {
          r.band = { mean: mean(b), sd: sd(b), n: b.length };
          const lim = LOW_SD * r.band.sd;
          if (r.ln < r.band.mean - lim) r.flag = 'low';
        }
      }
      if (Number.isFinite(r.ptRest) && r.ptRest > 0 && Number.isFinite(r.ptPractice)) r.ratio = r.ptPractice / r.ptRest;
    }
    return rows;
  }

  // 共鳴テンポの測り直しの案内。最後のテストから 30 日以上たっていたら日数を返す（なければ null）。テストが 1 件も無いときは 'none'
  function retestDue(tests, nowMs, days) {
    days = days || 30;
    const ts = (tests || []).map(t => Date.parse(t.date)).filter(Number.isFinite);
    if (!ts.length) return 'none';
    const ago = Math.floor((nowMs - Math.max(...ts)) / 86400000);
    return ago >= days ? ago : null;
  }

  // 体調メモ: 記録ごとに任意。{sleep:'good'|'bad', alcohol, sick, hard, text}。何も入っていなければ null（記録に付けない）
  function normalizeMemo(m) {
    if (!m || typeof m !== 'object') return null;
    const o = {};
    if (m.sleep === 'good' || m.sleep === 'bad') o.sleep = m.sleep;
    if (m.alcohol) o.alcohol = true;
    if (m.sick) o.sick = true;
    if (m.hard) o.hard = true;
    const text = typeof m.text === 'string' ? m.text.trim().slice(0, 200) : '';
    if (text) o.text = text;
    return Object.keys(o).length ? o : null;
  }
  function memoSummary(m) {
    m = normalizeMemo(m);
    if (!m) return '';
    const a = [];
    if (m.sleep) a.push(m.sleep === 'good' ? '睡眠 良い' : '睡眠 悪い');
    if (m.alcohol) a.push('前夜の酒');
    if (m.sick) a.push('体調不良');
    if (m.hard) a.push('激しい運動');
    if (m.text) a.push(m.text);
    return a.join('・');
  }

  const Trend = { REF_OK_RATIO, lnRmssd, dayKey, isReference, buildTrend, retestDue, normalizeMemo, memoSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = Trend;
  else root.Trend = Trend;
})(typeof window !== 'undefined' ? window : globalThis);
