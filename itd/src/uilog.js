"use strict";
/* ---------------------------------------------------------------------------------------------
   Motor log: plots one ITS_THAT_DEEP UI-mode session (UInnnnn.CSV). Rows are full snapshots:
     up_ms,unix,event,motor,duty_pct,dir,brake,current_ma,vbat_mv,pot_raw,tach,target,ble,detail
   (older files have no target column). SAMPLE rows come at 50 Hz while the motor runs and 1 Hz
   otherwise; every other row is an event (MOTOR, BUTTON, BT_RX, USB_RX, BLE, SESSION_*, SLEEP).
--------------------------------------------------------------------------------------------- */
const $m = (id) => document.getElementById(id);
const ml = { sessions: [], cur: null, t0: 0, span: 1, fetch: null, fetchedText: "" };

/* ---- parsing ---- */
function parseUiLog(text, name) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length || !/^up_ms,/.test(lines[0])) return null;
  const head = lines[0].split(",");
  const nFixed = head.length - 1;   // everything before the quoted detail
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    const f = [];
    let at = 0;
    for (let k = 0; k < nFixed; k++) {
      const c = l.indexOf(",", at);
      if (c < 0) break;
      f.push(l.slice(at, c)); at = c + 1;
    }
    if (f.length < nFixed) continue;   // a torn last line (power cut mid-write)
    let detail = l.slice(at);
    if (detail.startsWith('"')) detail = detail.slice(1, detail.endsWith('"') ? -1 : undefined);
    const r = { detail };
    head.slice(0, nFixed).forEach((h, k) => {
      const v = f[k];
      r[h] = /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
    });
    if (r.target === undefined) r.target = NaN;
    rows.push(r);
  }
  if (!rows.length) return null;
  const t0 = rows[0].up_ms;
  for (const r of rows) r.t = (r.up_ms - t0) / 1000;
  const start = rows.find((r) => r.event === "SESSION_START");
  const info = {};
  if (start) for (const kv of start.detail.split(";")) { const e = kv.indexOf("="); if (e > 0) info[kv.slice(0, e)] = kv.slice(e + 1); }
  return { name, rows, info, text };
}

/* ---- summary + table ---- */
function fmtS(s) { return s < 60 ? s.toFixed(1) + " s" : Math.floor(s / 60) + " m " + Math.round(s % 60) + " s"; }
function summarize(s) {
  const r = s.rows, last = r[r.length - 1];
  const cur = r.map((x) => x.current_ma).filter(Number.isFinite);
  const vb = r.map((x) => x.vbat_mv).filter((v) => Number.isFinite(v) && v > 0);
  const moves = r.filter((x) => x.event === "MOTOR" && /^(open|close) /.test(x.detail)).length;
  const stalls = r.filter((x) => x.event === "MOTOR" && /stall|timeout/.test(x.detail)).length;
  const cmds = r.filter((x) => x.event === "BT_RX" || x.event === "USB_RX").length;
  const presses = r.filter((x) => x.event === "BUTTON" && x.detail === "press").length;
  const end = r.find((x) => x.event === "SESSION_END");
  const date = r[0].unix > 1e9 ? new Date(r[0].unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
  const items = [
    ["file", s.name], ["started", date], ["duration", fmtS(last.t)],
    ["reason in / out", (s.info.reason || "?") + " / " + (end ? end.detail.replace("reason=", "") : "open (no end)")],
    ["audio before", s.info.audio || "—"], ["moves", moves], ["stalls / timeouts", stalls, stalls > 0],
    ["commands", cmds], ["button presses", presses],
    ["peak current", cur.length ? Math.max(...cur) + " mA" : "—"],
    ["battery", vb.length ? (Math.min(...vb) / 1000).toFixed(2) + "–" + (Math.max(...vb) / 1000).toFixed(2) + " V" : "—"],
    ["encoder", r[0].tach + " → " + last.tach], ["pot connected", s.info.pot_connected === "1" ? "yes" : "no"],
    ["build / id", (s.info.build || "?") + " / " + (s.info.id || "?")],
  ];
  $m("mlSummary").innerHTML = items.map(([k, v, bad]) =>
    `<div class="ml-kv"><span class="ml-k">${k}</span><span class="ml-v${bad ? " bad" : ""}">${escapeHtml(String(v))}</span></div>`).join("");
}
function escapeHtml(t) { return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function renderTable() {
  const s = ml.cur, body = $m("mlRows");
  if (!s) { body.innerHTML = ""; return; }
  const withSamples = $m("mlShowSamples").checked;
  const html = [];
  for (const r of s.rows) {
    if (r.event === "SAMPLE" && !withSamples) continue;
    const cls = "ev-" + r.event + (/stall|timeout/.test(r.detail) ? " ev-stall" : "");
    html.push(`<tr data-t="${r.t}"><td>${r.t.toFixed(3)}</td><td class="${cls}">${r.event}</td><td>${r.motor}</td>` +
      `<td>${r.tach}</td><td>${Number.isFinite(r.target) ? r.target : ""}</td><td>${r.current_ma}</td>` +
      `<td>${(r.vbat_mv / 1000).toFixed(2)}</td><td>${escapeHtml(r.detail)}</td></tr>`);
  }
  body.innerHTML = html.join("");
}
$m("mlRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr"); if (!tr || !ml.cur) return;
  ml.t0 = parseFloat(tr.dataset.t) - ml.span / 2; draw();   // centre the chart on that row
});

/* ---- chart: stacked lanes on one shared time axis ---- */
const LANES = [
  { key: "current_ma", label: "current", unit: "mA", color: "#ff7a6b" },
  { key: "tach", label: "encoder", unit: "edges", color: "#4ecdc4", extra: "target" },
  { key: "duty_pct", label: "duty", unit: "%", color: "#f2b544", fixed: [0, 100], step: true },
  { key: "vbat_mv", label: "battery", unit: "mV", color: "#5ddc8a" },
  { key: "pot_raw", label: "pot", unit: "raw", color: "#b48cff" },
];
const EV_COLORS = { MOTOR: "#4ecdc4", BUTTON: "#f2b544", BT_RX: "#6aa9ff", USB_RX: "#6aa9ff", BLE: "#b48cff",
  SESSION_START: "#5ddc8a", SESSION_END: "#5ddc8a", SLEEP: "#5ddc8a" };
const AXW = 64, EVH = 18;

function laneRange(rows, lane, i0, i1) {
  if (lane.fixed) return lane.fixed;
  let lo = Infinity, hi = -Infinity;
  for (let i = i0; i <= i1; i++) {
    for (const k of [lane.key, lane.extra]) {
      if (!k) continue;
      const v = rows[i][k];
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  if (!(hi >= lo)) return [0, 1];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}
function bsearch(rows, t) {   // first index with rows[i].t >= t
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}
let raf = 0;
function draw() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; drawNow(); }); }
function drawNow() {
  const c = $m("mlChart"), dpr = Math.min(devicePixelRatio || 1, 2);
  const W = Math.max(32, Math.round(c.clientWidth * dpr)), H = Math.max(32, Math.round(c.clientHeight * dpr));
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext("2d");
  g.fillStyle = "#0b1113"; g.fillRect(0, 0, W, H);
  const s = ml.cur;
  if (!s) return;
  const rows = s.rows, ax = AXW * dpr, plotW = W - ax, evh = EVH * dpr;
  const xOf = (t) => ax + ((t - ml.t0) / ml.span) * plotW;
  const i0 = Math.max(0, bsearch(rows, ml.t0) - 1), i1 = Math.min(rows.length - 1, bsearch(rows, ml.t0 + ml.span));
  const laneH = (H - evh - 16 * dpr) / LANES.length;
  g.font = (10 * dpr) + "px ui-monospace,monospace";

  // event strip + full-height markers
  const showCmds = $m("mlShowCmds").checked;
  for (let i = i0; i <= i1; i++) {
    const r = rows[i];
    if (r.event === "SAMPLE") continue;
    if (!showCmds && (r.event === "BT_RX" || r.event === "USB_RX")) continue;
    const x = xOf(r.t);
    if (x < ax || x > W) continue;
    const stall = /stall|timeout/.test(r.detail);
    g.strokeStyle = stall ? "#ff7a6b" : (EV_COLORS[r.event] || "#888");
    g.globalAlpha = r.event === "MOTOR" || r.event === "BUTTON" || stall ? 0.6 : 0.25;
    g.lineWidth = dpr;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 16 * dpr); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = g.strokeStyle;
    g.fillRect(x - 2 * dpr, 2 * dpr, 4 * dpr, evh - 6 * dpr);
  }
  g.fillStyle = "#5d7378"; g.textAlign = "right"; g.textBaseline = "middle";
  g.fillText("events", ax - 6 * dpr, evh / 2);

  LANES.forEach((lane, li) => {
    const top = evh + li * laneH, bot = top + laneH;
    g.strokeStyle = "#24343a"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, top + 0.5); g.lineTo(W, top + 0.5); g.stroke();
    const [lo, hi] = laneRange(rows, lane, i0, i1);
    const yOf = (v) => bot - 4 * dpr - ((v - lo) / (hi - lo)) * (laneH - 10 * dpr);
    // axis labels
    g.fillStyle = lane.color; g.textAlign = "right"; g.textBaseline = "top";
    g.fillText(lane.label, ax - 6 * dpr, top + 3 * dpr);
    g.fillStyle = "#5d7378";
    g.fillText(Math.round(hi) + "", ax - 6 * dpr, top + 15 * dpr);
    g.textBaseline = "bottom"; g.fillText(Math.round(lo) + " " + lane.unit, ax - 6 * dpr, bot - 2 * dpr);
    // series
    const series = [[lane.key, lane.color, []]];
    if (lane.extra) series.push([lane.extra, "rgba(223,234,236,.55)", [4 * dpr, 3 * dpr]]);
    for (const [key, color, dash] of series) {
      g.strokeStyle = color; g.lineWidth = 1.4 * dpr; g.setLineDash(dash);
      g.beginPath();
      let pen = false, lastY = 0;
      for (let i = i0; i <= i1; i++) {
        const v = rows[i][key];
        if (!Number.isFinite(v)) { pen = false; continue; }
        const x = xOf(rows[i].t), y = yOf(v);
        if (!pen) { g.moveTo(x, y); pen = true; }
        else if (lane.step) { g.lineTo(x, lastY); g.lineTo(x, y); }
        else g.lineTo(x, y);
        lastY = y;
      }
      g.stroke();
      g.setLineDash([]);
    }
  });

  // time axis
  g.fillStyle = "rgba(11,17,19,.85)"; g.fillRect(ax, H - 16 * dpr, plotW, 16 * dpr);
  g.fillStyle = "#8ba3a9"; g.textAlign = "left"; g.textBaseline = "alphabetic";
  const nT = Math.max(2, Math.min(10, Math.floor(plotW / (80 * dpr))));
  for (let k = 0; k <= nT; k++) {
    const t = ml.t0 + (ml.span * k) / nT;
    g.fillText(t.toFixed(ml.span < 5 ? 2 : 1) + "s", Math.min(W - 40 * dpr, ax + (plotW * k) / nT + 3 * dpr), H - 4 * dpr);
  }
  // the panes' left gutter
  g.strokeStyle = "#24343a"; g.beginPath(); g.moveTo(ax - 0.5, 0); g.lineTo(ax - 0.5, H); g.stroke();

  if (ml.hoverX != null) {
    g.strokeStyle = "rgba(223,234,236,.35)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(ml.hoverX * dpr, 0); g.lineTo(ml.hoverX * dpr, H - 16 * dpr); g.stroke();
  }
}

/* ---- interaction: wheel zoom about the cursor, drag pan, double-click fit ---- */
function fit() {
  if (!ml.cur) return;
  const last = ml.cur.rows[ml.cur.rows.length - 1].t;
  ml.span = Math.max(1, last * 1.02); ml.t0 = -last * 0.01; draw();
}
const chart = $m("mlChart");
chart.addEventListener("wheel", (e) => {
  if (!ml.cur) return; e.preventDefault();
  const r = chart.getBoundingClientRect(), fx = Math.max(0, Math.min(1, (e.clientX - r.left - AXW) / (r.width - AXW)));
  const at = ml.t0 + fx * ml.span;
  ml.span = Math.max(0.05, ml.span * (e.deltaY < 0 ? 1 / 1.15 : 1.15));
  ml.t0 = at - fx * ml.span; draw();
}, { passive: false });
let drag = null;
chart.addEventListener("pointerdown", (e) => { if (!ml.cur) return; drag = { x: e.clientX, t0: ml.t0 }; chart.setPointerCapture(e.pointerId); });
chart.addEventListener("pointerup", () => { drag = null; });
chart.addEventListener("pointercancel", () => { drag = null; });
chart.addEventListener("dblclick", fit);
chart.addEventListener("pointerleave", () => { ml.hoverX = null; $m("mlTip").hidden = true; draw(); });
chart.addEventListener("pointermove", (e) => {
  if (!ml.cur) return;
  const r = chart.getBoundingClientRect();
  if (drag) { ml.t0 = drag.t0 - ((e.clientX - drag.x) / (r.width - AXW)) * ml.span; draw(); return; }
  const px = e.clientX - r.left;
  if (px < AXW) { ml.hoverX = null; $m("mlTip").hidden = true; draw(); return; }
  const t = ml.t0 + ((px - AXW) / (r.width - AXW)) * ml.span;
  const rows = ml.cur.rows;
  let i = bsearch(rows, t);
  if (i > 0 && (i >= rows.length || Math.abs(rows[i - 1].t - t) < Math.abs(rows[i].t - t))) i--;
  const s = rows[Math.min(i, rows.length - 1)];
  // events within ~4 px of the cursor
  const tol = (4 / (r.width - AXW)) * ml.span;
  const near = rows.slice(Math.max(0, bsearch(rows, t - tol)), bsearch(rows, t + tol))
    .filter((x) => x.event !== "SAMPLE").slice(0, 4);
  const lines = [
    `t ${s.t.toFixed(3)} s   ${s.motor}   duty ${s.duty_pct}% ${s.dir}${s.brake ? " brake" : ""}`,
    `current ${s.current_ma} mA   battery ${(s.vbat_mv / 1000).toFixed(2)} V`,
    `encoder ${s.tach}${Number.isFinite(s.target) ? " → " + s.target : ""}   pot ${s.pot_raw}   ble ${s.ble}`,
    ...near.map((x) => `${x.event}  ${x.detail}`),
  ];
  const tip = $m("mlTip");
  tip.textContent = lines.join("\n"); tip.hidden = false;
  const left = px + 14 + 320 > r.width ? px - 14 - Math.min(320, tip.offsetWidth) : px + 14;
  tip.style.left = Math.max(0, left) + "px"; tip.style.top = "8px";
  ml.hoverX = px; draw();
});
addEventListener("resize", draw);

/* ---- sessions ---- */
function setSessions(list, select) {
  ml.sessions = list;
  const sel = $m("mlSession");
  sel.innerHTML = list.map((s, i) => `<option value="${i}">${escapeHtml(s.name)} (${fmtS(s.rows[s.rows.length - 1].t)})</option>`).join("") || "<option>none loaded</option>";
  sel.disabled = list.length < 2;
  showSession(list.length ? (select ?? list.length - 1) : -1);
}
function showSession(i) {
  ml.cur = ml.sessions[i] || null;
  $m("mlSession").value = String(i);
  $m("mlDownload").disabled = !ml.cur;
  $m("mlWatermark").hidden = !!ml.cur;
  if (ml.cur) { summarize(ml.cur); fit(); } else draw();
  renderTable();
}
$m("mlSession").addEventListener("change", (e) => showSession(parseInt(e.target.value, 10)));
$m("mlShowSamples").addEventListener("change", renderTable);
$m("mlShowCmds").addEventListener("change", draw);
$m("mlFit").addEventListener("click", fit);

async function openFiles(files) {
  const added = [], bad = [];
  for (const f of files) {
    const s = parseUiLog(await f.text(), f.name);
    if (s) added.push(s); else bad.push(f.name);
  }
  // keep earlier sessions, replace same-named ones; order by file name (= session number)
  const byName = new Map(ml.sessions.map((s) => [s.name, s]));
  for (const s of added) byName.set(s.name, s);
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  setSessions(list, added.length ? list.indexOf(added[added.length - 1]) : undefined);
  $m("mlStatus").textContent = (added.length ? added.length + " loaded" : "") + (bad.length ? "  ·  not a UI log: " + bad.join(", ") : "");
}
$m("mlPick").addEventListener("change", (e) => { if (e.target.files.length) openFiles(e.target.files); e.target.value = ""; });

/* ---- fetch the latest session over the Console tab's connection (--uilog) ---- */
function finishFetch() {
  const f = ml.fetch; ml.fetch = null;
  $m("mlFetch").disabled = !(window.ITD && window.ITD.isConnected && window.ITD.isConnected());
  if (!f || !f.lines.length) { $m("mlStatus").textContent = "no UI log received (none this boot?)"; return; }
  const text = f.lines.join("\n") + "\n";
  const s = parseUiLog(text, (f.name || "UI-latest.CSV") + " (fetched)");
  if (!s) { $m("mlStatus").textContent = "fetched data did not parse"; return; }
  const list = ml.sessions.filter((x) => x.name !== s.name).concat([s]);
  setSessions(list, list.length - 1);
  $m("mlStatus").textContent = "fetched " + f.lines.length + " lines" + (f.bytes ? " (" + f.bytes + " bytes on card)" : "");
}
if (window.ITD) {
  window.ITD.on("uilogline", (line) => {
    if (!ml.fetch) return;
    const m = line.match(/^file=(\S+)\s+bytes=(\d+)/);
    if (m) { ml.fetch.name = m[1]; ml.fetch.bytes = +m[2]; ml.fetch.lines = []; }
    else ml.fetch.lines.push(line);
    clearTimeout(ml.fetch.timer);
    ml.fetch.timer = setTimeout(finishFetch, 1200);   // the dump ends when the lines stop
    $m("mlStatus").textContent = "receiving… " + ml.fetch.lines.length + " lines";
  });
  window.ITD.on("connection", (c) => { if (!ml.fetch) $m("mlFetch").disabled = !c; });
  window.ITD.openUiLogFiles = (files) => openFiles(files);
}
$m("mlFetch").addEventListener("click", () => {
  if (!window.ITD || !window.ITD.consoleSend) return;
  ml.fetch = { lines: [], name: "", bytes: 0, timer: setTimeout(finishFetch, 4000) };
  $m("mlFetch").disabled = true;
  $m("mlStatus").textContent = "requesting…";
  window.ITD.consoleSend("--uilog");
});
$m("mlDownload").addEventListener("click", () => {
  if (!ml.cur) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ml.cur.text], { type: "text/csv" }));
  a.download = ml.cur.name.replace(/\s*\(fetched\)$/, "").replace(/\.csv$/i, "") + ".csv";
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
draw();
