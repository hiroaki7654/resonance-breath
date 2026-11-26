// 画面とデバイスの扱い。信号処理は signal.js（window.Signal）
(() => {
  'use strict';
  const S = window.Signal;
  const T = window.Trend;
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();

  // ---------- 保存 ----------
  const KEY = 'resonance-breath.v1';
  const DEF = { settings: { ratio: 0.4, cue: 'voice', warn: true, vib: true, segSec: 120, bpm: 6, practiceMin: 10, camId: null, verify: false }, tests: [], sessions: [], rests: [] }; // rests = 朝の安静時測定（kind: 'rest'）。練習の sessions とは別の配列（kind の無い古い記録は練習）
  let db;
  try { db = Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || '{}')); db.settings = Object.assign({}, DEF.settings, db.settings); }
  catch (e) { db = JSON.parse(JSON.stringify(DEF)); }
  if (!Array.isArray(db.rests)) db.rests = [];
  if ('sound' in db.settings) { if (db.settings.sound === false) db.settings.cue = 'none'; delete db.settings.sound; } // 旧設定から移す
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toastQuality('記録を保存できませんでした（容量不足の可能性）', 'bad'); } };

  // ---------- 拍の受け皿（カメラ・ベルト共通。時刻は performance.now） ----------
  let beats = [];          // {t, rr, ok}
  let source = null;       // 'cam' | 'ble'
  let lastBeatAt = 0, lastOkAt = 0;
  function onBeat(b) {
    beats.push(b);
    lastBeatAt = now();
    if (b.ok) lastOkAt = lastBeatAt;
    if (beats.length > 4000) beats.splice(0, beats.length - 4000);
    if (b.ok) $('hrNow').textContent = Math.round(60000 / b.rr);
  }

  // ---------- 検証モード（カメラと胸ベルトを同時に記録。docs/製品設計.md §2.1） ----------
  // ON のとき: 胸ベルトが主（テスト・練習はベルトの拍で動く）、カメラは従（拍を記録するだけ）。OFF のときは今までと同じ
  let verifyLog = null;
  const verifyOn = () => !!db.settings.verify;
  function ensureVerifyLog() {
    if (!verifyLog) verifyLog = { format: 'metatron-verify', version: 1, userAgent: navigator.userAgent, startedAt: new Date().toISOString(), startedPerf: now(),
      cam: { beats: [], stat: [] }, ble: { notifications: [] }, segments: [] };
    return verifyLog;
  }
  let lastCamStatLog = 0;
  function logCamStat(t, fps, r, g, on) {
    if (!verifyOn() || t - lastCamStatLog < 1000) return;
    lastCamStatLog = t; const L = ensureVerifyLog();
    if (L.cam.stat.length < 20000) L.cam.stat.push({ t, fps, r, g, finger: on });
  }
  // 主の機器を決め直す（検証モードのみ。ベルトがつながっていればベルト、なければカメラ）
  function updateSource() {
    source = (bleDevice && bleDevice.gatt && bleDevice.gatt.connected && bleChar) ? 'ble' : (camStream ? 'cam' : null);
  }
  function onCamBeat(b) {
    if (verifyOn()) {
      const L = ensureVerifyLog();
      if (L.cam.beats.length < 20000) L.cam.beats.push({ t: b.t, ibi: b.rr, ok: b.ok });
      if (source !== 'cam') return; // ベルトが主のときは記録だけ（警告・判定には使わない）
    }
    onBeat(b);
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
    if (verifyOn()) stopCam(); else stopAll();
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
    if (verifyOn()) updateSource(); else source = 'cam';
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
  let perCache = { t: 0, v: 0 };
  function camPeriodicity() { // 直近 5 秒の脈波の周期性。1 秒に 1 回だけ計算する
    const t = now();
    if (t - perCache.t > 900) { const t1 = ppgBuf.length ? ppgBuf[ppgBuf.length - 1].t : t; perCache = { t, v: S.periodicity(ppgBuf.filter(p => p.t > t1 - 5000)) }; }
    return perCache.v;
  }
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
    logCamStat(t, camStat.length / 2, Math.round(r * 10) / 10, Math.round(g * 10) / 10, on);
    ppgBuf.push({ t, v: on ? r : NaN });
    while (ppgBuf.length && ppgBuf[0].t < t - 6000) ppgBuf.shift();
    if (!on) return;
    if (t - fingerSince < 1500) return; // 乗せた直後は明るさが落ち着くまで待つ
    const out = detector.push(t, r);
    for (const b of out) onCamBeat(b);
  }

  // ---------- 心拍ベルト（Web Bluetooth） ----------
  let bleDevice = null, bleChar = null, bleLastT = null, bleRecent = [], blePrevOk = null;
  async function startBle() {
    if (!navigator.bluetooth) { toastQuality('このブラウザは Bluetooth に対応していません（Android の Chrome で開いてください）', 'bad'); return; }
    try {
      const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      if (verifyOn()) stopBle(); else stopAll();
      bleDevice = dev;
      dev.addEventListener('gattserverdisconnected', () => { if (source === 'ble') { setQuality('ベルトとの接続が切れました', 'bad'); $('btnBle').textContent = '心拍ベルト'; source = (verifyOn() && camStream) ? 'cam' : null; } });
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
    if (verifyOn()) { const L = ensureVerifyLog(); if (L.ble.notifications.length < 20000) L.ble.notifications.push({ t, hr: m.hr, rr: m.rr.slice() }); }
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

  function stopCam() {
    stopStream(camStream); camStream = null; camTrack = null; video.srcObject = null;
    $('btnCam').textContent = 'カメラで測る';
    finger = false; ppgBuf = [];
  }
  function stopBle() {
    if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
    bleDevice = null; bleChar = null;
    $('btnBle').textContent = '心拍ベルト';
  }
  function stopAll() {
    stopCam(); stopBle();
    source = null;
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
      const per = camPeriodicity();
      $('camDbg').textContent = `${fps.toFixed(0)} fps・赤 ${Math.round(camStat.r || 0)}・緑 ${Math.round(camStat.g || 0)}・脈の形 ${Math.round(per * 100)}`;
      if (!finger) { setQuality('指が乗っていません（ライトの赤い光が指に透けるように）', 'bad'); return; }
      if (camStat.r > 248) { setQuality('明るすぎて脈が消えています。指を少しずらすか、押す強さを変えて', 'bad'); return; }
      if (fps < 15) { setQuality(`カメラのコマ数が少なすぎます（${fps.toFixed(0)} fps）`, 'bad'); return; }
      if (finger && now() - fingerSince > 4000 && per < 0.4) { setQuality('脈の形が見えません。指を動かさず、押す強さを変えてみて', 'bad'); return; }
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
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = 'sine';
    o.frequency.setValueAtTime(up ? 392 : 523, t); o.frequency.exponentialRampToValueAtTime(up ? 523 : 392, t + 0.6);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 1);
  }

  // 女性の声（tools/make-voice.ps1 で作った app/voice/*.wav）。頭の無音を切って、切り替わりと声の出だしを合わせる
  const clips = {};
  let clipsLoading = null;
  function loadClips() {
    if (clipsLoading || !actx) return clipsLoading;
    clipsLoading = Promise.all(['in', 'out', 'end', 'lost'].map(async (k) => {
      try {
        const buf = await actx.decodeAudioData(await (await fetch(`voice/${k}.wav`)).arrayBuffer());
        const d = buf.getChannelData(0);
        let i = 0; while (i < d.length && Math.abs(d[i]) < 0.01) i++;
        clips[k] = { buf, offset: Math.max(0, i / buf.sampleRate - 0.02) };
      } catch (e) { /* 声が無くても音で続ける */ }
    }));
    return clipsLoading;
  }
  let voiceSrc = null;
  function say(k, gain) {
    const c = clips[k]; if (!c || !actx) return false;
    // 「脈が取れていません」の途中なら切らない（呼び出し側は音の合図に切り替える）
    if (voiceSrc && voiceSrc.clip === 'lost' && now() < voiceSrc.endAt && k !== 'end') return false;
    if (voiceSrc) { try { voiceSrc.stop(); } catch (e) { /* 済み */ } }
    const s = actx.createBufferSource(), g = actx.createGain();
    s.buffer = c.buf; g.gain.value = gain || 1;
    s.connect(g).connect(actx.destination); s.start(0, c.offset);
    s.clip = k; s.endAt = now() + (c.buf.duration - c.offset) * 1000; voiceSrc = s;
    return true;
  }
  // 呼吸の切り替わりの合図（声・音・なし）
  function cue(up) {
    const m = db.settings.cue;
    if (m === 'voice' && say(up ? 'in' : 'out')) return;
    if (m !== 'none') chime(up);
  }

  // 脈が取れないときのやさしい警告音（低めの 2 音がふわっと下がる）。呼吸の合図とは違う音にする
  function warnTone() {
    if (!actx) return;
    const t = actx.currentTime;
    [[659, 0], [523, 0.35]].forEach(([f, dt]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.07, t + dt + 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.8);
      o.connect(g).connect(actx.destination); o.start(t + dt); o.stop(t + dt + 0.85);
    });
  }
  function okTone() { // 脈が戻ったとき
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = 'sine'; o.frequency.value = 784;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.55);
  }
  // 測りながら実行しているときだけ見張る。3 秒続けて取れなければ鳴らし、取れない間は 8 秒おきに繰り返す
  // 「取れていない」= きれいな拍（採用した拍）が 4 秒来ない、または直近 8 秒の拍の半分以上が乱れている。
  // 乱れた拍も数えると、指がずれて雑音を拾っている間は「取れている」ことになり、警告が鳴らなかった（2026-11-26 実機）
  function pulseLost() {
    if (!source) return true; // 途中で接続が切れた
    if (source === 'cam' && (!finger || camStat.r > 248)) return true;
    // 雑音でも間隔のそろった「拍らしきもの」が 6 割ほど合格してしまうので、カメラでは脈波の形の周期性も見る
    if (source === 'cam' && camPeriodicity() < 0.4) return true;
    const t = now();
    if (t - lastOkAt > 4000) return true;
    const recent = beats.filter(b => b.t > t - 8000);
    return recent.length >= 4 && recent.filter(b => b.ok).length / recent.length < 0.6;
  }
  function watchPulse() {
    if (!run || !run.source || !db.settings.warn) return;
    const t = now();
    if (t - run.t0 < 10000) return; // 始めの 10 秒は待つ
    const lost = pulseLost();
    if (lost) {
      run.goodSince = 0;
      if (!run.lostSince) { run.lostSince = t; run.warnedAt = 0; }
      if (t - run.lostSince >= 3000 && t - run.warnedAt >= 8000) {
        if (!run.warnedAt && db.settings.cue === 'voice' && clips.lost && run.kind !== 'rest') { warnTone(); setTimeout(() => run && run.lostSince && say('lost', 0.9), 1000); }
        else warnTone();
        run.warnedAt = t;
      }
    } else if (run.lostSince) {
      // 一瞬戻っただけで解除しない（3 秒続けて取れたら解除）
      if (!run.goodSince) run.goodSince = t;
      if (t - run.goodSince >= 3000) { if (run.warnedAt) okTone(); run.lostSince = 0; run.goodSince = 0; }
    }
  }
  setInterval(watchPulse, 1000);
  // カメラで測っている間は振動させない（指とレンズが揺れて、呼吸のテンポに偽の揺れが乗るため）
  function buzz(up) { if (db.settings.vib && source !== 'cam' && navigator.vibrate) navigator.vibrate(up ? 40 : [20, 80, 20]); }

  // ---------- 画面の消灯を防ぐ ----------
  let wakeLock = null;
  async function lockScreen() { try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 無くても動く */ } }
  document.addEventListener('visibilitychange', () => { if (run && document.visibilityState === 'visible') lockScreen(); });

  // ---------- 実行（テスト・練習） ----------
  let run = null; // {kind, segs:[{bpm,start,end}], idx, pacerStart, bpm, t0, tEnd, lastPhase}
  async function startRun(kind, plan) {
    // テストは心拍が要る。練習は測らずにガイドだけでもよい（カメラのライトを長く点けると熱くなるため）
    if (!source && (kind === 'test' || kind === 'rest')) { toastQuality('先に「カメラで測る」か「心拍ベルト」を選んでください', 'bad'); window.scrollTo(0, 0); return; }
    ensureAudio(); lockScreen();
    await Promise.race([loadClips(), new Promise(r => setTimeout(r, 2000))]); // 最初の「すって」に間に合わせる
    const t0 = now();
    let acc = t0;
    const segs = plan.map(p => { const s = { bpm: p.bpm, start: acc, end: acc + p.sec * 1000 }; acc = s.end; return s; });
    run = { kind, posture: plan.posture, source, segs, idx: 0, pacerStart: t0, bpm: segs[0].bpm, t0, tEnd: acc, lastPhase: null, beatFrom: beats.length };
    if (verifyOn()) run.verifyRecs = segs.map(s => { const o = { kind, startT: s.start, bpm: s.bpm, durationMs: s.end - s.start }; ensureVerifyLog().segments.push(o); return o; });
    $('guideCard').classList.remove('hidden');
    $('srcCard').querySelector('.src').classList.add('hidden');
    document.querySelectorAll('nav button').forEach(b => b.disabled = true);
    $('testIntro').classList.add('hidden'); $('practiceSetup').classList.add('hidden'); $('restSetup').classList.add('hidden');
    $('testResult').classList.add('hidden'); $('practiceResult').classList.add('hidden'); $('restResult').classList.add('hidden');
    tick();
  }
  function endRun(completed) {
    const r = run; run = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('guideCard').classList.add('hidden');
    $('srcCard').querySelector('.src').classList.remove('hidden');
    document.querySelectorAll('nav button').forEach(b => b.disabled = false);
    $('testIntro').classList.remove('hidden'); $('practiceSetup').classList.remove('hidden'); $('restSetup').classList.remove('hidden');
    if (!r) return;
    const tStop = now();
    if (r.verifyRecs) for (const o of r.verifyRecs) { o.durationMs = Math.max(0, Math.min(o.durationMs, tStop - o.startT)); if (o.durationMs <= 0 && verifyLog) verifyLog.segments.splice(verifyLog.segments.indexOf(o), 1); }
    if (r.kind === 'test') finishTest(r, completed, tStop); else if (r.kind === 'rest') finishRest(r, tStop); else finishPractice(r, tStop);
  }

  function tick() {
    if (!run) return;
    const t = now();
    const isRest = run.kind === 'rest'; // 朝の測定: ペーサー・声・振動なし
    if (t >= run.tEnd) { if (isRest) okTone(); else if (db.settings.cue === 'voice' && !say('end')) chime(false); else if (db.settings.cue === 'chime') chime(false); endRun(true); return; }
    let seg = run.segs[run.idx];
    if (t >= seg.end) { run.idx++; seg = run.segs[run.idx]; run.pacerStart = seg.start; run.bpm = seg.bpm; run.lastPhase = null; }
    const p = S.pacer(t, run.pacerStart, run.bpm, db.settings.ratio);
    if (!isRest && p.phase !== run.lastPhase) { cue(p.phase === 'in'); buzz(p.phase === 'in'); run.lastPhase = p.phase; }
    if (isRest) { $('orb').style.transform = 'scale(0.6)'; $('cueWord').textContent = '自然な呼吸で'; $('cueSub').textContent = Math.ceil((run.tEnd - t) / 1000) + ' 秒'; }
    else {
      $('orb').style.transform = `scale(${0.45 + 0.55 * p.size})`;
      $('cueWord').textContent = p.phase === 'in' ? '吸って' : '吐いて';
      $('cueSub').textContent = Math.ceil(p.remainMs / 1000) + ' 秒';
    }
    const total = run.tEnd - run.t0;
    $('progBar').style.width = ((t - run.t0) / total * 100).toFixed(1) + '%';
    const left = Math.ceil((run.kind === 'test' ? seg.end - t : run.tEnd - t) / 1000);
    const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('progText').textContent = isRest ? `残り ${mmss}` : run.kind === 'test'
      ? `${run.idx + 1}/${run.segs.length}　${seg.bpm} 回/分　残り ${mmss}`
      : `${seg.bpm} 回/分　残り ${mmss}`;
    drawHr(isRest ? null : run);
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
    showMemo($('pMemo'), s);
    $('practiceResult').classList.remove('hidden');
    renderHistory();
  }

  // 朝の測定。自然な呼吸なのでガイドは無い。山谷差は 10 秒の窓（6 回/分の 1 呼吸と同じ長さ）の最大−最小の平均で、練習の山谷差との倍率に使う
  const REST_MIN_SEC = 120;
  const POSTURE = { sit: '座る', lie: '寝る' };
  function finishRest(r, tStop) {
    const dur = (tStop - r.t0) / 1000;
    if (dur < REST_MIN_SEC) { toastQuality('2 分未満なので記録しませんでした', 'weak'); return; }
    const m = S.segmentMetrics(beats, { tStart: r.t0 + SETTLE, tEnd: tStop, pacerStart: r.t0, bpm: 6 });
    const rec = { id: Date.now(), kind: 'rest', date: new Date().toISOString(), source: r.source || 'none', posture: r.posture, minutes: Math.round(dur / 6) / 10,
      meanHr: m.meanHr, rmssd: m.rmssd, lnRmssd: T.lnRmssd(m.rmssd), peakTrough: m.peakTrough, okRatio: m.okRatio };
    rec.reference = T.isReference(rec);
    db.rests.push(rec); save();
    const tb = $('rResTable'); tb.textContent = '';
    [['姿勢', POSTURE[rec.posture] || '—'], ['時間', rec.minutes + ' 分'], ['平均心拍', f1(rec.meanHr, 0) + ' 拍/分'], ['RMSSD', f1(rec.rmssd, 0) + ' ms'], ['ln RMSSD', f1(rec.lnRmssd, 2)],
     ['採用', Math.round(rec.okRatio * 100) + '%']]
      .forEach(([k, v]) => { const tr = tb.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; });
    $('rRefNote').textContent = rec.reference ? `採用率が ${Math.round(T.REF_OK_RATIO * 100)}% 未満（または値が出ていない）ので「参考値」として残しました。平均と基準の計算には入れません。` : '';
    showMemo($('rMemo'), rec);
    $('restResult').classList.remove('hidden');
    renderHistory();
  }
  function updatePostureWarn() {
    const last = db.rests[db.rests.length - 1], cur = $('rPosture').value;
    const w = $('rPostureWarn');
    const diff = last && last.posture && last.posture !== cur;
    w.classList.toggle('hidden', !diff);
    if (diff) w.textContent = `前回は「${POSTURE[last.posture]}」で測りました。姿勢が違うと値が変わるので、前回と比べるときは同じ姿勢で。`;
  }

  // 体調メモ（任意）。記録ごとに rec.memo へ保存する。何も入っていなければ memo は付けない
  function memoEditor(rec, onChange) {
    const box = document.createElement('div'); box.className = 'memo full';
    const m = rec.memo || {};
    const sel = document.createElement('select');
    [['', '睡眠: 未記入'], ['good', '睡眠: 良い'], ['bad', '睡眠: 悪い']].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); });
    sel.value = m.sleep || '';
    const cb = (key, label) => { const l = document.createElement('label'), c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!m[key]; c.dataset.k = key; l.append(c, ' ' + label); return l; };
    const txt = document.createElement('input'); txt.type = 'text'; txt.maxLength = 200; txt.placeholder = '自由記述（任意）'; txt.value = m.text || '';
    box.append(sel, cb('alcohol', '前夜の酒'), cb('sick', '体調不良'), cb('hard', '激しい運動'), txt);
    const commit = () => {
      const memo = T.normalizeMemo({ sleep: sel.value, alcohol: box.querySelector('[data-k=alcohol]').checked, sick: box.querySelector('[data-k=sick]').checked,
        hard: box.querySelector('[data-k=hard]').checked, text: txt.value });
      if (memo) rec.memo = memo; else delete rec.memo;
      save(); if (onChange) onChange();
    };
    box.addEventListener('change', commit);
    box.addEventListener('click', (e) => e.stopPropagation());
    return box;
  }
  function showMemo(container, rec) { container.textContent = ''; const p = document.createElement('p'); p.className = 'muted'; p.textContent = '体調メモ（任意）'; container.append(p, memoEditor(rec, renderHistory)); }
  // 記録の行に、メモの要約と、タップで開くメモ欄を付ける
  function attachMemo(it, rec) {
    const line = document.createElement('div'); line.className = 'memoLine full';
    const setLine = () => { const s = T.memoSummary(rec.memo); line.textContent = s ? '体調メモ: ' + s : ''; line.classList.toggle('hidden', !s); };
    setLine(); it.appendChild(line);
    let ed = null;
    it.style.cursor = 'pointer';
    it.addEventListener('click', () => {
      if (ed) { ed.remove(); ed = null; return; }
      ed = memoEditor(rec, setLine); it.appendChild(ed);
    });
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
      it.append(a, b); attachMemo(it, s); sl.appendChild(it);
    });
    if (!db.sessions.length) sl.textContent = 'まだありません';
    const rl = $('restList'); rl.textContent = '';
    db.rests.slice().reverse().forEach(x => {
      const it = document.createElement('div'); it.className = 'item';
      const a = document.createElement('span'); a.textContent = `${fmtDate(x.date)}　${POSTURE[x.posture] || ''} ${x.minutes} 分`;
      if (x.reference) { const tg = document.createElement('span'); tg.className = 'tag'; tg.textContent = '参考値'; a.appendChild(tg); }
      const b = document.createElement('span'); b.textContent = `ln RMSSD ${f1(x.lnRmssd, 2)}・心拍 ${f1(x.meanHr, 0)}`;
      it.append(a, b); attachMemo(it, x); rl.appendChild(it);
    });
    if (!db.rests.length) rl.textContent = 'まだありません';
    const due = T.retestDue(db.tests, Date.now());
    $('retestCard').classList.toggle('hidden', due === null);
    $('retestNote').textContent = due === 'none' ? '共鳴テンポのテストはまだです。月に 1 回ほど測り直します。' : due === null ? '' : `共鳴テンポの測り直し: 最後のテストから ${due} 日たっています（目安は月に 1 回）。毎日でなく月 1 回で足ります。`;
    drawAll();
  }
  function drawAll() { drawHistory(); drawRestChart(); drawRatioChart(); }
  // 日ごとの推移（朝の ln RMSSD・7 日平均・基準の帯・下回った日の印）。直近 60 日
  function dayAxis(rows) { const n0 = rows[0].num, n1 = rows[rows.length - 1].num; return { n0, n1, span: Math.max(1, n1 - n0) }; }
  function drawRestChart() {
    const c = $('restChart');
    const all = T.buildTrend(db.rests, db.sessions);
    const rows = all.filter(r => Number.isFinite(r.ln)).slice(-60);
    $('restEmpty').classList.toggle('hidden', rows.length > 0);
    c.classList.toggle('hidden', rows.length === 0);
    const last = rows[rows.length - 1];
    const refN = db.rests.filter(x => T.isReference(x)).length;
    $('restSummary').textContent = rows.length ? [`直近 ${last.day}: ln RMSSD ${f1(last.ln, 2)}`, last.band ? `基準 ${f1(last.band.mean, 2)} ± ${f1(last.band.sd, 2)}${last.flag === 'low' ? '（基準を下回った日）' : ''}` : '基準は直前 7 日分の測定がそろうと出ます',
      refN ? `参考値 ${refN} 件は平均・基準から除外` : ''].filter(Boolean).join('　') : '';
    if (!rows.length || !c.offsetParent) return;
    const { ctx, w, h } = fitCanvas(c); ctx.clearRect(0, 0, w, h);
    const padL = 30, padR = 8, padT = 8, padB = 20, { n0, span } = dayAxis(rows);
    const X = (n) => padL + (rows.length === 1 ? (w - padL - padR) / 2 : (n - n0) / span * (w - padL - padR));
    const vs = []; rows.forEach(r => { vs.push(r.ln); if (Number.isFinite(r.ma7)) vs.push(r.ma7); if (r.band) vs.push(r.band.mean - 1.5 * r.band.sd, r.band.mean + 1.5 * r.band.sd); });
    let mn = Math.min(...vs), mx = Math.max(...vs); const pad = (mx - mn) * 0.1 || 0.1; mn -= pad; mx += pad;
    const Y = (v) => h - padB - (v - mn) / (mx - mn) * (h - padT - padB);
    ctx.strokeStyle = css('--line'); ctx.beginPath(); ctx.moveTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();
    const bandRows = rows.filter(r => r.band);
    if (bandRows.length >= 2) {
      ctx.fillStyle = 'rgba(95,196,184,.18)'; ctx.beginPath();
      bandRows.forEach((r, i) => { const x = X(r.num), y = Y(r.band.mean + 1.5 * r.band.sd); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      for (let i = bandRows.length - 1; i >= 0; i--) ctx.lineTo(X(bandRows[i].num), Y(bandRows[i].band.mean - 1.5 * bandRows[i].band.sd));
      ctx.closePath(); ctx.fill();
    }
    const maRows = rows.filter(r => Number.isFinite(r.ma7));
    if (maRows.length >= 2) { ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2; ctx.beginPath(); maRows.forEach((r, i) => { const x = X(r.num), y = Y(r.ma7); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
    ctx.fillStyle = css('--accent2');
    rows.forEach(r => { ctx.beginPath(); ctx.arc(X(r.num), Y(r.ln), 3, 0, 7); ctx.fill(); });
    ctx.strokeStyle = css('--warn'); ctx.lineWidth = 2;
    rows.filter(r => r.flag === 'low').forEach(r => { ctx.beginPath(); ctx.arc(X(r.num), Y(r.ln), 7, 0, 7); ctx.stroke(); });
    ctx.fillStyle = css('--muted'); ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(mx.toFixed(1), 0, padT + 8); ctx.fillText(mn.toFixed(1), 0, h - padB - 2);
    ctx.fillText(rows[0].day.slice(5), padL, h - 4); ctx.textAlign = 'right'; ctx.fillText(last.day.slice(5), w - padR, h - 4);
  }
  // 練習の振れ幅倍率の推移（朝と練習がそろった日だけ）
  function drawRatioChart() {
    const c = $('ratioChart');
    const rows = T.buildTrend(db.rests, db.sessions).filter(r => Number.isFinite(r.ratio)).slice(-60);
    $('ratioEmpty').classList.toggle('hidden', rows.length > 0);
    c.classList.toggle('hidden', rows.length === 0);
    if (!rows.length || !c.offsetParent) return;
    const { ctx, w, h } = fitCanvas(c); ctx.clearRect(0, 0, w, h);
    const padL = 30, padR = 8, padT = 8, padB = 20, { n0, span } = dayAxis(rows);
    const X = (n) => padL + (rows.length === 1 ? (w - padL - padR) / 2 : (n - n0) / span * (w - padL - padR));
    const mx = Math.max(...rows.map(r => r.ratio)) * 1.1 || 1;
    const Y = (v) => h - padB - v / mx * (h - padT - padB);
    ctx.strokeStyle = css('--line'); ctx.beginPath(); ctx.moveTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();
    ctx.strokeStyle = css('--accent'); ctx.fillStyle = css('--accent'); ctx.lineWidth = 2; ctx.beginPath();
    rows.forEach((r, i) => { const x = X(r.num), y = Y(r.ratio); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    rows.forEach(r => { ctx.beginPath(); ctx.arc(X(r.num), Y(r.ratio), 3, 0, 7); ctx.fill(); });
    ctx.fillStyle = css('--muted'); ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(mx.toFixed(1) + ' 倍', 0, padT + 8); ctx.fillText(rows[0].day.slice(5), padL, h - 4); ctx.textAlign = 'right'; ctx.fillText(rows[rows.length - 1].day.slice(5), w - padR, h - 4);
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
    if (name === 'rest') updatePostureWarn();
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
  $('btnRest').onclick = () => {
    const min = Number($('rMin').value) || 3;
    db.settings.restMin = min; db.settings.restPosture = $('rPosture').value; save();
    const plan = [{ bpm: 6, sec: min * 60 }]; plan.posture = $('rPosture').value;
    startRun('rest', plan);
  };
  $('rPosture').onchange = updatePostureWarn;
  $('btnJson1').onclick = () => { const t = db.tests[db.tests.length - 1]; if (t && t.bpm) $('pBpm').value = t.bpm; saveBreathingJson(); };
  $('btnJson2').onclick = saveBreathingJson;
  $('btnExport').onclick = () => download(`resonance-records-${new Date().toISOString().slice(0, 10)}.json`, db);
  $('fileImport').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      if (!o || !Array.isArray(o.tests) || !Array.isArray(o.sessions)) throw new Error('形式が違います');
      if (o.rests === undefined) o.rests = []; // 朝の測定が入る前の書き出し
      if (!Array.isArray(o.rests)) throw new Error('形式が違います');
      // 1 件でも壊れた記録があれば、何も変えずに断る
      const okRec = (x) => x && typeof x === 'object' && Number.isFinite(x.id) && typeof x.date === 'string' && !isNaN(Date.parse(x.date));
      if (![...o.tests, ...o.sessions, ...o.rests].every(okRec)) throw new Error('壊れた記録が含まれています');
      const ids = new Set([...db.tests, ...db.sessions, ...db.rests].map(x => x.id));
      const fresh = (x) => !ids.has(x.id) && ids.add(x.id); // ファイル内の重複も 1 件にする
      const addT = o.tests.filter(fresh), addS = o.sessions.filter(fresh), addR = o.rests.filter(fresh);
      db.tests.push(...addT); db.sessions.push(...addS); db.rests.push(...addR);
      db.tests.sort((a, b) => a.id - b.id); db.sessions.sort((a, b) => a.id - b.id); db.rests.sort((a, b) => a.id - b.id);
      save(); renderHistory(); toastQuality(`記録を読み込みました（新しく ${addT.length + addS.length + addR.length} 件）`, 'good');
    } catch (err) { toastQuality('読み込めませんでした: ' + err.message, 'bad'); }
    e.target.value = '';
  };
  $('sRatio').value = String(db.settings.ratio);
  $('sRatio').onchange = (e) => { db.settings.ratio = Number(e.target.value); save(); updateNote(); };
  $('sCue').value = db.settings.cue; $('sCue').onchange = (e) => { db.settings.cue = e.target.value; save(); };
  $('sWarn').checked = db.settings.warn; $('sWarn').onchange = (e) => { db.settings.warn = e.target.checked; save(); };
  $('btnVoiceTest').onclick = async () => {
    ensureAudio(); await loadClips();
    if (db.settings.cue === 'voice') { say('in'); setTimeout(() => say('out'), 1800); }
    else if (db.settings.cue === 'chime') { chime(true); setTimeout(() => chime(false), 1200); }
    if (db.settings.warn) setTimeout(warnTone, 3600);
  };
  $('sVerify').checked = db.settings.verify; $('sVerify').onchange = (e) => { db.settings.verify = e.target.checked; save(); $('verifyBox').classList.toggle('hidden', !e.target.checked); };
  $('verifyBox').classList.toggle('hidden', !db.settings.verify);
  $('btnVerifyExport').onclick = () => {
    if (!verifyLog || (!verifyLog.cam.beats.length && !verifyLog.ble.notifications.length)) { toastQuality('書き出す検証データがまだありません', 'weak'); showTab('test'); return; }
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    download(`metatron-verify-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.json`,
      Object.assign({}, verifyLog, { exportedAt: d.toISOString(), exportedPerf: now() }));
  };
  $('sVib').checked = db.settings.vib; $('sVib').onchange = (e) => { db.settings.vib = e.target.checked; save(); };
  $('segSec').value = String(db.settings.segSec);
  { const lr = db.rests[db.rests.length - 1]; $('rPosture').value = db.settings.restPosture || (lr && lr.posture) || 'sit'; if (db.settings.restMin) $('rMin').value = String(db.settings.restMin); updatePostureWarn(); }
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
  window.addEventListener('resize', drawAll);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
