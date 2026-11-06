// Controlli custom in stile plugin audio: manopola + campo valore, fader verticale, meter L/R.
// Gesti comuni: trascina in verticale · rotella · Shift = fine · doppio clic = valore di default.

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const FINE_FACTOR = 0.25;

// Rotella → numero di "passi" (anche frazionari), positivo = verso l'alto.
// Proporzionale al delta: una tacca del mouse (~100 px) = 1 passo, i trackpad con inerzia
// (Mac) producono tanti piccoli delta che diventano frazioni di passo invece di passi interi.
// Ritorna 0 per gli eventi da ignorare: pinch-zoom (Ctrl) e swipe orizzontali senza Shift.
function wheelSteps(e) {
  if (e.ctrlKey) return 0;
  // Shift+rotella su Windows arriva come scroll orizzontale
  const d = e.deltaY || (e.shiftKey ? e.deltaX : 0);
  if (!d) return 0;
  const px = e.deltaMode === 1 ? d * 33 : e.deltaMode === 2 ? d * 300 : d;
  return Math.max(-3, Math.min(3, -px / 100));
}

// ---------------------------------------------------------------------------
// ValueControl: manopola opzionale + campo di testo modificabile + unità.
// opts: min, max, scale ("lin"|"log"), def, decimals, bipolar, knob (bool),
//       format(v) → { text, unit }, parse(text, ctrl) → number|NaN, onChange(v, final)
// ---------------------------------------------------------------------------
class ValueControl {
  constructor(opts) {
    this.o = { scale: "lin", decimals: 1, knob: true, bipolar: false, dragPixels: 180, ...opts };
    this.value = this.o.def ?? this.o.min;
    this.disabled = false;
    this.dirty = false; // true mentre il campo contiene testo digitato e non ancora confermato

    this.el = document.createElement("div");
    this.el.className = "vc";
    if (this.o.knob) {
      this.knob = document.createElement("div");
      this.knob.className = "knob";
      this.knob.innerHTML =
        '<svg viewBox="0 0 32 32"><path class="k-track"/><path class="k-val"/>' +
        '<circle class="k-cap" cx="16" cy="16" r="9"/><line class="k-ptr" x1="16" y1="15.5" x2="16" y2="9.5"/></svg>';
      this.el.append(this.knob);
    }
    this.field = document.createElement("input");
    this.field.type = "text";
    this.field.className = "vf";
    this.field.spellcheck = false;
    this.field.autocomplete = "off";
    this.field.inputMode = "decimal";
    if (this.o.label) this.field.setAttribute("aria-label", this.o.label);
    this.unit = document.createElement("span");
    this.unit.className = "vu";
    this.el.append(this.field, this.unit);
    if (this.o.title) this.el.title = this.o.title;
    this.bind();
    this.render();
  }

  configure(opts) {
    Object.assign(this.o, opts);
    this.value = this.clampV(this.value);
    this.render();
  }
  toNorm(v) {
    const { min, max, scale } = this.o;
    return scale === "log" ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
  }
  fromNorm(n) {
    const { min, max, scale } = this.o;
    n = clamp01(n);
    return scale === "log" ? min * Math.pow(max / min, n) : min + (max - min) * n;
  }
  clampV(v) { return Math.min(this.o.max, Math.max(this.o.min, v)); }
  roundV(v) { const p = Math.pow(10, this.o.decimals); return Math.round(v * p) / p; }

  set(v) { this.value = this.clampV(v); this.render(); }
  setDisabled(d) {
    this.disabled = d;
    this.el.classList.toggle("disabled", d);
    this.field.disabled = d;
  }

  emit(v, final = false) {
    v = this.roundV(this.clampV(v));
    if (v === this.value && !final) return;
    this.value = v;
    this.render();
    this.o.onChange?.(v, final);
  }
  nudge(steps, fine) {
    // un passo = 1% della corsa (0,25% con Shift)
    this.emit(this.fromNorm(this.toNorm(this.value) + steps * (fine ? 0.0025 : 0.01)), true);
  }
  // Come nudge, ma accumula le frazioni: i piccoli delta del trackpad non vengono
  // persi nell'arrotondamento del valore.
  wheel(steps, fine) {
    const now = performance.now();
    if (this.wheelN === undefined || now - this.wheelT > 400 || this.wheelV !== this.value) this.wheelN = this.toNorm(this.value);
    this.wheelT = now;
    this.wheelN = clamp01(this.wheelN + steps * (fine ? 0.0025 : 0.01));
    this.emit(this.fromNorm(this.wheelN), true);
    this.wheelV = this.value;
  }

  text() {
    return this.o.format ? this.o.format(this.value)
      : { text: this.value.toFixed(this.o.decimals), unit: this.o.unit || "" };
  }
  render() {
    const { text, unit } = this.text();
    // il testo segue il valore, tranne quando l'utente ci sta scrivendo (dirty)
    if (!this.dirty) {
      const focused = document.activeElement === this.field;
      this.field.value = text;
      if (focused) this.field.select();
    }
    this.unit.textContent = unit;
    if (this.knob) this.drawKnob();
  }

  drawKnob() {
    const A0 = -135, A1 = 135, R = 13;
    const pt = (a) => {
      const r = (a * Math.PI) / 180;
      return [16 + R * Math.sin(r), 16 - R * Math.cos(r)];
    };
    const arc = (a, b) => {
      if (Math.abs(b - a) < 0.5) return "";
      const [x0, y0] = pt(a), [x1, y1] = pt(b);
      const large = Math.abs(b - a) > 180 ? 1 : 0;
      return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${R} ${R} 0 ${large} ${b > a ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    const ang = (n) => A0 + (A1 - A0) * clamp01(n);
    const aVal = ang(this.toNorm(this.value));
    const aStart = this.o.bipolar ? ang(this.toNorm(0)) : A0;
    this.knob.querySelector(".k-track").setAttribute("d", arc(A0, A1));
    this.knob.querySelector(".k-val").setAttribute("d", aVal >= aStart ? arc(aStart, aVal) : arc(aVal, aStart));
    this.knob.querySelector(".k-ptr").setAttribute("transform", `rotate(${aVal.toFixed(1)} 16 16)`);
  }

  // Applica il testo digitato; se non è stato modificato non fa nulla.
  commitField() {
    if (!this.dirty) return;
    this.dirty = false;
    const txt = this.field.value.trim();
    const v = this.o.parse ? this.o.parse(txt, this) : parseFloat(txt.replace(",", "."));
    if (Number.isFinite(v)) this.emit(v, true);
    else this.render();
  }

  bind() {
    if (this.knob) {
      let drag = null;
      this.knob.addEventListener("pointerdown", (e) => {
        if (this.disabled || e.button !== 0) return;
        e.preventDefault();
        // se il campo ha il focus: conferma l'eventuale testo digitato e lascia il campo
        if (document.activeElement === this.field) { this.commitField(); this.field.blur(); }
        this.knob.setPointerCapture(e.pointerId);
        drag = { y: e.clientY, n: this.toNorm(this.value) };
        this.el.classList.add("active");
        this.o.onGrab?.();
      });
      this.knob.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const dy = drag.y - e.clientY;
        drag.y = e.clientY;
        drag.n = clamp01(drag.n + (dy / this.o.dragPixels) * (e.shiftKey ? FINE_FACTOR : 1));
        this.emit(this.fromNorm(drag.n));
      });
      const end = () => {
        if (!drag) return;
        drag = null;
        this.el.classList.remove("active");
        this.emit(this.value, true);
      };
      this.knob.addEventListener("pointerup", end);
      this.knob.addEventListener("pointercancel", end);
      this.knob.addEventListener("dblclick", () => {
        if (!this.disabled && this.o.def !== undefined) this.emit(this.o.def, true);
      });
    }
    // rotella: sulla manopola sempre; sul campo solo mentre ha il focus,
    // così nelle liste lunghe si può scorrere la pagina passando sopra i valori
    this.el.addEventListener("wheel", (e) => {
      if (this.disabled) return;
      if (!this.knob?.contains(e.target) && document.activeElement !== this.field) return;
      const steps = wheelSteps(e);
      if (e.ctrlKey) return;
      e.preventDefault();
      if (!steps) return;
      this.commitField();
      this.wheel(steps, e.shiftKey);
    }, { passive: false });

    this.field.addEventListener("focus", () => { this.dirty = false; this.field.select(); this.o.onGrab?.(); });
    this.field.addEventListener("input", () => { this.dirty = true; });
    this.field.addEventListener("blur", () => { this.commitField(); this.render(); });
    this.field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { this.commitField(); this.field.blur(); }
      else if (e.key === "Escape") { e.stopPropagation(); this.dirty = false; this.render(); this.field.blur(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        this.commitField(); // se avevi scritto qualcosa, le frecce partono da quel valore
        this.nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Fader verticale con scala. opts: min, max, def, ticks[], onChange(v, final)
// ---------------------------------------------------------------------------
class Fader {
  constructor(host, opts) {
    this.o = { decimals: 1, ...opts };
    this.value = this.o.def ?? 0;
    host.classList.add("fader");
    if (this.o.compact) host.classList.add("compact"); // senza scala: cursori della modalità grafica
    host.innerHTML = '<div class="f-scale"></div><div class="f-track"><div class="f-fill"></div><div class="f-zero"></div><div class="f-cap"></div></div>';
    this.track = host.querySelector(".f-track");
    this.cap = host.querySelector(".f-cap");
    this.fill = host.querySelector(".f-fill");
    if (!this.o.fill) this.fill.remove(), (this.fill = null);
    const scale = host.querySelector(".f-scale");
    for (const t of this.o.ticks || []) {
      const s = document.createElement("span");
      s.textContent = t > 0 ? "+" + t : String(t);
      s.style.top = (1 - this.norm(t)) * 100 + "%";
      scale.append(s);
    }
    host.querySelector(".f-zero").style.top = (1 - this.norm(0)) * 100 + "%";
    // tacche ai lati del binario (opzione marks: { step, major }), dietro al cappuccio
    if (this.o.marks) {
      const { step, major } = this.o.marks;
      for (let v = this.o.min; v <= this.o.max + 1e-9; v += step) {
        if (Math.abs(v) < 1e-9) continue; // lo zero ha già la sua linea
        const tk = document.createElement("div");
        const end = Math.abs(v - this.o.min) < 1e-9 || Math.abs(v - this.o.max) < 1e-9;
        tk.className = "f-tick" + (Math.abs(v) % major < 1e-9 ? " major" : "") + (end ? " end" : "");
        tk.style.top = (1 - this.norm(v)) * 100 + "%";
        this.track.insertBefore(tk, this.cap);
      }
    }
    this.host = host;
    this.bind();
    this.render();
  }
  norm(v) { return (v - this.o.min) / (this.o.max - this.o.min); }
  set(v) { this.value = Math.min(this.o.max, Math.max(this.o.min, v)); this.render(); }
  render() {
    const v = this.norm(this.value), z = this.norm(0);
    this.cap.style.top = (1 - v) * 100 + "%";
    if (this.fill) { // dallo zero al cappuccio: si vede subito quanto si alza o si abbassa
      this.fill.style.top = (1 - Math.max(v, z)) * 100 + "%";
      this.fill.style.height = Math.abs(v - z) * 100 + "%";
    }
  }
  emit(v, final = false) {
    const p = Math.pow(10, this.o.decimals);
    v = Math.round(Math.min(this.o.max, Math.max(this.o.min, v)) * p) / p;
    if (v === this.value && !final) return;
    this.value = v;
    this.render();
    this.o.onChange?.(v, final);
  }
  bind() {
    let drag = null;
    const range = this.o.max - this.o.min;
    this.host.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.host.setPointerCapture(e.pointerId);
      const r = this.track.getBoundingClientRect();
      // clic sulla traccia fuori dal cappuccio: salta lì; sul cappuccio: trascinamento relativo
      if (!this.cap.contains(e.target)) this.emit(this.o.min + (1 - clamp01((e.clientY - r.top) / r.height)) * range);
      drag = { y: e.clientY, v: this.value, h: r.height };
      this.host.classList.add("active");
    });
    this.host.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dy = drag.y - e.clientY;
      drag.y = e.clientY;
      drag.v += (dy / drag.h) * range * (e.shiftKey ? FINE_FACTOR : 1);
      this.emit(drag.v);
    });
    const end = () => { if (drag) { drag = null; this.host.classList.remove("active"); this.emit(this.value, true); } };
    this.host.addEventListener("pointerup", end);
    this.host.addEventListener("pointercancel", end);
    this.host.addEventListener("dblclick", () => this.emit(this.o.def ?? 0, true));
    // rotella proporzionale con accumulo delle frazioni (trackpad)
    let wv, wt = 0;
    this.host.addEventListener("wheel", (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      const steps = wheelSteps(e);
      if (!steps) return;
      const now = performance.now();
      if (wv === undefined || now - wt > 400 || Math.abs(wv - this.value) > 0.051) wv = this.value;
      wt = now;
      wv = Math.min(this.o.max, Math.max(this.o.min, wv + steps * (e.shiftKey ? 0.1 : 0.5)));
      this.emit(wv, true);
    }, { passive: false });
  }
}

// ---------------------------------------------------------------------------
// Meter stereo: picco con decadimento, indicatore del massimo, LED di clip.
// ---------------------------------------------------------------------------
class Meter {
  constructor(canvas, clipEl) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.clipEl = clipEl;
    this.MIN = -48;
    this.lvl = [this.MIN, this.MIN];
    this.hold = [this.MIN, this.MIN];
    this.holdT = [0, 0];
    this.last = performance.now();
    this.clipped = false;
    clipEl.addEventListener("click", () => { this.clipped = false; this.clipEl.classList.remove("on"); });
    this.resize();
  }
  resize() {
    const dpr = devicePixelRatio || 1;
    this.w = this.c.clientWidth; this.h = this.c.clientHeight;
    this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // m = { l: {peak, rms}, r: {peak, rms} } oppure null (silenzio / EQ spento)
  update(m) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const ch = m ? [m.l, m.r] : [null, null];
    ch.forEach((c, i) => {
      const p = c ? c.peak : this.MIN - 10;
      this.lvl[i] = p > this.lvl[i] ? p : Math.max(p, this.lvl[i] - 24 * dt); // attacco istantaneo, rilascio 24 dB/s
      // massimo: resta fermo 1,2 s, poi scende di 18 dB/s
      if (p >= this.hold[i]) { this.hold[i] = p; this.holdT[i] = now; }
      else if (now - this.holdT[i] > 1200) this.hold[i] = Math.max(p, this.hold[i] - 18 * dt);
      if (c && c.peak > -0.3 && !this.clipped) { this.clipped = true; this.clipEl.classList.add("on"); }
    });
    this.draw();
  }
  reset() {
    this.lvl = [this.MIN, this.MIN];
    this.hold = [this.MIN, this.MIN];
    this.draw();
  }
  y(db) { return this.h * (1 - clamp01((db - this.MIN) / -this.MIN)); }
  draw() {
    const { g, w, h } = this;
    g.clearRect(0, 0, w, h);
    const bw = (w - 3) / 2;
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, "#16a34a");
    grad.addColorStop(clamp01((-18 - this.MIN) / -this.MIN), "#22c55e");
    grad.addColorStop(clamp01((-6 - this.MIN) / -this.MIN), "#eab308");
    grad.addColorStop(clamp01((-2 - this.MIN) / -this.MIN), "#f97316");
    grad.addColorStop(1, "#ef4444");
    for (let i = 0; i < 2; i++) {
      const x = i * (bw + 3);
      g.fillStyle = "rgba(255,255,255,0.06)";
      g.fillRect(x, 0, bw, h);
      const y = this.y(this.lvl[i]);
      g.fillStyle = grad;
      g.fillRect(x, y, bw, h - y);
      if (this.hold[i] > this.MIN) {
        g.fillStyle = this.hold[i] > -2 ? "#ef4444" : "#e6e8eb";
        g.fillRect(x, Math.max(0, this.y(this.hold[i]) - 1), bw, 2);
      }
    }
    // tacche ogni 6 dB
    g.fillStyle = "rgba(0,0,0,0.45)";
    for (let db = -6; db > this.MIN; db -= 6) g.fillRect(0, Math.round(this.y(db)), w, 1);
  }
}
