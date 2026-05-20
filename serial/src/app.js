(function() {
'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  port: null,
  reader: null,
  writer: null,
  connected: false,
  connecting: false,
  shouldReconnect: false,
  lastPortInfo: null,   // {usbVendorId, usbProductId} for replug match
  logLines: [],
  rawBytes: [],
  cmdHistory: [],
  historyIdx: -1,
  currentDraft: '',
  rxBytes: 0,
  txBytes: 0,
  rxBytesLast: 0,
  loggingActive: false,
  logFiles: [],         // [{id, name, lines:[], startTime, endTime, active}]
  currentLogFile: null,
  startTime: Date.now(),
  plotData: {},
  plotLabels: [],
  plotBuffer: '',
  settings: {
    maxLines: 5000,
    tsFormat: 'hmsms',
    fontSize: 12,
    highlights: ['ERROR','WARN','OK','FAIL'],
    autoReconnect: false,
    reconnectInterval: 2000,
    echo: true,
    logPrefix: 'serial_log',
    logHeader: true
  }
};

// ─── Utils ───────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(2) + ' MB';
}

function fmtTimestamp() {
  const now = new Date();
  const fmt = state.settings.tsFormat;
  if (fmt === 'epoch') return now.getTime().toString();
  if (fmt === 'rel') return ((now.getTime() - state.startTime) / 1000).toFixed(3) + 's';
  const h = String(now.getHours()).padStart(2,'0');
  const m = String(now.getMinutes()).padStart(2,'0');
  const s = String(now.getSeconds()).padStart(2,'0');
  const ms = String(now.getMilliseconds()).padStart(3,'0');
  if (fmt === 'hms') return `${h}:${m}:${s}`;
  return `${h}:${m}:${s}.${ms}`;
}

function hexByte(b) { return b.toString(16).toUpperCase().padStart(2,'0'); }

function formatDataForDisplay(bytes, mode) {
  if (mode === 'hex') return Array.from(bytes).map(hexByte).join(' ');
  if (mode === 'dec') return Array.from(bytes).map(b=>b.toString()).join(' ');
  if (mode === 'mixed') {
    return Array.from(bytes).map(b => {
      if (b >= 32 && b < 127) return String.fromCharCode(b);
      return `\\x${hexByte(b)}`;
    }).join('');
  }
  return Array.from(bytes).map(b => {
    if (b === 10 || b === 13) return '';
    if (b >= 32 && b < 127) return String.fromCharCode(b);
    if (b === 9) return '\t';
    return `[${hexByte(b)}]`;
  }).join('');
}

function safeFilename(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ─── Log System (console buffer) ─────────────────────────────────────────────
const logEl = document.getElementById('log-container');
const filterInput = document.getElementById('filter-input');

function appendLog(text, type = 'rx', raw = null) {
  const ts = fmtTimestamp();
  const entry = { text, type, ts, raw };
  state.logLines.push(entry);
  if (state.loggingActive && state.currentLogFile) {
    state.currentLogFile.lines.push(`[${ts}][${type.toUpperCase()}] ${text}`);
  }

  const max = state.settings.maxLines;
  while (state.logLines.length > max) {
    state.logLines.shift();
    if (logEl.firstChild) logEl.removeChild(logEl.firstChild);
  }

  if (!passesFilter(text)) return;

  const lineEl = createLogLineEl(entry);
  logEl.appendChild(lineEl);
  document.getElementById('stat-lines').textContent = state.logLines.length;

  if (document.getElementById('chk-autoscroll').checked) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function passesFilter(text) {
  const f = filterInput.value.trim();
  if (!f) return true;
  try { return new RegExp(f, 'i').test(text); }
  catch(e) { return text.toLowerCase().includes(f.toLowerCase()); }
}

function createLogLineEl(entry) {
  const div = document.createElement('div');
  div.className = `log-line ${entry.type}`;

  if (document.getElementById('chk-timestamps').checked) {
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = entry.ts;
    div.appendChild(ts);
  }

  const dir = document.createElement('span');
  dir.className = 'dir';
  dir.textContent = entry.type === 'sent' ? '›' : entry.type === 'info' ? '·' : entry.type === 'error' ? '!' : '‹';
  div.appendChild(dir);

  const txt = document.createElement('span');
  txt.className = 'log-text';
  if (!document.getElementById('chk-wrap').checked) txt.style.whiteSpace = 'pre';

  const highlights = state.settings.highlights;
  if (highlights.length && entry.type === 'rx') {
    const escaped = highlights.map(h => h.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
    try {
      const parts = entry.text.split(new RegExp(`(${escaped})`, 'gi'));
      txt.innerHTML = '';
      parts.forEach(part => {
        if (!part) return;
        const isHi = highlights.some(h => h.toLowerCase() === part.toLowerCase());
        if (isHi) {
          const lm = part.toLowerCase();
          const color = lm.includes('error') || lm.includes('fail') ? 'var(--red)' :
                        lm.includes('warn') ? 'var(--amber)' : 'var(--green)';
          const span = document.createElement('span');
          span.style.color = color;
          span.style.fontWeight = '500';
          span.textContent = part;
          txt.appendChild(span);
        } else {
          txt.appendChild(document.createTextNode(part));
        }
      });
      div.appendChild(txt);
      return div;
    } catch(e) {}
  }

  txt.textContent = entry.text;
  div.appendChild(txt);
  return div;
}

function rebuildLog() {
  logEl.innerHTML = '';
  state.logLines.forEach(e => {
    if (passesFilter(e.text)) logEl.appendChild(createLogLineEl(e));
  });
  if (document.getElementById('chk-autoscroll').checked) logEl.scrollTop = logEl.scrollHeight;
}

// ─── Hex View ────────────────────────────────────────────────────────────────
const hexContainer = document.getElementById('hex-container');
const HEX_CHUNK_SIZE = () => parseInt(document.getElementById('hex-width').value) || 16;
let hexRowAddr = 0;

function appendHex(bytes, dir = 'rx') {
  const maxRows = parseInt(document.getElementById('hex-maxrows').value) || 200;
  const width = HEX_CHUNK_SIZE();
  const showAscii = document.getElementById('hex-show-ascii').checked;
  const showAddr = document.getElementById('hex-show-addr').checked;
  const colorize = document.getElementById('hex-color').checked;
  const groupSize = parseInt(document.getElementById('hex-group').value) || 4;

  const arr = Array.from(bytes);
  for (let i = 0; i < arr.length; i += width) {
    const chunk = arr.slice(i, i + width);
    const row = document.createElement('div');
    row.className = 'hex-row';

    if (showAddr) {
      const addrEl = document.createElement('span');
      addrEl.className = 'hex-addr';
      addrEl.textContent = hexRowAddr.toString(16).toUpperCase().padStart(8,'0') + ':';
      row.appendChild(addrEl);
    }

    const dirEl = document.createElement('span');
    dirEl.className = 'hex-dir';
    dirEl.textContent = dir === 'rx' ? '‹' : '›';
    dirEl.style.color = dir === 'rx' ? 'var(--text3)' : 'var(--cyan)';
    row.appendChild(dirEl);

    const bytesEl = document.createElement('span');
    bytesEl.className = 'hex-bytes';
    chunk.forEach((b, bi) => {
      const byteEl = document.createElement('span');
      byteEl.className = 'hex-byte';
      byteEl.textContent = hexByte(b);
      if (colorize) {
        if (b === 0) byteEl.classList.add('zero');
        else if (b < 32 || b === 127) byteEl.classList.add('control');
        else if (b > 127) byteEl.classList.add('high');
        else byteEl.classList.add('printable');
      }
      if ((bi + 1) % groupSize === 0) byteEl.style.marginRight = '6px';
      byteEl.title = `0x${hexByte(b)} = ${b} = ${b < 32 ? '(ctrl)' : String.fromCharCode(b)}`;
      bytesEl.appendChild(byteEl);
    });

    for (let p = chunk.length; p < width; p++) {
      const pad = document.createElement('span');
      pad.className = 'hex-byte';
      pad.textContent = '  ';
      bytesEl.appendChild(pad);
    }
    row.appendChild(bytesEl);

    if (showAscii) {
      const asciiEl = document.createElement('span');
      asciiEl.className = 'hex-ascii';
      asciiEl.textContent = chunk.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
      row.appendChild(asciiEl);
    }

    hexContainer.appendChild(row);
    hexRowAddr += chunk.length;

    while (hexContainer.children.length > maxRows) hexContainer.removeChild(hexContainer.firstChild);
  }
  hexContainer.scrollTop = hexContainer.scrollHeight;
}

// ─── Terminal (xterm.js) ─────────────────────────────────────────────────────
let term = null;
let fitAddon = null;
const termHost = document.getElementById('terminal-host');

function initTerminal() {
  if (term) return;
  if (typeof Terminal === 'undefined') {
    console.error('xterm Terminal not loaded');
    return;
  }
  term = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code","Consolas",monospace',
    fontSize: 13,
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: false,
    theme: {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#39d0d8',
      cursorAccent: '#0d1117',
      selectionBackground: 'rgba(88,166,255,0.35)',
      black: '#161b22', red: '#f85149', green: '#3fb950',
      yellow: '#d29922', blue: '#58a6ff', magenta: '#a371f7',
      cyan: '#39d0d8', white: '#e6edf3',
      brightBlack: '#484f58', brightRed: '#ff7b72', brightGreen: '#56d364',
      brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#bc8cff',
      brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
    }
  });

  try {
    const FitCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
    if (FitCtor) {
      fitAddon = new FitCtor();
      term.loadAddon(fitAddon);
    }
  } catch(e) { console.warn('FitAddon failed:', e); }

  term.open(termHost);

  term.onData(data => {
    if (!state.connected || !state.port) return;
    // Translate Enter (\r) per setting
    let out = data;
    if (document.getElementById('term-crlf').checked) {
      out = out.replace(/\r/g, '\r\n');
    }
    // Translate backspace
    const bsMode = document.getElementById('term-backspace').value;
    if (bsMode === 'bs') {
      out = out.replace(/\x7f/g, '\x08');
    }
    const bytes = new TextEncoder().encode(out);
    sendBytesRaw(bytes, /*echoToTerminal=*/document.getElementById('term-local-echo').checked, data);
  });

  // Initial fit after attach
  fitTerminalSoon();
}

function fitTerminalSoon() {
  if (!fitAddon) return;
  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch(e) {}
  });
}

function clearTerminal() {
  if (term) {
    term.reset();
    term.clear();
  }
}

// ─── Serial Connection ───────────────────────────────────────────────────────
const connectBtn = document.getElementById('connect-btn');
const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const sendInput = document.getElementById('send-input');
const sendBtn = document.getElementById('send-btn');

function setStatus(s) {
  statusDot.className = 'status-dot ' + s;
  if (s === 'connected') { statusLabel.textContent = 'Connected'; connectBtn.textContent = 'Disconnect'; connectBtn.className = 'btn danger'; }
  else if (s === 'connecting') { statusLabel.textContent = 'Connecting…'; connectBtn.textContent = 'Cancel'; connectBtn.className = 'btn'; }
  else if (s === 'waiting') { statusLabel.textContent = 'Waiting for device…'; connectBtn.textContent = 'Cancel'; connectBtn.className = 'btn'; }
  else { statusLabel.textContent = 'Disconnected'; connectBtn.textContent = 'Connect'; connectBtn.className = 'btn primary'; }
  const isConn = s === 'connected';
  sendInput.disabled = !isConn;
  sendBtn.disabled = !isConn;
}

function currentPortOptions() {
  return {
    baudRate: parseInt(document.getElementById('baud-select').value),
    dataBits: parseInt(document.getElementById('databits-select').value),
    stopBits: parseInt(document.getElementById('stopbits-select').value),
    parity: document.getElementById('parity-select').value,
    flowControl: document.getElementById('flowcontrol-select').value
  };
}

function portLabelFor(info, baud) {
  const lbl = info && info.usbVendorId
    ? `USB ${info.usbVendorId.toString(16).padStart(4,'0')}:${info.usbProductId.toString(16).padStart(4,'0')}`
    : 'Serial Port';
  return `${lbl} @ ${baud}`;
}

async function connect() {
  if (!navigator.serial) {
    appendLog('Web Serial API not supported. Use Chrome/Edge 89+.', 'error');
    return;
  }

  if (state.connected) { await disconnect(true); return; }
  if (state.connecting) {
    // Cancel pending reconnect attempts
    state.shouldReconnect = false;
    setStatus('');
    state.connecting = false;
    return;
  }

  try {
    state.connecting = true;
    setStatus('connecting');
    appendLog('Requesting serial port…', 'info');

    let port;
    const portSel = document.getElementById('port-select').value;
    const ports = await navigator.serial.getPorts();

    if (portSel && ports.length) {
      port = ports.find(p => {
        const info = p.getInfo();
        return `${info.usbVendorId}:${info.usbProductId}` === portSel;
      }) || await navigator.serial.requestPort();
    } else {
      port = await navigator.serial.requestPort();
    }

    await openPort(port);
  } catch(e) {
    state.connecting = false;
    setStatus('');
    if (e.name !== 'NotFoundError') {
      appendLog(`Connection failed: ${e.message}`, 'error');
    } else {
      appendLog('Port selection cancelled.', 'info');
    }
  }
}

async function openPort(port) {
  const opts = currentPortOptions();
  await port.open(opts);

  state.port = port;
  state.connected = true;
  state.connecting = false;
  state.shouldReconnect = true;
  hexRowAddr = 0;

  const info = port.getInfo();
  state.lastPortInfo = info;
  document.getElementById('stat-port').textContent = portLabelFor(info, opts.baudRate);
  appendLog(`Connected: ${portLabelFor(info, opts.baudRate)}`, 'info');

  setStatus('connected');
  readLoop();
}

async function readLoop() {
  const port = state.port;
  while (port && port.readable && state.connected) {
    state.reader = port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await state.reader.read();
        if (done) break;
        if (value) processIncomingBytes(value);
      }
    } catch(e) {
      if (state.connected) {
        appendLog(`Read error: ${e.message}`, 'error');
        await handleDisconnect(false);
      }
    } finally {
      try { state.reader.releaseLock(); } catch(e) {}
      state.reader = null;
    }
  }
}

let rxBuffer = '';

function processIncomingBytes(bytes) {
  state.rxBytes += bytes.length;
  state.rawBytes.push(...bytes);

  // Hex view (always)
  appendHex(bytes, 'rx');

  // Terminal (raw, with full ANSI/control support)
  if (term) {
    try { term.write(bytes); } catch(e) {}
  }

  // Decode for console + plot
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const mode = document.getElementById('display-mode').value;

  rxBuffer += text;
  const lines = rxBuffer.split('\n');
  rxBuffer = lines.pop();

  lines.forEach(line => {
    line = line.replace(/\r$/, '');
    if (line === '') return;

    let display = line;
    if (mode !== 'ascii') {
      const enc = new TextEncoder().encode(line);
      display = formatDataForDisplay(enc, mode);
    }
    appendLog(display, 'rx');

    if (!document.getElementById('plot-paused').checked) {
      parsePlotLine(line);
      schedulePlotDraw();
    }
  });

  updateStats();
}

async function handleDisconnect(userInitiated = false) {
  const wasConnected = state.connected;
  state.connected = false;
  state.connecting = false;

  try { if (state.reader) { await state.reader.cancel(); state.reader = null; } } catch(e) {}
  try { if (state.writer) { await state.writer.close(); state.writer = null; } } catch(e) {}
  try { if (state.port) { await state.port.close(); } } catch(e) {}

  state.port = null;
  document.getElementById('stat-port').textContent = 'No port';

  if (wasConnected) appendLog(userInitiated ? 'Disconnected.' : 'Port disconnected (device removed?)', 'info');

  if (!userInitiated && state.shouldReconnect && state.settings.autoReconnect) {
    setStatus('waiting');
    appendLog(`Auto-reconnect armed — will retry on replug or after ${state.settings.reconnectInterval}ms.`, 'info');
    setTimeout(tryAutoReconnect, state.settings.reconnectInterval);
  } else {
    setStatus('');
  }
}

async function disconnect(userInitiated = true) {
  state.shouldReconnect = false;
  await handleDisconnect(userInitiated);
}

async function tryAutoReconnect() {
  if (state.connected || state.connecting) return;
  if (!state.shouldReconnect || !state.settings.autoReconnect) return;
  if (!state.lastPortInfo) return;
  if (!navigator.serial) return;

  try {
    const ports = await navigator.serial.getPorts();
    const match = ports.find(p => {
      const i = p.getInfo();
      if (i.usbVendorId == null || state.lastPortInfo.usbVendorId == null) return false;
      return i.usbVendorId === state.lastPortInfo.usbVendorId &&
             i.usbProductId === state.lastPortInfo.usbProductId;
    });
    if (match) {
      appendLog('Found matching port — reopening…', 'info');
      state.connecting = true;
      setStatus('connecting');
      await openPort(match);
    }
    // else: wait passively for 'connect' event
  } catch(e) {
    state.connecting = false;
    setStatus('waiting');
    appendLog(`Auto-reconnect attempt failed: ${e.message}. Will retry on replug.`, 'warn');
  }
}

// ─── Send ────────────────────────────────────────────────────────────────────
async function sendBytesRaw(bytes, echoToTerminal = false, terminalEchoStr = null) {
  if (!state.connected || !state.port) return;
  try {
    const writer = state.port.writable.getWriter();
    await writer.write(bytes);
    writer.releaseLock();
    state.txBytes += bytes.length;
    appendHex(bytes, 'tx');
    if (echoToTerminal && term && terminalEchoStr != null) {
      term.write(terminalEchoStr);
    }
    updateStats();
  } catch(e) {
    appendLog(`Send error: ${e.message}`, 'error');
    if (e.name === 'InvalidStateError') await handleDisconnect(false);
  }
}

async function send() {
  if (!state.connected || !state.port) return;
  const raw = sendInput.value;
  if (!raw) return;

  const eolRaw = document.getElementById('eol-select').value;
  const eol = eolRaw.replace('\\r\\n','\r\n').replace('\\n','\n').replace('\\r','\r');
  const mode = document.getElementById('send-mode-select').value;

  let bytes;
  if (mode === 'hex') {
    const hex = raw.replace(/\s+/g,'');
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      appendLog('Invalid hex string (must be even length, hex chars only)', 'error');
      return;
    }
    bytes = new Uint8Array(hex.match(/.{1,2}/g).map(h=>parseInt(h,16)));
  } else {
    bytes = new TextEncoder().encode(raw + eol);
  }

  try {
    const writer = state.port.writable.getWriter();
    await writer.write(bytes);
    writer.releaseLock();
    state.txBytes += bytes.length;

    if (state.settings.echo) appendLog(raw, 'sent');
    appendHex(bytes, 'tx');

    if (state.cmdHistory[0] !== raw) {
      state.cmdHistory.unshift(raw);
      if (state.cmdHistory.length > 200) state.cmdHistory.pop();
    }
    state.historyIdx = -1;
    state.currentDraft = '';
    sendInput.value = '';
    updateStats();
  } catch(e) {
    appendLog(`Send error: ${e.message}`, 'error');
    if (e.name === 'InvalidStateError') await handleDisconnect(false);
  }
}

// ─── Plot ────────────────────────────────────────────────────────────────────
const plotCanvas = document.getElementById('plot-canvas');
const plotCtx = plotCanvas.getContext('2d');
const plotLegend = document.getElementById('plot-legend');
const PLOT_COLORS = ['#58a6ff','#3fb950','#f85149','#d29922','#a371f7','#39d0d8','#ff7b72','#ffa657'];
let plotAnimRequested = false;

function resizePlotCanvas() {
  const area = document.getElementById('plot-area');
  plotCanvas.width = area.clientWidth;
  plotCanvas.height = area.clientHeight;
  drawPlot();
}

function parsePlotLine(line) {
  const delimMap = { comma: /,/, space: /\s+/, tab: /\t/, semicolon: /;/, pipe: /\|/, colon: /:/ };
  const delimKey = document.getElementById('plot-delim').value;
  const delim = delimMap[delimKey] || /,/;
  const parts = line.trim().split(delim).map(p => p.trim());

  const keysRaw = document.getElementById('plot-keys').value.trim();
  let keys = keysRaw ? keysRaw.split(',').map(k=>k.trim()) : null;
  const maxSamples = parseInt(document.getElementById('plot-samples').value) || 200;

  const kvParts = parts.filter(p => /^[\w.]+\s*=\s*[-\d.]+$/.test(p));
  if (kvParts.length > 0 && kvParts.length === parts.length) {
    kvParts.forEach(kv => {
      const [k, v] = kv.split('=').map(s=>s.trim());
      const num = parseFloat(v);
      if (!isNaN(num)) {
        if (!state.plotData[k]) state.plotData[k] = [];
        state.plotData[k].push(num);
        if (state.plotData[k].length > maxSamples) state.plotData[k].shift();
      }
    });
    return;
  }

  const nums = parts.map(p => parseFloat(p));
  if (nums.every(n => isNaN(n))) return;

  nums.forEach((n, i) => {
    if (isNaN(n)) return;
    const key = keys ? (keys[i] || `ch${i}`) : `ch${i}`;
    if (!state.plotData[key]) state.plotData[key] = [];
    state.plotData[key].push(n);
    if (state.plotData[key].length > maxSamples) state.plotData[key].shift();
  });
}

function drawPlot() {
  const w = plotCanvas.width, h = plotCanvas.height;
  if (!w || !h) return;
  const ctx = plotCtx;
  ctx.clearRect(0, 0, w, h);

  const PAD = { top: 20, right: 160, bottom: 35, left: 55 };
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;
  if (plotW < 20 || plotH < 20) return;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  const keys = Object.keys(state.plotData);
  if (keys.length === 0) {
    ctx.fillStyle = '#6e7681';
    ctx.font = '13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for data…', w/2, h/2);
    return;
  }

  let yMin, yMax;
  if (document.getElementById('plot-autoscale').checked) {
    yMin = Infinity; yMax = -Infinity;
    keys.forEach(k => {
      state.plotData[k].forEach(v => { if (v < yMin) yMin = v; if (v > yMax) yMax = v; });
    });
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const margin = (yMax - yMin) * 0.1;
    yMin -= margin; yMax += margin;
  } else {
    yMin = parseFloat(document.getElementById('plot-ymin').value) || 0;
    yMax = parseFloat(document.getElementById('plot-ymax').value) || 100;
  }
  const yRange = yMax - yMin || 1;
  const maxSamples = parseInt(document.getElementById('plot-samples').value) || 200;

  const gridLines = 6;
  for (let i = 0; i <= gridLines; i++) {
    const y = PAD.top + plotH - (i / gridLines) * plotH;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + plotW, y);
    ctx.strokeStyle = '#21262d'; ctx.lineWidth = 0.5; ctx.stroke();
    const val = yMin + (i / gridLines) * yRange;
    ctx.fillStyle = '#6e7681'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(1), PAD.left - 6, y + 3);
  }
  const xGrids = 10;
  for (let i = 0; i <= xGrids; i++) {
    const x = PAD.left + (i / xGrids) * plotW;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + plotH);
    ctx.strokeStyle = '#21262d'; ctx.lineWidth = 0.5; ctx.stroke();
  }
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.strokeRect(PAD.left, PAD.top, plotW, plotH);

  keys.forEach((key, ki) => {
    const data = state.plotData[key];
    if (data.length < 2) return;
    const color = PLOT_COLORS[ki % PLOT_COLORS.length];
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    data.forEach((v, i) => {
      const x = PAD.left + (i / (maxSamples - 1)) * plotW;
      const y = PAD.top + plotH - ((v - yMin) / yRange) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    const lv = data[data.length-1];
    const lx = PAD.left + ((data.length-1) / (maxSamples-1)) * plotW;
    const ly = PAD.top + plotH - ((lv - yMin) / yRange) * plotH;
    ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
  });

  plotLegend.innerHTML = '';
  keys.forEach((key, ki) => {
    const data = state.plotData[key];
    const last = data.length ? data[data.length-1] : 0;
    const color = PLOT_COLORS[ki % PLOT_COLORS.length];
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-dot" style="background:${color}"></span><span style="color:${color}">${key}</span><span style="color:var(--text2);margin-left:auto;padding-left:8px">${last.toFixed(2)}</span>`;
    plotLegend.appendChild(item);
  });
}

function schedulePlotDraw() {
  if (!plotAnimRequested) {
    plotAnimRequested = true;
    requestAnimationFrame(() => { plotAnimRequested = false; drawPlot(); });
  }
}

// ─── Port Scanner ────────────────────────────────────────────────────────────
async function refreshPorts() {
  if (!navigator.serial) return;
  const ports = await navigator.serial.getPorts();
  const sel = document.getElementById('port-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select Port —</option>';
  ports.forEach((p, i) => {
    const info = p.getInfo();
    const id = `${info.usbVendorId}:${info.usbProductId}`;
    const label = info.usbVendorId ? `USB ${id}` : `Port ${i+1}`;
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = label;
    if (id === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ─── Stats ───────────────────────────────────────────────────────────────────
function updateStats() {
  document.getElementById('stat-rx').textContent = fmtBytes(state.rxBytes);
  document.getElementById('stat-tx').textContent = fmtBytes(state.txBytes);
}

setInterval(() => {
  const rate = state.rxBytes - state.rxBytesLast;
  state.rxBytesLast = state.rxBytes;
  document.getElementById('stat-rate').textContent = fmtBytes(rate) + '/s';
}, 1000);

// ─── Logging (file-per-session) ──────────────────────────────────────────────
function toggleLogging() {
  state.loggingActive = !state.loggingActive;
  const btn = document.getElementById('logging-btn');
  const lbl = document.getElementById('stat-logging');
  if (state.loggingActive) {
    startLoggingFile();
    btn.classList.add('active');
    lbl.textContent = 'Logging: ON';
    lbl.style.color = 'var(--amber)';
    appendLog(`Logging started → ${state.currentLogFile.name}`, 'info');
  } else {
    btn.classList.remove('active');
    lbl.textContent = 'Logging: OFF';
    lbl.style.color = 'var(--text3)';
    appendLog(`Logging stopped (${state.currentLogFile ? state.currentLogFile.name : 'no file'})`, 'info');
    stopLoggingFile();
  }
  renderLogFiles();
}

function startLoggingFile() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = safeFilename(state.settings.logPrefix || 'serial_log');
  const file = {
    id: 'log_' + Date.now() + '_' + Math.floor(Math.random()*1000),
    name: `${prefix}_${stamp}.txt`,
    lines: [],
    startTime: now,
    endTime: null,
    active: true
  };
  if (state.settings.logHeader) {
    file.lines.push(
      `# Serial Monitor Log`,
      `# Started: ${now.toISOString()}`,
      `# Port: ${document.getElementById('stat-port').textContent}`,
      ``
    );
  }
  state.logFiles.push(file);
  state.currentLogFile = file;
}

function stopLoggingFile() {
  if (!state.currentLogFile) return;
  state.currentLogFile.endTime = new Date();
  state.currentLogFile.active = false;
  if (state.settings.logHeader) {
    state.currentLogFile.lines.push('', `# Ended: ${state.currentLogFile.endTime.toISOString()}`);
  }
  state.currentLogFile = null;
}

function downloadLogFile(file) {
  const content = file.lines.join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.click();
  URL.revokeObjectURL(url);
}

function deleteLogFile(id) {
  state.logFiles = state.logFiles.filter(f => f.id !== id);
  renderLogFiles();
}

function logFileSize(file) {
  let n = 0;
  for (const l of file.lines) n += l.length + 1;
  return n;
}

function renderLogFiles() {
  const container = document.getElementById('log-files-list');
  if (!container) return;
  container.innerHTML = '';
  if (state.logFiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No log files yet. Click ⏺ Logging in the top bar to start recording.';
    container.appendChild(empty);
    return;
  }
  const sorted = [...state.logFiles].reverse();
  sorted.forEach(file => {
    const row = document.createElement('div');
    row.className = 'log-file-row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name;
    row.appendChild(name);

    const pill = document.createElement('span');
    pill.className = 'status-pill ' + (file.active ? 'active' : 'closed');
    pill.textContent = file.active ? '● recording' : 'closed';
    row.appendChild(pill);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${file.lines.length} lines · ${fmtBytes(logFileSize(file))}`;
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const dl = document.createElement('button');
    dl.className = 'btn btn-sm';
    dl.textContent = '↓ Download';
    dl.addEventListener('click', () => downloadLogFile(file));
    actions.appendChild(dl);

    const del = document.createElement('button');
    del.className = 'btn btn-sm';
    del.textContent = '✕';
    del.title = file.active ? 'Stop logging first to delete' : 'Delete file';
    if (file.active) del.disabled = true;
    else del.addEventListener('click', () => {
      if (confirm(`Delete ${file.name}?`)) deleteLogFile(file.id);
    });
    actions.appendChild(del);

    row.appendChild(actions);
    container.appendChild(row);
  });
}

// Periodic re-render so size/line count updates while recording
setInterval(() => {
  if (document.querySelector('.tab-panel.active')?.id === 'tab-logs') renderLogFiles();
}, 1500);

// ─── Save View (ad-hoc download of current console buffer) ───────────────────
function saveView() {
  const lines = state.logLines.map(e => `[${e.ts}][${e.type.toUpperCase()}] ${e.text}`);
  if (state.settings.logHeader) {
    lines.unshift(
      `# Serial Monitor Console Snapshot`,
      `# Date: ${new Date().toISOString()}`,
      `# Port: ${document.getElementById('stat-port').textContent}`,
      `# RX: ${fmtBytes(state.rxBytes)}  TX: ${fmtBytes(state.txBytes)}`,
      ''
    );
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename(state.settings.logPrefix)}_view_${new Date().toISOString().replace(/[:.]/g,'-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearLog() {
  state.logLines = [];
  logEl.innerHTML = '';
  hexContainer.innerHTML = '';
  hexRowAddr = 0;
  state.rxBytes = 0; state.txBytes = 0;
  document.getElementById('stat-lines').textContent = '0';
  updateStats();
}

// ─── Event Wiring ────────────────────────────────────────────────────────────
connectBtn.addEventListener('click', connect);
document.getElementById('save-btn').addEventListener('click', saveView);
document.getElementById('clear-btn').addEventListener('click', clearLog);
document.getElementById('logging-btn').addEventListener('click', toggleLogging);
document.getElementById('port-refresh-btn').addEventListener('click', refreshPorts);

sendBtn.addEventListener('click', send);
sendInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { send(); return; }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.historyIdx === -1) state.currentDraft = sendInput.value;
    if (state.historyIdx < state.cmdHistory.length - 1) {
      state.historyIdx++;
      sendInput.value = state.cmdHistory[state.historyIdx];
      setTimeout(() => sendInput.setSelectionRange(sendInput.value.length, sendInput.value.length), 0);
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.historyIdx > 0) {
      state.historyIdx--;
      sendInput.value = state.cmdHistory[state.historyIdx];
    } else if (state.historyIdx === 0) {
      state.historyIdx = -1;
      sendInput.value = state.currentDraft;
    }
    setTimeout(() => sendInput.setSelectionRange(sendInput.value.length, sendInput.value.length), 0);
  }
});

// Tabs
function showSendBar(visible) {
  const sb = document.getElementById('send-bar');
  sb.classList.toggle('hidden', !visible);
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${id}`).classList.add('active');

    showSendBar(id !== 'logs' && id !== 'settings');

    if (id === 'plot') resizePlotCanvas();
    if (id === 'terminal') {
      initTerminal();
      fitTerminalSoon();
      // delay focus to avoid swallowing the click
      setTimeout(() => { if (term) term.focus(); }, 30);
    }
    if (id === 'logs') renderLogFiles();
  });
});

// Filter
filterInput.addEventListener('input', () => rebuildLog());
document.getElementById('filter-clear-btn').addEventListener('click', () => { filterInput.value = ''; rebuildLog(); });

['chk-timestamps','chk-wrap'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => rebuildLog());
});

document.getElementById('chk-autoscroll').addEventListener('change', e => {
  if (e.target.checked) logEl.scrollTop = logEl.scrollHeight;
});

document.getElementById('scroll-lock-btn').addEventListener('click', function() {
  const autoChk = document.getElementById('chk-autoscroll');
  autoChk.checked = !autoChk.checked;
  this.classList.toggle('locked', autoChk.checked);
  this.textContent = autoChk.checked ? '⤓ Auto' : '⤓ Lock';
  if (autoChk.checked) logEl.scrollTop = logEl.scrollHeight;
});

// Hex controls
document.getElementById('hex-clear-btn').addEventListener('click', () => { hexContainer.innerHTML = ''; hexRowAddr = 0; });
document.getElementById('hex-save-btn').addEventListener('click', () => {
  const blob = new Blob([new Uint8Array(state.rawBytes)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'serial_dump.bin'; a.click();
  URL.revokeObjectURL(url);
});

// Terminal controls
document.getElementById('term-clear-btn').addEventListener('click', clearTerminal);
document.getElementById('term-paste-btn').addEventListener('click', async () => {
  if (!state.connected) { appendLog('Not connected — cannot paste.', 'warn'); return; }
  try {
    const txt = await navigator.clipboard.readText();
    if (!txt) return;
    const bytes = new TextEncoder().encode(txt);
    await sendBytesRaw(bytes);
    appendLog(`Pasted ${bytes.length} bytes to device.`, 'info');
  } catch(e) {
    appendLog(`Paste failed: ${e.message}`, 'error');
  }
});

// Plot controls
document.getElementById('plot-clear-btn').addEventListener('click', () => {
  state.plotData = {}; state.plotBuffer = '';
  plotLegend.innerHTML = ''; drawPlot();
});
document.getElementById('plot-export-btn').addEventListener('click', () => {
  const keys = Object.keys(state.plotData);
  if (!keys.length) return;
  const rows = [keys.join(',')];
  const maxLen = Math.max(...keys.map(k => state.plotData[k].length));
  for (let i = 0; i < maxLen; i++) {
    rows.push(keys.map(k => state.plotData[k][i] !== undefined ? state.plotData[k][i] : '').join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'plot_data.csv'; a.click();
  URL.revokeObjectURL(url);
});

['plot-autoscale','plot-samples','plot-ymin','plot-ymax','plot-delim','plot-keys'].forEach(id => {
  document.getElementById(id).addEventListener('change', schedulePlotDraw);
});

// Settings toggles
document.querySelectorAll('.toggle').forEach(toggle => {
  toggle.addEventListener('click', () => {
    const on = toggle.dataset.on === 'true';
    toggle.dataset.on = (!on).toString();
    toggle.classList.toggle('on', !on);
    applySettings();
  });
});

['s-maxlines','s-ts-format','s-fontsize','s-highlights','s-reconnect-interval','s-logprefix'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', applySettings);
});

function applySettings() {
  state.settings.maxLines = parseInt(document.getElementById('s-maxlines').value) || 5000;
  state.settings.tsFormat = document.getElementById('s-ts-format').value;
  state.settings.fontSize = parseInt(document.getElementById('s-fontsize').value) || 12;
  state.settings.highlights = document.getElementById('s-highlights').value.split(',').map(s=>s.trim()).filter(Boolean);
  state.settings.autoReconnect = document.getElementById('s-autoreconnect').dataset.on === 'true';
  state.settings.reconnectInterval = parseInt(document.getElementById('s-reconnect-interval').value) || 2000;
  state.settings.echo = document.getElementById('s-echo').dataset.on === 'true';
  state.settings.logPrefix = document.getElementById('s-logprefix').value || 'serial_log';
  state.settings.logHeader = document.getElementById('s-log-header').dataset.on === 'true';
  logEl.style.fontSize = state.settings.fontSize + 'px';
  hexContainer.style.fontSize = state.settings.fontSize + 'px';
}

document.getElementById('display-mode').addEventListener('change', rebuildLog);
document.getElementById('s-fontsize').addEventListener('input', applySettings);

// Resize observers
const plotResizeObs = new ResizeObserver(() => {
  const active = document.querySelector('.tab-panel.active');
  if (active && active.id === 'tab-plot') resizePlotCanvas();
});
plotResizeObs.observe(document.getElementById('plot-area'));

const termResizeObs = new ResizeObserver(() => {
  const active = document.querySelector('.tab-panel.active');
  if (active && active.id === 'tab-terminal') fitTerminalSoon();
});
termResizeObs.observe(termHost);

// Serial port events
if (navigator.serial) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (state.port && e.target === state.port) {
      handleDisconnect(false);
    }
    refreshPorts();
  });

  navigator.serial.addEventListener('connect', async (e) => {
    refreshPorts();
    if (!state.settings.autoReconnect) return;
    if (state.connected || state.connecting) return;
    if (!state.shouldReconnect || !state.lastPortInfo) return;
    const info = e.target.getInfo();
    // Require both sides to have a real USB VID:PID — avoid spuriously matching
    // two unrelated non-USB ports that both expose undefined vendor IDs.
    if (info.usbVendorId == null || state.lastPortInfo.usbVendorId == null) return;
    if (info.usbVendorId === state.lastPortInfo.usbVendorId &&
        info.usbProductId === state.lastPortInfo.usbProductId) {
      appendLog(`Device replugged (${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)}) — auto-reconnecting…`, 'info');
      try {
        state.connecting = true;
        setStatus('connecting');
        await openPort(e.target);
      } catch(err) {
        state.connecting = false;
        setStatus('waiting');
        appendLog(`Auto-reconnect failed: ${err.message}`, 'error');
      }
    }
  });
}

// ─── Startup ─────────────────────────────────────────────────────────────────
function init() {
  const supported = 'serial' in navigator;
  const badge = document.getElementById('api-support-badge');
  if (supported) {
    badge.textContent = 'Supported';
    badge.style.background = 'var(--green-dim)';
    badge.style.color = 'var(--green)';
  } else {
    badge.textContent = 'Not supported';
    badge.style.background = 'var(--red-dim)';
    badge.style.color = 'var(--red)';
    connectBtn.disabled = true;
    appendLog('Web Serial API not available. Please use Chrome or Edge 89+.', 'error');
  }

  appendLog('Serial Monitor ready. Select a port and click Connect.', 'info');
  appendLog('Tip: Use ↑↓ arrow keys in the send box to navigate command history.', 'info');
  refreshPorts();
  setStatus('');
  applySettings();
  renderLogFiles();
}

init();

})();
