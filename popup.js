// Bandwise EQ user interface.
// State:
//   chrome.storage.session "tab:<id>" → { eq, activePreset, host }: configuration of that tab
//   chrome.storage.local:
//     eq, activePreset → last configuration used (starting point for new tabs)
//     sites            → { host: { eq, activePreset } } sites with per-site memory enabled (📌)
//     presets          → { name: configuration } user presets
//     view, analyzer, ui, prefs → display and listening preferences
// eq.bypass = bypass locked with Shift+A/B. eq.mode = "graphic" | "parametric".

const $ = (id) => document.getElementById(id);
localize(); // HTML texts in the browser's language, before everything else
// band colors, designed for the dark display
const BAND_COLORS = ["#ff9f43", "#ff5fa2", "#3ddc84", "#b388ff", "#4dabf7",
                     "#ff6b6b", "#22d3ee", "#ffd43b", "#ced4da", "#a3e635"];
const bandColor = (i) => BAND_COLORS[i % BAND_COLORS.length];
// Graphic mode: a spectrum from red (lows) to violet (highs), one color per slider.
// OKLCH at constant lightness: red, yellow and violet appear equally bright
// (in HSL red and blue look much darker than yellow).
const GRAPHIC_COLORS = GRAPHIC_FREQS.map((_, i) => `oklch(0.76 0.15 ${Math.round(25 + i * 32)})`);
const TYPE_LABELS = Object.fromEntries(EQ_TYPES.map((k) => [k, t("type_" + k)]));
// display palette (always dark)
const D = {
  grid: "rgba(255,255,255,0.055)", major: "rgba(255,255,255,0.15)", zero: "rgba(255,255,255,0.32)",
  text: "#8a919b", fg: "#e6e8eb", label: "rgba(17,19,23,0.92)",
  curve: "#7cc4ff", curveGlow: "rgba(124,196,255,0.45)",
  post: "#34d399", peak: "#fbbf24", preA: "#8b5cf6", preB: "#3b82f6"
};

let eq = eqDefault();
let userPresets = {};
let activePreset = "";
let tabId = null;
let tabHost = "";       // site of the tab (empty for internal pages)
let sites = {};
let prefs = { matchAB: true };
let capturing = false;
let selIdx = 0;         // selected band (parametric)
let abHold = false;     // A/B held down (momentary bypass)
let advanced = false;
let matchNow = null;    // compensation applied to B, in dB (from the engine)

// analyzer
let view = { pre: true, post: true, peak: false };
let paused = false;
let spec = null;
let peak = null;
let hoverX = -1;
let loopRunning = false;
let an = { ...ANALYZER_DEFAULTS };
let sampleRate = 0;

const isGraphic = () => eq.mode === "graphic";

// ---------- value formats ----------

const fmtF = (f) => (f >= 1000 ? (f / 1000).toFixed(f % 1000 ? 1 : 0) + "k" : String(Math.round(f)));
const fmtGain = (v) => ({ text: (v > 0 ? "+" : "") + v.toFixed(1), unit: "dB" });
const fmtFreq = (v) => (v >= 1000
  ? { text: (v / 1000).toFixed(v >= 10000 ? 1 : 2), unit: "kHz" }
  : { text: String(Math.round(v)), unit: "Hz" });
const parseNum = (s) => parseFloat(String(s).trim().replace(",", "."));
// accepts "250", "2.5k", "2,5 kHz"; if the field shows kHz, "3" means 3 kHz
function parseFreq(s, ctrl) {
  s = String(s).trim().toLowerCase();
  let n = parseNum(s);
  if (!Number.isFinite(n)) return NaN;
  if (s.includes("k")) n *= 1000;
  else if (ctrl.unit.textContent === "kHz" && n < 20) n *= 1000;
  return n;
}

// ---------- messages and saving ----------

const send = (msg) => chrome.runtime.sendMessage(msg);

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 200);
}
function flushSave() {
  clearTimeout(saveTimer);
  const state = { eq, activePreset };
  const local = { ...state };
  if (tabHost && sites[tabHost]) { sites[tabHost] = state; local.sites = sites; } // 📌 enabled: update the site
  chrome.storage.local.set(local);
  if (tabId != null) chrome.storage.session.set({ ["tab:" + tabId]: { ...state, host: tabHost } });
}
addEventListener("pagehide", flushSave);

const isBypassed = () => eq.bypass || abHold;
const effectiveEq = () => (abHold ? { ...eq, bypass: true } : eq);

// Send to the audio engine, at most ~60 times per second. A timer rather than requestAnimationFrame:
// if Chrome suspends frames, sending must not get stuck.
let livePending = false;
function sendLive() {
  if (livePending || tabId == null) return;
  livePending = true;
  setTimeout(() => {
    livePending = false;
    send({ target: "offscreen", cmd: "eq", tabId, eq: effectiveEq(), match: prefs.matchAB }).catch(() => {});
  }, 16);
}

// Call after every change made by the user.
function changed({ structure = false, keepPreset = false } = {}) {
  if (!keepPreset && activePreset) {
    activePreset = "";
    renderPresets();
  }
  selIdx = Math.min(Math.max(0, selIdx), eq.bands.length - 1);
  if (structure) { renderChips(); renderBandList(); }
  syncMode();
  syncBands();
  syncGraphic();
  syncGlobal();
  syncAB();
  draw();
  sendLive();
  save();
}

// ---------- state and power ----------

// Overlay message. kind: "info" | "warn" | "error".
// Stays visible long enough to read it (~70 ms per character; minimum 2.5 s, 6 s for warnings and errors),
// doesn't disappear while the mouse is over it, and closes with a click.
let statusTimer = 0, statusMs = 0;
function setStatus(text, kind = "info") {
  const el = $("status");
  clearTimeout(statusTimer);
  el.textContent = text;
  el.className = "status " + kind;
  el.hidden = !text;
  if (!text) return;
  statusMs = Math.max(kind === "info" ? 2500 : 6000, text.length * 70);
  armStatus();
}
function armStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $("status").hidden = true; }, statusMs);
}
$("status").addEventListener("mouseenter", () => clearTimeout(statusTimer));
$("status").addEventListener("mouseleave", () => { if (!$("status").hidden) { statusMs = 1500; armStatus(); } });
$("status").addEventListener("click", () => { clearTimeout(statusTimer); $("status").hidden = true; });

function renderPower() {
  $("power").disabled = tabId == null;
  $("power").checked = capturing;
  $("powerLabel").textContent = capturing ? "ON" : "OFF";
}

$("power").addEventListener("change", async () => {
  const wanted = $("power").checked;
  $("power").disabled = true;
  try {
    if (!wanted) {
      await send({ target: "sw", cmd: "stop", tabId });
      capturing = false;
      spec = null;
      setStatus("");
      draw();
    } else {
      flushSave();
      const res = await send({ target: "sw", cmd: "start", tabId, eq: effectiveEq(), match: prefs.matchAB });
      if (res?.ok) {
        capturing = true;
        setStatus("");
        startLoop();
      } else {
        setStatus(friendlyError(res?.error), "error");
      }
    }
  } catch (e) {
    setStatus(friendlyError(String(e?.message || e)), "error");
  }
  renderPower();
});

function friendlyError(err = "") {
  if (/active stream|already/i.test(err)) return t("errBusy");
  if (/chrome:|Chrome pages|cannot be captured|not allowed/i.test(err)) return t("errNoCapture");
  if (/invoked/i.test(err)) return t("errInvoke");
  return err || t("errUnknown");
}

// ---------- presets ----------

const builtinName = (id) => t("preset_" + id.replace(/^g_/, ""));

function renderPresets() {
  const sel = $("preset");
  sel.replaceChildren();
  sel.add(new Option(t("custom"), ""));
  const ids = Object.keys(EQ_BUILTIN_PRESETS);
  const groups = [
    [t("presetsGraphic"), ids.filter((id) => EQ_BUILTIN_PRESETS[id].mode === "graphic").map((id) => [builtinName(id), "b:" + id])],
    [t("presetsParametric"), ids.filter((id) => EQ_BUILTIN_PRESETS[id].mode !== "graphic").map((id) => [builtinName(id), "b:" + id])],
    [t("myPresets"), Object.keys(userPresets).sort((a, b) => a.localeCompare(b)).map((n) => [n, "u:" + n])]
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const og = document.createElement("optgroup");
    og.label = label;
    for (const [text, value] of items) og.append(new Option(text, value));
    sel.append(og);
  }
  // import of a headphone profile: at the bottom of the menu, where someone wanting to load a preset looks for it
  const og = document.createElement("optgroup");
  og.label = t("importGroup");
  og.append(new Option(t("importMenu"), IMPORT_OPTION));
  sel.append(og);
  sel.value = activePreset;
  if (sel.value !== activePreset) sel.value = "";
  // rename and delete (in the 💾 popover) apply only to user presets
  $("presetManage").hidden = !activePreset.startsWith("u:");
}

const IMPORT_OPTION = "__import";
$("preset").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === IMPORT_OPTION) { // not a preset: go back to the current selection and open the import
    e.target.value = activePreset;
    if (e.target.value !== activePreset) e.target.value = "";
    openImport();
    return;
  }
  if (!v) return;
  const name = v.slice(2);
  const src = v.startsWith("b:") ? EQ_BUILTIN_PRESETS[name] : userPresets[name];
  if (!src) return;
  const locked = eq.bypass;           // the locked bypass doesn't depend on the preset
  eq = eqSanitize(structuredClone(src));
  eq.bypass = locked;
  activePreset = v;
  selIdx = 0;
  renderPresets();
  changed({ structure: true, keepPreset: true });
});

// 💾 popover: name + Save; for user presets also Rename and Delete; APO import/export.
let suggestedName = "";
function openPresetPop() {
  $("presetName").value = activePreset.startsWith("u:") ? activePreset.slice(2) : suggestedName;
  $("presetPop").hidden = false;
  $("presetName").focus();
  $("presetName").select();
}
const closePresetPop = () => { $("presetPop").hidden = true; };

$("savePresetBtn").addEventListener("click", () => {
  if ($("presetPop").hidden) openPresetPop(); else closePresetPop();
});
$("presetName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("presetPopOk").click();
  if (e.key === "Escape") closePresetPop();
});

async function presetAction(rename) {
  const name = $("presetName").value.trim();
  if (!name) { $("presetName").focus(); return; }
  if (rename && activePreset.startsWith("u:")) {
    const old = activePreset.slice(2);
    if (name !== old) {
      userPresets[name] = userPresets[old];
      delete userPresets[old];
    }
    setStatus(t("presetRenamed", name));
  } else {
    const copy = structuredClone(eq);
    copy.bypass = false;              // a preset doesn't save the bypass state
    userPresets[name] = copy;
    setStatus(t("presetSaved", name));
  }
  activePreset = "u:" + name;
  suggestedName = "";
  await chrome.storage.local.set({ presets: userPresets });
  flushSave();
  closePresetPop();
  renderPresets();
}
$("presetPopOk").addEventListener("click", () => presetAction(false));
$("renamePreset").addEventListener("click", () => presetAction(true));

$("deletePreset").addEventListener("click", async () => {
  if (!activePreset.startsWith("u:")) return;
  const name = activePreset.slice(2);
  delete userPresets[name];
  activePreset = "";
  await chrome.storage.local.set({ presets: userPresets });
  flushSave();
  closePresetPop();
  renderPresets();
  setStatus(t("presetDeleted", name));
});

// ---------- import / export AutoEQ · Equalizer APO ----------

const openImport = () => { closePresetPop(); $("importDlg").hidden = false; $("importText").focus(); };
const closeImport = () => { $("importDlg").hidden = true; };
$("importApo").addEventListener("click", openImport);
$("importCancel").addEventListener("click", closeImport);
$("importFileBtn").addEventListener("click", () => $("importFile").click());
let importFileName = "";
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  importFileName = file.name.replace(/\.[^.]+$/, "").replace(/\s*ParametricEQ$/i, "").trim();
  $("importText").value = (await file.text()).slice(0, 20000);
  e.target.value = "";
});
$("importOk").addEventListener("click", () => {
  const r = eqFromApo($("importText").value, eq);
  if (!r) { setStatus(t("importNone"), "error"); return; }
  const locked = eq.bypass;
  eq = r.eq;
  eq.bypass = locked;
  activePreset = "";
  selIdx = 0;
  suggestedName = importFileName;
  importFileName = "";
  $("importText").value = "";
  closeImport();
  renderPresets();
  changed({ structure: true, keepPreset: true });
  setStatus(r.count < r.total ? t("importPartial", r.count, r.total) : t("importDone", r.count), r.count < r.total ? "warn" : "info");
});
$("exportApo").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(eqToApo(eq));
    closePresetPop();
    setStatus(t("exportDone"));
  } catch (e) {
    setStatus(String(e?.message || e), "error");
  }
});

// ---------- per-site memory (📌) ----------

function syncPin() {
  const b = $("sitePin");
  b.disabled = !tabHost;
  const on = !!(tabHost && sites[tabHost]);
  b.setAttribute("aria-pressed", String(on));
  b.title = !tabHost ? t("siteNA") : t(on ? "siteRemembered" : "siteRemember", tabHost);
}
$("sitePin").addEventListener("click", async () => {
  if (!tabHost) return;
  if (sites[tabHost]) {
    delete sites[tabHost];
    setStatus(t("siteOff", tabHost));
  } else {
    sites[tabHost] = { eq, activePreset };
    setStatus(t("siteOn", tabHost));
  }
  await chrome.storage.local.set({ sites });
  syncPin();
});

// ---------- preamp: fader + field + meter ----------

const fader = new Fader($("fader"), {
  min: -12, max: 12, def: 0, ticks: [12, 6, 0, -6, -12],
  onChange: (v) => { eq.preamp = v; changed(); }
});
const preampCtl = new ValueControl({
  knob: false, min: -12, max: 12, def: 0, decimals: 1, format: fmtGain, label: t("preamp"),
  onChange: (v) => { eq.preamp = v; changed(); }
});
$("preampField").append(preampCtl.el);
const meter = new Meter($("meter"), $("clip"));

function syncGlobal() {
  fader.set(eq.preamp);
  preampCtl.set(eq.preamp);
  $("limiter").checked = eq.limiter;
  $("addBand").disabled = eq.bands.length >= EQ_MAX_BANDS;
}
$("limiter").addEventListener("change", (e) => { eq.limiter = e.target.checked; changed(); });
$("resetAll").addEventListener("click", () => {
  eq.preamp = 0;
  eq.bands.forEach((b) => { b.gain = 0; });
  changed();
});

// ---------- A/B ----------
// Hold = listen without EQ. Shift+click = lock/unlock the bypass. Click with bypass locked = unlock.

function syncAB() {
  const b = $("ab");
  b.classList.toggle("bypassed", isBypassed());
  b.classList.toggle("locked", eq.bypass);
  b.title = t(eq.bypass ? "abLockedTitle" : "abHoldTitle");
}
$("ab").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (e.shiftKey || eq.bypass) {
    eq.bypass = !eq.bypass;
    changed({ keepPreset: true });
    return;
  }
  abHold = true;
  $("ab").setPointerCapture(e.pointerId);
  syncAB(); draw(); sendLive();
});
const releaseAB = () => {
  if (!abHold) return;
  abHold = false;
  syncAB(); draw(); sendLive();
};
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) $("ab").addEventListener(ev, releaseAB);
$("ab").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); eq.bypass = !eq.bypass; changed({ keepPreset: true }); }
});

// ---------- mode: graphic / parametric, advanced view ----------

function syncMode() {
  const graphic = isGraphic();
  const adv = advanced && !graphic; // the advanced view applies only to parametric
  document.body.classList.toggle("graphic", graphic);
  const wasAdv = document.body.classList.contains("adv");
  document.body.classList.toggle("adv", adv);
  $("advanced").hidden = !adv;
  $("bandEdit").hidden = adv; // the list already contains all the bands
  $("modeBtn").setAttribute("aria-expanded", String(adv));
  $("modeGraphic").setAttribute("aria-pressed", String(graphic));
  $("modeParam").setAttribute("aria-pressed", String(!graphic));
  if (adv) fitList(); // rows can be measured only when the list is visible
  if (adv !== wasAdv || W !== canvas.clientWidth || H !== canvas.clientHeight) resize();
}
$("modeBtn").addEventListener("click", () => {
  advanced = !advanced;
  syncMode();
  draw();
  chrome.storage.local.set({ ui: { advanced } });
});
// A single equalizer, two ways to edit it: when switching from one mode to the other the curve
// is transferred (see eqSwitchMode). From parametric to graphic it may be approximated: the user is warned.
function switchMode(mode) {
  if (eq.mode === mode) return;
  const r = eqSwitchMode(eq, mode);
  eq = r.eq;
  selIdx = 0;
  changed({ structure: true, keepPreset: true });
  if (r.approxDb >= 1) setStatus(t("approxWarn", r.approxDb.toFixed(1)), "warn");
}
$("modeGraphic").addEventListener("click", () => switchMode("graphic"));
$("modeParam").addEventListener("click", () => switchMode("parametric"));

// Touching the sliders makes the curve "graphic": the original parametric bands no longer apply.
function graphicEdited() { delete eq.paramBackup; }
$("resetGraphic").addEventListener("click", () => {
  eq.graphic = eq.graphic.map(() => 0);
  graphicEdited();
  changed();
});

// ---------- graphic mode: 10 sliders ----------

const gcols = GRAPHIC_FREQS.map((f, i) => {
  const col = document.createElement("div");
  col.className = "gcol";
  const val = document.createElement("div");
  val.className = "gval";
  const host = document.createElement("div");
  const lab = document.createElement("div");
  lab.className = "gfreq";
  lab.textContent = fmtF(f);
  col.append(val, host, lab);
  $("gbank").append(col);
  col.style.setProperty("--c", GRAPHIC_COLORS[i]);
  const fd = new Fader(host, {
    min: -GRAPHIC_MAX, max: GRAPHIC_MAX, def: 0, compact: true, fill: true, marks: { step: 3 },
    onChange: (v) => { eq.graphic[i] = v; graphicEdited(); changed(); }
  });
  host.title = `${fmtF(f)} Hz`;
  return { fd, val };
});
function syncGraphic() {
  gcols.forEach(({ fd, val }, i) => {
    const v = eq.graphic[i];
    fd.set(v);
    val.textContent = (v > 0 ? "+" : "") + v.toFixed(1);
    val.classList.toggle("zero", v === 0);
  });
}

// ---------- parametric: bands ----------

function addBand() {
  if (eq.bands.length >= EQ_MAX_BANDS) return;
  // new band at the "emptiest" point of the spectrum
  const used = eq.bands.map((b) => Math.log10(b.freq)).sort((a, b) => a - b);
  const pts = [Math.log10(FREQ_MIN), ...used, Math.log10(FREQ_MAX)];
  let best = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > pts[best + 1] - pts[best]) best = i - 1;
  const freq = Math.round(Math.pow(10, (pts[best] + pts[best + 1]) / 2));
  eq.bands.push(eqBand("peaking", freq, 0, 1));
  selIdx = eq.bands.length - 1;
  changed({ structure: true });
}
function removeBand(i) {
  if (eq.bands.length <= 1 || !eq.bands[i]) return;
  eq.bands.splice(i, 1);
  if (selIdx >= i && selIdx > 0) selIdx--;
  changed({ structure: true });
}
$("addBand").addEventListener("click", addBand);

function editBand(i, key, value) {
  const b = eq.bands[i];
  if (!b) return;
  if (key === "type") {
    const wasQDb = EQ_Q_DB_TYPES.includes(b.type);
    b.type = value;
    if (wasQDb !== EQ_Q_DB_TYPES.includes(b.type)) b.q = wasQDb ? 1 : 0; // different Q unit
  } else b[key] = value;
  eq = eqSanitize(eq);
  changed();
}

function select(i) {
  if (i === selIdx || !eq.bands[i]) return;
  selIdx = i;
  syncBands();
  draw();
}

// Response shape of each filter type (24×24, stroke only).
const TYPE_ICONS = {
  peaking:   "M2 15h4c3 0 4-9 6-9s3 9 6 9h4",          // flat shoulders, bump upward
  lowshelf:  "M2 7h5c4 0 5 10 9 10h6",
  highshelf: "M2 17h6c4 0 5-10 9-10h5",
  lowpass:   "M2 7h9c4 0 6 4 9 13",
  highpass:  "M4 20c3-9 5-13 9-13h9",
  notch:     "M2 7h7.5L12 19l2.5-12H22",                // flat on top, narrow "V" downward
  bandpass:  "M2 20h3c3 0 5-14 7-14s4 14 7 14h3"        // starts and ends low
}
const typeIcon = (k) =>
  `<svg viewBox="0 0 24 24"><path d="${TYPE_ICONS[k]}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICON_POWER = '<svg viewBox="0 0 24 24"><path d="M12 3v8M6.4 6.9a8 8 0 1 0 11.2 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Control row of a band: type, frequency, gain, Q, on/off, trash.
class BandControls {
  constructor(index, { numbered = false } = {}) {
    this.i = index;
    const row = this.el = document.createElement("div");
    row.className = "band-row";
    if (numbered) {
      this.num = document.createElement("span");
      this.num.className = "num-chip";
      row.append(this.num);
    }
    // filter type: one button per type, with the shape icon and an explanation in the tooltip
    const wrap = document.createElement("div");
    wrap.className = "type-seg";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", t("filterType"));
    this.typeBtns = EQ_TYPES.map((k) => {
      const b = document.createElement("button");
      b.className = "type-btn";
      b.innerHTML = typeIcon(k);
      b.title = `${TYPE_LABELS[k]} — ${t("typeHint_" + k)}`;
      b.setAttribute("aria-label", TYPE_LABELS[k]);
      b.addEventListener("click", () => { if (eq.bands[this.i]?.type !== k) editBand(this.i, "type", k); });
      wrap.append(b);
      return b;
    });

    const grab = () => select(this.i);
    this.freq = new ValueControl({
      min: FREQ_MIN, max: FREQ_MAX, scale: "log", def: 1000, decimals: 0, format: fmtFreq, parse: parseFreq,
      label: t("frequency"), title: t("frequency"), onGrab: grab, onChange: (v) => editBand(this.i, "freq", v)
    });
    this.gain = new ValueControl({
      min: -an.gainRange, max: an.gainRange, def: 0, decimals: 1, bipolar: true, format: fmtGain,
      label: t("gain"), title: t("gain"), onGrab: grab, onChange: (v) => editBand(this.i, "gain", v)
    });
    this.q = new ValueControl({
      min: 0.1, max: 30, scale: "log", def: 1, decimals: 2, unit: "Q",
      label: "Q", title: t("qTitle"), onGrab: grab, onChange: (v) => editBand(this.i, "q", v)
    });

    this.on = document.createElement("button");
    this.on.className = "icon-btn small on-btn";
    this.on.innerHTML = ICON_POWER;
    this.on.addEventListener("click", () => editBand(this.i, "on", !eq.bands[this.i].on));
    this.del = document.createElement("button");
    this.del.className = "icon-btn small del-btn";
    this.del.title = t("removeBand");
    this.del.innerHTML = ICON_TRASH;
    this.del.addEventListener("click", () => removeBand(this.i));

    const grow = document.createElement("span");
    grow.className = "grow";
    row.append(wrap, this.freq.el, this.gain.el, this.q.el, grow, this.on, this.del);
    row.addEventListener("pointerdown", grab, true);
    this.update();
  }

  update() {
    const b = eq.bands[this.i];
    if (!b) return;
    const color = bandColor(this.i);
    this.el.style.setProperty("--c", color);
    this.el.style.setProperty("--kc", color);
    this.el.classList.toggle("off", !b.on);
    this.el.classList.toggle("sel", this.i === selIdx);
    if (this.num) this.num.textContent = String(this.i + 1);
    EQ_TYPES.forEach((k, n) => this.typeBtns[n].setAttribute("aria-pressed", String(k === b.type)));

    this.freq.set(b.freq);
    this.gain.configure({ min: -an.gainRange, max: an.gainRange });
    this.gain.set(b.gain);
    this.gain.setDisabled(!EQ_GAIN_TYPES.includes(b.type));
    const qDb = EQ_Q_DB_TYPES.includes(b.type);
    this.q.configure(qDb
      ? { min: -10, max: 20, scale: "lin", def: 0, decimals: 1, bipolar: true }
      : { min: 0.1, max: 30, scale: "log", def: 1, decimals: 2, bipolar: false });
    this.q.set(b.q);
    this.q.setDisabled(!EQ_Q_TYPES.includes(b.type));

    this.on.setAttribute("aria-pressed", String(b.on));
    this.on.title = t(b.on ? "bandOff" : "bandOn");
    this.del.disabled = eq.bands.length <= 1;
  }
}

// bar below the graph: chips + editor of the selected band
const editor = new BandControls(0);
$("bandEdit").append(editor.el);

function renderChips() {
  const box = $("chips");
  box.replaceChildren();
  box.classList.toggle("many", eq.bands.length >= 8); // slightly smaller chips: the row stays on a single line
  eq.bands.forEach((_, i) => {
    const c = document.createElement("button");
    c.className = "band-chip";
    c.textContent = String(i + 1);
    c.style.setProperty("--c", bandColor(i));
    c.addEventListener("click", () => select(i));
    box.append(c);
  });
  const add = document.createElement("button");
  add.className = "add-chip";
  add.title = t("addBandTitle");
  add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  add.addEventListener("click", addBand);
  box.append(add);
}

// full list (advanced view)
let listControls = [];
function renderBandList() {
  listControls = eq.bands.map((_, i) => new BandControls(i, { numbered: true }));
  $("bandList").replaceChildren(...listControls.map((c) => c.el));
  fitList();
}

// The list shows at most 5 rows (actually measured), beyond that it scrolls.
const LIST_ROWS = 5;
function fitList() {
  const row = $("bandList").querySelector(".band-row");
  if (row?.offsetHeight) $("bandList").style.maxHeight = row.offsetHeight * LIST_ROWS + "px";
}

function syncBands() {
  $("chips").querySelectorAll(".band-chip").forEach((c, i) => {
    const b = eq.bands[i];
    if (!b) return;
    c.classList.toggle("sel", i === selIdx);
    c.classList.toggle("off", !b.on);
    c.title = t(b.on ? "bandChip" : "bandChipOff", i + 1, TYPE_LABELS[b.type], fmtF(b.freq));
  });
  const addChip = $("chips").querySelector(".add-chip");
  if (addChip) addChip.disabled = eq.bands.length >= EQ_MAX_BANDS;
  editor.i = selIdx;
  editor.update();
  for (const c of listControls) c.update();
}

// ---------- graph ----------

const canvas = $("graph");
const g = canvas.getContext("2d");
const PAD = 14;
let W = 0, H = 0;
const offline = new OfflineAudioContext(1, 128, 48000);

// The EQ curve and the spectrum use horizontally equidistant points.
const N_POINTS = 300;
let curveFreqs = new Float32Array(N_POINTS);
const mag = new Float32Array(N_POINTS), phase = new Float32Array(N_POINTS);
let specN = 512;

const xOf = (f) => W * posOf(f, an.scale);
const fOf = (x) => freqAt(Math.min(1, Math.max(0, x / W)), an.scale);
const yOf = (db) => H / 2 - (db / an.gainRange) * (H / 2 - PAD);
const dbOf = (y) => ((H / 2 - y) / (H / 2 - PAD)) * an.gainRange;

function updateAxes() {
  curveFreqs = curveFreqs.map((_, i) => freqAt(i / (N_POINTS - 1), an.scale));
}

function resize() {
  const dpr = devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  specN = Math.max(64, Math.min(2048, Math.round(W))); // one point per pixel
  meter.resize();
}

function bandResponseDb(b, out) {
  const f = offline.createBiquadFilter();
  f.type = b.type; f.frequency.value = b.freq; f.gain.value = b.gain; f.Q.value = b.q;
  f.getFrequencyResponse(curveFreqs, mag, phase);
  for (let i = 0; i < N_POINTS; i++) out[i] += 20 * Math.log10(Math.max(mag[i], 1e-6));
}

// Draggable points of the graph for the active mode.
//   graphic: 10 points fixed in frequency, move only vertically
//   parametric: one point per band, colored
function graphPoints() {
  return isGraphic()
    // in graphic mode the points sit on the curve: slider value + preamp (except in bypass, where the curve is flat)
    ? GRAPHIC_FREQS.map((f, i) => ({ freq: f, gain: eq.graphic[i], offset: isBypassed() ? 0 : eq.preamp, hasGain: true, on: true, color: GRAPHIC_COLORS[i], label: "" }))
    : eq.bands.map((b, i) => ({ freq: b.freq, gain: b.gain, hasGain: EQ_GAIN_TYPES.includes(b.type), on: b.on,
        color: bandColor(i), label: String(i + 1), q: b.q, hasQ: EQ_Q_TYPES.includes(b.type) }));
}
function pointY(pt) {
  const y = yOf((pt.hasGain ? pt.gain : 0) + (pt.offset || 0));
  return Math.min(H - 6, Math.max(6, y));
}

function label(text, x, y) {
  g.font = "11px system-ui, sans-serif";
  const tw = g.measureText(text).width;
  const lx = Math.min(W - tw - 10, Math.max(2, x));
  g.fillStyle = D.label;
  g.beginPath(); g.roundRect(lx, y, tw + 10, 18, 5); g.fill();
  g.fillStyle = D.fg;
  g.fillText(text, lx + 5, y + 13);
}

let focusIdx = -1; // band whose field has focus (highlighted in the graph)
document.addEventListener("focusin", (e) => {
  const row = e.target.closest?.(".band-row");
  focusIdx = row ? (row === editor.el ? editor.i : listControls.findIndex((c) => c.el === row)) : -1;
});
document.addEventListener("focusout", (e) => {
  if (!e.relatedTarget?.closest?.(".band-row")) focusIdx = -1;
});

function draw() {
  g.clearRect(0, 0, W, H);
  g.font = "10px system-ui, sans-serif";
  g.lineWidth = 1;

  // frequency grid
  g.fillStyle = D.text;
  const vline = (f, color) => {
    const x = Math.round(xOf(f)) + 0.5;
    g.strokeStyle = color;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    return x;
  };
  if (an.scale === "linear") {
    for (let f = 2000; f < FREQ_MAX; f += 2000) g.fillText(fmtF(f), vline(f, D.grid) + 3, H - 4);
  } else {
    // classic logarithmic grid: 1…9 per decade, decades marked, labels on 1-2-5
    for (let decade = 10; decade <= 10000; decade *= 10) {
      for (let m = 1; m <= 9; m++) {
        const f = m * decade;
        if (f < FREQ_MIN || f > FREQ_MAX) continue;
        const x = vline(f, m === 1 ? D.major : D.grid);
        if ((m === 1 || m === 2 || m === 5) && f > FREQ_MIN) g.fillText(fmtF(f), x + 3, H - 4);
      }
    }
  }
  const r = an.gainRange;
  for (const db of [-r, -r / 2, r / 2, r]) {
    const y = Math.round(yOf(db)) + 0.5;
    g.strokeStyle = D.grid;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillText((db > 0 ? "+" : "") + db, 4, y - 3);
  }
  g.strokeStyle = D.zero;
  g.beginPath(); g.moveTo(0, Math.round(yOf(0)) + 0.5); g.lineTo(W, Math.round(yOf(0)) + 0.5); g.stroke();

  drawSpectrum();

  // curves: the overall one always; those of individual filters only in parametric
  const bypassed = isBypassed();
  const graphic = isGraphic();
  const total = new Float32Array(N_POINTS).fill(bypassed ? 0 : eq.preamp);
  const sel = graphic ? -1 : dragIdx >= 0 ? dragIdx : hoverIdx >= 0 ? hoverIdx : focusIdx >= 0 ? focusIdx : selIdx;
  const yClamp = (db) => yOf(Math.max(-r * 1.4, Math.min(r * 1.4, db)));
  const y0 = yOf(0);
  const trace = (resp) => {
    g.beginPath();
    for (let k = 0; k < N_POINTS; k++) {
      const x = (k / (N_POINTS - 1)) * W;
      k ? g.lineTo(x, yClamp(resp[k])) : g.moveTo(x, yClamp(resp[k]));
    }
  };
  eqActiveBands(eq).forEach((b, i) => {
    if (!b.on) return;
    const resp = new Float32Array(N_POINTS);
    bandResponseDb(b, resp);
    if (!bypassed) for (let k = 0; k < N_POINTS; k++) total[k] += resp[k];
    if (graphic) return;

    const color = bandColor(i);
    const selected = i === sel;
    if (selected) {
      // area between the filter curve and 0 dB: makes the width (Q) evident
      trace(resp);
      g.lineTo(W, y0); g.lineTo(0, y0); g.closePath();
      g.fillStyle = color; g.globalAlpha = bypassed ? 0.06 : 0.15; g.fill();
    }
    trace(resp);
    g.strokeStyle = color;
    g.lineWidth = selected ? 1.6 : 1;
    g.globalAlpha = (selected ? 0.95 : 0.45) * (bypassed ? 0.4 : 1);
    g.stroke();
    g.globalAlpha = 1;
  });
  lastTotal = total;

  g.beginPath();
  for (let i = 0; i < N_POINTS; i++) {
    const x = (i / (N_POINTS - 1)) * W, y = yClamp(total[i]);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.strokeStyle = D.curve; g.lineWidth = 2;
  g.globalAlpha = bypassed ? 0.3 : 1;
  if (!bypassed) { g.shadowColor = D.curveGlow; g.shadowBlur = 3; } // barely hinted glow
  g.stroke();
  g.shadowBlur = 0; g.globalAlpha = 1;

  // points
  graphPoints().forEach((pt, i) => {
    const x = xOf(pt.freq), y = pointY(pt);
    const big = i === dragIdx || i === hoverIdx || i === sel;
    g.globalAlpha = pt.on && !bypassed ? 1 : 0.35;
    g.fillStyle = pt.color;
    g.beginPath(); g.arc(x, y, graphic ? (big ? 6.5 : 5) : big ? 8.5 : 7, 0, Math.PI * 2); g.fill();
    if (i === sel || (graphic && big)) { g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke(); }
    if (pt.label) {
      g.fillStyle = "#111"; g.font = "bold 9px system-ui, sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(pt.label, x, y + 0.5);
      g.textAlign = "start"; g.textBaseline = "alphabetic";
    }
  });
  g.globalAlpha = 1;

  if (bypassed) {
    // label at bottom center (the crosshair is at the top), with the volume compensation if active
    const m = matchNow != null && capturing ? (matchNow > 0 ? "+" : "") + matchNow.toFixed(1) : null;
    const text = m != null
      ? t(eq.bypass ? "bypassTagMatched" : "abTagMatched", m)
      : t(eq.bypass ? "bypassTag" : "abTag");
    g.font = "bold 10.5px system-ui, sans-serif";
    const tw = g.measureText(text).width;
    g.fillStyle = "#f08a24";
    g.beginPath(); g.roundRect(W / 2 - tw / 2 - 8, H - 40, tw + 16, 18, 9); g.fill();
    g.fillStyle = "#fff"; g.textAlign = "center";
    g.fillText(text, W / 2, H - 27);
    g.textAlign = "start";
  }

  // label of the active point or crosshair
  const li = dragIdx >= 0 ? dragIdx : hoverIdx;
  const pts = graphPoints();
  if (li >= 0 && pts[li]) {
    const pt = pts[li];
    let text = `${fmtF(pt.freq)} Hz`;
    if (pt.hasGain) text += ` · ${pt.gain > 0 ? "+" : ""}${pt.gain.toFixed(1)} dB`;
    if (pt.hasQ) text += ` · Q ${pt.q.toFixed(2)}`;
    g.font = "11px system-ui, sans-serif";
    const tw = g.measureText(text).width;
    const py = pointY(pt);
    label(text, xOf(pt.freq) - tw / 2 - 5, py < 40 ? py + 14 : py - 32);
  } else if (hoverX >= 0) {
    drawCrosshair();
  }
}

// ---------- analyzer ----------

let lastTotal = null;
const specRange = () => DB_RANGES[an.dbRange];
const ySpec = (db) => { const [mn, mx] = specRange(); return H - ((db - mn) / (mx - mn)) * H; };
const validSpec = (arr) => Array.isArray(arr) && arr.length === specN;

function specPath(arr, close) {
  const step = W / (arr.length - 1);
  g.beginPath();
  let px = 0, py = ySpec(arr[0]);
  g.moveTo(px, py);
  for (let i = 1; i < arr.length; i++) {
    const x = i * step, y = ySpec(arr[i]);
    g.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
    px = x; py = y;
  }
  g.lineTo(px, py);
  if (close) { g.lineTo(W, H); g.lineTo(0, H); g.closePath(); }
}

function drawSpectrum() {
  if (!(view.pre || view.post || view.peak)) return;
  if (!capturing) {
    g.fillStyle = D.text; g.font = "12px system-ui, sans-serif"; g.textAlign = "center";
    g.fillText(t("noSpectrum"), W / 2, H / 2 + 34);
    g.textAlign = "start";
    return;
  }
  const [mn] = specRange();
  const stepDb = an.dbRange === 60 ? 10 : 20;
  g.fillStyle = D.text; g.font = "10px system-ui, sans-serif"; g.textAlign = "right";
  for (let db = -stepDb; db > mn + stepDb / 2; db -= stepDb) g.fillText(String(db), W - 4, ySpec(db) - 2);
  g.fillText("dBFS", W - 4, PAD - 2);
  g.textAlign = "start";

  if (validSpec(spec?.pre) && view.pre) {
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, D.preA); grad.addColorStop(1, D.preB);
    g.fillStyle = grad; g.globalAlpha = 0.38;
    specPath(spec.pre, true); g.fill();
    g.globalAlpha = 1;
  }
  if (validSpec(spec?.post) && view.post) {
    g.fillStyle = D.post; g.globalAlpha = 0.1;
    specPath(spec.post, true); g.fill();
    g.globalAlpha = 0.9; g.strokeStyle = D.post; g.lineWidth = 1.4;
    specPath(spec.post, false); g.stroke();
    g.globalAlpha = 1;
  }
  if (validSpec(peak) && view.peak) {
    g.strokeStyle = D.peak; g.lineWidth = 1; g.globalAlpha = 0.9;
    specPath(peak, false); g.stroke();
    g.globalAlpha = 1;
  }
}

function drawCrosshair() {
  const f = fOf(hoverX);
  const x = Math.round(hoverX) + 0.5;
  g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = 1; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  g.setLineDash([]);

  const tt = Math.min(1, Math.max(0, hoverX / W));
  const parts = [`${fmtF(f)} Hz`];
  if (lastTotal) {
    const v = lastTotal[Math.round(tt * (N_POINTS - 1))];
    parts.push(`EQ ${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`);
  }
  const si = Math.round(tt * (specN - 1));
  const [mn] = specRange();
  const lvl = (v) => (v <= mn ? "—" : `${v.toFixed(0)} dB`);
  if (capturing && validSpec(spec?.pre) && view.pre) parts.push(`pre ${lvl(spec.pre[si])}`);
  if (capturing && validSpec(spec?.post) && view.post) parts.push(`post ${lvl(spec.post[si])}`);
  if (capturing && validSpec(peak) && view.peak) parts.push(`${t("xhPeak")} ${lvl(peak[si])}`);

  const text = parts.join(" · ");
  g.font = "11px system-ui, sans-serif";
  const tw = g.measureText(text).width;
  label(text, hoverX + tw + 20 < W ? hoverX + 6 : hoverX - tw - 16, 4);
}

function updatePeak(pre) {
  if (!validSpec(peak)) { peak = pre.slice(); return; }
  for (let i = 0; i < pre.length; i++) if (pre[i] > peak[i]) peak[i] = pre[i];
}

// On every frame asks the audio engine for the spectrum (if not paused), levels and A/B compensation.
async function loop() {
  if (!capturing) { loopRunning = false; meter.reset(); draw(); return; }
  const wantPre = !paused && (view.pre || view.peak);
  const wantPost = !paused && view.post;
  try {
    const r = await send({
      target: "offscreen", cmd: "spectrum", tabId, pre: wantPre, post: wantPost, meter: true,
      fft: an.fft, smoothing: an.smoothing, scale: an.scale, n: specN
    });
    if (r) {
      if (!paused) spec = r;
      meter.update(r.meter);
      matchNow = r.matchDb ?? null;
      if (r.sampleRate && r.sampleRate !== sampleRate) { sampleRate = r.sampleRate; syncAnalyzerInfo(); }
      if (!paused && view.peak && validSpec(r.pre)) updatePeak(r.pre);
    }
  } catch { /* engine unreachable: retry on the next frame */ }
  draw();
  requestAnimationFrame(loop);
}
function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  requestAnimationFrame(loop);
}

// display legend
function syncView() {
  $("viewPre").setAttribute("aria-pressed", String(view.pre));
  $("viewPost").setAttribute("aria-pressed", String(view.post));
  $("viewPeak").setAttribute("aria-pressed", String(view.peak));
  $("resetPeak").hidden = !view.peak;
  $("pause").setAttribute("aria-pressed", String(paused));
}
for (const [id, key] of [["viewPre", "pre"], ["viewPost", "post"], ["viewPeak", "peak"]]) {
  $(id).addEventListener("click", () => {
    view[key] = !view[key];
    if (key === "peak" && view.peak) peak = null;
    syncView();
    chrome.storage.local.set({ view });
    draw();
  });
}
$("resetPeak").addEventListener("click", () => { peak = null; draw(); });
$("pause").addEventListener("click", () => { paused = !paused; syncView(); });

// ---------- settings (panel behind the gear) ----------

$("matchAB").addEventListener("change", (e) => {
  prefs.matchAB = e.target.checked;
  chrome.storage.local.set({ prefs });
  sendLive();
});

for (const n of FFT_SIZES) $("anFft").add(new Option(t("fftBins", n), n));
const smoothingCtl = new ValueControl({
  knob: false, min: 0, max: 1, def: ANALYZER_DEFAULTS.smoothing, decimals: 2, label: "Smoothing",
  title: t("anSmoothingTitle"),
  onChange: (v) => { an.smoothing = v; analyzerChanged(false); }
});
$("anSmoothing").append(smoothingCtl.el);

function syncAnalyzerInfo() {
  const sr = sampleRate || 48000;
  $("anInfo").textContent = (sampleRate ? "" : "≈ ") +
    t("anInfo", sr, (sr / an.fft).toFixed(2), ((an.fft / sr) * 1000).toFixed(0));
}

function syncAnalyzer() {
  $("anFft").value = an.fft;
  $("anScale").value = an.scale;
  $("anDbRange").value = an.dbRange;
  $("anGainRange").value = an.gainRange;
  smoothingCtl.set(an.smoothing);
  $("matchAB").checked = prefs.matchAB;
  syncAnalyzerInfo();
}

function analyzerChanged(resetPeak) {
  an = analyzerSanitize(an);
  if (resetPeak) peak = null;
  updateAxes();
  syncAnalyzer();
  syncBands();
  chrome.storage.local.set({ analyzer: an });
  draw();
}

$("anFft").addEventListener("change", (e) => { an.fft = Number(e.target.value); analyzerChanged(true); });
$("anScale").addEventListener("change", (e) => { an.scale = e.target.value; analyzerChanged(true); });
$("anDbRange").addEventListener("change", (e) => { an.dbRange = Number(e.target.value); analyzerChanged(false); });
$("anGainRange").addEventListener("change", (e) => { an.gainRange = Number(e.target.value); analyzerChanged(false); });
$("anDefaults").addEventListener("click", () => { an = { ...ANALYZER_DEFAULTS }; analyzerChanged(true); });

const setPanel = (open) => {
  $("anPanel").hidden = !open;
  $("gear").setAttribute("aria-expanded", String(open));
  $("gear").setAttribute("aria-pressed", String(open));
};
$("gear").addEventListener("click", () => setPanel($("anPanel").hidden));

document.addEventListener("pointerdown", (e) => {
  if (!$("anPanel").hidden && !$("anPanel").contains(e.target) && !$("gear").contains(e.target)) setPanel(false);
  if (!$("presetPop").hidden && !$("presetPop").contains(e.target) &&
      !$("savePresetBtn").contains(e.target)) closePresetPop();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { setPanel(false); closePresetPop(); closeImport(); }
});

// ---------- graph interaction ----------

let dragIdx = -1, hoverIdx = -1;

function hit(e) {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let best = -1, bestD = 12;
  graphPoints().forEach((pt, i) => {
    const d = Math.hypot(xOf(pt.freq) - mx, pointY(pt) - my);
    if (d < bestD) { bestD = d; best = i; }
  });
  return { i: best, mx, my };
}

// Relative dragging: the point moves as much as the mouse (¼ with Shift held).
// In graphic mode the points move only vertically.
let drag = null;

canvas.addEventListener("pointerdown", (e) => {
  const { i, mx, my } = hit(e);
  if (i < 0) return;
  dragIdx = i;
  if (!isGraphic()) selIdx = i;
  const pt = graphPoints()[i];
  drag = { vx: xOf(pt.freq), vy: yOf((pt.hasGain ? pt.gain : 0) + (pt.offset || 0)), lastX: mx, lastY: my, offset: pt.offset || 0 };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
  syncBands();
  draw();
});
canvas.addEventListener("pointermove", (e) => {
  const { i, mx, my } = hit(e);
  if (dragIdx < 0) {
    hoverX = mx;
    if (i !== hoverIdx) { hoverIdx = i; canvas.style.cursor = i >= 0 ? (isGraphic() ? "ns-resize" : "grab") : "crosshair"; }
    if (!loopRunning) draw();
    return;
  }
  const k = e.shiftKey ? FINE_FACTOR : 1;
  const lim = isGraphic() ? Math.min(GRAPHIC_MAX, an.gainRange) : an.gainRange;
  drag.vx = Math.min(W, Math.max(0, drag.vx + (mx - drag.lastX) * k));
  drag.vy = Math.min(yOf(-lim + drag.offset), Math.max(yOf(lim + drag.offset), drag.vy + (my - drag.lastY) * k));
  drag.lastX = mx; drag.lastY = my;
  if (isGraphic()) {
    eq.graphic[dragIdx] = Math.round((dbOf(drag.vy) - drag.offset) * 10) / 10; // vertical only
    graphicEdited();
  } else {
    const b = eq.bands[dragIdx];
    b.freq = Math.round(Math.min(FREQ_MAX, Math.max(FREQ_MIN, fOf(drag.vx))));
    if (EQ_GAIN_TYPES.includes(b.type)) b.gain = Math.round(dbOf(drag.vy) * 10) / 10;
  }
  changed();
});
const endDrag = () => {
  drag = null;
  if (dragIdx >= 0) { dragIdx = -1; canvas.style.cursor = hoverIdx >= 0 ? "grab" : "crosshair"; draw(); }
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("pointerleave", () => {
  hoverX = -1;
  if (dragIdx < 0) hoverIdx = -1;
  draw();
});

canvas.addEventListener("wheel", (e) => {
  if (e.ctrlKey || isGraphic()) return; // pinch-zoom; in graphic mode Q is fixed
  const { i } = hit(e);
  if (i < 0) return;
  e.preventDefault();
  const b = eq.bands[i];
  if (!EQ_Q_TYPES.includes(b.type)) return;
  const steps = wheelSteps(e); // proportional: no jumps with trackpad and inertia
  if (!steps) return;
  if (EQ_Q_DB_TYPES.includes(b.type)) b.q += steps * (e.shiftKey ? 0.1 : 0.5);
  else b.q *= Math.pow(e.shiftKey ? 1.025 : 1.12, steps);
  selIdx = i;
  eq = eqSanitize(eq);
  changed();
}, { passive: false });

canvas.addEventListener("dblclick", (e) => {
  const { i } = hit(e);
  if (i < 0) return;
  if (isGraphic()) { eq.graphic[i] = 0; graphicEdited(); }
  else if (EQ_GAIN_TYPES.includes(eq.bands[i].type)) eq.bands[i].gain = 0;
  else return;
  changed();
});

// ---------- startup ----------

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : "";
  } catch { return ""; }
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  tabHost = hostOf(tab?.url || ""); // the URL is readable thanks to activeTab

  const stored = await chrome.storage.local.get({
    eq: null, presets: {}, activePreset: "", view: null, analyzer: null, ui: null, sites: {}, prefs: null
  });
  const session = tabId != null ? (await chrome.storage.session.get("tab:" + tabId))["tab:" + tabId] : null;
  sites = stored.sites && typeof stored.sites === "object" ? stored.sites : {};
  prefs = { matchAB: stored.prefs?.matchAB !== false };
  userPresets = stored.presets && typeof stored.presets === "object" ? stored.presets : {};

  // Configuration of this tab, in order of priority:
  // 1. the tab's own (if it's still on the same site, or the site has no memory)
  // 2. the site's memory (📌)
  // 3. the last configuration used
  const site = tabHost ? sites[tabHost] : null;
  const src = session && (session.host === tabHost || !site) ? session
    : site ? site
    : { eq: stored.eq, activePreset: stored.activePreset };
  eq = src.eq ? eqSanitize(src.eq) : eqDefault();
  activePreset = src.activePreset || "";

  if (stored.view && typeof stored.view === "object") {
    view = { pre: stored.view.pre !== false, post: stored.view.post !== false, peak: stored.view.peak === true };
  }
  an = analyzerSanitize(stored.analyzer);
  advanced = stored.ui?.advanced === true;
  if (activePreset.startsWith("b:") && !(activePreset.slice(2) in EQ_BUILTIN_PRESETS)) activePreset = "";

  updateAxes();
  syncMode();
  resize();
  syncView();
  syncAnalyzer();
  renderPresets();
  renderChips();
  renderBandList();
  syncBands();
  syncGraphic();
  syncGlobal();
  syncAB();
  syncPin();
  meter.reset();
  draw();
  flushSave(); // immediately record this tab's configuration

  try {
    const { tabs = [] } = (await send({ target: "sw", cmd: "status" })) || {};
    capturing = tabs.includes(tabId);
    if (capturing) { sendLive(); startLoop(); }
    else if (tabs.length) setStatus(t("otherTabs", tabs.length));
  } catch { /* service worker not ready yet */ }
  renderPower();
})();
