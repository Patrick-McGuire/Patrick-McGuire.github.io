'use strict';

const EVENT_TYPE_NAMES = ['NONE', 'DECODED', 'DECODING_FAILED', 'SLEEP_FAILED', 'BATTERY_STATUS', 'BUFFER_OVERFLOW', 'BOOT'];
// Mirrors testMessages[] in include/ars.h — hex values shown green in the log.
const TEST_MESSAGES = new Set([
  0x1A3F, 0xB27D, 0x4C88, 0x73E1, 0x9D42,
  0x0F3C, 0x56A9, 0xE204, 0x3B7F, 0x8C15,
]);
// Bit 0 (NONE) is filtered separately on device; only the real event types are user-toggleable.
const EVENT_TOGGLE_BITS = [1, 2, 3, 4, 5, 6];
// Decode a DECODED event's attribute byte into consensus telemetry:
// [candidates:3 bits][voteScore:5 bits]. voteScore is the winner's agreement
// normalized to 0..31 (fraction of the offsets scanned that voted for it); the
// per-frame denominator isn't stored, so we show the fraction as a percentage
// rather than an un-recoverable absolute vote count. Returns "Nc/P%".
function formatDecodedAttr(attr) {
  const candidates = (attr >> 5) & 0x07;
  const voteScore = attr & 0x1F;
  const agreePct = Math.round((voteScore / 31) * 100);
  return `${candidates}c/${agreePct}%`;
}

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), dot: $('dot'),
  connectBtn: $('connectBtn'), disconnectBtn: $('disconnectBtn'),
  deviceTime: $('deviceTime'), deviceUnix: $('deviceUnix'), timeDrift: $('timeDrift'),
  readTimeBtn: $('readTimeBtn'), syncTimeBtn: $('syncTimeBtn'), autoSyncTime: $('autoSyncTime'),
  battery: $('battery'), readBatBtn: $('readBatBtn'),
  txMessage: $('txMessage'), txSendBtn: $('txSendBtn'), txStatus: $('txStatus'),
  cfgVersion: $('cfgVersion'),
  cfgId: $('cfgId'), cfgSleep: $('cfgSleep'), cfgAwake: $('cfgAwake'), cfgState: $('cfgState'),
  cfgEvents: $('cfgEvents'), cfgEventsCurrent: $('cfgEventsCurrent'),
  cfgIdCurrent: $('cfgIdCurrent'),
  cfgSleepCurrent: $('cfgSleepCurrent'),
  cfgAwakeCurrent: $('cfgAwakeCurrent'),
  cfgStateCurrent: $('cfgStateCurrent'),
  setIdBtn: $('setIdBtn'), setSleepBtn: $('setSleepBtn'), setAwakeBtn: $('setAwakeBtn'), setStateBtn: $('setStateBtn'),
  setEventsBtn: $('setEventsBtn'),
  readConfigBtn: $('readConfigBtn'),
  logCount: $('logCount'), logBody: $('logBody'), logEmpty: $('logEmpty'),
  readLogCountBtn: $('readLogCountBtn'), dumpLogBtn: $('dumpLogBtn'),
  downloadCsvBtn: $('downloadCsvBtn'), clearLogTableBtn: $('clearLogTableBtn'),
  clearDeviceLogBtn: $('clearDeviceLogBtn'),
  console: $('console'), consoleInput: $('consoleInput'),
  consoleSendBtn: $('consoleSendBtn'), consoleClearBtn: $('consoleClearBtn'),
  consoleForm: $('consoleForm'), unsupported: $('unsupported'),
};

const state = {
  port: null, reader: null, writer: null,
  rxBuf: '', readLoop: null,
  config: null, deviceUnix: null, deviceUnixReadAt: null,
  logEntries: [],
  shouldReconnect: false,
  lastDeviceInfo: null,
  reconnectTimer: null,
};
const RECONNECT_INTERVAL_MS = 1000;

function log(text, cls) {
  const span = document.createElement('span');
  span.textContent = text + '\n';
  if (cls) span.className = cls;
  ui.console.appendChild(span);
  ui.console.scrollTop = ui.console.scrollHeight;
}

function setConnected(connected) {
  ui.status.textContent = connected ? 'Connected' : 'Disconnected';
  ui.dot.classList.toggle('connected', connected);
  ui.connectBtn.disabled = connected;
  ui.disconnectBtn.disabled = !connected;
  const ctrls = [
    ui.readTimeBtn, ui.syncTimeBtn, ui.readBatBtn, ui.readConfigBtn,
    ui.setIdBtn, ui.setSleepBtn, ui.setAwakeBtn, ui.setStateBtn, ui.setEventsBtn,
    ui.cfgId, ui.cfgSleep, ui.cfgAwake, ui.cfgState,
    ui.readLogCountBtn, ui.dumpLogBtn, ui.clearLogTableBtn, ui.clearDeviceLogBtn,
    ui.consoleInput, ui.consoleSendBtn,
    ui.txMessage, ui.txSendBtn,
  ];
  ctrls.forEach(el => el.disabled = !connected);
  ui.autoSyncTime.disabled = connected;
  ui.cfgEvents.querySelectorAll('input[type="checkbox"]').forEach(el => el.disabled = !connected);
}

async function openAndStart(port) {
  await port.open({ baudRate: 115200 });
  state.port = port;
  state.writer = port.writable.getWriter();
  state.reader = port.readable.getReader();
  state.rxBuf = '';
  state.lastDeviceInfo = port.getInfo();
  state.shouldReconnect = true;
  setConnected(true);
  log('[connected]', 'tx');
  state.readLoop = readLoop();
  // Initial pull
  setTimeout(() => {
    if (ui.autoSyncTime.checked) syncTimeToNow();
    send('--config');
    send('--time');
    send('--bat');
    send('--log');
  }, 100);
}

async function connect() {
  if (!navigator.serial) {
    ui.unsupported.style.display = 'block';
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await openAndStart(port);
  } catch (e) {
    log('[connect failed: ' + e.message + ']', 'err');
  }
}

async function disconnect() {
  state.shouldReconnect = false;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  try {
    if (state.reader) {
      try { await state.reader.cancel(); } catch (_) {}
      try { state.reader.releaseLock(); } catch (_) {}
    }
    if (state.writer) {
      try { state.writer.releaseLock(); } catch (_) {}
    }
    if (state.port) {
      try { await state.port.close(); } catch (_) {}
    }
  } catch (e) {
    log('[disconnect error: ' + e.message + ']', 'err');
  } finally {
    state.port = state.reader = state.writer = null;
    setConnected(false);
    log('[disconnected]', 'tx');
  }
}

// Called when the connection is lost involuntarily (cable unplugged, device reset, etc.)
function handleConnectionLost() {
  if (!state.port && !state.reader && !state.writer) return;
  log('[connection lost]', 'warn');
  try { state.reader && state.reader.releaseLock(); } catch (_) {}
  try { state.writer && state.writer.releaseLock(); } catch (_) {}
  state.port = state.reader = state.writer = null;
  state.rxBuf = '';
  setConnected(false);
  if (state.shouldReconnect) scheduleReconnect();
}

function scheduleReconnect() {
  if (state.reconnectTimer || !state.shouldReconnect) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    tryReconnect();
  }, RECONNECT_INTERVAL_MS);
}

async function tryReconnect() {
  if (!state.shouldReconnect || state.port) return;
  try {
    const ports = await navigator.serial.getPorts();
    const target = ports.find(p => {
      const info = p.getInfo();
      return state.lastDeviceInfo
          && info.usbVendorId === state.lastDeviceInfo.usbVendorId
          && info.usbProductId === state.lastDeviceInfo.usbProductId;
    });
    if (!target) {
      scheduleReconnect();
      return;
    }
    log('[reconnecting...]', 'tx');
    await openAndStart(target);
  } catch (_) {
    // Device probably still enumerating; try again.
    scheduleReconnect();
  }
}

async function readLoop() {
  const decoder = new TextDecoder();
  try {
    while (state.reader) {
      const { value, done } = await state.reader.read();
      if (done) break;
      state.rxBuf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = state.rxBuf.indexOf('\n')) >= 0) {
        const line = state.rxBuf.slice(0, idx).replace(/\r$/, '');
        state.rxBuf = state.rxBuf.slice(idx + 1);
        if (line.length === 0) continue;
        handleLine(line);
      }
    }
  } catch (e) {
    if (state.port) log('[read error: ' + e.message + ']', 'err');
  } finally {
    // The reader returned done or threw — almost always means the device went away.
    // Don't fire if we're already cleaned up (user-initiated disconnect path).
    if (state.shouldReconnect) handleConnectionLost();
  }
}

async function send(cmd) {
  if (!state.writer) return;
  log('> ' + cmd, 'tx');
  const data = new TextEncoder().encode(cmd + '\n');
  try {
    await state.writer.write(data);
  } catch (e) {
    log('[send error: ' + e.message + ']', 'err');
  }
}

function syncTimeToNow() {
  const now = Math.floor(Date.now() / 1000);
  send('--time -setUnix ' + now);
}

function handleLine(line) {
  // High-volume LOGENTRY lines skip the console (already going to the table)
  // to avoid DOM pressure during large dumps that can stall the read loop.
  const isLogEntry = line.startsWith('MSG:\tLOGENTRY ');

  if (!isLogEntry) {
    let cls = null;
    if (line.startsWith('ERROR:')) cls = 'err';
    else if (line.startsWith('WARN:')) cls = 'warn';
    log(line, cls);
  }

  // Parse our structured MSG: lines.
  // Format: "MSG:\tTAG key=val key=val ..."
  if (!line.startsWith('MSG:')) return;
  const body = line.slice(line.indexOf('\t') + 1).trim();
  const parts = body.split(/\s+/);
  if (parts.length === 0) return;
  const tag = parts[0];
  const kv = {};
  for (let i = 1; i < parts.length; ++i) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) kv[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
  }
  switch (tag) {
    case 'TIME': handleTime(kv); break;
    case 'CONFIG': handleConfig(kv); break;
    case 'EVENTS': handleEvents(kv); break;
    case 'BAT': handleBat(kv); break;
    case 'LOG': handleLogCount(kv); break;
    case 'LOGENTRY': handleLogEntry(kv); break;
    case 'LOGEND': handleLogEnd(); break;
    case 'LOGCLEARED': handleLogCleared(); break;
    case 'TRANSMIT': handleTransmit(kv); break;
    case 'TRANSMITDONE': handleTransmitDone(); break;
  }
}

function handleTransmit(kv) {
  ui.txStatus.textContent = 'transmitting: ' + (kv.message ?? '?');
  ui.txSendBtn.disabled = true;
}

function handleTransmitDone() {
  ui.txStatus.textContent = 'done';
  ui.txSendBtn.disabled = !state.writer;
}

function handleTime(kv) {
  const unix = parseInt(kv.unix, 10);
  if (!Number.isFinite(unix)) return;
  state.deviceUnix = unix;
  state.deviceUnixReadAt = Date.now();
  ui.deviceUnix.textContent = unix;
  ui.deviceTime.textContent = new Date(unix * 1000).toISOString().replace('T', ' ').replace(/\..+$/, ' UTC');
  const drift = unix - Math.floor(Date.now() / 1000);
  ui.timeDrift.textContent = (drift >= 0 ? '+' : '') + drift + ' s';
}

const STATE_NAMES = ['UNRELEASED', 'RELEASING', 'RELEASED'];
function handleConfig(kv) {
  state.config = {
    version: parseInt(kv.version, 10),
    id: parseInt(kv.id, 10),
    sleep: parseInt(kv.sleep, 10),
    awake: parseInt(kv.awake, 10),
    stateValue: parseInt(kv.state, 10),
    events: parseInt(kv.events, 10),
  };
  ui.cfgVersion.textContent = state.config.version;
  ui.cfgIdCurrent.textContent = 'current: ' + state.config.id;
  ui.cfgSleepCurrent.textContent = 'current: ' + state.config.sleep;
  ui.cfgAwakeCurrent.textContent = 'current: ' + state.config.awake;
  const stateName = STATE_NAMES[state.config.stateValue] || ('?' + state.config.stateValue);
  ui.cfgStateCurrent.textContent = 'current: ' + state.config.stateValue + ' (' + stateName + ')';
  if (document.activeElement !== ui.cfgId) ui.cfgId.value = state.config.id;
  if (document.activeElement !== ui.cfgSleep) ui.cfgSleep.value = state.config.sleep;
  if (document.activeElement !== ui.cfgAwake) ui.cfgAwake.value = state.config.awake;
  if (document.activeElement !== ui.cfgState) ui.cfgState.value = String(state.config.stateValue);
  if (Number.isFinite(state.config.events)) applyEventsMask(state.config.events);
}

function handleEvents(kv) {
  const mask = parseInt(kv.mask, 10);
  if (Number.isFinite(mask)) {
    if (state.config) state.config.events = mask;
    applyEventsMask(mask);
  }
}

function buildEventCheckboxes() {
  const frag = document.createDocumentFragment();
  for (const bit of EVENT_TOGGLE_BITS) {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 12px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.bit = String(bit);
    cb.disabled = true;
    wrap.appendChild(cb);
    const txt = document.createElement('span');
    txt.textContent = EVENT_TYPE_NAMES[bit];
    wrap.appendChild(txt);
    frag.appendChild(wrap);
  }
  ui.cfgEvents.innerHTML = '';
  ui.cfgEvents.appendChild(frag);
}

function applyEventsMask(mask) {
  const u32 = (mask >>> 0);
  ui.cfgEvents.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (document.activeElement === cb) return;
    const bit = parseInt(cb.dataset.bit, 10);
    cb.checked = (u32 & (1 << bit)) !== 0;
  });
  ui.cfgEventsCurrent.textContent = 'current: 0x' + u32.toString(16).padStart(8, '0');
}

function readEventsMaskFromUi() {
  let mask = state.config && Number.isFinite(state.config.events) ? (state.config.events >>> 0) : 0xFFFFFFFF;
  ui.cfgEvents.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const bit = parseInt(cb.dataset.bit, 10);
    if (cb.checked) mask |= (1 << bit);
    else mask &= ~(1 << bit);
  });
  return mask >>> 0;
}

function handleBat(kv) {
  const v = parseFloat(kv.volts);
  ui.battery.textContent = Number.isFinite(v) ? v.toFixed(3) + ' V' : '—';
}

function handleLogCount(kv) {
  const n = parseInt(kv.count, 10);
  ui.logCount.textContent = 'count: ' + (Number.isFinite(n) ? n : '?');
}

let dumpInProgress = false;
function handleLogEntry(kv) {
  if (!dumpInProgress) {
    state.logEntries = [];
    dumpInProgress = true;
  }
  state.logEntries.push({
    idx: parseInt(kv.idx, 10),
    type: parseInt(kv.type, 10),
    attr: parseInt(kv.attr, 10),
    time: parseInt(kv.time, 10),
    value: parseInt(kv.value, 10),
  });
  // Defer DOM rendering until LOGEND to keep the read loop responsive.
}

function handleLogEnd() {
  dumpInProgress = false;
  // Build all rows in one DocumentFragment, then a single insert.
  // Newest at top: iterate entries in reverse.
  const frag = document.createDocumentFragment();
  for (let i = state.logEntries.length - 1; i >= 0; --i) {
    frag.appendChild(buildLogRow(state.logEntries[i]));
  }
  ui.logBody.innerHTML = '';
  ui.logBody.appendChild(frag);
  ui.logEmpty.style.display = state.logEntries.length === 0 ? 'block' : 'none';
  ui.downloadCsvBtn.disabled = state.logEntries.length === 0;
  log('[dump complete: ' + state.logEntries.length + ' entries]', 'tx');
}

function handleLogCleared() {
  state.logEntries = [];
  ui.logBody.innerHTML = '';
  ui.logEmpty.style.display = 'block';
  ui.downloadCsvBtn.disabled = true;
  ui.logCount.textContent = 'count: 0';
  log('[device log cleared]', 'tx');
}

function buildLogRow(e) {
  const tr = document.createElement('tr');
  const typeName = EVENT_TYPE_NAMES[e.type] || ('TYPE_' + e.type);
  const dateStr = e.time > 0 ? new Date(e.time * 1000).toISOString().replace('T', ' ').replace(/\..+$/, '') : '—';
  let attrStr = String(e.attr);
  if (typeName === 'DECODED') {
    attrStr = formatDecodedAttr(e.attr);
  }
  const valU16 = e.value & 0xFFFF;
  const valHex = '0x' + valU16.toString(16).toUpperCase().padStart(4, '0');
  const valBin = valU16.toString(2).padStart(16, '0');
  const hexStyle = TEST_MESSAGES.has(valU16) ? ' style="color: var(--good)"' : '';
  tr.innerHTML = `<td>${e.idx}</td><td>${typeName}</td><td>${attrStr}</td><td>${dateStr}</td><td>${e.time}</td><td>${e.value}</td><td${hexStyle}>${valHex}</td><td>${valBin}</td>`;
  return tr;
}

function downloadCsv() {
  const rows = [['idx', 'type_id', 'type_name', 'attr', 'unix', 'iso_utc', 'value', 'value_hex', 'value_bin']];
  for (const e of state.logEntries) {
    const typeName = EVENT_TYPE_NAMES[e.type] || '';
    let attrStr = String(e.attr);
    if (typeName === 'DECODED') {
      attrStr = formatDecodedAttr(e.attr);
    }
    const valU16 = e.value & 0xFFFF;
    const valHex = '0x' + valU16.toString(16).toUpperCase().padStart(4, '0');
    const valBin = valU16.toString(2).padStart(16, '0');
    rows.push([
      e.idx, e.type, typeName, attrStr, e.time,
      e.time > 0 ? new Date(e.time * 1000).toISOString() : '', e.value, valHex, valBin,
    ]);
  }
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ars_event_log_' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// Wire up UI
ui.connectBtn.addEventListener('click', connect);
ui.disconnectBtn.addEventListener('click', disconnect);
ui.readTimeBtn.addEventListener('click', () => send('--time'));
ui.syncTimeBtn.addEventListener('click', syncTimeToNow);
ui.readBatBtn.addEventListener('click', () => send('--bat'));
ui.readConfigBtn.addEventListener('click', () => send('--config'));
ui.setIdBtn.addEventListener('click', () => {
  const v = parseInt(ui.cfgId.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 65535) return alert('Invalid ID');
  send('--id -set ' + v);
  setTimeout(() => send('--config'), 100);
});
ui.setSleepBtn.addEventListener('click', () => {
  const v = parseInt(ui.cfgSleep.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 65535) return alert('Invalid sleep');
  send('--sleep -set ' + v);
  setTimeout(() => send('--config'), 100);
});
ui.setAwakeBtn.addEventListener('click', () => {
  const v = parseInt(ui.cfgAwake.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 65535) return alert('Invalid awake');
  send('--awake -set ' + v);
  setTimeout(() => send('--config'), 100);
});
ui.setStateBtn.addEventListener('click', () => {
  const v = parseInt(ui.cfgState.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 2) return alert('Invalid state');
  send('--state -set ' + v);
  setTimeout(() => send('--config'), 100);
});
ui.setEventsBtn.addEventListener('click', () => {
  const mask = readEventsMaskFromUi();
  send('--events -mask ' + mask);
  setTimeout(() => send('--config'), 100);
});
ui.readLogCountBtn.addEventListener('click', () => send('--log'));
ui.dumpLogBtn.addEventListener('click', () => {
  state.logEntries = [];
  ui.logBody.innerHTML = '';
  ui.logEmpty.style.display = 'block';
  ui.downloadCsvBtn.disabled = true;
  send('--log -dump');
});
ui.downloadCsvBtn.addEventListener('click', downloadCsv);
ui.clearLogTableBtn.addEventListener('click', () => {
  state.logEntries = [];
  ui.logBody.innerHTML = '';
  ui.logEmpty.style.display = 'block';
  ui.downloadCsvBtn.disabled = true;
});
ui.clearDeviceLogBtn.addEventListener('click', () => {
  if (!confirm('Erase all event log entries on the device? This cannot be undone.')) return;
  send('--log -clear');
  // Clearing the EEPROM takes ~1-2s on device; refresh count after a delay
  setTimeout(() => send('--log'), 2500);
});
ui.consoleForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = ui.consoleInput.value;
  if (!v) return;
  send(v);
  ui.consoleInput.value = '';
});
ui.txSendBtn.addEventListener('click', () => {
  const v = parseInt(ui.txMessage.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 65535) return alert('Invalid message (0–65535)');
  send('--transmit ' + v);
});
ui.consoleClearBtn.addEventListener('click', () => { ui.console.innerHTML = ''; });

buildEventCheckboxes();

if (!navigator.serial) {
  ui.unsupported.style.display = 'block';
  ui.connectBtn.disabled = true;
} else {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target === state.port) handleConnectionLost();
  });
}
