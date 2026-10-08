"use strict";
/* Shared state between the tabs. Defined before the tools load, so each can hook in:
   the Console publishes its connection, event-log dumps and --uilog lines here, and the
   Audio / Motor log tabs listen. */
window.ITD = (function () {
  const handlers = {};
  const api = {
    active: "console",
    eventLog: null,
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
    emit(evt, data) { (handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
    isActive(tab) { return api.active === tab; },
    // called by the Console (src/console/app.js)
    onEventLog(entries) { api.eventLog = entries; api.emit("eventlog", entries); },
    onUiLogLine(line) { api.emit("uilogline", line); },
    onConnection(connected) { api.emit("connection", connected); },
  };
  return api;
})();
