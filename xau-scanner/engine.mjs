const makeEngine = function () {
  const TFS = [1, 5, 15, 30, 60, 120, 240, 480, 1440];
  const LABEL = { 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1H', 120: '2H', 240: '4H', 480: '8H', 1440: '1D' };
  const W = { 1: 0.6, 5: 1, 15: 1.5, 30: 2, 60: 3, 120: 3.5, 240: 4, 480: 4.5, 1440: 5 };
  const P = { minRisk: 2.0, cost: 0.30, maxBars: 48, thresh: 55, biasMin: 30, slMin: 0.8, slMax: 2.5, lt: 1, revMin: 15, ltMul: 16, ltBias: 30, ltThresh: 60, rev: 1, revThresh: 70, revRsi: 35, only: null, router: 1, minConf: 3, sess: 1 };
  const S = { base: [], baseMin: 5, list: [], tfs: {}, bt: {}, cursor: 0, startCursor: 0, hasFuture: false, source: 'Simulated', warm: 0, live: false };

  /* ---------- helpers ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function usDst(ms) {
    const y = new Date(ms).getUTCFullYear();
    const sunday = (mon, n) => { const first = new Date(Date.UTC(y, mon, 1)).getUTCDay(); return 1 + (7 - first) % 7 + (n - 1) * 7; };
    return ms >= Date.UTC(y, 2, sunday(2, 2), 7) && ms < Date.UTC(y, 10, sunday(10, 1), 6);
  }
  // Gold closes Friday 5pm New York and reopens Sunday 5pm New York: 21:00 UTC in US summer time, 22:00 UTC in winter.
  function isTrading(t) {
    const d = new Date(t * 1000), w = d.getUTCDay(), h = d.getUTCHours() + d.getUTCMinutes() / 60, cut = usDst(t * 1000) ? 21 : 22;
    if (w === 6) return false;
    if (w === 5 && h >= cut) return false;
    if (w === 0 && h < cut) return false;
    return true;
  }

  /* ---------- simulated gold feed ---------- */
  function genSim(nowSec, histBars, futBars, seed) {
    histBars = histBars || 41000; futBars = futBars || 1500; seed = seed || 20261030;
    const r = mulberry32(seed);
    const gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    let now = Math.floor(nowSec / 300) * 300;
    while (!isTrading(now)) now -= 300;
    const times = []; let t = now;
    for (let i = 0; i < histBars; i++) { times.push(t); do { t -= 300; } while (!isTrading(t)); }
    times.reverse();
    t = now;
    for (let i = 0; i < futBars; i++) { do { t += 300; } while (!isTrading(t)); times.push(t); }
    const out = []; let p = 3700, mu = 0, left = 0, vm = 1;
    for (let i = 0; i < times.length; i++) {
      if (left <= 0) {
        left = 150 + Math.floor(r() * 450);
        const c = r();
        mu = c < .28 ? 0.00005 : c < .56 ? -0.00005 : c < .7 ? 0.00002 : c < .84 ? -0.00002 : 0;
        vm = 0.8 + r() * 0.8;
      }
      left--;
      const tt = times[i], h = new Date(tt * 1000).getUTCHours();
      const sess = h < 7 ? 0.75 : h < 12 ? 1.15 : h < 17 ? 1.4 : h < 21 ? 1.0 : 0.7;
      const gap = i > 0 && tt - times[i - 1] > 3600 ? gauss() * 0.0010 : 0;
      let sig = 0.00042 * vm * sess; if (r() < 0.01) sig *= 3;
      const o = p * (1 + gap), c = o * (1 + mu + sig * gauss());
      const wu = Math.abs(gauss()) * sig * 0.55 * o, wd = Math.abs(gauss()) * sig * 0.55 * o;
      out.push({ t: tt, o: o, h: Math.max(o, c) + wu, l: Math.min(o, c) - wd, c: c });
      p = c;
    }
    const cursor = histBars - 1, delta = 3883.6 - out[cursor].c;
    for (const b of out) { b.o = +(b.o + delta).toFixed(2); b.h = +(b.h + delta).toFixed(2); b.l = +(b.l + delta).toFixed(2); b.c = +(b.c + delta).toFixed(2); }
    return { bars: out, cursor: cursor };
  }

  /* ---------- CSV / API rows ---------- */
  function parseTime(v) {
    v = String(v).trim().replace(/^"|"$/g, '');
    if (/^\d+(\.\d+)?$/.test(v)) { const n = +v; return n > 1e11 ? n / 1000 : n; }
    let s = v.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3').replace(' ', 'T');
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    const ms = Date.parse(s);
    return isNaN(ms) ? NaN : ms / 1000;
  }
  function parseCSV(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(x => x.trim());
    if (lines.length < 200) throw new Error('Need at least 200 rows of candles.');
    const sep = lines[0].indexOf('\t') >= 0 ? '\t' : lines[0].indexOf(';') >= 0 ? ';' : ',';
    const clean = s => s.trim().toLowerCase().replace(/[<>"]/g, '');
    const first = lines[0].split(sep).map(clean);
    const hasHead = first.some(h => /[a-z]/.test(h));
    let ix = { d: 0, tm: -1, o: 1, h: 2, l: 3, c: 4 }, start = 0;
    if (hasHead) {
      start = 1;
      const f = n => first.findIndex(h => h === n || h.startsWith(n));
      const di = first.findIndex(h => h === 'datetime' || h === 'timestamp' || h === 'date' || h === 'time' || h === 'gmt time' || h === 'local time');
      ix = { d: di < 0 ? 0 : di, tm: first.indexOf('time') >= 0 && first.indexOf('date') >= 0 ? first.indexOf('time') : -1, o: f('open'), h: f('high'), l: f('low'), c: f('close') };
      if (ix.o < 0 || ix.h < 0 || ix.l < 0 || ix.c < 0) throw new Error('Could not find open, high, low and close columns.');
      if (first.indexOf('date') >= 0 && first.indexOf('time') >= 0) ix.d = first.indexOf('date');
    }
    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const p = lines[i].split(sep);
      const ts = ix.tm >= 0 ? p[ix.d].trim() + ' ' + p[ix.tm].trim() : p[ix.d];
      const t = parseTime(ts), o = +p[ix.o], h = +p[ix.h], l = +p[ix.l], c = +p[ix.c];
      if (isNaN(t) || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
      rows.push({ t: t, o: o, h: h, l: l, c: c });
    }
    return normalise(rows);
  }
  function normalise(rows, keep1) {
    rows.sort((a, b) => a.t - b.t);
    const d = []; for (const r of rows) { if (d.length && d[d.length - 1].t === r.t) d[d.length - 1] = r; else d.push(r); }
    if (d.length < 200) throw new Error('Too few valid candles (' + d.length + ').');
    const dts = []; for (let i = 1; i < Math.min(d.length, 400); i++) dts.push(d[i].t - d[i - 1].t);
    dts.sort((a, b) => a - b);
    const baseMin = Math.round(dts[Math.floor(dts.length / 2)] / 60);
    if ([1, 5, 15, 30, 60].indexOf(baseMin) < 0) throw new Error('Candle interval of ' + baseMin + ' min is not supported. Use 1, 5, 15, 30 or 60 minutes.');
    if (baseMin === 1 && !keep1) return { bars: resample(d, 5, 1).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c })), baseMin: 5 };
    return { bars: d, baseMin: baseMin };
  }

  /* ---------- resample + indicators ---------- */
  function resample(base, m, baseMin) {
    if (m === baseMin) return base.map((b, i) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, start: i, end: i }));
    const sec = m * 60, off = m >= 240 ? 79200 : 0, out = []; let cur = null, key = null;
    for (let i = 0; i < base.length; i++) {
      const b = base[i], k = Math.floor((b.t - off) / sec);
      if (k !== key) { if (cur) out.push(cur); key = k; cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, start: i, end: i }; }
      else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; cur.end = i; }
    }
    // The last group may still be forming. Count it as done only when its period has fully elapsed, the way the backtest sees it.
    if (cur) { const lastT = base[base.length - 1].t + baseMin * 60, per = cur.t - (((cur.t - off) % sec) + sec) % sec + sec; if (per > lastT) cur.end = base.length + 1e9; out.push(cur); }
    return out;
  }
  function ema(v, p) { const k = 2 / (p + 1), o = new Array(v.length); let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; o[i] = e; } return o; }
  function rsi(c, p) {
    const o = new Array(c.length).fill(50); let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
      if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
      else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return o;
  }
  function atr(b, p) {
    const o = new Array(b.length); let a = b[0].h - b[0].l;
    for (let i = 0; i < b.length; i++) {
      const tr = i ? Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)) : b[i].h - b[i].l;
      a = i < p ? (a * i + tr) / (i + 1) : (a * (p - 1) + tr) / p; o[i] = a;
    }
    return o;
  }
  function mapExt(rows, m) {
    const base = S.base, n = base.length, sec = m * 60, lastT = base[n - 1].t + S.baseMin * 60;
    const lastBefore = t => { let lo = -1, hi = n - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (base[mid].t < t) lo = mid; else hi = mid - 1; } return lo; };
    const firstFrom = t => { let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (base[mid].t >= t) hi = mid; else lo = mid + 1; } return lo; };
    return rows.map(r => { const endT = r.t + sec; return { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, start: firstFrom(r.t), end: endT <= lastT ? lastBefore(endT) : n + 1e9 }; });
  }
  function sma(v, p) { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
  function adxCalc(b, p) {
    const n = b.length, o = new Array(n).fill(NaN); if (n < 2 * p + 2) return o; let tr = 0, pd = 0, md = 0; const dx = [];
    for (let i = 1; i < n; i++) {
      const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l, t = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
      const P1 = up > dn && up > 0 ? up : 0, M1 = dn > up && dn > 0 ? dn : 0;
      if (i <= p) { tr += t; pd += P1; md += M1; } else { tr = tr - tr / p + t; pd = pd - pd / p + P1; md = md - md / p + M1; }
      if (i >= p) { const pi = tr ? 100 * pd / tr : 0, mi = tr ? 100 * md / tr : 0; dx[i] = pi + mi ? 100 * Math.abs(pi - mi) / (pi + mi) : 0; }
    }
    let a = 0; for (let i = p; i < 2 * p; i++) a += dx[i]; a /= p; o[2 * p - 1] = a;
    for (let i = 2 * p; i < n; i++) { a = (a * (p - 1) + dx[i]) / p; o[i] = a; }
    return o;
  }
  function extras(bars) {
    const n = bars.length, c = bars.map(b => b.c), s20 = sma(c, 20), bbu = new Array(n).fill(NaN), bbd = new Array(n).fill(NaN);
    for (let i = 19; i < n; i++) { let v = 0; for (let k = i - 19; k <= i; k++) v += (c[k] - s20[i]) * (c[k] - s20[i]); const sd = Math.sqrt(v / 20); bbu[i] = s20[i] + 2 * sd; bbd[i] = s20[i] - 2 * sd; }
    const vw = new Array(n).fill(NaN), vsd = new Array(n).fill(NaN), vn = new Array(n).fill(0), pdh = new Array(n).fill(NaN), pdl = new Array(n).fill(NaN), ash = new Array(n).fill(NaN), asl = new Array(n).fill(NaN);
    let day = -1, sum = 0, sq = 0, cnt = 0, dh = -Infinity, dl = Infinity, ph = NaN, pl = NaN, ah = -Infinity, al = Infinity;
    for (let i = 0; i < n; i++) {
      const b = bars[i], d = Math.floor(b.t / 86400), hr = (b.t % 86400) / 3600;
      if (d !== day) { if (day >= 0 && cnt) { ph = dh; pl = dl; } day = d; sum = 0; sq = 0; cnt = 0; dh = -Infinity; dl = Infinity; ah = -Infinity; al = Infinity; }
      const tp = (b.h + b.l + b.c) / 3; sum += tp; sq += tp * tp; cnt++; if (b.h > dh) dh = b.h; if (b.l < dl) dl = b.l;
      if (hr < 7) { if (b.h > ah) ah = b.h; if (b.l < al) al = b.l; }
      vw[i] = sum / cnt; vsd[i] = cnt > 1 ? Math.sqrt(Math.max(0, sq / cnt - vw[i] * vw[i])) : NaN; vn[i] = cnt; pdh[i] = ph; pdl[i] = pl;
      if (hr >= 7 && ah > -Infinity) { ash[i] = ah; asl[i] = al; }
    }
    return { sma5: sma(c, 5), sma200: sma(c, 200), rsi2: rsi(c, 2), bbm: s20, bbu: bbu, bbd: bbd, adx: adxCalc(bars, 14), vw: vw, vsd: vsd, vn: vn, pdh: pdh, pdl: pdl, ash: ash, asl: asl };
  }
  function buildTF(m, ext) {
    const bars = ext || resample(S.base, m, S.baseMin), c = bars.map(b => b.c);
    const e12 = ema(c, 12), e26 = ema(c, 26), macd = e12.map((x, i) => x - e26[i]), sg = ema(macd, 9);
    const hh = new Array(bars.length), ll = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      let H = -Infinity, L = Infinity;
      for (let k = Math.max(0, i - 20); k < i; k++) { if (bars[k].h > H) H = bars[k].h; if (bars[k].l < L) L = bars[k].l; }
      hh[i] = H; ll[i] = L;
    }
    return Object.assign({ m: m, bars: bars, e20: ema(c, 20), e50: ema(c, 50), rsi: rsi(c, 14), atr: atr(bars, 14), mh: macd.map((x, i) => x - sg[i]), hh: hh, ll: ll }, extras(bars));
  }

  function init(bars, baseMin, cursor, source, hasFuture, live, daily) {
    S.live = !!live; S.base = bars; S.baseMin = baseMin; S.source = source; S.hasFuture = !!hasFuture;
    S.list = TFS.filter(m => m >= baseMin && m % baseMin === 0);
    S.tfs = {}; S.bt = {};
    for (const m of S.list) S.tfs[m] = buildTF(m, m === 1440 && daily && daily.length >= 35 ? mapExt(daily, 1440) : null);
    S.cursor = cursor; S.startCursor = cursor;
    const t4 = S.tfs[240];
    S.warm = t4 && t4.bars.length > 31 ? t4.bars[30].end : 60 * baseMin;
  }

  /* ---------- trend + bias ---------- */
  function lastDone(tf, cur) {
    let lo = -1, hi = tf.bars.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tf.bars[mid].end <= cur) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function trendScore(tf, j) {
    const b = tf.bars[j];
    return (b.c > tf.e20[j] ? 1 : -1) + (tf.e20[j] > tf.e50[j] ? 1 : -1) + (tf.mh[j] > 0 ? 1 : -1) + (tf.rsi[j] > 50 ? 1 : -1);
  }
  function trendLabel(s) { return s >= 3 ? 'Bullish' : s <= -3 ? 'Bearish' : s > 0 ? 'Mild bull' : s < 0 ? 'Mild bear' : 'Neutral'; }
  function biasAt(cur, minM, maxM) {
    let num = 0, den = 0; const per = [];
    for (const m of S.list) {
      const tf = S.tfs[m], j = lastDone(tf, cur), ok = j >= 30, s = ok ? trendScore(tf, j) : 0;
      per.push({ m: m, s: s, ok: ok });
      if (ok && m >= minM && (!maxM || m <= maxM)) { num += W[m] * s / 4; den += W[m]; }
    }
    return { bias: den ? num / den * 100 : 0, per: per };
  }

  /* ---------- signal ---------- */
  const GROUPS = { range: ['rsi2', 'bb', 'vwap', 'range', 'sweep', 'div', 'rev'], neutral: ['sweep', 'div', 'news', 'orb', 'fib', 'ema', 'lt', 'rev'], trend: ['ob', 'ema', 'brk', 'fib', 'orb', 'lt', 'sweep'] };
  // Only the strategies that made money in the signal history (3 Nov to 24 Nov, 79 signals): liquidity sweep +6.3R, Bollinger fade +5.6R, Fibonacci +5.2R.
  // Dropped: EMA pullback (-4.7R, 42% wins), short-term trend (-3.5R, 25% wins), RSI(2) pullback (-0.6R), breakout and opening range (scratches only).
  // To bring one back, add its id here, or set this to null to allow all 14.
  P.enabled = ['s1', 's2', 's3', 's4', 's5', 's6'];
  // Optional per-strategy minimum timeframe in minutes (strategy missing from the map is off). null = no gate.
  // Left off: after fixing a timestamp error in my tests, no strategy shows a proven edge on 15m or 1H.
  P.mt = null;
  function runStrat(id, tf, i, cur) {
    const sig = STRAT_FN[id](tf, i, cur); if (!sig) return null;
    sig.strat = id; sig.maxBars = sig.maxBars || SID[id].maxBars;
    if (id !== 'ema' && id !== 'lt' && id !== 'rev') {
      const c = confluence(tf, i, cur, sig); sig.conf = c.pts; sig.score = Math.min(99, 45 + c.pts * 10);
      if (fvgNear(tf, i, sig.side)) { sig.score = Math.min(99, sig.score + 5); sig.reasons.push('Fair value gap nearby'); }
      sig.reasons = sig.reasons.concat(c.why);
    } else sig.conf = null;
    if (P.minConf && sig.conf !== null && sig.conf < P.minConf) return null;
    if (tf.m < 15) sig.reasons.push('Under 15m: no proven edge after costs, size small');
    return sig;
  }
  function evalSignal(tf, i, cur) {
    if (P.spec) return evalSpec(tf, i, cur);
    if (i < 60) return null;
    if (P.sess) { const h = hourOf(tf.bars[i].t); if (h < 7.5 || h >= 17) return null; }
    const ids = P.only ? P.only : (P.router ? GROUPS[regimeOf(tf, i)] : STRATS.map(s => s.id));
    for (const id of ids) {
      if (!P.only && P.enabled && P.enabled.indexOf(id) < 0) continue;
      if (!P.only && P.mt && tf.m < (P.mt[id] === undefined ? Infinity : P.mt[id])) continue;
      const s = runStrat(id, tf, i, cur); if (s) return s;
    }
    return null;
  }
  /* A bounce against the bigger trend: a sweep of the 20-bar extreme that closes back with a long wick and an RSI stretched the other way. */
  function reversalSig(tf, i, fullSide) {
    if (tf.m < P.revMin) return null;
    const b = tf.bars[i], a = tf.atr[i], rng = b.h - b.l;
    if (a * P.slMax < P.minRisk || rng < 0.8 * a || rng <= 0) return null;
    for (const side of [1, -1]) {
      if (side === fullSide) continue; // with the trend is the trend signal's job
      const sweep = side === 1 ? b.l <= tf.ll[i] : b.h >= tf.hh[i];
      const close = side === 1 ? (b.c - b.l) / rng : (b.h - b.c) / rng;
      let r = side === 1 ? Infinity : -Infinity; for (let k = i - 2; k <= i; k++) r = side === 1 ? Math.min(r, tf.rsi[k]) : Math.max(r, tf.rsi[k]);
      const rsiOk = side === 1 ? r <= P.revRsi : r >= 100 - P.revRsi;
      if (!sweep || close < 0.6 || !rsiOk || (side === 1 ? b.c <= b.o : b.c >= b.o)) continue;
      const reasons = ['Swept the 20-bar ' + (side === 1 ? 'low' : 'high') + ' and closed back with a long wick', 'RSI ' + r.toFixed(0) + ' stretched', 'Against the bigger trend, so smaller size'];
      let score = 50 + Math.round(Math.min(15, Math.abs(50 - r) / 2)) + Math.round((close - 0.6) * 25);
      const dmh = tf.mh[i] - tf.mh[i - 1]; if (dmh * side > 0) { score += 10; reasons.push('MACD histogram turning'); }
      score = Math.min(99, score); if (score < P.revThresh) continue;
      const entry = b.c, swing = side === 1 ? b.l : b.h;
      let risk = Math.abs(entry - (side === 1 ? swing - 0.25 * a : swing + 0.25 * a));
      if (risk < P.slMin * a) risk = P.slMin * a; if (risk > P.slMax * a) risk = P.slMax * a; if (risk < P.minRisk) risk = P.minRisk;
      return { side: side, score: score, entry: entry, sl: entry - side * risk, tp: [1, 2, 3].map(n => entry + side * n * risk), risk: risk, atr: a, bias: 0, reasons: reasons, trigger: 'Reversal (counter-trend)', counter: true };
    }
    return null;
  }
  function trendSig(tf, i, side, bias, lt) {
    const b = tf.bars[i], a = tf.atr[i], reasons = [];
    if (a * P.slMax < P.minRisk) return null; // dead market: the average range is too small to trade
    let pull = false, brk = false;
    if (side === 1) {
      if (b.l <= tf.e20[i] + 0.1 * a && b.c > tf.e20[i] && b.c > b.o) { pull = true; reasons.push('Pullback to the 20 EMA held and closed bullish'); }
      if (b.c > tf.hh[i] && (b.h - b.l) > a) { brk = true; reasons.push('Close above the 20-bar high on a wide range bar'); }
    } else {
      if (b.h >= tf.e20[i] - 0.1 * a && b.c < tf.e20[i] && b.c < b.o) { pull = true; reasons.push('Pullback to the 20 EMA rejected and closed bearish'); }
      if (b.c < tf.ll[i] && (b.h - b.l) > a) { brk = true; reasons.push('Close below the 20-bar low on a wide range bar'); }
    }
    if (!pull && !brk) return null;
    let score = 40 * Math.min(1, Math.abs(bias) / 100);
    const mh = tf.mh[i], dmh = mh - tf.mh[i - 1];
    if (mh * side > 0 && dmh * side > 0) { score += 20; reasons.push('MACD histogram agrees and is expanding'); }
    else if (mh * side > 0) { score += 10; reasons.push('MACD histogram agrees'); }
    const r = tf.rsi[i];
    if (side === 1 ? (r >= 45 && r <= 68) : (r >= 32 && r <= 55)) { score += 15; reasons.push('RSI ' + r.toFixed(0) + ' has room to run'); }
    else if (side === 1 ? r < 80 : r > 20) score += 5;
    score += pull && brk ? 25 : pull ? 20 : 22;
    score = Math.round(score);
    if (score < (lt ? P.ltThresh : P.thresh)) return null;
    const entry = b.c;
    let swing = side === 1 ? Infinity : -Infinity;
    for (let k = Math.max(0, i - 5); k <= i; k++) swing = side === 1 ? Math.min(swing, tf.bars[k].l) : Math.max(swing, tf.bars[k].h);
    let sl = side === 1 ? swing - 0.25 * a : swing + 0.25 * a;
    let risk = Math.abs(entry - sl);
    if (risk < P.slMin * a) risk = P.slMin * a;
    if (risk > P.slMax * a) risk = P.slMax * a;
    if (risk < P.minRisk) risk = P.minRisk;
    sl = entry - side * risk;
    const tp = [1, 2, 3].map(n => entry + side * n * risk);
    return { side: side, score: score, entry: entry, sl: sl, tp: tp, risk: risk, atr: a, bias: bias, reasons: reasons, trigger: (lt ? 'Short-term ' : '') + (pull && brk ? 'pullback + breakout' : pull ? 'EMA pullback' : 'breakout'), lt: lt };
  }


  /* ================= STRATEGY LIBRARY =================
     Each strategy reads closed candles only and returns a signal with entry, stop and three target prices.
     A router picks the strategies that suit the market regime (ADX), and a confluence score filters the setups. */
  const STRATS = [
    { id: 'rsi2', n: 'RSI(2) pullback', g: 'A', maxBars: 12 },
    { id: 'bb', n: 'Bollinger range fade', g: 'A', maxBars: 16 },
    { id: 'vwap', n: 'VWAP deviation reversion', g: 'A', maxBars: 24 },
    { id: 'range', n: 'Range support/resistance fade', g: 'A', maxBars: 30 },
    { id: 'sweep', n: 'Liquidity sweep reversal', g: 'B', maxBars: 36 },
    { id: 'ob', n: 'Order block with break of structure', g: 'B', maxBars: 48 },
    { id: 'ema', n: 'EMA pullback with trend filter', g: 'C', maxBars: 48 },
    { id: 'brk', n: 'Breakout and retest', g: 'C', maxBars: 36 },
    { id: 'fib', n: 'Fibonacci 61.8% retracement', g: 'C', maxBars: 48 },
    { id: 'div', n: 'RSI divergence at a key level', g: 'D', maxBars: 36 },
    { id: 'news', n: 'Spike fade (post-news style)', g: 'D', maxBars: 24 },
    { id: 'orb', n: 'Opening range breakout and retest', g: 'D', maxBars: 36 },
    { id: 'lt', n: 'Short-term trend (lower timeframes)', g: 'C', maxBars: 48 },
    { id: 'rev', n: 'Counter-trend reversal', g: 'D', maxBars: 48 },
    { id: 's1', n: 'Range-break retest', g: 'S', maxBars: 36 },
    { id: 's2', n: 'Compression breakdown', g: 'S', maxBars: 36 },
    { id: 's3', n: 'MA rejection', g: 'S', maxBars: 36 },
    { id: 's4', n: 'Failed-breakdown reclaim', g: 'S', maxBars: 36 },
    { id: 's5', n: 'Range-edge fade', g: 'S', maxBars: 36 },
    { id: 's6', n: 'SMC order-block retest', g: 'S', maxBars: 36 }
  ];
  const SID = {}; STRATS.forEach(s => { SID[s.id] = s; });
  const hourOf = t => { const d = new Date(t * 1000); return d.getUTCHours() + d.getUTCMinutes() / 60; };
  const pivH = (b, k, l, r) => { if (k - l < 0 || k + r >= b.length) return false; for (let j = k - l; j <= k + r; j++) if (j !== k && b[j].h > b[k].h) return false; return true; };
  const pivL = (b, k, l, r) => { if (k - l < 0 || k + r >= b.length) return false; for (let j = k - l; j <= k + r; j++) if (j !== k && b[j].l < b[k].l) return false; return true; };
  function regimeOf(tf, i) { const a = tf.adx[i]; return isNaN(a) ? 'neutral' : a < 20 ? 'range' : a < 25 ? 'neutral' : 'trend'; }
  function htfDir(cur) {
    const t = S.tfs[240]; if (!t) return 0; const j = lastDone(t, cur); if (j < 50) return 0; const b = t.bars[j];
    return b.c > t.e50[j] && t.e20[j] > t.e50[j] ? 1 : b.c < t.e50[j] && t.e20[j] < t.e50[j] ? -1 : 0;
  }
  function hourDir(cur) {
    const t = S.tfs[60]; if (!t) return 0; const j = lastDone(t, cur); if (j < 50) return 0; const b = t.bars[j];
    return b.c > t.e50[j] ? 1 : b.c < t.e50[j] ? -1 : 0;
  }
  function fvgNear(tf, i, side) {
    const b = tf.bars, a = tf.atr[i];
    for (let k = i - 1; k >= Math.max(2, i - 14); k--) {
      if (side === 1 && b[k - 2].h < b[k].l && b[k - 1].c > b[k - 1].o) { const lo = b[k - 2].h, hi = b[k].l; if (b[i].l <= hi + 0.2 * a && b[i].l >= lo - 0.3 * a) return true; }
      if (side === -1 && b[k - 2].l > b[k].h && b[k - 1].c < b[k - 1].o) { const hi = b[k - 2].l, lo = b[k].h; if (b[i].h >= lo - 0.2 * a && b[i].h <= hi + 0.3 * a) return true; }
    }
    return false;
  }
  /* five confluence points: higher-timeframe bias, 1H structure, a key level close by, momentum, a clean candle */
  function confluence(tf, i, cur, sig) {
    const side = sig.side, b = tf.bars[i], a = tf.atr[i], rng = b.h - b.l || 1; let pts = 0; const why = [];
    if (htfDir(cur) === side) { pts++; why.push('4H bias agrees'); }
    if (hourDir(cur) === side) { pts++; why.push('1H structure agrees'); }
    const lv = [tf.pdh[i], tf.pdl[i], tf.ash[i], tf.asl[i]].filter(x => !isNaN(x));
    if (lv.some(x => Math.abs(sig.entry - x) <= 0.6 * a) || fvgNear(tf, i, side)) { pts++; why.push('At a key level or imbalance'); }
    if (tf.mh[i] * side > 0 || (tf.mh[i] - tf.mh[i - 1]) * side > 0) { pts++; why.push('Momentum agrees'); }
    const body = Math.abs(b.c - b.o) / rng, wick = side === 1 ? (Math.min(b.o, b.c) - b.l) / rng : (b.h - Math.max(b.o, b.c)) / rng;
    if ((b.c - b.o) * side > 0 && (body >= 0.5 || wick >= 0.4)) { pts++; why.push('Clean signal candle'); }
    return { pts: pts, why: why };
  }
  function mk(id, tf, i, side, entry, sl, d, reasons, trigger, extra) {
    const a = tf.atr[i]; let risk = Math.abs(entry - sl);
    if (!(risk > 0) || !d || d.length < 3) return null;
    if (risk < Math.max(P.minRisk, 0.5 * a)) risk = Math.max(P.minRisk, 0.5 * a);
    if (risk > 4 * a) return null;
    sl = entry - side * risk;
    const dd = d.map(x => Math.max(x, 0.15 * a));
    for (let k = 1; k < 3; k++) if (dd[k] <= dd[k - 1]) dd[k] = dd[k - 1] + 0.2 * a;
    return Object.assign({ side: side, score: 0, entry: entry, sl: sl, tp: dd.map(x => entry + side * x), risk: risk, atr: a, bias: 0, reasons: reasons, trigger: trigger, strat: id, maxBars: SID[id].maxBars }, extra || {});
  }
  const STRAT_FN = {
    rsi2(tf, i) {
      const c = tf.bars[i].c, s2 = tf.sma200[i]; if (isNaN(s2) || i < 200) return null;
      const r2 = tf.rsi2[i], side = c > s2 && r2 < 10 ? 1 : c < s2 && r2 > 90 ? -1 : 0; if (!side) return null;
      const a = tf.atr[i], d1 = (tf.sma5[i] - c) * side, d2 = (tf.bbm[i] - c) * side;
      return mk('rsi2', tf, i, side, c, c - side * 2.5 * a, [Math.max(d1, 0.35 * a), Math.max(d2, 0.7 * a), Math.max(d2, 0.7 * a) * 1.6], ['RSI(2) ' + r2.toFixed(0) + ' stretched ' + (side === 1 ? 'down' : 'up') + ' against the 200 SMA trend'], 'RSI(2) pullback');
    },
    bb(tf, i) {
      if (i < 25 || !(tf.adx[i] < 20)) return null;
      const b = tf.bars, p = b[i - 1], q = b[i]; let side = 0;
      if (p.c < tf.bbd[i - 1] && q.c > tf.bbd[i] && q.c > q.o) side = 1; else if (p.c > tf.bbu[i - 1] && q.c < tf.bbu[i] && q.c < q.o) side = -1;
      if (!side) return null; const a = tf.atr[i], ext = side === 1 ? Math.min(p.l, q.l) : Math.max(p.h, q.h), sl = ext - side * 0.2 * a;
      const d1 = (tf.bbm[i] - q.c) * side, d2 = (side === 1 ? tf.bbu[i] : tf.bbd[i]) - q.c; if (d1 < 0.5 * Math.abs(q.c - sl)) return null;
      return mk('bb', tf, i, side, q.c, sl, [d1, Math.abs(d2), Math.abs(d2) + 0.5 * a], ['Closed outside the Bollinger band, then back inside', 'ADX ' + tf.adx[i].toFixed(0) + ' says the market is ranging'], 'Band fade');
    },
    vwap(tf, i) {
      const sd = tf.vsd[i], n = tf.vn[i]; if (!(sd > 0) || n < 14) return null;
      const b = tf.bars[i], dev = (b.c - tf.vw[i]) / sd, a = tf.atr[i], rng = b.h - b.l; if (rng <= 0) return null;
      const side = dev <= -1.5 && dev >= -4 ? 1 : dev >= 1.5 && dev <= 4 ? -1 : 0; if (!side) return null;
      const lw = side === 1 ? (Math.min(b.o, b.c) - b.l) / rng : (b.h - Math.max(b.o, b.c)) / rng, p = tf.bars[i - 1];
      const eng = side === 1 ? (b.c > b.o && b.c > p.o && b.o <= p.c && p.c < p.o) : (b.c < b.o && b.c < p.o && b.o >= p.c && p.c > p.o);
      if (!(lw >= 0.5 && (b.c - b.o) * side > 0) && !eng) return null;
      const nb = Math.max(1, Math.ceil(60 / tf.m)); let touched = false; for (let k = Math.max(0, i - nb); k < i; k++) if (tf.bars[k].l <= tf.vw[k] && tf.vw[k] <= tf.bars[k].h) { touched = true; break; }
      if (!touched) return null;
      const sl = side === 1 ? b.l - 0.1 * a : b.h + 0.1 * a, dist = (tf.vw[i] - b.c) * side; if (dist < 0.8 * Math.abs(b.c - sl)) return null;
      return mk('vwap', tf, i, side, b.c, sl, [0.6 * dist, dist, 1.4 * dist], ['Stretched ' + Math.abs(dev).toFixed(1) + ' deviations from the day average and rejected'], 'VWAP reversion');
    },
    range(tf, i) {
      const L = 40; if (i < L + 2 || !(tf.adx[i] < 20)) return null; const b = tf.bars, a = tf.atr[i];
      let hi = -Infinity, lo = Infinity; for (let k = i - L; k < i; k++) { if (b[k].h > hi) hi = b[k].h; if (b[k].l < lo) lo = b[k].l; }
      const H = hi - lo; if (H < 2 * a || H > 8 * a) return null;
      let th = 0, tl = 0, lastH = -9, lastL = -9;
      for (let k = i - L; k < i; k++) { if (b[k].h >= hi - 0.2 * a && k - lastH >= 3) { th++; lastH = k; } if (b[k].l <= lo + 0.2 * a && k - lastL >= 3) { tl++; lastL = k; } }
      if (th < 3 || tl < 3) return null; const q = b[i], rng = q.h - q.l; if (rng <= 0) return null; let side = 0;
      if (q.l <= lo + 0.25 * a && q.c > q.o && (Math.min(q.o, q.c) - q.l) / rng >= 0.5) side = 1; else if (q.h >= hi - 0.25 * a && q.c < q.o && (q.h - Math.max(q.o, q.c)) / rng >= 0.5) side = -1;
      if (!side) return null; const mid = (hi + lo) / 2, sl = side === 1 ? lo - 0.3 * a : hi + 0.3 * a;
      const d1 = (mid - q.c) * side, d3 = side === 1 ? hi - q.c : q.c - lo; if (d1 < 0.5 * Math.abs(q.c - sl)) return null;
      return mk('range', tf, i, side, q.c, sl, [d1, d3 - 0.15 * H, d3], ['Rejection at the edge of a ' + th + '-touch range'], 'Range fade');
    },
    sweep(tf, i, cur) {
      if (i < 90) return null; const b = tf.bars, q = b[i], a = tf.atr[i], h = hourOf(q.t); if (tf.m > 60) return null;
      const lows = [tf.asl[i], tf.pdl[i]].filter(x => !isNaN(x)), highs = [tf.ash[i], tf.pdh[i]].filter(x => !isNaN(x));
      for (let k = i - 80; k < i - 6; k++) { if (pivL(b, k, 3, 3)) { for (let k2 = k + 4; k2 < i - 6; k2++) if (pivL(b, k2, 3, 3) && Math.abs(b[k2].l - b[k].l) <= 0.15 * a) lows.push(Math.min(b[k].l, b[k2].l)); } if (pivH(b, k, 3, 3)) { for (let k2 = k + 4; k2 < i - 6; k2++) if (pivH(b, k2, 3, 3) && Math.abs(b[k2].h - b[k].h) <= 0.15 * a) highs.push(Math.max(b[k].h, b[k2].h)); } }
      let side = 0, lvl = 0, ext = 0;
      for (const v of lows) { let sw = false, e = Infinity; for (let k = i - 2; k <= i; k++) if (b[k].l < v - 0.05 * a) { sw = true; e = Math.min(e, b[k].l); } if (sw && q.c > v && q.c > q.o && b[i - 3].c > v) { side = 1; lvl = v; ext = e; break; } }
      if (!side) for (const v of highs) { let sw = false, e = -Infinity; for (let k = i - 2; k <= i; k++) if (b[k].h > v + 0.05 * a) { sw = true; e = Math.max(e, b[k].h); } if (sw && q.c < v && q.c < q.o && b[i - 3].c < v) { side = -1; lvl = v; ext = e; break; } }
      if (!side) return null;
      const sl = ext - side * 0.15 * a, risk = Math.abs(q.c - sl), opp = (side === 1 ? highs : lows).filter(x => (x - q.c) * side > 2 * risk).sort((x, y) => Math.abs(x - q.c) - Math.abs(y - q.c))[0];
      const d3 = opp !== undefined ? Math.abs(opp - q.c) : 3 * risk;
      return mk('sweep', tf, i, side, q.c, sl, [risk, 2 * risk, Math.max(d3, 3 * risk)], ['Swept a ' + (side === 1 ? 'low' : 'high') + ' of the Asian range, previous day or equal ' + (side === 1 ? 'lows' : 'highs') + ' and closed back inside'], 'Liquidity sweep');
    },
    ob(tf, i, cur) {
      if (tf.m > 60 || i < 60) return null; const b = tf.bars, q = b[i], a = tf.atr[i], dir = htfDir(cur); if (!dir) return null;
      for (let k = i - 2; k >= i - 24; k--) {
        const imp = dir === 1 ? (b[k].c > b[k].o && b[k].c - b[k].o >= 1.0 * a) : (b[k].c < b[k].o && b[k].o - b[k].c >= 1.0 * a); if (!imp) continue;
        let pv = -1; for (let p = k - 2; p >= k - 30 && p >= 4; p--) if (dir === 1 ? pivH(b, p, 3, 3) : pivL(b, p, 3, 3)) { pv = p; break; }
        if (pv < 0 || pv + 3 >= k) continue; const brk = dir === 1 ? b[k].c > b[pv].h : b[k].c < b[pv].l; if (!brk) continue;
        let o = -1; for (let p = k - 1; p >= Math.max(0, k - 6); p--) if (dir === 1 ? b[p].c < b[p].o : b[p].c > b[p].o) { o = p; break; } if (o < 0) continue;
        const zh = b[o].h, zl = b[o].l; let early = false; for (let p = k + 1; p < i; p++) if (dir === 1 ? b[p].l <= zh : b[p].h >= zl) { early = true; break; } if (early) continue;
        const touch = dir === 1 ? q.l <= zh && q.c > zl && q.c > q.o : q.h >= zl && q.c < zl + (zh - zl) + 1e9 && q.h >= zl && q.c < q.o && q.c < zh;
        if (!touch) continue; const sl = dir === 1 ? zl - 0.1 * a : zh + 0.1 * a, risk = Math.abs(q.c - sl), swing = Math.abs((dir === 1 ? Math.max(b[k].h, b[pv].h) : Math.min(b[k].l, b[pv].l)) - q.c);
        return mk('ob', tf, i, dir, q.c, sl, [risk, Math.max(2 * risk, swing), Math.max(3 * risk, swing * 1.4)], ['4H trend ' + (dir === 1 ? 'up' : 'down') + ', break of structure, retest of the order block'], 'Order block retest');
      }
      return null;
    },
    ema(tf, i, cur) {
      const bi = biasAt(cur, tf.m).bias, side = bi >= P.biasMin ? 1 : bi <= -P.biasMin ? -1 : 0; if (!side) return null;
      const r = trendSig(tf, i, side, bi, false, true); return r;
    },
    brk(tf, i) {
      if (i < 40) return null; const b = tf.bars, q = b[i], a = tf.atr[i];
      for (let k = i - 1; k >= i - 8; k--) {
        let hi = -Infinity, lo = Infinity; for (let p = k - 12; p < k; p++) { if (b[p].h > hi) hi = b[p].h; if (b[p].l < lo) lo = b[p].l; }
        const H = hi - lo; if (H > 2.8 * a || H <= 0) continue; const up = b[k].c > hi && b[k].h - b[k].l >= 1.1 * a, dn = b[k].c < lo && b[k].h - b[k].l >= 1.1 * a; if (!up && !dn) continue;
        const side = up ? 1 : -1, lvl = up ? hi : lo; let used = false;
        for (let p = k + 1; p < i; p++) if (side === 1 ? (b[p].l <= lvl + 0.15 * a || b[p].c < lvl - 0.1 * a) : (b[p].h >= lvl - 0.15 * a || b[p].c > lvl + 0.1 * a)) { used = true; break; } if (used) continue;
        const ok = side === 1 ? q.l <= lvl + 0.15 * a && q.c > lvl && q.c > q.o : q.h >= lvl - 0.15 * a && q.c < lvl && q.c < q.o; if (!ok) continue;
        const sl = lvl - side * 0.5 * H;
        return mk('brk', tf, i, side, q.c, sl, [0.5, 1, 1.5].map(x => (lvl + side * x * H - q.c) * side), ['Broke out of a ' + (H / a).toFixed(1) + ' ATR consolidation and retested the level'], 'Breakout retest');
      }
      return null;
    },
    fib(tf, i, cur) {
      if (i < 40) return null; const b = tf.bars, q = b[i], a = tf.atr[i];
      for (const side of [1, -1]) {
        if (side === 1 ? !(tf.e20[i] > tf.e50[i]) : !(tf.e20[i] < tf.e50[i])) continue;
        let B = -1; for (let p = i - 6; p >= i - 40; p--) if (side === 1 ? pivH(b, p, 5, 5) : pivL(b, p, 5, 5)) { B = p; break; } if (B < 0) continue;
        let A = -1; for (let p = B - 3; p >= Math.max(5, B - 40); p--) if (side === 1 ? pivL(b, p, 5, 5) : pivH(b, p, 5, 5)) { A = p; break; } if (A < 0) continue;
        const bp = side === 1 ? b[B].h : b[B].l, ap = side === 1 ? b[A].l : b[A].h, leg = Math.abs(bp - ap); if (leg < 2.5 * a) continue;
        const z1 = bp - side * 0.5 * leg, z2 = bp - side * 0.618 * leg, z3 = bp - side * 0.786 * leg, zm = (z1 + z2) / 2;
        const inZone = side === 1 ? q.l <= z1 && q.l >= z3 : q.h >= z1 && q.h <= z3; if (!inZone) continue;
        let broke = false; for (let p = B + 1; p < i; p++) if (side === 1 ? b[p].l < z3 : b[p].h > z3) { broke = true; break; } if (broke) continue;
        if (Math.min(Math.abs(tf.e20[i] - zm), Math.abs(tf.e50[i] - zm)) > 0.6 * a) continue;
        const conf = side === 1 ? q.c > q.o && q.c > b[i - 1].h : q.c < q.o && q.c < b[i - 1].l; if (!conf) continue;
        const sl = z3 - side * 0.1 * a, dB = (bp - q.c) * side; if (dB < 0.8 * Math.abs(q.c - sl)) continue;
        return mk('fib', tf, i, side, q.c, sl, [0.5 * dB, dB, dB + 0.272 * leg], ['Retraced into the 50-61.8% zone of a ' + (leg / a).toFixed(1) + ' ATR leg, lined up with an EMA'], 'Fibonacci retracement');
      }
      return null;
    },
    div(tf, i) {
      if (i < 70) return null; const b = tf.bars, q = b[i], a = tf.atr[i];
      for (const side of [1, -1]) {
        let p2 = -1; for (let p = i - 4; p >= i - 14; p--) if (side === 1 ? pivL(b, p, 3, 3) : pivH(b, p, 3, 3)) { p2 = p; break; } if (p2 < 0) continue;
        let p1 = -1; for (let p = p2 - 5; p >= p2 - 50 && p >= 3; p--) if (side === 1 ? pivL(b, p, 3, 3) : pivH(b, p, 3, 3)) { p1 = p; break; } if (p1 < 0) continue;
        const v1 = side === 1 ? b[p1].l : b[p1].h, v2 = side === 1 ? b[p2].l : b[p2].h;
        if (side === 1 ? !(v2 < v1 - 0.05 * a && tf.rsi[p2] > tf.rsi[p1] + 2 && tf.rsi[p2] < 45) : !(v2 > v1 + 0.05 * a && tf.rsi[p2] < tf.rsi[p1] - 2 && tf.rsi[p2] > 55)) continue;
        const keys = side === 1 ? [tf.pdl[i], tf.asl[i], tf.ll[i]] : [tf.pdh[i], tf.ash[i], tf.hh[i]];
        if (!keys.some(x => !isNaN(x) && Math.abs(v2 - x) <= 0.6 * a)) { let ext = side === 1 ? Infinity : -Infinity; for (let p = Math.max(0, i - 150); p < i; p++) ext = side === 1 ? Math.min(ext, b[p].l) : Math.max(ext, b[p].h); if (Math.abs(v2 - ext) > 0.6 * a) continue; }
        let mn = side === 1 ? -Infinity : Infinity; for (let p = p2 + 1; p < i; p++) mn = side === 1 ? Math.max(mn, b[p].h) : Math.min(mn, b[p].l);
        if (!(side === 1 ? q.c > mn && q.c > q.o : q.c < mn && q.c < q.o)) continue;
        const sl = v2 - side * 0.15 * a, risk = Math.abs(q.c - sl);
        return mk('div', tf, i, side, q.c, sl, [risk, 2 * risk, 3 * risk], ['RSI divergence at a key level, then a break of the minor swing'], 'RSI divergence');
      }
      return null;
    },
    news(tf, i) {
      if (tf.m > 15 || i < 40) return null; const b = tf.bars, q = b[i], a = tf.atr[i], w1 = Math.max(1, Math.ceil(15 / tf.m)), w2 = Math.ceil(45 / tf.m) + 1;
      for (let k = i - w1; k >= i - w2; k--) {
        const rg = b[k].h - b[k].l; if (rg < 2.5 * tf.atr[k - 1]) continue; const side = b[k].c > b[k].o ? -1 : 1;
        let cont = false; for (let p = k + 1; p <= i; p++) if (side === -1 ? b[p].h > b[k].h + 0.1 * a : b[p].l < b[k].l - 0.1 * a) { cont = true; break; } if (cont) continue;
        if (!((q.c - q.o) * side > 0 && (side === -1 ? q.c < b[i - 1].c : q.c > b[i - 1].c))) continue;
        const ex = side === -1 ? b[k].h : b[k].l, st = b[k].o, mv = Math.abs(ex - st), risk = Math.abs(q.c - (ex + (side === -1 ? 0.1 * a : -0.1 * a)));
        const t1 = ex + side * 0.5 * mv, d1x = (t1 - q.c) * side, d2x = (st - q.c) * side; if (d1x < 0.6 * risk) continue;
        return mk('news', tf, i, side, q.c, ex + (side === -1 ? 0.1 * a : -0.1 * a), [d1x, Math.max(d2x, d1x + 0.2 * a), Math.max(d2x, d1x + 0.2 * a) + 0.3 * mv], ['Spike of ' + (rg / tf.atr[k - 1]).toFixed(1) + 'x the average range failed to continue and reversed'], 'Spike fade');
      }
      return null;
    },
    orb(tf, i) {
      if (tf.m > 30 || i < 40) return null; const b = tf.bars, q = b[i], a = tf.atr[i], d0 = Math.floor(q.t / 86400) * 86400;
      const opens = [7 * 3600, (usDst(q.t * 1000) ? 13.5 : 14.5) * 3600];
      for (const o of opens) {
        const t0 = d0 + o, t1 = t0 + 1800; if (q.t < t1 + tf.m * 60 || q.t > t1 + 3 * 3600) continue; let hi = -Infinity, lo = Infinity, n = 0, idx = -1;
        for (let k = i; k >= Math.max(0, i - 60); k--) { if (b[k].t >= t0 && b[k].t < t1) { n++; if (b[k].h > hi) hi = b[k].h; if (b[k].l < lo) lo = b[k].l; idx = k; } else if (b[k].t < t0) break; }
        if (!n || hi - lo <= 0.3 * a || hi - lo > 4 * a) continue; const H = hi - lo; let bs = 0, bk = -1;
        for (let k = idx; k < i; k++) { if (b[k].t < t1) continue; if (b[k].c > hi) { bs = 1; bk = k; break; } if (b[k].c < lo) { bs = -1; bk = k; break; } }
        if (!bs) continue; const lvl = bs === 1 ? hi : lo; let used = false;
        for (let p = bk + 1; p < i; p++) if (bs === 1 ? (b[p].l <= lvl + 0.15 * a || b[p].c < lvl) : (b[p].h >= lvl - 0.15 * a || b[p].c > lvl)) { used = true; break; } if (used) continue;
        const ok = bs === 1 ? q.l <= lvl + 0.15 * a && q.c > lvl && q.c > q.o : q.h >= lvl - 0.15 * a && q.c < lvl && q.c < q.o; if (!ok) continue;
        const sl = (hi + lo) / 2, off = Math.abs(q.c - lvl);
        return mk('orb', tf, i, bs, q.c, sl, [0.75 * H - (bs === 1 ? q.c - lvl : lvl - q.c), 1.5 * H - (bs === 1 ? q.c - lvl : lvl - q.c), 2 * H - (bs === 1 ? q.c - lvl : lvl - q.c)], ['Opening range ' + (o === 7 * 3600 ? 'London' : 'New York') + ' broke and held on the retest'], 'Opening range breakout');
      }
      return null;
    },
    lt(tf, i, cur) {
      const full = biasAt(cur, tf.m).bias; if (Math.abs(full) >= P.biasMin) return null;
      const b2 = biasAt(cur, tf.m, tf.m * P.ltMul).bias; if (Math.abs(b2) < P.ltBias) return null;
      return trendSig(tf, i, b2 > 0 ? 1 : -1, b2, true, true);
    },
    rev(tf, i, cur) {
      const bi = biasAt(cur, tf.m).bias, fs = bi >= P.biasMin ? 1 : bi <= -P.biasMin ? -1 : 0; return reversalSig(tf, i, fs);
    }
  };

  /* ================= Spec engine: five 5-minute setups (Gold_scanner_strategy_spec) =================
     Entries are only ever taken on the 5m chart. The 15m, 1H and 4H charts do not make entries; they grade the 5m entry (A+ / A / B).
     Stand-ins (the spec asks which indicators you use): green MA = 20 SMA, blue MA = 50 EMA, POC = most-traded $1 price band of the last 24h by time at price.
     Point values in the spec (20 stretch, 5-7 stops, ...) are scaled by ATR(14)/5 because the spec day had a 5m ATR of about 5. */
  P.spec = 1; P.entryTf = 5;
  P.sp = { stretch: 20, touchN: 3, t1R: 1.5, dead: 1, ev: 1, nyCut: 1, grade: 0, hours: [0, 21], loseStop: 2 };
  const SESS = h => h < 7 ? 'Tokyo' : h < 13 ? 'London' : 'New York';
  const clampN = (x, a, b) => Math.max(a, Math.min(b, x));
  function specLevels(tf, i) {
    // highs and lows of the session boxes: finished ones, plus the one in progress (excluding the signal bar), plus yesterday's high/low
    const b = tf.bars, out = [], seen = {}; const sk = k => { const d = new Date(b[k].t * 1000); return d.getUTCFullYear() * 1000 + d.getUTCMonth() * 40 + d.getUTCDate() + '-' + SESS(d.getUTCHours()); };
    let key = null, hi = -Infinity, lo = Infinity, firstK = i;
    const flush = () => { if (key) { out.push({ p: hi, k: 'h', n: key.split('-')[1] + ' high' }); out.push({ p: lo, k: 'l', n: key.split('-')[1] + ' low' }); } };
    for (let k = i - 1; k >= Math.max(0, i - 700); k--) {
      const kk = sk(k);
      if (kk !== key) { flush(); key = kk; hi = -Infinity; lo = Infinity; if (Object.keys(seen).length > 7) { key = null; break; } seen[kk] = 1; }
      if (b[k].h > hi) hi = b[k].h; if (b[k].l < lo) lo = b[k].l;
    }
    if (key) flush();
    if (!isNaN(tf.pdh[i])) { out.push({ p: tf.pdh[i], k: 'h', n: 'Yesterday high' }); out.push({ p: tf.pdl[i], k: 'l', n: 'Yesterday low' }); }
    return out;
  }
  function specPoc(tf, i) {
    const b = tf.bars, cnt = {}; let best = null, bc = 0;
    for (let k = Math.max(0, i - 288); k < i; k++) { const p = Math.round((b[k].h + b[k].l + 2 * b[k].c) / 4); cnt[p] = (cnt[p] || 0) + 1; }
    for (const p in cnt) { const v = cnt[p] + 0.5 * ((cnt[+p - 1] || 0) + (cnt[+p + 1] || 0)); if (v > bc) { bc = v; best = +p; } }
    return best;
  }
  function eventNear(tf, i) {
    const t = tf.bars[i].t + 300, d = new Date(t * 1000), w = d.getUTCDay(); if (w < 1 || w > 5) return false;
    const off = usDst(t * 1000) ? 4 : 5, m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return [8 * 60 + 30, 9 * 60 + 30, 10 * 60].some(e => Math.abs(m - (e + off * 60)) <= 5); // 08:30 US data, 09:30 New York open, 10:00 data (New York time)
  }
  function specCtx(tf, i) {
    const b = tf.bars, q = b[i], a = tf.atr[i], sc = clampN(a / 5, 0.6, 2), g = tf.bbm[i], bl = tf.e50[i];
    const gs = g - tf.bbm[i - 12], bs = bl - tf.e50[i - 12];
    const state = q.c < g && q.c < bl && gs < 0 && bs < 0 ? 'down' : q.c > g && q.c > bl && gs > 0 && bs > 0 ? 'up' : 'balance';
    let hi = -Infinity, lo = Infinity; for (let k = i - 36; k < i; k++) { if (b[k].h > hi) hi = b[k].h; if (b[k].l < lo) lo = b[k].l; }
    return { a: a, sc: sc, g: g, bl: bl, gs: gs, bs: bs, state: state, hi: hi, lo: lo, levels: specLevels(tf, i), poc: null };
  }
  const rngOf = x => (x.h - x.l) || 1e-9;
  const wickUp = x => (x.h - Math.max(x.o, x.c)) / rngOf(x), wickDn = x => (Math.min(x.o, x.c) - x.l) / rngOf(x);
  const bearEng = (x, p) => x.c < x.o && p.c > p.o && x.c < p.o && x.o >= p.c;
  const bullEng = (x, p) => x.c > x.o && p.c < p.o && x.c > p.o && x.o <= p.c;
  function specBlockers(tf, i, side, trendSide, cx, entry) {
    const out = [], q = tf.bars[i];
    if (P.sp.ev && eventNear(tf, i)) out.push('event window');
    if (P.sp.stretch && trendSide && (q.c - cx.g) * side < 0 && Math.abs(q.c - cx.g) > P.sp.stretch * cx.sc) out.push('stretch guard');
    if (P.sp.dead) {
      const pos = cx.hi > cx.lo ? (q.c - cx.lo) / (cx.hi - cx.lo) : 0.5, poc = specPoc(tf, i);
      if (cx.hi - cx.lo > 3 * cx.a && pos > 0.35 && pos < 0.65) out.push('dead zone (mid-range)');
      else if (poc !== null && Math.abs(entry - poc) <= 2.5 * cx.sc) out.push('dead zone (volume POC ' + poc + ')');
    }
    return out;
  }
  // next target levels beyond the entry in the trade direction: session levels, swing points, round numbers (10s)
  function specTargets(tf, i, side, entry, cx, minDist) {
    const b = tf.bars, c = [];
    cx.levels.forEach(l => { if ((l.p - entry) * side > minDist) c.push({ p: l.p, n: l.n }); });
    for (let k = i - 3; k >= Math.max(5, i - 200); k--) { if (side === -1 && pivL(b, k, 3, 3) && b[k].l < entry - minDist) c.push({ p: b[k].l, n: 'swing low' }); if (side === 1 && pivH(b, k, 3, 3) && b[k].h > entry + minDist) c.push({ p: b[k].h, n: 'swing high' }); }
    const r0 = side === 1 ? Math.ceil((entry + minDist) / 10) * 10 : Math.floor((entry - minDist) / 10) * 10;
    for (let n = 0; n < 6; n++) { const p = r0 + side * 10 * n; c.push({ p: p, n: 'round ' + p }); }
    c.sort((x, y) => (x.p - y.p) * side); return c;
  }
  function specMk(id, no, name, tf, i, side, entry, sl, cx, extraSide, pattern, reasons, opt) {
    opt = opt || {}; const a = cx.a; let risk = Math.abs(entry - sl);
    if (!(risk > 0)) return null;
    risk = Math.max(risk, P.minRisk, 0.45 * a); if (risk > 2 * Math.max(10 * cx.sc, 2 * a)) return null; // stop wider than ~10 points: stand aside
    const q = tf.bars[i], nyHot = P.sp.nyCut && SESS(new Date(q.t * 1000).getUTCHours()) === 'New York', widen = nyHot ? 1.2 : 1;
    risk *= widen; sl = entry - side * risk;
    const cand = specTargets(tf, i, side, entry, cx, P.sp.t1R * risk);
    if (cand.length < 3) return null;
    const d1 = Math.abs(cand[0].p - entry), d2 = Math.max(opt.t2 !== undefined ? Math.abs(opt.t2 - entry) : 0, Math.abs(cand[1].p - entry)), d3 = Math.max(Math.abs(cand[2].p - entry), d2 + 0.5 * a);
    if (d1 < P.sp.t1R * risk) return null;
    const s = mk(id, tf, i, side, entry, sl, [d1, Math.max(d2, d1 + 0.2 * a), d3], reasons, name); if (!s) return null;
    s.setupNo = no; s.setupName = name; s.state = cx.state === 'down' ? 'Trend down' : cx.state === 'up' ? 'Trend up' : 'Balance';
    s.pattern = pattern; s.zone = { lo: Math.min(q.l, q.c), hi: Math.max(q.h, q.c) };
    s.sizeMul = (no >= 4 ? 0.5 : 1) * (nyHot ? 0.5 : 1);
    s.tpNames = [cand[0].n, cand[1].n, cand[2].n];
    s.invalid = opt.invalid !== undefined ? opt.invalid : (side === -1 ? Math.max(cx.g, entry + 0.5 * risk) : Math.min(cx.g, entry - 0.5 * risk));
    s.blockers = specBlockers(tf, i, side, extraSide, cx, entry);
    s.status = 'triggered';
    return s;
  }
  function specGrade(tf, i, cur, s) {
    let pts = 0; const why = [];
    if (htfDir(cur) === s.side) { pts++; why.push('4H trend agrees'); } else why.push('4H trend against');
    if (hourDir(cur) === s.side) { pts++; why.push('1H trend agrees'); } else why.push('1H trend against');
    const t15 = S.tfs[15]; if (t15) { const j = lastDone(t15, cur); if (j > 50) { const d = t15.bars[j].c > t15.e50[j] && t15.e20[j] > t15.e50[j] ? 1 : t15.bars[j].c < t15.e50[j] && t15.e20[j] < t15.e50[j] ? -1 : 0; if (d === s.side) { pts++; why.push('15m trend agrees'); } else why.push('15m trend against'); } }
    const c = confluence(tf, i, cur, s); // key level + clean candle + momentum
    if (c.why.some(x => /key level/.test(x))) { pts++; why.push('At a key level'); }
    if (c.why.some(x => /Clean/.test(x))) { pts++; why.push('Clean signal candle'); }
    s.conf = pts; s.grade = pts >= 4 ? 'A+' : pts === 3 ? 'A' : 'B'; s.score = Math.min(99, 45 + pts * 10); s.gradeWhy = why;
    if (fvgNear(tf, i, s.side)) s.score = Math.min(99, s.score + 5);
    return s;
  }
  const SPEC_FN = {
    s1(tf, i, cur) { // range-break retest (trend side)
      const cx = specCtx(tf, i); if (cx.state === 'balance') return null; const side = cx.state === 'down' ? -1 : 1, b = tf.bars, q = b[i], p = b[i - 1], a = cx.a;
      if (side === -1 ? !(q.c < q.o && (wickUp(q) >= 0.5 || bearEng(q, p))) : !(q.c > q.o && (wickDn(q) >= 0.5 || bullEng(q, p)))) return null;
      const lv = cx.levels.filter(l => (side === -1 ? l.k === 'l' : l.k === 'h'));
      for (const L of lv) {
        // a 5m close beyond the level within the last 12 bars, then a pullback that tags the level
        let brk = -1; for (let k = i - 1; k >= i - 12; k--) { if (side === -1 ? (b[k].c < L.p - 0.2 * a && b[k - 1].c >= L.p - 0.2 * a) : (b[k].c > L.p + 0.2 * a && b[k - 1].c <= L.p + 0.2 * a)) { brk = k; break; } }
        if (brk < 0 || brk === i - 0) continue;
        let ok = true; for (let k = brk + 1; k < i; k++) if (side === -1 ? b[k].c > L.p + 0.5 * a : b[k].c < L.p - 0.5 * a) ok = false; if (!ok) continue;
        const tag = side === -1 ? q.h >= L.p - 0.4 * a && q.h <= L.p + 1.2 * a && q.c < L.p + 0.2 * a : q.l <= L.p + 0.4 * a && q.l >= L.p - 1.2 * a && q.c > L.p - 0.2 * a; if (!tag) continue;
        const ext = side === -1 ? Math.min.apply(null, b.slice(brk, i).map(x => x.l)) : Math.max.apply(null, b.slice(brk, i).map(x => x.h));
        const sl = side === -1 ? q.h + 1 * cx.sc : q.l - 1 * cx.sc;
        return specMk('s1', 1, 'Range-break retest ' + (side === -1 ? 'short' : 'long'), tf, i, side, q.c, sl, cx, true, side === -1 ? (bearEng(q, p) ? 'bearish engulfing' : 'rejection wick') : (bullEng(q, p) ? 'bullish engulfing' : 'rejection wick'), ['Closed beyond the ' + L.n + ' (' + L.p.toFixed(2) + ') and retested it', 'Rejection candle closed at the retest'], { t2: ext, invalid: cx.g });
      }
      return null;
    },
    s2(tf, i, cur) { // compression breakdown (trend side)
      const cx = specCtx(tf, i); if (cx.state === 'balance') return null; const side = cx.state === 'down' ? -1 : 1, b = tf.bars, q = b[i], a = cx.a;
      let L = side === -1 ? Infinity : -Infinity; for (let k = i - 20; k < i; k++) L = side === -1 ? Math.min(L, b[k].l) : Math.max(L, b[k].h);
      if (side === -1 ? !(q.c < L - 0.1 * a && b[i - 1].c >= L - 0.1 * a) : !(q.c > L + 0.1 * a && b[i - 1].c <= L + 0.1 * a)) return null;
      const touches = []; for (let k = i - 20; k < i; k++) if (side === -1 ? b[k].l <= L + 0.25 * a : b[k].h >= L - 0.25 * a) { if (!touches.length || k - touches[touches.length - 1] >= 2) touches.push(k); }
      if (touches.length < P.sp.touchN) return null;
      const ex = touches.map(k => side === -1 ? b[k].h : b[k].l); let mono = true; for (let n = 1; n < ex.length; n++) if (side === -1 ? ex[n] > ex[n - 1] + 0.3 * a : ex[n] < ex[n - 1] - 0.3 * a) mono = false; if (!mono) return null;
      if (!(Math.abs(q.c - q.o) >= 0.4 * rngOf(q))) return null;
      const sl = L + side * -1 * 0 + (side === -1 ? 1.2 * a : -1.2 * a); // back inside the range, about 6 points
      return specMk('s2', 2, 'Compression breakdown ' + (side === -1 ? 'short' : 'long'), tf, i, side, q.c, sl, cx, true, 'closed ' + (side === -1 ? 'below' : 'above') + ' a level tested ' + touches.length + ' times', ['Level ' + L.toFixed(2) + ' tested ' + touches.length + ' times with ' + (side === -1 ? 'lower highs' : 'higher lows'), '5m close ' + (side === -1 ? 'below' : 'above') + ' it'], { invalid: L + (side === -1 ? 1 : -1) * 0.2 * a });
    },
    s3(tf, i, cur) { // MA rejection (trend side, or balance under a falling blue MA)
      const cx = specCtx(tf, i), b = tf.bars, q = b[i], p = b[i - 1], a = cx.a; let side = 0;
      if (cx.state === 'down' || (cx.state === 'balance' && cx.bs < 0 && q.c < cx.bl)) side = -1; else if (cx.state === 'up' || (cx.state === 'balance' && cx.bs > 0 && q.c > cx.bl)) side = 1; if (!side) return null;
      const ma = side === -1 ? Math.max(cx.g, cx.bl) : Math.min(cx.g, cx.bl), near = side === -1 ? Math.min(cx.g, cx.bl) : Math.max(cx.g, cx.bl), overlap = Math.abs(cx.g - cx.bl) <= 0.8 * a;
      const reach = side === -1 ? q.h >= near - 0.3 * a && q.h <= ma + 1 * a : q.l <= near + 0.3 * a && q.l >= ma - 1 * a; if (!reach) return null;
      if (side === -1 ? !(q.c < q.o && q.c < near && (wickUp(q) >= 0.4 || bearEng(q, p))) : !(q.c > q.o && q.c > near && (wickDn(q) >= 0.4 || bullEng(q, p)))) return null;
      let bounce = false; for (let k = i - 8; k < i; k++) if (side === -1 ? b[k].c < near - 0.8 * a : b[k].c > near + 0.8 * a) bounce = true; if (!bounce) return null; // a real bounce up into the MA first
      const sl = side === -1 ? Math.max(q.h, ma) + 4.5 * cx.sc * 0.5 : Math.min(q.l, ma) - 4.5 * cx.sc * 0.5;
      return specMk('s3', 3, 'MA rejection ' + (side === -1 ? 'short' : 'long'), tf, i, side, q.c, sl, cx, cx.state !== 'balance', 'rejection at the ' + (overlap ? 'green/blue MA overlap' : 'moving average'), ['Bounce into the moving average (' + near.toFixed(2) + ') rejected'], { invalid: ma + side * -0.3 * a });
    },
    s4(tf, i, cur) { // failed breakdown reclaim (long) and its mirror
      const cx = specCtx(tf, i), b = tf.bars, q = b[i], a = cx.a;
      for (const side of [1, -1]) {
        if (side === 1 && cx.state === 'up' && false) continue;
        if (side === 1 ? !(q.c > q.o && q.c > cx.g) : !(q.c < q.o && q.c < cx.g)) continue;
        const lv = cx.levels.filter(l => side === 1 ? l.k === 'l' : l.k === 'h');
        for (const L of lv) {
          let sw = -1; for (let k = i - 12; k < i - 1; k++) { if (side === 1 ? (b[k].l < L.p - 0.3 * a && b[k + 1].c > L.p) : (b[k].h > L.p + 0.3 * a && b[k + 1].c < L.p)) { sw = k; break; } }
          if (sw < 0) continue;
          const pb = Math.min.apply(null, b.slice(i - 3, i + 1).map(x => side === 1 ? x.l : -x.h)) * (side === 1 ? 1 : -1);
          if (side === 1 ? pb < L.p - 0.2 * a : pb > L.p + 0.2 * a) continue; // pullback must hold the reclaimed level
          let held = true; for (let k = sw + 2; k < i; k++) if (side === 1 ? b[k].c < L.p - 0.2 * a : b[k].c > L.p + 0.2 * a) held = false; if (!held) continue;
          if (!(i - sw >= 3)) continue;
          const sl = pb - side * 5 * cx.sc * 0.6;
          return specMk('s4', 4, 'Failed-breakdown reclaim ' + (side === 1 ? 'long' : 'short'), tf, i, side, q.c, sl, cx, false, side === 1 ? 'bullish candle holding the reclaimed level' : 'bearish candle under the reclaimed level', ['Swept ' + L.n + ' (' + L.p.toFixed(2) + ') and closed back ' + (side === 1 ? 'above' : 'below') + ' it', 'Then back ' + (side === 1 ? 'above' : 'below') + ' the green MA; half size (against the bigger trend)'], { invalid: L.p - side * 0.2 * a });
        }
      }
      return null;
    },
    s5(tf, i, cur) { // range-edge fade (balance only)
      const cx = specCtx(tf, i); if (cx.state !== 'balance') return null; const b = tf.bars, q = b[i], p = b[i - 1], a = cx.a, H = cx.hi - cx.lo;
      if (H < 2 * a || H > 6 * a) return null;
      let side = 0; if (q.h >= cx.hi - 0.15 * H && q.c < q.o && (wickUp(q) >= 0.4 || bearEng(q, p))) side = -1; else if (q.l <= cx.lo + 0.15 * H && q.c > q.o && (wickDn(q) >= 0.4 || bullEng(q, p))) side = 1; if (!side) return null;
      const edge = side === -1 ? cx.hi : cx.lo, conf = [cx.g, cx.bl].some(m => Math.abs(m - edge) <= 0.8 * a) || cx.levels.some(l => Math.abs(l.p - edge) <= 0.6 * a); if (!conf) return null;
      const sl = side === -1 ? Math.max(q.h, edge) + 3.5 * cx.sc * 0.6 : Math.min(q.l, edge) - 3.5 * cx.sc * 0.6, mid = (cx.hi + cx.lo) / 2;
      const s = specMk('s5', 5, 'Range-edge fade ' + (side === -1 ? 'short' : 'long'), tf, i, side, q.c, sl, cx, false, 'rejection at the range ' + (side === -1 ? 'top' : 'bottom'), ['Range ' + cx.lo.toFixed(2) + ' to ' + cx.hi.toFixed(2) + ', rejected at the edge with MA or session-level confluence'], { t2: side === -1 ? cx.lo + 0.25 * a : cx.hi - 0.25 * a, invalid: edge - side * 0.5 * a });
      return s;
    }
  };

  /* ---------- Setup 6: Smart Money Concepts (structure break, order block retest) ----------
     Written from the public SMC ideas (pivot structure, BOS / CHoCH on a close, order block = the extreme candle of the leg that broke structure,
     premium / discount of the recent range). It is NOT a copy of the LuxAlgo script, which is licensed CC BY-NC-SA 4.0 (non-commercial only).
     Built once per timeframe from closed candles only, so it never looks ahead. */
  function smcBuild(tf) {
    if (tf._smc) return tf._smc;
    const b = tf.bars, n = b.length, L = 5, obs = [], trendAt = new Array(n).fill(0), lastEv = new Array(n).fill(null);
    let trend = 0, pH = { p: NaN, bar: -1, x: true }, pL = { p: NaN, bar: -1, x: true }, ev = null;
    for (let i = 0; i < n; i++) {
      const j = i - L;
      if (j >= L) { if (pivH(b, j, L, L)) pH = { p: b[j].h, bar: j, x: false }; if (pivL(b, j, L, L)) pL = { p: b[j].l, bar: j, x: false }; }
      if (i > 0) {
        if (!pH.x && b[i].c > pH.p && b[i - 1].c <= pH.p) { // bullish break of structure
          const kind = trend === -1 ? 'choch' : 'bos'; trend = 1; pH.x = true; ev = { i: i, dir: 1, kind: kind, level: pH.p };
          let k = pH.bar; for (let m = pH.bar; m < i; m++) if (b[m].l < b[k].l) k = m;
          obs.push({ born: i, bar: k, hi: b[k].h, lo: b[k].l, dir: 1, kind: kind, mit: Infinity });
        } else if (!pL.x && b[i].c < pL.p && b[i - 1].c >= pL.p) {
          const kind = trend === 1 ? 'choch' : 'bos'; trend = -1; pL.x = true; ev = { i: i, dir: -1, kind: kind, level: pL.p };
          let k = pL.bar; for (let m = pL.bar; m < i; m++) if (b[m].h > b[k].h) k = m;
          obs.push({ born: i, bar: k, hi: b[k].h, lo: b[k].l, dir: -1, kind: kind, mit: Infinity });
        }
      }
      trendAt[i] = trend; lastEv[i] = ev;
    }
    for (const o of obs) for (let k = o.born + 1; k < n; k++) if (o.dir === 1 ? b[k].c < o.lo : b[k].c > o.hi) { o.mit = k; break; } // closed through it: mitigated
    return (tf._smc = { obs: obs, trendAt: trendAt, lastEv: lastEv });
  }
  SPEC_FN.s6 = function (tf, i, cur) {
    const S6 = smcBuild(tf), cx = specCtx(tf, i), b = tf.bars, q = b[i], p = b[i - 1], a = cx.a, side = S6.trendAt[i];
    if (!side) return null;
    const ev = S6.lastEv[i]; if (!ev || i - ev.i > 80) return null; // the structure break must be recent
    let rh = -Infinity, rl = Infinity; for (let k = Math.max(0, i - 100); k < i; k++) { if (b[k].h > rh) rh = b[k].h; if (b[k].l < rl) rl = b[k].l; }
    const eq = (rh + rl) / 2; if (side === 1 ? q.c > eq : q.c < eq) return null; // longs from discount, shorts from premium
    for (let m = S6.obs.length - 1; m >= 0; m--) {
      const o = S6.obs[m]; if (o.dir !== side || o.born >= i || i - o.born > 80 || o.mit <= i) continue;
      if (o.hi - o.lo < 0.3 * a || o.hi - o.lo > 3 * a) continue;
      const tag = side === 1 ? q.l <= o.hi && q.c > o.lo : q.h >= o.lo && q.c < o.hi; if (!tag) continue;
      let fresh = true; for (let k = o.born + 1; k < i; k++) if (side === 1 ? b[k].l <= o.hi : b[k].h >= o.lo) { fresh = false; break; } if (!fresh) continue; // first touch only
      if (side === 1 ? !(q.c > q.o && (wickDn(q) >= 0.3 || bullEng(q, p))) : !(q.c < q.o && (wickUp(q) >= 0.3 || bearEng(q, p)))) continue;
      const sl = side === 1 ? o.lo - 0.5 * cx.sc : o.hi + 0.5 * cx.sc;
      const s = specMk('s6', 6, 'SMC order-block retest ' + (side === 1 ? 'long' : 'short'), tf, i, side, q.c, sl, cx, cx.state !== 'balance', 'first retest of the ' + (side === 1 ? 'bullish' : 'bearish') + ' order block, ' + (side === 1 ? 'bullish' : 'bearish') + ' candle',
        [(ev.kind === 'choch' ? 'Change of character' : 'Break of structure') + ' ' + (side === 1 ? 'up' : 'down') + ' through ' + ev.level.toFixed(2), 'Price retests the order block ' + o.lo.toFixed(2) + ' to ' + o.hi.toFixed(2) + ' from ' + (side === 1 ? 'discount' : 'premium')], { invalid: side === 1 ? o.lo - 0.2 * a : o.hi + 0.2 * a });
      if (!s) continue;
      s.sizeMul = (ev.kind === 'choch' ? 0.5 : 1) * (s.sizeMul < 1 && SESS(new Date(q.t * 1000).getUTCHours()) === 'New York' ? 0.5 : 1);
      return s;
    }
    return null;
  };
  const SPEC_IDS = ['s1', 's2', 's3', 's4', 's5', 's6'];
  function evalSpec(tf, i, cur) {
    if (tf.m !== P.entryTf || i < 60) return null;
    const h = hourOf(tf.bars[i].t + 300); if (h < P.sp.hours[0] || h >= P.sp.hours[1]) return null;
    const on = P.enabled ? SPEC_IDS.filter(x => P.enabled.indexOf(x) >= 0) : SPEC_IDS;
    let best = null;
    for (const id of on) {
      const s = SPEC_FN[id](tf, i, cur); if (!s) continue;
      if (s.blockers.length) { if (!P.sp.keepBlocked) continue; }
      specGrade(tf, i, cur, s); if (s.conf < P.sp.grade) continue;
      if (!best || s.conf > best.conf) best = s; // setup 1 is checked first, so it wins ties
    }
    return best;
  }

  /* ---------- backtest (no lookahead) ---------- */
  function simulate(tf, i, sig) {
    const bars = tf.bars, fi = i + 1;
    if (fi >= bars.length) return null;
    const fb = bars[fi];
    if (!(fb.l <= sig.entry && sig.entry <= fb.h)) return null; // limit at signal close not touched
    const side = sig.side, risk = sig.risk, entry = sig.entry;
    let rem = 1, R = 0, stop = sig.sl, ev = [], hit = [false, false, false], exit = null;
    const MB = sig.maxBars || P.maxBars;
    for (let j = fi; j < bars.length && j <= fi + MB; j++) {
      const bb = bars[j];
      if (side === 1 ? bb.l <= stop : bb.h >= stop) {
        const d = rem * ((stop - entry) * side / risk);
        R += d; ev.push({ j: j, end: bb.end, k: hit[1] ? 'STOP+1R' : hit[0] ? 'BE' : 'SL', price: stop, dR: d, rem: 0 });
        rem = 0; exit = j; break;
      }
      for (let n = 0; n < 3; n++) {
        if (hit[n]) continue;
        const px = sig.tp[n];
        if (side === 1 ? bb.h >= px : bb.l <= px) {
          hit[n] = true;
          const part = n < 2 ? 1 / 3 : rem, d = part * ((px - entry) * side / risk);
          R += d; rem -= part;
          ev.push({ j: j, end: bb.end, k: 'TP' + (n + 1), price: px, dR: d, rem: rem });
          if (n === 0) stop = entry; if (n === 1) stop = sig.tp[0];
        } else break;
      }
      if (rem <= 1e-9) { exit = j; break; }
    }
    if (exit === null) {
      const j = Math.min(bars.length - 1, fi + MB), bb = bars[j], d = rem * ((bb.c - entry) * side / risk);
      R += d; ev.push({ j: j, end: bb.end, k: 'TIME', price: bb.c, dR: d, rem: 0 }); exit = j;
    }
    const costR = P.cost / risk; R -= costR;
    return { side: side, sigIdx: i, sigEnd: bars[i].end, sigT: bars[i].t, fillIdx: fi, entry: entry, sl: sig.sl, tp: sig.tp, risk: risk, score: sig.score, reasons: sig.reasons, trigger: sig.trigger, strat: sig.strat || (sig.counter ? 'rev' : sig.lt ? 'lt' : 'ema'), conf: sig.conf, grade: sig.grade, setupNo: sig.setupNo, setupName: sig.setupName, state: sig.state, zone: sig.zone, pattern: sig.pattern, blockers: sig.blockers, invalid: sig.invalid, sizeMul: sig.sizeMul, tpNames: sig.tpNames, counter: !!sig.counter, lt: !!sig.lt, bias: sig.bias, R: R, costR: costR, hit: hit, ev: ev, exitIdx: exit, exitEnd: bars[exit].end, exitT: bars[exit].t, exitPx: ev[ev.length - 1].price, exitK: ev[ev.length - 1].k };
  }
  function backtest(tf) {
    const out = [], bars = tf.bars, lossDay = {}; let i = 60;
    while (i < bars.length - 2) {
      const cur = bars[i].end;
      if (cur < S.warm) { i++; continue; }
      const sig = evalSignal(tf, i, cur);
      if (!sig) { i++; continue; }
      const tr = simulate(tf, i, sig);
      if (!tr) { i++; continue; }
      if (P.spec && P.sp.loseStop) { const dk = Math.floor(tf.bars[i].t / 86400); if (lossDay[dk] >= P.sp.loseStop) { i++; continue; } }
      out.push(tr); if (P.spec) { const dk = Math.floor(tr.sigT / 86400); lossDay[dk] = tr.R < 0 ? (lossDay[dk] || 0) + 1 : 0; } i = tr.exitIdx + 1;
    }
    return out;
  }
  function trades(m) { return S.bt[m] || (S.bt[m] = backtest(S.tfs[m])); }
  function closedAt(m, cur) { return trades(m).filter(t => t.exitEnd <= cur); }
  function openAt(m, cur) { return trades(m).find(t => t.sigEnd <= cur && t.exitEnd > cur) || null; }
  function statusAt(t, cur) {
    let R = -t.costR, rem = 1; const hit = [false, false, false]; let stop = t.sl;
    for (const e of t.ev) {
      if (e.end > cur) break;
      R += e.dR; rem = e.rem;
      if (e.k === 'TP1') { hit[0] = true; stop = t.entry; }
      if (e.k === 'TP2') { hit[1] = true; stop = t.tp[0]; }
      if (e.k === 'TP3') hit[2] = true;
    }
    const px = price(), live = R + rem * ((px - t.entry) * t.side / t.risk);
    return { R: R, rem: rem, hit: hit, stop: stop, live: live, px: px };
  }

  function stats(trs) {
    const n = trs.length; if (!n) return null;
    let w = 0, gw = 0, gl = 0, tot = 0, peak = 0, dd = 0; const curve = [0], hit = [0, 0, 0];
    for (const t of trs) {
      tot += t.R; curve.push(tot); if (tot > peak) peak = tot; if (peak - tot > dd) dd = peak - tot;
      if (t.R > 0) { w++; gw += t.R; } else gl += -t.R;
      t.hit.forEach((h, i) => { if (h) hit[i]++; });
    }
    return { n: n, wr: w / n, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), exp: tot / n, tot: tot, dd: dd, hit: hit.map(x => x / n), curve: curve };
  }

  /* ---------- market map ---------- */
  function zones(cur) {
    const tf = S.tfs[60] || S.tfs[S.list[S.list.length - 1]], j = lastDone(tf, cur), b = tf.bars, px = price();
    let sup = null, dem = null; const sups = [];
    for (let k = j - 2; k >= Math.max(2, j - 300); k--) {
      if (b[k].h >= b[k - 1].h && b[k].h >= b[k - 2].h && b[k].h >= b[k + 1].h && b[k].h >= b[k + 2].h && b[k].h > px) {
        const z = { hi: b[k].h, lo: Math.max(b[k].o, b[k].c), t: b[k].t }; sups.push(z);
        if (!sup || b[k].h < sup.hi) sup = z;
      }
      if (b[k].l <= b[k - 1].l && b[k].l <= b[k - 2].l && b[k].l <= b[k + 1].l && b[k].l <= b[k + 2].l && b[k].l < px) {
        if (!dem || b[k].l > dem.lo) dem = { lo: b[k].l, hi: Math.min(b[k].o, b[k].c), t: b[k].t };
      }
    }
    const n24 = Math.round(1440 / S.baseMin) - 1; let lo = Infinity, hi = -Infinity;
    for (let k = Math.max(0, cur - n24); k <= cur; k++) { if (S.base[k].l < lo) lo = S.base[k].l; if (S.base[k].h > hi) hi = S.base[k].h; }
    sups.sort((x, y) => x.hi - y.hi); const pick = []; sups.forEach(z => { if (pick.length < 3 && pick.every(q => Math.abs(q.hi - z.hi) > tf.atr[j] * 1.5)) pick.push(z); });
    return { sup: sup, sups: pick, dem: dem, lo: lo, hi: hi, pos: hi > lo ? (px - lo) / (hi - lo) : 0.5, price: px, atr1h: tf.atr[j] };
  }
  function price() { return S.base[S.live ? S.base.length - 1 : S.cursor].c; }
  function forming(tf, cur) {
    const j = lastDone(tf, cur), nb = tf.bars[j + 1], hiIdx = S.live ? S.base.length - 1 : cur;
    if (!nb || nb.start > hiIdx) return null;
    let h = -Infinity, l = Infinity;
    for (let k = nb.start; k <= hiIdx; k++) { if (S.base[k].h > h) h = S.base[k].h; if (S.base[k].l < l) l = S.base[k].l; }
    return { t: nb.t, o: S.base[nb.start].o, h: h, l: l, c: S.base[hiIdx].c, forming: true };
  }

  return { S: S, P: P, TFS: TFS, LABEL: LABEL, genSim: genSim, parseCSV: parseCSV, normalise: normalise, init: init, lastDone: lastDone, trendScore: trendScore, trendLabel: trendLabel, biasAt: biasAt, evalSignal: evalSignal, trades: trades, closedAt: closedAt, openAt: openAt, statusAt: statusAt, stats: stats, zones: zones, STRATS: STRATS, backtest: backtest, regimeOf: regimeOf, forming: forming, price: price, isTrading: isTrading };
};
export default makeEngine;
