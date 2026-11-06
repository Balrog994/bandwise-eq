// Motore audio: gira nel documento offscreen (invisibile).
// Catena per ogni scheda: sorgente → preamp → filtri → limitatore → uscita.

// Analizzatori: "pre" legge la sorgente, "post" l'uscita finale.
// FFT e smoothing arrivano dal popup a ogni richiesta di spettro.

const ctx = new AudioContext({ latencyHint: "interactive" });
const chains = new Map(); // tabId → catena audio con la sua configurazione (chain.eq)

const FLOOR_DB = -160;

function makeAnalyser() {
  const a = ctx.createAnalyser();
  a.fftSize = ANALYZER_DEFAULTS.fft;
  a.smoothingTimeConstant = ANALYZER_DEFAULTS.smoothing;
  return a;
}

function configure(an, fft, smoothing) {
  if (an.fftSize !== fft) an.fftSize = fft;
  if (an.smoothingTimeConstant !== smoothing) an.smoothingTimeConstant = smoothing;
}

// Mappa punto del grafico → bin della FFT. Ogni punto copre una colonna del grafico:
// se contiene più bin si prende il massimo, se cade tra due bin (FFT poco risoluta
// rispetto ai pixel, tipicamente sui bassi) si interpola.
const specMaps = new Map();
function getSpecMap(fft, scale, n) {
  const key = `${fft}|${scale}|${n}`;
  let map = specMaps.get(key);
  if (map) return map;
  const binHz = ctx.sampleRate / fft;
  const edge = (t) => freqAt(Math.min(1, Math.max(0, t)), scale);
  map = Array.from({ length: n }, (_, i) => {
    const lo = edge((i - 0.5) / (n - 1)), hi = edge((i + 0.5) / (n - 1));
    const b0 = Math.ceil(lo / binHz), b1 = Math.floor(hi / binHz);
    return b1 >= b0 ? { b0, b1 } : { pos: freqAt(i / (n - 1), scale) / binHz };
  });
  if (specMaps.size > 8) specMaps.clear();
  specMaps.set(key, map);
  return map;
}

let binBuf = new Float32Array(0);
function readSpectrum(an, map) {
  if (binBuf.length !== an.frequencyBinCount) binBuf = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(binBuf);
  const last = binBuf.length - 1;
  const out = new Array(map.length);
  for (let i = 0; i < map.length; i++) {
    const m = map[i];
    let v;
    if (m.pos !== undefined) {
      const k = Math.min(last - 1, Math.floor(m.pos)), t = m.pos - k;
      v = binBuf[k] * (1 - t) + binBuf[k + 1] * t;
    } else {
      v = -Infinity;
      for (let k = m.b0, end = Math.min(m.b1, last); k <= end; k++) if (binBuf[k] > v) v = binBuf[k];
    }
    out[i] = Number.isFinite(v) ? Math.round(Math.max(FLOOR_DB, v) * 10) / 10 : FLOOR_DB;
  }
  return out;
}

const dbToGain = (db) => Math.pow(10, db / 20);

function setParam(param, value, immediate) {
  if (immediate) param.value = value;
  else param.setTargetAtTime(value, ctx.currentTime, 0.012); // transizione morbida, niente click
}

function makeLimiter() {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = -2;
  c.knee.value = 0;
  c.ratio.value = 20;
  c.attack.value = 0.002;
  c.release.value = 0.15;
  return c;
}

// Meter di uscita: separa i canali L/R e ne legge la forma d'onda per picco e RMS.
function makeMeter() {
  const split = ctx.createChannelSplitter(2);
  const meterL = ctx.createAnalyser(), meterR = ctx.createAnalyser();
  meterL.fftSize = meterR.fftSize = 2048; // ~43 ms a 48 kHz
  split.connect(meterL, 0);
  split.connect(meterR, 1);
  return { split, meterL, meterR };
}

const meterBuf = new Float32Array(2048);
function readLevel(an) {
  an.getFloatTimeDomainData(meterBuf);
  let peak = 0, sum = 0;
  for (let i = 0; i < meterBuf.length; i++) {
    const v = meterBuf[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  const db = (x) => Math.round(Math.max(-120, 20 * Math.log10(x || 1e-9)) * 10) / 10;
  return { peak: db(peak), rms: db(Math.sqrt(sum / meterBuf.length)) };
}

// ---------- A/B a volume pareggiato ----------
// Mentre l'EQ è attivo si stima di continuo la differenza di volume (RMS mediato ~1 s)
// tra uscita e sorgente. Quando si ascolta B (bypass) la sorgente viene compensata di
// quella differenza: il confronto riguarda il suono, non il volume.

const MATCH_LIMIT_DB = 12;
const powBufs = new Map();
function meanSquare(an) {
  let buf = powBufs.get(an.fftSize);
  if (!buf) powBufs.set(an.fftSize, (buf = new Float32Array(an.fftSize)));
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return sum / buf.length;
}
function matchDb(chain) {
  if (!chain.preE || !chain.postE) return 0;
  const d = 10 * Math.log10(chain.postE / chain.preE);
  return Math.max(-MATCH_LIMIT_DB, Math.min(MATCH_LIMIT_DB, d));
}
setInterval(() => {
  for (const chain of chains.values()) {
    if (chain.eq.bypass) continue;          // durante il bypass la stima resta congelata
    const pre = meanSquare(chain.preAn), post = meanSquare(chain.postAn);
    if (pre < 1e-6) continue;               // sotto -60 dBFS: silenzio, non aggiornare
    chain.preE = chain.preE ? chain.preE * 0.9 + pre * 0.1 : pre;
    chain.postE = chain.postE ? chain.postE * 0.9 + post * 0.1 : post;
  }
}, 100);

// ---------- catena audio di una scheda ----------
// sorgente → preamp → filtri → limitatore → uscita (+ analizzatore post e meter)
// in bypass: sorgente → guadagno di compensazione → uscita
// Ogni scheda ha la sua configurazione (chain.eq).

function apply(chain, immediate = false) {
  const eq = chain.eq;
  const active = eqActiveBands(eq).filter((b) => b.on);
  const key = JSON.stringify([eq.bypass, eq.limiter, active.length]);

  if (key !== chain.key) {
    chain.key = key;
    immediate = true;
    for (const n of [chain.source, chain.pre, chain.lim, chain.byp, ...chain.filters]) n.disconnect();
    chain.filters = [];
    chain.source.connect(chain.preAn);
    let node;
    if (eq.bypass) {
      chain.source.connect(chain.byp);
      node = chain.byp;
    } else {
      chain.filters = active.map(() => ctx.createBiquadFilter());
      node = chain.source;
      for (const next of [chain.pre, ...chain.filters, ...(eq.limiter ? [chain.lim] : [])]) {
        node.connect(next);
        node = next;
      }
    }
    node.connect(ctx.destination);
    node.connect(chain.postAn);
    node.connect(chain.split);
  }

  if (eq.bypass) {
    // se l'EQ suona d dB più forte, B viene alzato di d dB
    setParam(chain.byp.gain, chain.match ? dbToGain(matchDb(chain)) : 1, immediate);
    return;
  }
  setParam(chain.pre.gain, dbToGain(eq.preamp), immediate);
  active.forEach((b, i) => {
    const f = chain.filters[i];
    if (f.type !== b.type) f.type = b.type;
    setParam(f.frequency, b.freq, immediate);
    setParam(f.gain, b.gain, immediate);
    setParam(f.Q, b.q, immediate);
  });
}

async function start(tabId, streamId, eq, match) {
  if (chains.has(tabId)) return { ok: true };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false
  });
  if (ctx.state !== "running") await ctx.resume();
  const chain = {
    stream,
    eq: eqSanitize(eq),
    match: match !== false,
    preE: 0, postE: 0,
    source: ctx.createMediaStreamSource(stream),
    pre: ctx.createGain(),
    lim: makeLimiter(),
    byp: ctx.createGain(),
    filters: [],
    preAn: makeAnalyser(),
    postAn: makeAnalyser(),
    ...makeMeter(),
    key: null
  };
  chains.set(tabId, chain);
  apply(chain, true);
  // la traccia termina quando la scheda viene chiusa
  stream.getAudioTracks()[0]?.addEventListener("ended", () => stop(tabId, true));
  return { ok: true };
}

function stop(tabId, notify = false) {
  const chain = chains.get(tabId);
  if (!chain) return;
  chains.delete(tabId);
  chain.stream.getTracks().forEach((t) => t.stop());
  for (const n of [chain.source, chain.pre, chain.lim, chain.byp, ...chain.filters]) n.disconnect();
  if (notify) chrome.runtime.sendMessage({ target: "sw", cmd: "ended", tabId }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  (async () => {
    switch (msg.cmd) {
      case "start":
        return start(msg.tabId, msg.streamId, msg.eq, msg.match);
      case "stop":
        stop(msg.tabId);
        return { ok: true };
      case "eq": {
        const chain = chains.get(msg.tabId);
        if (!chain) return { ok: false };
        chain.eq = eqSanitize(msg.eq);
        if (typeof msg.match === "boolean") chain.match = msg.match;
        apply(chain);
        return { ok: true };
      }
      case "status":
        return { tabs: [...chains.keys()] };
      case "spectrum": {
        const chain = chains.get(msg.tabId);
        if (!chain) return null;
        const a = analyzerSanitize(msg);
        const n = Math.round(clamp(msg.n, 16, 4096, 512));
        configure(chain.preAn, a.fft, a.smoothing);
        configure(chain.postAn, a.fft, a.smoothing);
        const map = getSpecMap(a.fft, a.scale, n);
        return {
          pre: msg.pre ? readSpectrum(chain.preAn, map) : null,
          post: msg.post ? readSpectrum(chain.postAn, map) : null,
          meter: msg.meter ? { l: readLevel(chain.meterL), r: readLevel(chain.meterR) } : null,
          // compensazione applicata a B (null se non in bypass o se disattivata)
          matchDb: chain.eq.bypass && chain.match ? Math.round(matchDb(chain) * 10) / 10 : null,
          sampleRate: ctx.sampleRate
        };
      }
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
