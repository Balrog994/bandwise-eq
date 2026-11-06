// Strutture dati e validazione condivise tra popup e motore audio.

const EQ_TYPES = ["peaking", "lowshelf", "highshelf", "lowpass", "highpass", "notch", "bandpass"];
const EQ_GAIN_TYPES = ["peaking", "lowshelf", "highshelf"];    // tipi che usano il guadagno
const EQ_Q_DB_TYPES = ["lowpass", "highpass"];                  // per questi Web Audio esprime Q in dB
const EQ_Q_TYPES = ["peaking", "notch", "bandpass", "lowpass", "highpass"]; // gli shelf ignorano Q
const EQ_MAX_BANDS = 10;
const EQ_MAX_GAIN = 40; // limite assoluto; quello effettivo è il "range guadagno filtri"

// Modalità grafica: 10 cursori a ottave (31 Hz … 16 kHz).
// Filtri: 8 campane con Q 0,8 + shelf alle estremità (40 Hz e 11,3 kHz): a 16 kHz una
// campana si deformerebbe (vicino al limite di Nyquist) creando una cuspide.
// I filtri si sovrappongono, quindi i loro guadagni vengono calcolati (graphicFilterGains)
// perché la curva passi esattamente per i valori dei cursori. Parametri scelti con una
// ricerca su curve di prova: tra un cursore e l'altro la curva resta entro ~0,2 dB dal
// segmento che li unisce (con Q 1,0 e shelf a 44 Hz si formava una "U" di ~0,4 dB).
const GRAPHIC_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const GRAPHIC_Q = 0.8;
const GRAPHIC_MAX = 12;
const GRAPHIC_FILTERS = GRAPHIC_FREQS.map((f, i) =>
  i === 0 ? { type: "lowshelf", freq: 40 }
  : i === GRAPHIC_FREQS.length - 1 ? { type: "highshelf", freq: 11314 }
  : { type: "peaking", freq: f });

// ---- Asse delle frequenze e impostazioni dell'analizzatore (stessi valori di Just EQ) ----
const FREQ_MIN = 20, FREQ_MAX = 20000;

// t ∈ [0,1] = posizione orizzontale sul grafico
const freqAt = (t, scale) => scale === "linear"
  ? FREQ_MIN + (FREQ_MAX - FREQ_MIN) * t
  : FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t);
const posOf = (f, scale) => scale === "linear"
  ? (f - FREQ_MIN) / (FREQ_MAX - FREQ_MIN)
  : Math.log(f / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN);

const FFT_SIZES = [1024, 2048, 4096, 8192, 16384, 32768];
const DB_RANGES = { 60: [-70, 4], 90: [-110, 6], 120: [-140, 7] }; // range → [min, max] dBFS
const GAIN_RANGES = [10, 20, 40];
const ANALYZER_DEFAULTS = { fft: 8192, scale: "log", dbRange: 90, gainRange: 20, smoothing: 0.8 };

function analyzerSanitize(a) {
  a = a && typeof a === "object" ? a : {};
  const d = ANALYZER_DEFAULTS;
  return {
    fft: FFT_SIZES.includes(Number(a.fft)) ? Number(a.fft) : d.fft,
    scale: a.scale === "linear" ? "linear" : "log",
    dbRange: Number(a.dbRange) in DB_RANGES ? Number(a.dbRange) : d.dbRange,
    gainRange: GAIN_RANGES.includes(Number(a.gainRange)) ? Number(a.gainRange) : d.gainRange,
    smoothing: clamp(a.smoothing, 0, 1, d.smoothing)
  };
}

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function eqBand(type, freq, gain = 0, q = 1) {
  return { on: true, type, freq, gain, q };
}

const flatBands = () => [
  eqBand("lowshelf", 80),
  eqBand("peaking", 250, 0, 1),
  eqBand("peaking", 1000, 0, 1),
  eqBand("peaking", 4000, 0, 1),
  eqBand("highshelf", 10000)
];

// Stato completo: ogni modalità conserva le sue impostazioni.
function eqState(mode, { preamp = 0, bands = flatBands(), graphic = GRAPHIC_FREQS.map(() => 0) } = {}) {
  return { mode, preamp, limiter: true, bypass: false, bands, graphic };
}
const eqFlat = () => eqState("parametric");
// Configurazione per una nuova installazione: modalità grafica, piatta.
const eqDefault = () => eqState("graphic");

// Normalizza qualsiasi oggetto (da storage, preset o messaggio) in uno stato valido.
// Gli stati salvati prima della modalità grafica non hanno "mode": restano parametrici.
function sanitizeBands(list) {
  return list.slice(0, EQ_MAX_BANDS).map((b) => {
    const type = EQ_TYPES.includes(b?.type) ? b.type : "peaking";
    const qDb = EQ_Q_DB_TYPES.includes(type);
    return {
      on: b?.on !== false,
      type,
      freq: Math.round(clamp(b?.freq, 20, 20000, 1000)),
      gain: clamp(b?.gain, -EQ_MAX_GAIN, EQ_MAX_GAIN, 0),
      q: qDb ? clamp(b?.q, -10, 20, 0) : clamp(b?.q, 0.1, 30, 1)
    };
  });
}

function eqSanitize(e) {
  if (!e || typeof e !== "object") return eqDefault();
  const bands = Array.isArray(e.bands) ? sanitizeBands(e.bands) : flatBands();
  const graphic = GRAPHIC_FREQS.map((_, i) => clamp(Array.isArray(e.graphic) ? e.graphic[i] : 0, -GRAPHIC_MAX, GRAPHIC_MAX, 0));
  const out = {
    mode: e.mode === "graphic" ? "graphic" : "parametric",
    preamp: clamp(e.preamp, -12, 12, 0),
    limiter: e.limiter !== false,
    bypass: e.bypass === true,
    bands: bands.length ? bands : flatBands(),
    graphic
  };
  // bande parametriche originali, conservate passando al grafico finché i cursori non vengono toccati
  if (out.mode === "graphic" && Array.isArray(e.paramBackup) && e.paramBackup.length) out.paramBackup = sanitizeBands(e.paramBackup);
  return out;
}

// Risposta in dB di un filtro alla frequenza f, con le formule RBJ usate da BiquadFilterNode
// (shelf con pendenza S = 1; Q di passa-alto/basso in dB, come in Web Audio).
function biquadDb(type, f0, gain, q, f, fs = 48000) {
  if (!gain && EQ_GAIN_TYPES.includes(type)) return 0;
  const A = Math.pow(10, gain / 40), w0 = (2 * Math.PI * f0) / fs, c = Math.cos(w0), s = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === "lowpass" || type === "highpass" || type === "notch" || type === "bandpass") {
    const al = s / (2 * (EQ_Q_DB_TYPES.includes(type) ? Math.pow(10, q / 20) : q));
    [a0, a1, a2] = [1 + al, -2 * c, 1 - al];
    if (type === "lowpass") [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
    else if (type === "highpass") [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    else if (type === "notch") [b0, b1, b2] = [1, -2 * c, 1];
    else [b0, b1, b2] = [al, 0, -al];
  } else if (type === "peaking") {
    const al = s / (2 * q);
    [b0, b1, b2, a0, a1, a2] = [1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A];
  } else {
    const sa = 2 * Math.sqrt(A) * (s / Math.SQRT2);
    if (type === "lowshelf") {
      [b0, b1, b2] = [A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa)];
      [a0, a1, a2] = [(A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa];
    } else {
      [b0, b1, b2] = [A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa)];
      [a0, a1, a2] = [(A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa];
    }
  }
  const w = (2 * Math.PI * f) / fs, cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const num = Math.hypot(b0 + b1 * cw + b2 * c2, b1 * sw + b2 * s2);
  const den = Math.hypot(a0 + a1 * cw + a2 * c2, a1 * sw + a2 * s2);
  return 20 * Math.log10(Math.max(num / den, 1e-6));
}
const graphicFilterDb = (j, gain, f) => biquadDb(GRAPHIC_FILTERS[j].type, GRAPHIC_FILTERS[j].freq, gain, GRAPHIC_Q, f);

// Sistema lineare n×n (eliminazione di Gauss con pivot).
function solveLinear(M, y) {
  const n = y.length, A = M.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j];
    }
  }
  return A.map((r, i) => r[n] / r[i]);
}

// Guadagni reali dei 10 filtri perché la curva complessiva valga esattamente quanto
// indicano i cursori alle frequenze centrali (compensa la sovrapposizione tra bande).
const GRAPHIC_M = GRAPHIC_FREQS.map((fi) => GRAPHIC_FILTERS.map((_, j) => graphicFilterDb(j, 1, fi)));
const graphicCache = new Map();
function graphicFilterGains(sliders) {
  const key = sliders.join(",");
  let x = graphicCache.get(key);
  if (x) return x;
  if (sliders.every((v) => v === 0)) x = sliders.map(() => 0);
  else {
    x = solveLinear(GRAPHIC_M, sliders);
    // la risposta in dB non è perfettamente lineare nel guadagno: qualche passo di correzione
    for (let it = 0; it < 4; it++) {
      const err = GRAPHIC_FREQS.map((f, i) => sliders[i] - x.reduce((s, g, j) => s + graphicFilterDb(j, g, f), 0));
      const dx = solveLinear(GRAPHIC_M, err);
      x = x.map((v, i) => Math.max(-EQ_MAX_GAIN, Math.min(EQ_MAX_GAIN, v + dx[i])));
    }
    x = x.map((v) => Math.round(v * 100) / 100);
  }
  if (graphicCache.size > 200) graphicCache.clear();
  graphicCache.set(key, x);
  return x;
}

// Bande effettivamente applicate dal motore audio, per la modalità attiva.
function eqActiveBands(e) {
  if (e.mode !== "graphic") return e.bands;
  const gains = graphicFilterGains(e.graphic);
  return GRAPHIC_FILTERS.map((flt, i) => ({ on: true, type: flt.type, freq: flt.freq, gain: gains[i], q: GRAPHIC_Q }));
}

// Copia le 10 bande grafiche nel parametrico, per rifinirle.
function graphicToParametric(e) {
  return { ...e, mode: "parametric", bands: eqActiveBands({ ...e, mode: "graphic" }).map((b) => ({ ...b })) };
}

// Curva (senza preamp) di un insieme di bande parametriche, in dB alla frequenza f.
const bandsDb = (bands, f) => bands.reduce((s, b) => s + (b.on ? biquadDb(b.type, b.freq, b.gain, b.q, f) : 0), 0);

// Un solo equalizzatore, due modi di modificarlo. Ritorna { eq, approxDb }.
//   parametrico → grafico: i cursori prendono il valore medio della curva sulla loro ottava;
//     le bande originali vengono conservate (paramBackup) e approxDb dice di quanto, al massimo,
//     i 10 cursori si discostano dalla curva parametrica.
//   grafico → parametrico: se i cursori non sono stati toccati si ritrovano le bande originali;
//     altrimenti la curva dei cursori diventa bande parametriche identiche nel suono
//     (tutti i cursori a zero → le 5 bande di partenza).
function eqSwitchMode(e, mode) {
  if (e.mode === mode) return { eq: e, approxDb: 0 };
  if (mode === "graphic") {
    // ogni cursore prende la media della curva sulla sua ottava (½ ottava per parte):
    // un dettaglio stretto (es. un notch) pesa quanto si sente, invece di diventare un buco largo
    const avgDb = (fc) => {
      let sum = 0;
      const n = 24;
      for (let k = 0; k < n; k++) sum += bandsDb(e.bands, Math.min(20000, fc * Math.pow(2, (k / (n - 1) - 0.5))));
      return sum / n;
    };
    const graphic = GRAPHIC_FREQS.map((f) => Math.round(clamp(avgDb(f), -GRAPHIC_MAX, GRAPHIC_MAX, 0) * 10) / 10);
    const next = { ...e, mode: "graphic", graphic, paramBackup: e.bands.map((b) => ({ ...b })) };
    const gb = eqActiveBands(next);
    let approxDb = 0;
    for (let f = 31; f <= 16000; f *= 1.03) approxDb = Math.max(approxDb, Math.abs(bandsDb(e.bands, f) - bandsDb(gb, f)));
    return { eq: next, approxDb: Math.round(approxDb * 10) / 10 };
  }
  const { paramBackup, ...rest } = e;
  if (paramBackup) return { eq: { ...rest, mode: "parametric", bands: paramBackup }, approxDb: 0 };
  if (e.graphic.every((v) => v === 0)) return { eq: { ...rest, mode: "parametric", bands: flatBands() }, approxDb: 0 };
  return { eq: graphicToParametric(rest), approxDb: 0 };
}

// Preset predefiniti. ID stabili; il nome mostrato è tradotto ("preset_<id senza g_>").
const presetG = (preamp, gains) => eqState("graphic", { preamp, graphic: gains });
const presetP = (preamp, bands) => eqState("parametric", { preamp, bands });
const EQ_BUILTIN_PRESETS = {
  //                    31  62 125 250 500  1k  2k  4k  8k 16k
  g_flat:     presetG(0,  [0,  0,  0,  0,  0,  0,  0,  0,  0,  0]),
  g_bass:     presetG(-4, [6,  5,  4,  2,  0,  0,  0,  0,  0,  0]),
  g_treble:   presetG(-3, [0,  0,  0,  0,  0,  0,  1,  3,  5,  6]),
  g_voice:    presetG(-2, [-3, -2, -1, 0,  2,  3,  3,  2,  0, -1]),
  g_loudness: presetG(-3, [5,  4,  2,  0, -1, -1,  0,  2,  4,  5]),
  g_rock:     presetG(-3, [4,  3,  2,  0, -1, -1,  1,  3,  4,  4]),
  g_pop:      presetG(-3, [-1, 1,  3,  4,  3,  0, -1, -1,  0,  1]),
  flat: eqFlat(),
  bass: presetP(-3, [eqBand("lowshelf", 90, 6), eqBand("peaking", 250, -1, 1), eqBand("peaking", 1000, 0, 1),
    eqBand("peaking", 4000, 0, 1), eqBand("highshelf", 10000, 1)]),
  voice: presetP(-2, [eqBand("highpass", 90, 0, 0), eqBand("peaking", 250, -2, 1), eqBand("peaking", 2500, 4, 1),
    eqBand("peaking", 5000, 2, 1.5), eqBand("highshelf", 10000, -1)]),
  treble: presetP(-2, [eqBand("lowshelf", 80, 0), eqBand("peaking", 250, 0, 1), eqBand("peaking", 1000, 0, 1),
    eqBand("peaking", 4000, 2, 1), eqBand("highshelf", 6000, 5)]),
  loudness: presetP(-4, [eqBand("lowshelf", 100, 5), eqBand("peaking", 250, 0, 1), eqBand("peaking", 1000, -2, 0.8),
    eqBand("peaking", 4000, 0, 1), eqBand("highshelf", 8000, 4)])
};

// ---- Formato Equalizer APO / AutoEQ (ParametricEQ.txt) ----
//   Preamp: -6.2 dB
//   Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70
// In APO la Q di passa-alto/basso è lineare; in Web Audio è in dB (20·log10 Q).
// Gli shelf di Web Audio hanno pendenza fissa (Q ≈ 0,71, quella usata da AutoEQ).

const APO_TYPES = {
  PK: "peaking", PEQ: "peaking", MODAL: "peaking",
  LS: "lowshelf", LSC: "lowshelf", LSQ: "lowshelf",
  HS: "highshelf", HSC: "highshelf", HSQ: "highshelf",
  LP: "lowpass", LPQ: "lowpass", HP: "highpass", HPQ: "highpass",
  NO: "notch", BP: "bandpass"
};

// Ritorna { eq, count, total, skipped } oppure null se non trova filtri.
function eqFromApo(text, base = eqFlat()) {
  const num = (s) => parseFloat(String(s).replace(",", "."));
  let preamp = 0;
  const bands = [];
  let total = 0, skipped = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const pm = /^preamp\s*:\s*([-+]?\d+(?:[.,]\d+)?)\s*db/i.exec(line);
    if (pm) { preamp = num(pm[1]); continue; }
    const fm = /^filter\s*\d*\s*:\s*(on|off)\s+([a-z]+)\b(.*)$/i.exec(line);
    if (!fm) continue;
    total++;
    const type = APO_TYPES[fm[2].toUpperCase()];
    const fc = /\bfc\s+([\d.,]+)\s*(k?)hz/i.exec(fm[3]);
    if (!type || !fc) { skipped++; continue; }
    const gm = /\bgain\s+([-+]?[\d.,]+)\s*db/i.exec(fm[3]);
    const qm = /\bq\s+([\d.,]+)/i.exec(fm[3]);
    const q = qm ? num(qm[1]) : EQ_Q_DB_TYPES.includes(type) ? Math.SQRT1_2 : 1;
    if (bands.length >= EQ_MAX_BANDS) continue;
    bands.push({
      on: fm[1].toLowerCase() === "on",
      type,
      freq: num(fc[1]) * (fc[2] ? 1000 : 1),
      gain: gm ? num(gm[1]) : 0,
      q: EQ_Q_DB_TYPES.includes(type) ? 20 * Math.log10(Math.max(q, 1e-3)) : q
    });
  }
  if (!bands.length) return null;
  const eq = eqSanitize({ ...base, mode: "parametric", preamp, bands, bypass: false });
  return { eq, count: bands.length, total, skipped };
}

function eqToApo(e) {
  const code = { peaking: "PK", lowshelf: "LSC", highshelf: "HSC", lowpass: "LPQ", highpass: "HPQ", notch: "NO", bandpass: "BP" };
  const f = (n, d) => Number(n).toFixed(d);
  const lines = [`Preamp: ${f(e.preamp, 1)} dB`];
  eqActiveBands(e).forEach((b, i) => {
    let s = `Filter ${i + 1}: ${b.on ? "ON" : "OFF"} ${code[b.type]} Fc ${Math.round(b.freq)} Hz`;
    if (EQ_GAIN_TYPES.includes(b.type)) s += ` Gain ${f(b.gain, 1)} dB`;
    if (b.type === "lowshelf" || b.type === "highshelf") s += " Q 0.71";
    else if (EQ_Q_DB_TYPES.includes(b.type)) s += ` Q ${f(Math.pow(10, b.q / 20), 2)}`;
    else s += ` Q ${f(b.q, 2)}`;
    lines.push(s);
  });
  return lines.join("\n") + "\n";
}
