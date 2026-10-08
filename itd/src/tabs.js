"use strict";
/* Tab switching. The URL hash names the tab (#console, #audio, #motorlog) so a tab can be linked
   and survives a reload. Canvases size themselves from their box, which is 0x0 while hidden, so a
   resize is fired whenever a tab is shown. */
(function () {
  const tabs = [...document.querySelectorAll(".itd-tab")];
  const names = tabs.map((t) => t.dataset.tab);
  function show(name, push) {
    if (!names.includes(name)) name = "console";
    window.ITD.active = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      document.getElementById("tab-" + t.dataset.tab).hidden = !on;
    }
    if (push && location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    window.dispatchEvent(new Event("resize"));
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => show(t.dataset.tab, true));
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      const n = tabs[(i + d + tabs.length) % tabs.length];
      n.focus(); show(n.dataset.tab, true);
    });
  });
  addEventListener("hashchange", () => show(location.hash.slice(1), false));
  show(location.hash.slice(1), false);

  // connection light in the tab bar, so it is visible from every tab
  const conn = document.getElementById("itdConn");
  window.ITD.on("connection", (c) => {
    conn.classList.toggle("on", c);
    conn.lastChild.textContent = c ? " connected" : " disconnected";
  });
})();
