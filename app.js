// 画面とデバイスの扱い。信号処理は signal.js（window.Signal）
(() => {
  'use strict';
  const S = window.Signal;
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();

  // ---------- 保存 ----------
  const KEY = 'resonance-breath.v1';
  const DEF = { settings: { ratio: 0.4, sound: true, vib: true, segSec: 120, bpm: 6, practiceMin: 10, camId: null }, tests: [], sessions: [] };
  let db;
  try { db = Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || '{}')); db.settings = Object.assign({}, DEF.settings, db.settings); }
  catch (e) { db = JSON.parse(JSON.stringify(DEF)); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toastQuality('記録を保存できませんでした（容量不足の可能性）', 'bad'); } };

  // ---------- 拍の受け皿（カメラ・ベルト共通。時刻は performance.now） ----------
  let beats = [];          // {t, rr, ok}
  let source = null;       // 'cam' | 'ble'
  let lastBeatAt = 0;
  function onBeat(b) {
    beats.push(b);
    lastBeatAt = now();
    if (beats.length > 4000) beats.splice(0, beats.length - 4000);
    if (b.ok) $('hrNow').textContent = Math.round(60000 / b.rr);
  }

  // ---------- カメラ（指先 PPG） ----------
  const video = $('video');
  let camStream = null, camTrack = null, detector = null, frameCanvas = null, frameCtx = null;
  let ppgBuf = [];  // {t, v} 直近 6 秒（波形表示用）
  let finger = false, fingerSince = 0;

  const hasTorch = (track) => { try { return !!(track.getCapabilities && track.getCapabilities().torch); } catch (e) { return false; } };
  async function openStream(deviceId) {
    const v = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } };
    if (deviceId) v.deviceId = { exact: deviceId }; else v.facingMode = { ideal: 'environment' };
    return navigator.mediaDevices.getUserMedia({ video: v, audio: false });
  }
  const stopStream = (s) => s && s.getTracks().forEach(t => t.stop());

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toastQuality('このブラウザではカメラが使えません（https で開いているか確認）', 'bad'); return; }
    stopAll();
    setQuality('カメラを準備中…', '');
    let stream;
    try { stream = await openStream(db.settings.camId); }
    catch (e) { try { stream = await openStream(null); } catch (e2) { toastQuality('カメラを開けませんでした: ' + e2.name, 'bad'); return; } }
    let track = stream.getVideoTracks()[0];
    // ライトの付かないカメラだったら、他の背面カメラを順に試す
    if (!hasTorch(track)) {
      const cur = track.getSettings().deviceId;
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId !== cur);
      for (const d of devs) {
        let s2;
        try { stopStream(stream); s2 = await openStream(d.deviceId); } catch (e) { continue; }
        const t2 = s2.getVideoTracks()[0];
        if (hasTorch(t2)) { stream = s2; track = t2; break; }
        stopStream(s2);
      }
      if (!stream.active) { try { stream = await openStream(null); track = stream.getVideoTracks()[0]; } catch (e) { toastQuality('カメラを開けませんでした', 'bad'); return; } }
    }
    camStream = stream; camTrack = track;
    if (hasTorch(track)) {
      db.settings.camId = track.getSettings().deviceId || null; save();
      try { await track.applyConstraints({ advanced: [{ torch: true }] }); } catch (e) { /* 付かなくても続ける */ }
    }
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* 再生は frame callback で拾う */ }
    source = 'cam';
    detector = new S.PpgBeatDetector();
    frameCanvas = document.createElement('canvas'); frameCanvas.width = 40; frameCanvas.height = 30;
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
    $('btnCam').textContent = 'カメラ: 使用中';
    $('camHelp').classList.remove('hidden');
    setQuality(hasTorch(track) ? '指をカメラとライトに乗せてください' : 'ライトが付きません。明るい所で指を乗せてください', 'weak');
    pumpFrames();
  }

  function pumpFrames() {
    if (!camStream) return;
    const handle = (ts, meta) => {
      if (!camStream) return;
      let t = now();
      if (meta && meta.captureTime && Math.abs(meta.captureTime - t) < 1000) t = meta.captureTime;
      readFrame(t);
      schedule();
    };
    const schedule = () => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(handle);
      else requestAnimationFrame((ts) => handle(ts, null));
    };
    schedule();
  }

  let lastFrameT = 0;
  const camStat = []; // 直近 2 秒のフレーム時刻（fps 表示用）と赤・緑の平均
  function readFrame(t) {
    if (video.readyState < 2 || t === lastFrameT) return;
    lastFrameT = t;
    const w = frameCanvas.width, h = frameCanvas.height;
    frameCtx.drawImage(video, 0, 0, w, h);
    const d = frameCtx.getImageData(w * 0.2, h * 0.2, w * 0.6, h * 0.6).data;
    let r = 0, g = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; n++; }
    r /= n; g /= n;
    camStat.push(t); while (camStat.length && camStat[0] < t - 2000) camStat.shift();
    camStat.r = r; camStat.g = g;
    // 指が乗ってライトが当たると、赤が強く緑が弱い
    const on = r > 60 && r > g * 1.8;
    if (on !== finger) { finger = on; fingerSince = t; if (!on) detector.reset(); }
    ppgBuf.push({ t, v: on ? r : NaN });
    while (ppgBuf.length && ppgBuf[0].t < t - 6000) ppgBuf.shift();
    if (!on) return;
    if (t - fingerSince < 1500) return; // 乗せた直後は明るさが落ち着くまで待つ
    const out = detector.push(t, r);
    for (const b of out) onBeat(b);
  }

  // ---------- 心拍ベルト（Web Bluetooth） ----------
  let bleDevice = null, bleChar = null, bleLastT = null, bleRecent = [], blePrevOk = null;
  async function startBle() {
    if (!navigator.bluetooth) { toastQuality('このブラウザは Bluetooth に対応していません（Android の Chrome で開いてください）', 'bad'); return; }
    try {
      const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      stopAll();
      bleDevice = dev;
      dev.addEventListener('gattserverdisconnected', () => { if (source === 'ble') { setQuality('ベルトとの接続が切れました', 'bad'); $('btnBle').textContent = '心拍ベルト'; source = null; } });
      setQuality('ベルトに接続中…', '');
      const srv = await dev.gatt.connect();
      const svc = await srv.getPrimaryService('heart_rate');
      bleChar = await svc.getCharacteristic('heart_rate_measurement');
      bleChar.addEventListener('characteristicvaluechanged', onBleValue);
      await bleChar.startNotifications();
      source = 'ble'; bleLastT = null; bleRecent = []; blePrevOk = null;
      $('btnBle').textContent = 'ベルト: ' + (dev.name || '接続中');
      $('camHelp').classList.add('hidden');
      setQuality('ベルトから受信待ち', 'weak');
    } catch (e) {
      if (e.name !== 'NotFoundError') toastQuality('ベルトに接続できませんでした: ' + e.message, 'bad');
    }
  }
  function onBleValue(ev) {
    const m = S.parseHeartRateMeasurement(ev.target.value);
    const t = now();
    if (!m.rr.length) { if (m.hr) $('hrNow').textContent = m.hr; setQuality('ベルトが拍間隔（RR）を送っていません。対応機種か確認してください', 'weak'); return; }
    // 届いた RR を後ろから並べて拍の時刻を復元する。ずれが 3 秒を超えたら今の時刻に合わせ直す
    let tEnd = t;
    const total = m.rr.reduce((s, x) => s + x, 0);
    if (bleLastT !== null && Math.abs(bleLastT + total - t) < 3000) tEnd = bleLastT + total;
    let tb = tEnd - total;
    for (const rr of m.rr) {
      tb += rr;
      const ok = S.judgeRR(rr, blePrevOk, bleRecent);
      bleRecent.push(rr); if (bleRecent.length > 7) bleRecent.shift();
      blePrevOk = ok ? rr : null;
      onBeat({ t: tb, rr, ok, src: 'ble' });
    }
    bleLastT = tEnd;
  }

  function stopAll() {
    stopStream(camStream); camStream = null; camTrack = null; video.srcObject = null;
    $('btnCam').textContent = 'カメラで測る';
    if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
    bleDevice = null; bleChar = null;
    $('btnBle').textContent = '心拍ベルト';
    source = null; finger = false; ppgBuf = [];
  }

  // ---------- 信号の状態表示 ----------
  let toastUntil = 0;
  function setQuality(text, cls) { if (now() < toastUntil) return; $('qText').textContent = text; $('qDot').className = 'dot ' + (cls || ''); }
  function toastQuality(text, cls) { toastUntil = 0; setQuality(text, cls); toastUntil = now() + 5000; }
  function updateQuality() {
    if (!source) return;
    const t = now();
    const recent = beats.filter(b => b.t > t - 15000);
    const okR = recent.length ? recent.filter(b => b.ok).length / recent.length : 0;
    if (source === 'cam') {
      const fps = camStat.length / 2;
      $('camDbg').textContent = `${fps.toFixed(0)} fps・赤 ${Math.round(camStat.r || 0)}・緑 ${Math.round(camStat.g || 0)}`;
      if (!finger) { setQuality('指が乗っていません（ライトの赤い光が指に透けるように）', 'bad'); return; }
      if (camStat.r > 248) { setQuality('明るすぎて脈が消えています。指を少しずらすか、押す強さを変えて', 'bad'); return; }
      if (fps < 15) { setQuality(`カメラのコマ数が少なすぎます（${fps.toFixed(0)} fps）`, 'bad'); return; }
    }
    if (t - lastBeatAt > 4000) { setQuality(source === 'cam' ? '脈を探しています…指を動かさずに' : '受信待ち', 'weak'); return; }
    if (recent.length < 8) { setQuality('脈を拾い始めました', 'weak'); return; }
    if (okR >= 0.85) setQuality(`信号良好（きれいな拍 ${Math.round(okR * 100)}%）`, 'good');
    else if (okR >= 0.7) setQuality(`信号やや弱い（${Math.round(okR * 100)}%）指を動かさずに`, 'weak');
    else setQuality(`信号が乱れています（${Math.round(okR * 100)}%）押す強さを変えてみて`, 'bad');
  }
  setInterval(updateQuality, 700);

  // ---------- 描画 ----------
  function fitCanvas(c) {
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function drawPpg() {
    const c = $('ppg'); if (!c.offsetParent) return;
    const { ctx, w, h } = fitCanvas(c);
    ctx.clearRect(0, 0, w, h);
    const pts = ppgBuf.filter(p => !isNaN(p.v));
    if (pts.length < 10) return;
    const t1 = ppgBuf[ppgBuf.length - 1].t, t0 = t1 - 6000;
    // 1 秒の移動平均を引いて波だけを見せる（反転して山を上に）
    const vs = pts.map((p, i) => { let s = 0, n = 0; for (let j = i; j >= 0 && pts[j].t > p.t - 1000; j--) { s += pts[j].v; n++; } return -(p.v - s / n); });
    let mn = Infinity, mx = -Infinity; vs.forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; });
    if (mx - mn < 1e-6) return;
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5; ctx.beginPath();
    pts.forEach((p, i) => { const x = (p.t - t0) / 6000 * w, y = h - 4 - (vs[i] - mn) / (mx - mn) * (h - 8); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }

  function drawHr(run) {
    const c = $('hrChart'); if (!c.offsetParent) return;
    const { ctx, w, h } = fitCanvas(c);
    ctx.clearRect(0, 0, w, h);
    const t1 = now(), span = 60000, t0 = t1 - span;
    const pts = beats.filter(b => b.ok && b.t > t0).map(b => ({ t: b.t, hr: 60000 / b.rr }));
    let mn = 55, mx = 85;
    if (pts.length) { mn = Math.min(...pts.map(p => p.hr)) - 3; mx = Math.max(...pts.map(p => p.hr)) + 3; if (mx - mn < 12) { const m = (mx + mn) / 2; mn = m - 6; mx = m + 6; } }
    const X = (t) => (t - t0) / span * w, Y = (v) => h - 16 - (v - mn) / (mx - mn) * (h - 24);
    // 呼吸ガイドの形（吸うと上、吐くと下）を薄く敷く
    if (run) {
      ctx.fillStyle = 'rgba(95,196,184,.10)'; ctx.beginPath(); ctx.moveTo(0, h - 16);
      for (let x = 0; x <= w; x += 3) { const p = S.pacer(t0 + x / w * span, run.pacerStart, run.bpm, db.settings.ratio); ctx.lineTo(x, h - 16 - p.size * (h - 24)); }
      ctx.lineTo(w, h - 16); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = css('--muted'); ctx.font = '11px system-ui';
    ctx.fillText(Math.round(mx), 2, 10); ctx.fillText(Math.round(mn), 2, h - 18); ctx.fillText('直近 60 秒の心拍', w - 92, h - 3);
    if (pts.length < 2) return;
    ctx.strokeStyle = css('--accent2'); ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { const x = X(p.t), y = Y(p.hr); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }

  // ---------- 音と振動 ----------
  let actx = null;
  function ensureAudio() { if (!actx && window.AudioContext) actx = new AudioContext(); if (actx && actx.state === 'suspended') actx.resume(); }
  function chime(up) {
    if (!db.settings.sound || !actx) return;
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = 'sine';
    o.frequency.setValueAtTime(up ? 392 : 523, t); o.frequency.exponentialRampToValueAtTime(up ? 523 : 392, t + 0.6);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 1);
  }
  // カメラで測っている間は振動させない（指とレンズが揺れて、呼吸のテンポに偽の揺れが乗るため）
  function buzz(up) { if (db.settings.vib && source !== 'cam' && navigator.vibrate) navigator.vibrate(up ? 40 : [20, 80, 20]); }

  // ---------- 画面の消灯を防ぐ ----------
  let wakeLock = null;
  async function lockScreen() { try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 無くても動く */ } }
  document.addEventListener('visibilitychange', () => { if (run && document.visibilityState === 'visible') lockScreen(); });

  // ---------- 実行（テスト・練習） ----------
  let run = null; // {kind, segs:[{bpm,start,end}], idx, pacerStart, bpm, t0, tEnd, lastPhase}
  function startRun(kind, plan) {
    // テストは心拍が要る。練習は測らずにガイドだけでもよい（カメラのライトを長く点けると熱くなるため）
    if (!source && kind === 'test') { toastQuality('先に「カメラで測る」か「心拍ベルト」を選んでください', 'bad'); window.scrollTo(0, 0); return; }
    ensureAudio(); lockScreen();
    const t0 = now();
    let acc = t0;
    const segs = plan.map(p => { const s = { bpm: p.bpm, start: acc, end: acc + p.sec * 1000 }; acc = s.end; return s; });
    run = { kind, source, segs, idx: 0, pacerStart: t0, bpm: segs[0].bpm, t0, tEnd: acc, lastPhase: null, beatFrom: beats.length };
    $('guideCard').classList.remove('hidden');
    $('srcCard').querySelector('.src').classList.add('hidden');
    document.querySelectorAll('nav button').forEach(b => b.disabled = true);
    $('testIntro').classList.add('hidden'); $('practiceSetup').classList.add('hidden');
    $('testResult').classList.add('hidden'); $('practiceResult').classList.add('hidden');
    tick();
  }
  function endRun(completed) {
    const r = run; run = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('guideCard').classList.add('hidden');
    $('srcCard').querySelector('.src').classList.remove('hidden');
    document.querySelectorAll('nav button').forEach(b => b.disabled = false);
    $('testIntro').classList.remove('hidden'); $('practiceSetup').classList.remove('hidden');
    if (!r) return;
    const tStop = now();
    if (r.kind === 'test') finishTest(r, completed, tStop); else finishPractice(r, tStop);
  }

  function tick() {
    if (!run) return;
    const t = now();
    if (t >= run.tEnd) { endRun(true); return; }
    let seg = run.segs[run.idx];
    if (t >= seg.end) { run.idx++; seg = run.segs[run.idx]; run.pacerStart = seg.start; run.bpm = seg.bpm; run.lastPhase = null; }
    const p = S.pacer(t, run.pacerStart, run.bpm, db.settings.ratio);
    if (p.phase !== run.lastPhase) { chime(p.phase === 'in'); buzz(p.phase === 'in'); run.lastPhase = p.phase; }
    $('orb').style.transform = `scale(${0.45 + 0.55 * p.size})`;
    $('cueWord').textContent = p.phase === 'in' ? '吸う' : '吐く';
    $('cueSub').textContent = Math.ceil(p.remainMs / 1000) + ' 秒';
    const total = run.tEnd - run.t0;
    $('progBar').style.width = ((t - run.t0) / total * 100).toFixed(1) + '%';
    const left = Math.ceil((run.kind === 'test' ? seg.end - t : run.tEnd - t) / 1000);
    const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('progText').textContent = run.kind === 'test'
      ? `${run.idx + 1}/${run.segs.length}　${seg.bpm} 回/分　残り ${mmss}`
      : `${seg.bpm} 回/分　残り ${mmss}`;
    drawHr(run);
    requestAnimationFrame(tick);
  }

  const SETTLE = 20000; // テンポを変えた直後の 20 秒は集計しない
  function finishTest(r, completed, tStop) {
    const res = r.segs.filter(s => s.start + SETTLE + 60000 <= Math.min(s.end, tStop)).map(s =>
      S.segmentMetrics(beats, { tStart: s.start + SETTLE, tEnd: Math.min(s.end, tStop), pacerStart: s.start, bpm: s.bpm }));
    if (!res.length) { toastQuality('短すぎて判定できませんでした', 'weak'); return; }
    const rec = S.recommend(res);
    const rec2 = { id: Date.now(), date: new Date().toISOString(), source, segSec: (r.segs[0].end - r.segs[0].start) / 1000, completed, segs: res, bpm: rec.bpm, reason: rec.reason };
    db.tests.push(rec2); save();
    showTestResult(rec2);
    renderHistory();
  }
  const f1 = (v, d = 1) => (isFinite(v) ? v.toFixed(d) : '—');
  function showTestResult(t) {
    $('testResult').classList.remove('hidden');
    $('recBpm').textContent = t.bpm ? `${t.bpm} 回/分` : '判定できず';
    $('recReason').textContent = t.reason + (t.completed ? '' : '（途中でやめたので、測れたテンポだけで判定）');
    const tb = $('resTable'); tb.textContent = '';
    const hd = tb.insertRow(); ['テンポ', '山谷差', '呼吸帯', 'RMSSD', '心拍', '採用'].forEach(x => { const th = document.createElement('th'); th.textContent = x; hd.appendChild(th); });
    for (const s of t.segs) {
      const tr = tb.insertRow(); if (s.bpm === t.bpm) tr.className = 'best';
      [s.bpm, f1(s.peakTrough), isFinite(s.breathShare) ? Math.round(s.breathShare * 100) + '%' : '—', f1(s.rmssd, 0), f1(s.meanHr, 0), Math.round(s.okRatio * 100) + '%']
        .forEach(v => { tr.insertCell().textContent = v; });
    }
    $('btnUseRec').disabled = !t.bpm;
    $('btnUseRec').onclick = () => { db.settings.bpm = t.bpm; save(); $('pBpm').value = t.bpm; showTab('practice'); };
  }

  function finishPractice(r, tStop) {
    const dur = (tStop - r.t0) / 1000;
    if (dur < 60) { toastQuality('1 分未満なので記録しませんでした', 'weak'); return; }
    const m = S.segmentMetrics(beats, { tStart: r.t0 + SETTLE, tEnd: tStop, pacerStart: r.t0, bpm: r.bpm });
    const s = { id: Date.now(), date: new Date().toISOString(), source: r.source || 'none', bpm: r.bpm, ratio: db.settings.ratio, minutes: Math.round(dur / 6) / 10,
      meanHr: m.meanHr, rmssd: m.rmssd, peakTrough: m.peakTrough, breathShare: m.breathShare, okRatio: m.okRatio };
    db.sessions.push(s); save();
    const tb = $('pResTable'); tb.textContent = '';
    [['時間', s.minutes + ' 分'], ['テンポ', s.bpm + ' 回/分'], ['平均心拍', f1(s.meanHr, 0) + ' 拍/分'], ['山谷差', f1(s.peakTrough) + ' 拍/分'],
     ['RMSSD', f1(s.rmssd, 0) + ' ms'], ['呼吸帯', isFinite(s.breathShare) ? Math.round(s.breathShare * 100) + '%' : '—'], ['採用', Math.round(s.okRatio * 100) + '%']]
      .forEach(([k, v]) => { const tr = tb.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; });
    $('practiceResult').classList.remove('hidden');
    renderHistory();
  }

  // ---------- 記録 ----------
  const fmtDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  function renderHistory() {
    const tl = $('testList'); tl.textContent = '';
    db.tests.slice().reverse().forEach(t => {
      const it = document.createElement('div'); it.className = 'item';
      const a = document.createElement('span'); a.textContent = fmtDate(t.date) + (t.source === 'ble' ? '（ベルト）' : '（カメラ）');
      const b = document.createElement('b'); b.textContent = t.bpm ? t.bpm + ' 回/分' : '判定できず';
      it.append(a, b); it.onclick = () => { showTab('test'); showTestResult(t); }; tl.appendChild(it);
    });
    if (!db.tests.length) tl.textContent = 'まだありません';
    const sl = $('sessList'); sl.textContent = '';
    db.sessions.slice().reverse().forEach(s => {
      const it = document.createElement('div'); it.className = 'item';
      const a = document.createElement('span'); a.textContent = `${fmtDate(s.date)}　${s.bpm} 回/分 ${s.minutes} 分`;
      const b = document.createElement('span'); b.textContent = `山谷差 ${f1(s.peakTrough)}・RMSSD ${f1(s.rmssd, 0)}`;
      it.append(a, b); sl.appendChild(it);
    });
    if (!db.sessions.length) sl.textContent = 'まだありません';
    drawHistory();
  }
  function drawHistory() {
    const c = $('histChart');
    const ss = db.sessions.filter(s => isFinite(s.peakTrough) || isFinite(s.rmssd));
    $('histEmpty').classList.toggle('hidden', ss.length > 0);
    c.classList.toggle('hidden', ss.length === 0);
    if (!ss.length || !c.offsetParent) return;
    const { ctx, w, h } = fitCanvas(c);
    ctx.clearRect(0, 0, w, h);
    const padL = 28, padR = 28, padT = 8, padB = 20;
    const n = ss.length, X = (i) => padL + (n === 1 ? (w - padL - padR) / 2 : i / (n - 1) * (w - padL - padR));
    const line = (key, color, side) => {
      const vs = ss.map(s => s[key]).filter(isFinite); if (!vs.length) return;
      const mx = Math.max(...vs) * 1.1 || 1;
      const Y = (v) => h - padB - v / mx * (h - padT - padB);
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      let first = true;
      ss.forEach((s, i) => { if (!isFinite(s[key])) return; const x = X(i), y = Y(s[key]); first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false; });
      ctx.stroke();
      ss.forEach((s, i) => { if (isFinite(s[key])) { ctx.beginPath(); ctx.arc(X(i), Y(s[key]), 2.5, 0, 7); ctx.fill(); } });
      ctx.font = '11px system-ui'; ctx.textAlign = side === 'l' ? 'left' : 'right';
      ctx.fillText(Math.round(mx), side === 'l' ? 0 : w, padT + 8);
    };
    ctx.strokeStyle = css('--line'); ctx.beginPath(); ctx.moveTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();
    line('peakTrough', css('--accent'), 'l');
    line('rmssd', css('--accent2'), 'r');
    ctx.fillStyle = css('--muted'); ctx.textAlign = 'left'; ctx.fillText(fmtDate(ss[0].date).split(' ')[0], padL, h - 4);
    ctx.textAlign = 'right'; ctx.fillText(fmtDate(ss[n - 1].date).split(' ')[0], w - padR, h - 4);
  }

  // ---------- ファイル ----------
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function saveBreathingJson() {
    const bpm = Number($('pBpm').value) || db.settings.bpm;
    download('breathing.json', { bpm, inhale_ratio: db.settings.ratio, measured_at: new Date().toISOString(), source: 'smartphone' });
  }

  // ---------- タブ・設定 ----------
  function showTab(name) {
    document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === 'tab-' + name));
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    $('srcCard').classList.toggle('hidden', name === 'history' || name === 'settings');
    if (name === 'history') renderHistory();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

  $('btnCam').onclick = startCamera;
  $('btnBle').onclick = startBle;
  $('btnStop').onclick = () => endRun(false);
  $('btnTest').onclick = () => {
    db.settings.segSec = Number($('segSec').value); save();
    startRun('test', [6.5, 6, 5.5, 5, 4.5].map(bpm => ({ bpm, sec: db.settings.segSec })));
  };
  $('btnPractice').onclick = () => {
    const bpm = Math.min(8, Math.max(3, Number($('pBpm').value) || 6));
    db.settings.bpm = bpm; db.settings.practiceMin = Number($('pMin').value); save();
    startRun('practice', [{ bpm, sec: db.settings.practiceMin * 60 }]);
  };
  $('btnJson1').onclick = () => { const t = db.tests[db.tests.length - 1]; if (t && t.bpm) $('pBpm').value = t.bpm; saveBreathingJson(); };
  $('btnJson2').onclick = saveBreathingJson;
  $('btnExport').onclick = () => download(`resonance-records-${new Date().toISOString().slice(0, 10)}.json`, db);
  $('fileImport').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      if (!Array.isArray(o.tests) || !Array.isArray(o.sessions)) throw new Error('形式が違います');
      const ids = new Set([...db.tests, ...db.sessions].map(x => x.id));
      db.tests.push(...o.tests.filter(x => !ids.has(x.id))); db.sessions.push(...o.sessions.filter(x => !ids.has(x.id)));
      db.tests.sort((a, b) => a.id - b.id); db.sessions.sort((a, b) => a.id - b.id);
      save(); renderHistory(); toastQuality('記録を読み込みました', 'good');
    } catch (err) { toastQuality('読み込めませんでした: ' + err.message, 'bad'); }
    e.target.value = '';
  };
  $('sRatio').value = String(db.settings.ratio);
  $('sRatio').onchange = (e) => { db.settings.ratio = Number(e.target.value); save(); updateNote(); };
  $('sSound').checked = db.settings.sound; $('sSound').onchange = (e) => { db.settings.sound = e.target.checked; save(); };
  $('sVib').checked = db.settings.vib; $('sVib').onchange = (e) => { db.settings.vib = e.target.checked; save(); };
  $('segSec').value = String(db.settings.segSec);
  $('pBpm').value = db.settings.bpm; $('pMin').value = String(db.settings.practiceMin);
  function updateNote() {
    const bpm = Number($('pBpm').value) || 6, per = 60 / bpm;
    $('pNote').textContent = `1 呼吸 ${per.toFixed(1)} 秒（吸う ${(per * db.settings.ratio).toFixed(1)} 秒・吐く ${(per * (1 - db.settings.ratio)).toFixed(1)} 秒）`;
  }
  $('pBpm').oninput = updateNote; updateNote();
  const lastTest = db.tests[db.tests.length - 1];
  if (lastTest) showTestResult(lastTest);

  // 波形はテスト中以外も描く
  (function loop() { drawPpg(); if (!run && $('guideCard').classList.contains('hidden') === false) drawHr(null); requestAnimationFrame(loop); })();
  window.addEventListener('resize', drawHistory);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
