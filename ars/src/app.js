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

// --- Bluetooth (BLE) transport -----------------------------------------
// Device's Bluetooth module is an Ebyte E104-BT5005A running transparent-
// UART firmware. It exposes one GATT service with two characteristics:
//   FFF0 service
//   FFF1 "SLAVE CHANNEL" (read/notify) -- device -> browser
//   FFF2 "MAST CHANNEL"  (read/write)  -- browser -> device
// Firmware sets AT+NAME=ITD-MODEM-<id> on boot, but Chrome's service/name
// filters aren't reliable against this module's advertising data (validated
// against real hardware), so requestDevice() lists every nearby BLE device
// and the user picks the right one by name.
const BLE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const BLE_NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
const BLE_WRITE_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';
const BLE_CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb';
const BLE_WRITE_CHUNK_SIZE = 20;
const BLE_POLL_FALLBACK_MS = 400; // how often to poll readValue() once notify looks stuck
const BLE_POLL_FALLBACK_STALE_MS = 1500; // how long without any notify activity before polling kicks in

// Adapts a BLE notify characteristic to the ReadableStreamDefaultReader
// shape ({read, cancel, releaseLock}) so readLoop() doesn't need to care
// which transport it's reading from.
class BleReader {
  constructor() {
    this._queue = [];
    this._waiting = null;
    this._closed = false;
    this.lastActivityAt = 0; // last time push() was called, used by the poll fallback
    this.lastPolled = null;  // last bytes seen via poll, to avoid re-delivering a stale value
    this.pollTimer = null;
  }
  push(chunk) {
    this.lastActivityAt = Date.now();
    if (this._waiting) {
      const resolve = this._waiting;
      this._waiting = null;
      resolve({ value: chunk, done: false });
    } else {
      this._queue.push(chunk);
    }
  }
  read() {
    if (this._queue.length) return Promise.resolve({ value: this._queue.shift(), done: false });
    if (this._closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => { this._waiting = resolve; });
  }
  cancel() {
    this._closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this._waiting) {
      const resolve = this._waiting;
      this._waiting = null;
      resolve({ value: undefined, done: true });
    }
  }
  releaseLock() {
    // handleConnectionLost() (the involuntary-disconnect/reconnect path)
    // only calls releaseLock(), never cancel() -- clear the poll timer here
    // too so it can't outlive the connection it was polling for.
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Some Web Bluetooth polyfills (confirmed on Bluefy on iOS -- writes/reads
// work fine but characteristicvaluechanged is never delivered even though
// startNotifications() doesn't throw: see
// https://github.com/capacitor-community/bluetooth-le/issues/470) silently
// fail to actually wire up notifications. Since this is unverifiable without
// the specific broken browser in hand, three independent, harmless-if-unused
// fallbacks are stacked here rather than betting on one:
//   1. Bind the value-changed handler both the standard way and via the
//      legacy on... property, in case a given polyfill only fires one.
//   2. Also explicitly write the CCCD descriptor -- on a polyfill where
//      startNotifications() is a no-op, this may be what actually flips the
//      peripheral into notifying. No-op/harmless where it's unsupported or
//      redundant.
//   3. If nothing arrives via notify for a while, fall back to polling
//      readValue(). Imperfect for multi-chunk responses (a poll only ever
//      sees whatever the single latest chunk happens to be, so intermediate
//      chunks can be missed) -- but far better than total silence.
// A polyfill can fail a step by hanging forever instead of rejecting (seen
// while testing on Bluefy) -- wrap every speculative step below in a timeout
// so a broken one can't block the whole connection.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

async function setupNotify(notifyChar, bleReader) {
  const onValue = (value) => {
    bleReader.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  };
  try {
    notifyChar.addEventListener('characteristicvaluechanged', (e) => onValue(e.target.value));
  } catch (e) {
    log('[bluetooth addEventListener failed: ' + e.message + ']', 'warn');
  }
  try {
    notifyChar.oncharacteristicvaluechanged = (e) => onValue(e.target.value);
  } catch (_) {
    // Some implementations don't expose this as a settable property --
    // fine, addEventListener above is the standards-track path anyway.
  }

  try {
    await withTimeout(notifyChar.startNotifications(), 4000);
  } catch (e) {
    log('[bluetooth startNotifications failed/timed out: ' + e.message + ']', 'warn');
  }

  try {
    const cccd = await withTimeout(notifyChar.getDescriptor(BLE_CCCD_UUID), 2000);
    await withTimeout(cccd.writeValue(Uint8Array.of(0x01, 0x00)), 2000);
  } catch (_) {
    // Not fatal -- most stacks don't need this once startNotifications() has
    // run, and some polyfills don't expose descriptors at all (or hang
    // instead of rejecting, which withTimeout guards against).
  }

  bleReader.lastActivityAt = Date.now();
  bleReader.pollInFlight = false;
  bleReader.pollTimer = setInterval(async () => {
    if (Date.now() - bleReader.lastActivityAt < BLE_POLL_FALLBACK_STALE_MS) return;
    // If a previous tick's readValue() never settled, don't pile another one
    // on top of it -- on a broken stack that can turn into every future GATT
    // operation silently failing ("already in progress"), which would look
    // identical to notify just never working.
    if (bleReader.pollInFlight) return;
    bleReader.pollInFlight = true;
    try {
      const value = await withTimeout(notifyChar.readValue(), BLE_POLL_FALLBACK_MS * 3);
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (!bytesEqual(bytes, bleReader.lastPolled)) {
        bleReader.lastPolled = bytes;
        onValue(value);
      }
    } catch (_) {
      // Transient GATT busy/timeout -- next tick retries.
    } finally {
      bleReader.pollInFlight = false;
    }
  }, BLE_POLL_FALLBACK_MS);
}

// Adapts a BLE write characteristic to the WritableStreamDefaultWriter
// shape ({write, releaseLock}) used by send(). Chunked to BLE_WRITE_CHUNK_SIZE
// since a single GATT write is limited to the negotiated ATT MTU.
//
// Web Bluetooth allows only one in-flight GATT operation per device --
// overlapping writeValue() calls throw "GATT operation already in
// progress". send() callers fire sends back-to-back without awaiting each
// one (fine for USB, where the WritableStream queues for us), so writes are
// queued here instead of relying on every call site to serialize itself.
class BleWriter {
  constructor(characteristic) {
    this._char = characteristic;
    this._chain = Promise.resolve();
  }
  write(data) {
    const run = () => this._writeChunks(data);
    this._chain = this._chain.then(run, run);
    return this._chain;
  }
  async _writeChunks(data) {
    for (let offset = 0; offset < data.length; offset += BLE_WRITE_CHUNK_SIZE) {
      const chunk = data.slice(offset, offset + BLE_WRITE_CHUNK_SIZE);
      if ('writeValueWithoutResponse' in this._char) {
        await this._char.writeValueWithoutResponse(chunk);
      } else {
        await this._char.writeValue(chunk);
      }
    }
  }
  releaseLock() {}
}

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), dot: $('dot'),
  connectBtn: $('connectBtn'), connectBluetoothBtn: $('connectBluetoothBtn'), disconnectBtn: $('disconnectBtn'),
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
  transport: null,      // 'usb' | 'bluetooth' | null -- which transport is live right now
  lastTransport: null,  // sticky across disconnects, picks the reconnect strategy
  bleDevice: null,       // live BluetoothDevice, cleared on disconnect
  lastBleDevice: null,   // sticky BluetoothDevice, reused to retry the same device
  ack: { config: 0, time: 0, bat: 0, log: 0 }, // Date.now() of the last time each response tag was seen
};
const RECONNECT_INTERVAL_MS = 1000;
// tag (from "MSG:\tTAG ...") -> state.ack key, for the read-only "getter" queries
const ACK_KEY_BY_TAG = { CONFIG: 'config', TIME: 'time', BAT: 'bat', LOG: 'log' };
const GETTER_CMD_BY_ACK_KEY = { config: '--config', time: '--time', bat: '--bat', log: '--log' };

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
  ui.connectBtn.disabled = connected || !navigator.serial;
  ui.connectBluetoothBtn.disabled = connected || !navigator.bluetooth;
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
  state.transport = 'usb';
  state.lastTransport = 'usb';
  state.shouldReconnect = true;
  setConnected(true);
  log('[connected]', 'tx');
  state.readLoop = readLoop();
  // Initial pull
  setTimeout(() => {
    if (ui.autoSyncTime.checked) syncTimeToNow();
    requestInitialData();
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

function requestInitialData() {
  state.ack = { config: 0, time: 0, bat: 0, log: 0 };
  // Fired concurrently -- each retries independently until acked (see
  // sendUntilAcked); the underlying writer already serializes the actual
  // wire sends, so these don't race each other.
  for (const ackKey of Object.keys(GETTER_CMD_BY_ACK_KEY)) {
    sendUntilAcked(ackKey);
  }
}

async function openBluetoothDevice(device) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_SERVICE_UUID);
  const notifyChar = await service.getCharacteristic(BLE_NOTIFY_UUID);
  const writeChar = await service.getCharacteristic(BLE_WRITE_UUID);

  const bleReader = new BleReader();
  await setupNotify(notifyChar, bleReader);

  // Reused on auto-reconnect (same device object) -- avoid stacking listeners.
  device.removeEventListener('gattserverdisconnected', handleConnectionLost);
  device.addEventListener('gattserverdisconnected', handleConnectionLost);

  state.port = null;
  state.bleDevice = device;
  state.lastBleDevice = device;
  state.reader = bleReader;
  state.writer = new BleWriter(writeChar);
  state.rxBuf = '';
  state.transport = 'bluetooth';
  state.lastTransport = 'bluetooth';
  state.shouldReconnect = true;
  setConnected(true);
  log('[connected via bluetooth: ' + (device.name || device.id) + ']', 'tx');
  state.readLoop = readLoop();
  setTimeout(() => {
    if (ui.autoSyncTime.checked) syncTimeToNow();
    requestInitialData();
  }, 100);
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    ui.unsupported.style.display = 'block';
    return;
  }
  try {
    // acceptAllDevices (rather than a services/name filter) is what's been
    // validated against the real module -- Chrome's filter matching isn't
    // reliable against its advertising data, so the user picks the right
    // device by name (set to ITD-MODEM-<id> by the firmware) from the list.
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE_UUID],
    });
    await openBluetoothDevice(device);
  } catch (e) {
    log('[bluetooth connect failed: ' + e.message + ']', 'err');
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
    if (state.transport === 'usb' && state.port) {
      try { await state.port.close(); } catch (_) {}
    } else if (state.transport === 'bluetooth' && state.bleDevice) {
      try { state.bleDevice.removeEventListener('gattserverdisconnected', handleConnectionLost); } catch (_) {}
      try { if (state.bleDevice.gatt.connected) state.bleDevice.gatt.disconnect(); } catch (_) {}
    }
  } catch (e) {
    log('[disconnect error: ' + e.message + ']', 'err');
  } finally {
    state.port = state.reader = state.writer = state.bleDevice = null;
    state.transport = null;
    setConnected(false);
    log('[disconnected]', 'tx');
  }
}

// Called when the connection is lost involuntarily (cable unplugged, device
// out of range, reset, etc.) -- also fires as the 'gattserverdisconnected'
// listener for the Bluetooth path.
function handleConnectionLost() {
  if (!state.port && !state.reader && !state.writer) return;
  log('[connection lost]', 'warn');
  try { state.reader && state.reader.releaseLock(); } catch (_) {}
  try { state.writer && state.writer.releaseLock(); } catch (_) {}
  if (state.bleDevice) {
    try { state.bleDevice.removeEventListener('gattserverdisconnected', handleConnectionLost); } catch (_) {}
  }
  state.port = state.reader = state.writer = state.bleDevice = null;
  state.transport = null;
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
  if (!state.shouldReconnect || state.reader) return;
  if (state.lastTransport === 'bluetooth') {
    if (!state.lastBleDevice) {
      scheduleReconnect();
      return;
    }
    try {
      log('[reconnecting...]', 'tx');
      await openBluetoothDevice(state.lastBleDevice);
    } catch (_) {
      scheduleReconnect();
    }
    return;
  }
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
    if (state.transport) log('[read error: ' + e.message + ']', 'err');
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

// Retries a read-only "getter" command (--config/--time/--bat/--log) until
// its response tag is actually seen, rather than assuming one send == one
// answer. Needed because Bluetooth's raw UART link can drop/garble a command
// if it lands while the device is mid-decode (see IntegratedParser.h);
// resending a read-only query is always safe. No-op for USB, which doesn't
// have this failure mode -- retries there just never trigger past attempt 1.
async function sendUntilAcked(ackKey, { retries = 6, intervalMs = 1000 } = {}) {
  const cmd = GETTER_CMD_BY_ACK_KEY[ackKey];
  for (let attempt = 0; attempt < retries; attempt++) {
    if (!state.writer) return false;
    const requestedAt = Date.now();
    await send(cmd);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (state.ack[ackKey] >= requestedAt) return true;
  }
  return false;
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
  const ackKey = ACK_KEY_BY_TAG[tag];
  if (ackKey) state.ack[ackKey] = Date.now();
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
ui.connectBluetoothBtn.addEventListener('click', connectBluetooth);
ui.disconnectBtn.addEventListener('click', disconnect);
ui.readTimeBtn.addEventListener('click', () => sendUntilAcked('time'));
ui.syncTimeBtn.addEventListener('click', syncTimeToNow);
ui.readBatBtn.addEventListener('click', () => sendUntilAcked('bat'));
ui.readConfigBtn.addEventListener('click', () => sendUntilAcked('config'));
ui.setIdBtn.addEventListener('click', () => {
  const v = parseInt(ui.cfgId.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 65535) return alert('Invalid ID');
  send('--id -set ' + v);
  setTimeout(() => sendUntilAcked('config'), 100);
});
ui.setSleepBtn.addEventListener('click', () => {
  const v = parseInt(ui.cfgSleep.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 65535) return alert('Invalid sleep');
  send('--sleep -set ' + v);
  setTimeout(() => sendUntilAcked('config'), 100);
});
ui.setAwakeBtn.addEventListener('click', () => {
  const v = parseInt(ui.cfgAwake.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 65535) return alert('Invalid awake');
  send('--awake -set ' + v);
  setTimeout(() => sendUntilAcked('config'), 100);
});
ui.setStateBtn.addEventListener('click', () => {
  const v = parseInt(ui.cfgState.value, 10);
  if (!Number.isFinite(v) || v < 0 || v > 2) return alert('Invalid state');
  send('--state -set ' + v);
  setTimeout(() => sendUntilAcked('config'), 100);
});
ui.setEventsBtn.addEventListener('click', () => {
  const mask = readEventsMaskFromUi();
  send('--events -mask ' + mask);
  setTimeout(() => sendUntilAcked('config'), 100);
});
ui.readLogCountBtn.addEventListener('click', () => sendUntilAcked('log'));
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
  setTimeout(() => sendUntilAcked('log'), 2500);
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

if (!navigator.serial && !navigator.bluetooth) {
  ui.unsupported.style.display = 'block';
}
ui.connectBtn.disabled = !navigator.serial;
ui.connectBluetoothBtn.disabled = !navigator.bluetooth;
if (navigator.serial) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target === state.port) handleConnectionLost();
  });
}
