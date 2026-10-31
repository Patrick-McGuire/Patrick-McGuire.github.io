"use strict";

// Element ids carry a bs- prefix in the ITD page, so they cannot clash with the other tabs.
const $ = (id) => document.getElementById("bs-" + id);

/* ---------------- serial ---------------------------------------------- */

let port = null, reader = null, keepReading = false;
let running = false;          // are pulses meant to be on

function setConnected(on) {
  $("dot").classList.toggle("live", on);
  $("conn").textContent = on ? "connected" : "not connected";
  $("connect").textContent = on ? "Disconnect" : "Connect";
  $("on").disabled = $("off").disabled = $("once").disabled = !on;
}

async function send(text) {
  if (!port || !port.writable) return;
  const w = port.writable.getWriter();
  try { await w.write(new TextEncoder().encode(text)); }
  finally { w.releaseLock(); }
}

async function connect() {
  if (port) return disconnect();
  if (!("serial" in navigator)) {
    $("hint").textContent =
      "This browser has no Web Serial. Use Chrome or Edge on desktop.";
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
  } catch (e) {
    port = null;
    $("hint").textContent = e && e.name === "NotFoundError" ? "" : "Could not open: " + e;
    return;
  }
  $("hint").textContent = "";
  setConnected(true);
  await send("s");              // a previous session may have left it pulsing
  setRunning(false);
  keepReading = true;
  readLoop();
}

async function disconnect() {
  keepReading = false;
  try { await send("s"); } catch (e) { /* the port may already be gone */ }
  try { if (reader) await reader.cancel(); } catch (e) { /* already closed */ }
  try { if (port) await port.close(); } catch (e) { /* already closed */ }
  port = null; reader = null;
  setConnected(false);
  setRunning(false);
}

async function readLoop() {
  const dec = new TextDecoder();
  let buf = "";
  while (keepReading && port && port.readable) {
    reader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, i).replace(/\r$/, ""));
          buf = buf.slice(i + 1);
        }
      }
    } catch (e) {
      // a yank of the cable lands here; fall through and let the loop exit
    } finally {
      try { reader.releaseLock(); } catch (e) { /* already released */ }
    }
  }
}

/* ---------------- parsing --------------------------------------------- */

// "#RESULT type=A snr=788.6 mirror=-0.95 ..." -> {type:"A", snr:788.6, ...}
function fields(line) {
  const out = {};
  for (const m of line.matchAll(/([a-z]+)=(\S+)/g)) {
    const n = Number(m[2]);
    out[m[1]] = Number.isNaN(n) ? m[2] : n;
  }
  return out;
}

let wave = null, last = null;

function handleLine(line) {
  if (line.length) log(line);

  if (line.startsWith("#RESULT")) {
    const f = fields(line);
    const bad = line.indexOf("NO VERDICT:");
    f.why = bad >= 0 ? line.slice(bad + 11).trim() : "";
    last = f;
    render();
  } else if (line.startsWith("#WIRING")) {
    const f = fields(line);
    $("s-wiring").textContent = f.forward || "–";
  } else if (line.startsWith("#WAVE,")) {
    wave = line.slice(6).split(",").map(Number);
    drawChart();
    fillTable();
  }
}

function log(line) {
  const el = $("log");
  el.textContent += line + "\n";
  if (el.textContent.length > 60000) el.textContent = el.textContent.slice(-40000);
  el.scrollTop = el.scrollHeight;
}

/* ---------------- readout --------------------------------------------- */

function setRunning(on) {
  running = on;
  $("on").setAttribute("aria-pressed", String(on));
  $("off").setAttribute("aria-pressed", String(!on));
  $("note").textContent = on
    ? "Pulsing. Swap the buzzer and the label follows."
    : "The buzzer is silent while this is OFF.";
}

function render() {
  const v = $("verdict"), f = last;
  if (!f) return;

  const type = f.type === "A" || f.type === "B" ? f.type : "?";
  v.setAttribute("data-type", type);
  $("letter").textContent = type === "?" ? "?" : type;

  if (type === "?") {
    $("sub").textContent = f.why || "No verdict.";
  } else {
    $("sub").textContent = "Sort this one into bin " + type + ".";
  }

  $("s-snr").textContent = f.snr ? Math.round(f.snr) + "×" : "–";
  $("s-mirror").textContent = f.mirror !== undefined ? f.mirror.toFixed(2) : "–";
  $("s-onset").textContent = f.onset !== undefined ? f.onset : "–";
  $("s-agree").textContent = f.same !== undefined ? f.same : "–";

  // The only quality problem the operator can actually fix is the mic being too close: once
  // the clipping reaches the onset there is no shape left to read a sign off.
  const banner = $("banner");
  if (type !== "?" && f.clipfrom !== undefined && f.clipfrom <= f.onset) {
    banner.className = "banner bad";
    $("banner-text").textContent =
      "The mic is pinned at full scale from sample " + f.clipfrom + ", at or before the onset at "
      + f.onset + ". Back the mic away from the hole — this verdict is read off a flat line.";
  } else if (type === "?") {
    banner.className = "banner warn";
    $("banner-text").textContent = f.why || "No verdict.";
  } else {
    banner.className = "banner warn hide";
  }
}

/* ---------------- chart ------------------------------------------------ */

let view = "onset";

function drawChart() {
  const svg = $("svg");
  while (svg.childNodes.length > 1) svg.removeChild(svg.lastChild); // keep <title>
  if (!wave || !wave.length) return;

  const W = 860, H = 260, m = { t: 14, r: 16, b: 30, l: 52 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  // With no verdict there is no onset to mark, and marking sample 0 would imply one.
  const decided = last && (last.type === "A" || last.type === "B");
  const onset = decided && last.onset !== undefined ? last.onset : -1;
  const lo = view === "full" || onset < 0 ? 0 : Math.max(0, onset - 15);
  const hi = view === "full" || onset < 0 ? wave.length : Math.min(wave.length, onset + 45);
  const seg = wave.slice(lo, hi);

  let peak = 1;
  for (const y of seg) peak = Math.max(peak, Math.abs(y));
  peak = peak * 1.12;

  const X = (i) => m.l + ((i - lo) / (hi - 1 - lo)) * pw;
  const Y = (y) => m.t + ph / 2 - (y / peak) * (ph / 2);

  const ns = "http://www.w3.org/2000/svg";
  const el = (n, a) => { const e = document.createElementNS(ns, n);
    for (const k in a) e.setAttribute(k, a[k]); return e; };
  const add = (e) => { svg.appendChild(e); return e; };

  // y gridlines: zero gets the axis colour, the rest recede
  for (const frac of [-1, -0.5, 0, 0.5, 1]) {
    const y = Y(frac * peak / 1.12);
    add(el("line", { x1: m.l, x2: m.l + pw, y1: y, y2: y,
      stroke: frac === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
    const t = add(el("text", { x: m.l - 8, y: y + 4, "text-anchor": "end",
      fill: "var(--muted)", "font-size": 11 }));
    t.textContent = Math.round(frac * peak / 1.12);
  }

  // where the mic ran out of range -- the part of the trace that means nothing
  const full = last && last.full ? last.full : 0;
  if (full && peak / 1.12 > full * 0.85) {
    for (const s of [1, -1]) {
      const y = Y(s * full);
      add(el("line", { x1: m.l, x2: m.l + pw, y1: y, y2: y, stroke: "var(--muted)",
        "stroke-width": 1, "stroke-dasharray": "3 3" }));
    }
    const t = add(el("text", { x: m.l + pw, y: Y(full) - 6, "text-anchor": "end",
      fill: "var(--muted)", "font-size": 11 }));
    t.textContent = "mic at full scale";
  }

  // x ticks
  const step = Math.max(1, Math.round((hi - lo) / 8));
  for (let i = lo; i < hi; i += step) {
    const t = add(el("text", { x: X(i), y: H - 10, "text-anchor": "middle",
      fill: "var(--muted)", "font-size": 11 }));
    t.textContent = i;
  }
  const colour = !decided ? "var(--muted)"
               : last.type === "B" ? "var(--type-b)" : "var(--type-a)";

  // the onset: a hairline plus a direct label, so the sample the verdict came from is visible
  if (onset >= lo && onset < hi) {
    add(el("line", { x1: X(onset), x2: X(onset), y1: m.t, y2: m.t + ph,
      stroke: colour, "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0.6 }));
    const t = add(el("text", { x: X(onset) + 5, y: m.t + 12, fill: "var(--text-secondary)",
      "font-size": 11 }));
    t.textContent = "onset";
  }

  add(el("polyline", {
    points: seg.map((y, k) => `${X(lo + k)},${Y(y)}`).join(" "),
    fill: "none", stroke: colour, "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round" }));

  if (onset >= lo && onset < hi) {
    add(el("circle", { cx: X(onset), cy: Y(wave[onset]), r: 5, fill: colour,
      stroke: "var(--surface-1)", "stroke-width": 2 }));
  }

  // hover crosshair
  const cross = add(el("line", { x1: 0, x2: 0, y1: m.t, y2: m.t + ph, stroke: "var(--axis)",
    "stroke-width": 1, opacity: 0 }));
  const dot = add(el("circle", { r: 4, fill: colour, opacity: 0 }));
  const hit = add(el("rect", { x: m.l, y: m.t, width: pw, height: ph, fill: "transparent" }));

  const tip = $("tip");
  hit.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    let i = Math.round(lo + ((px - m.l) / pw) * (hi - 1 - lo));
    i = Math.max(lo, Math.min(hi - 1, i));
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i));
    cross.setAttribute("opacity", 1);
    dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(wave[i]));
    dot.setAttribute("opacity", 1);
    $("tip-v").textContent = wave[i];
    $("tip-k").textContent = "at sample " + i;
    tip.style.opacity = 1;
    tip.style.left = Math.min(r.width - 130, (X(i) / W) * r.width + 10) + "px";
    tip.style.top = ((Y(wave[i]) / H) * r.height - 34) + "px";
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); tip.style.opacity = 0;
  });

  $("caption").textContent = "Forward drive minus reverse drive, averaged over "
    + (last && last.rounds ? last.rounds : "?") + " rounds. Samples "
    + lo + "–" + (hi - 1) + " at 50 kHz — one sample is 20 µs.";
}

function fillTable() {
  if (!wave) return;
  $("nums").innerHTML = wave
    .map((v, i) => `<tr><td>${i}</td><td>${v}</td></tr>`).join("");
}

/* ---------------- wiring up -------------------------------------------- */

$("connect").addEventListener("click", connect);
$("on").addEventListener("click", async () => { setRunning(true); await send("c"); });
$("off").addEventListener("click", async () => {
  setRunning(false);
  $("note").textContent = "Stopping after the measurement in flight finishes.";
  await send("s");
});
$("once").addEventListener("click", async () => {
  $("sub").textContent = "Measuring…";
  await send("m");
});

for (const [id, mode] of [["v-onset", "onset"], ["v-full", "full"]]) {
  $(id).addEventListener("click", () => {
    view = mode;
    $("v-onset").setAttribute("aria-pressed", String(mode === "onset"));
    $("v-full").setAttribute("aria-pressed", String(mode === "full"));
    drawChart();
  });
}


window.addEventListener("beforeunload", () => { if (port) send("s"); });

setConnected(false);
if (!("serial" in navigator)) {
  $("hint").textContent = "This browser has no Web Serial — use Chrome or Edge on desktop. "
    + "If you opened this from a file:// path and Connect does nothing, run "
    + "`python -m http.server` in this folder and open http://localhost:8000/buzzer_sorter.html";
}
