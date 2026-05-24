// nagent-web SPA: lists sessions across the net and renders a live xterm.js
// terminal hooked up to a ttyd-on-peer over a hub-proxied WebSocket.
//
// ttyd binary protocol summary (the wire format both legs of our WS speak):
//   client → server:
//     '0' + bytes         : keyboard input
//     '1' + JSON {cols,rows}: terminal resize
//     '{' + JSON          : initial JSON_DATA frame (AuthToken + cols/rows)
//   server → client:
//     '0' + bytes         : output to write into xterm
//     '1' + string        : set window title
//     '2' + JSON          : terminal preferences (ignored for v0.4)

import { Terminal } from "/static/vendor/xterm.mjs";
import { FitAddon } from "/static/vendor/addon-fit.mjs";

const statusEl = document.getElementById("status");
const listEl = document.getElementById("sessions-list");
const terminalPanel = document.getElementById("terminal-panel");
const terminalTitle = document.getElementById("terminal-title");
const terminalContainer = document.getElementById("terminal-container");
const modeToolbar = document.getElementById("mode-toolbar");
const modeBtnLine = document.getElementById("mode-btn-line");
const modeBtnDirect = document.getElementById("mode-btn-direct");
const controlRow = document.getElementById("control-row");
const lineForm = document.getElementById("line-form");
const lineInput = document.getElementById("line-input");

const DEFAULT_MODE = "line";
const MAX_LINE_BYTES = 16384;

let term = null;
let fit = null;
let activeWs = null;
let activeRow = null;
let currentMode = DEFAULT_MODE;

function modeKey(node, session) {
  return `nagent.mode.${node}/${session}`;
}

function readMode(node, session) {
  try {
    const v = localStorage.getItem(modeKey(node, session));
    return v === "direct" ? "direct" : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

function writeMode(node, session, mode) {
  try { localStorage.setItem(modeKey(node, session), mode); } catch { /* ignore quota */ }
}

function sendInput(payload) {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
  // Strip NULs and cap at MAX_LINE_BYTES bytes as defense-in-depth.
  let safe = payload.replace(/\x00/g, "");
  if (safe.length > MAX_LINE_BYTES) safe = safe.slice(0, MAX_LINE_BYTES);
  activeWs.send("0" + safe);
}

function applyMode(mode) {
  currentMode = mode;
  const lineActive = mode === "line";
  controlRow.hidden = !lineActive;
  lineForm.hidden = !lineActive;
  terminalContainer.classList.toggle("mode-line", lineActive);
  terminalContainer.classList.toggle("mode-direct", !lineActive);
  modeBtnLine.classList.toggle("active", lineActive);
  modeBtnDirect.classList.toggle("active", !lineActive);
  modeBtnLine.setAttribute("aria-pressed", String(lineActive));
  modeBtnDirect.setAttribute("aria-pressed", String(!lineActive));
  if (term) {
    try { term.options.disableStdin = lineActive; } catch { /* older xterm */ }
  }
  if (lineActive) {
    setTimeout(() => lineInput.focus(), 0);
  } else {
    setTimeout(() => { if (term) term.focus(); }, 0);
  }
}

function switchMode(newMode) {
  if (!activeRow || newMode === currentMode) return;
  applyMode(newMode);
  writeMode(activeRow.node, activeRow.session.name, newMode);
}

modeBtnLine.addEventListener("click", () => switchMode("line"));
modeBtnDirect.addEventListener("click", () => switchMode("direct"));

controlRow.addEventListener("click", (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest(".ctl-btn") : null;
  if (!btn) return;
  const hex = btn.getAttribute("data-send");
  if (!hex) return;
  const code = parseInt(hex, 16);
  if (Number.isNaN(code)) return;
  sendInput(String.fromCharCode(code));
  // Keep focus on the input so the user can keep typing.
  lineInput.focus();
});

lineForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const value = lineInput.value;
  // Even an empty Enter is meaningful (re-issue prompt), so always send \r.
  sendInput(value + "\r");
  lineInput.value = "";
});

async function loadInfo() {
  try {
    const r = await fetch("/api/info", { credentials: "same-origin" });
    if (!r.ok) throw new Error(`info ${r.status}`);
    const info = await r.json();
    statusEl.textContent = `hub: ${info.node}`;
    statusEl.title = `cert fingerprint: ${info.fingerprint}\nexpires: ${info.notAfter}`;
  } catch (err) {
    statusEl.textContent = `hub: (info unavailable)`;
    statusEl.title = String(err);
  }
}

async function loadSessions() {
  try {
    const r = await fetch("/api/sessions", { credentials: "same-origin" });
    if (!r.ok) throw new Error(`sessions ${r.status}`);
    const { sessions } = await r.json();
    renderSessions(sessions);
  } catch (err) {
    listEl.innerHTML = `<li class="hint">failed to load: ${String(err)}</li>`;
  }
}

function renderSessions(sessions) {
  if (!sessions.length) {
    listEl.innerHTML = `<li class="hint">no sessions in net</li>`;
    return;
  }
  listEl.innerHTML = "";
  for (const row of sessions) {
    const li = document.createElement("li");
    if (row.unreachable) {
      li.classList.add("unreachable");
      li.textContent = `${row.node} · (unreachable)`;
    } else {
      const nodeSpan = document.createElement("span");
      nodeSpan.className = "node";
      nodeSpan.textContent = `${row.node} · `;
      li.appendChild(nodeSpan);
      li.appendChild(document.createTextNode(row.session.name));
      li.dataset.node = row.node;
      li.dataset.session = row.session.name;
      li.addEventListener("click", () => openSession(row));
    }
    listEl.appendChild(li);
  }
}

async function mintToken(node, session) {
  const r = await fetch("/api/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ node, session }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`mint token failed (${r.status}): ${text}`);
  }
  const { token } = await r.json();
  return token;
}

async function openSession(row) {
  // Clear any prior selection.
  for (const el of listEl.querySelectorAll("li.active")) el.classList.remove("active");
  if (activeWs) {
    try { activeWs.close(); } catch { /* ignore */ }
    activeWs = null;
  }
  if (term) {
    term.dispose();
    term = null;
  }
  const li = listEl.querySelector(`li[data-node="${CSS.escape(row.node)}"][data-session="${CSS.escape(row.session.name)}"]`);
  if (li) li.classList.add("active");
  activeRow = row;

  terminalPanel.hidden = false;
  terminalTitle.textContent = `${row.node}/${row.session.name} — connecting…`;
  terminalContainer.innerHTML = "";
  modeToolbar.hidden = false;
  lineInput.value = "";

  const persistedMode = readMode(row.node, row.session.name);
  term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    disableStdin: persistedMode === "line",
    theme: { background: "#0d1117", foreground: "#c9d1d9" },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(terminalContainer);
  fit.fit();

  let token;
  try {
    token = await mintToken(row.node, row.session.name);
  } catch (err) {
    term.write(`\r\n\x1b[31mfailed to mint token:\x1b[0m ${err}\r\n`);
    return;
  }

  const wsUrl = `wss://${location.host}/ws/${encodeURIComponent(row.node)}/${encodeURIComponent(row.session.name)}?t=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  activeWs = ws;

  ws.addEventListener("open", () => {
    terminalTitle.textContent = `${row.node}/${row.session.name}`;
    // ttyd protocol: first message MUST be JSON_DATA.
    const init = JSON.stringify({ AuthToken: "", columns: term.cols, rows: term.rows });
    ws.send("{" + init);
  });
  ws.addEventListener("message", (ev) => {
    const data = ev.data;
    if (typeof data === "string") {
      handleServerFrame(stringToBytes(data));
    } else {
      handleServerFrame(new Uint8Array(data));
    }
  });
  ws.addEventListener("close", (ev) => {
    if (term) term.write(`\r\n\x1b[33m[disconnected${ev.reason ? `: ${ev.reason}` : ""}]\x1b[0m\r\n`);
  });
  ws.addEventListener("error", () => {
    if (term) term.write(`\r\n\x1b[31m[ws error]\x1b[0m\r\n`);
  });

  term.onData((data) => {
    // In line mode, xterm input is suppressed: the user types into the line input field instead.
    if (currentMode !== "direct") return;
    if (ws.readyState === WebSocket.OPEN) ws.send("0" + data);
  });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send("1" + JSON.stringify({ columns: cols, rows }));
  });
  window.addEventListener("resize", () => {
    if (fit && term) fit.fit();
  });

  applyMode(persistedMode);
}

function handleServerFrame(bytes) {
  if (!bytes.length || !term) return;
  const cmd = String.fromCharCode(bytes[0]);
  const body = bytes.subarray(1);
  switch (cmd) {
    case "0":
      // OUTPUT — feed raw bytes into xterm.
      term.write(body);
      break;
    case "1":
      // SET_WINDOW_TITLE
      try { document.title = `${new TextDecoder().decode(body)} — nagent-web`; } catch { /* ignore */ }
      break;
    case "2":
      // SET_PREFERENCES — ignored for v0.4.
      break;
    default:
      // Unknown — write verbatim so the user can see the diagnostic stream.
      term.write(body);
  }
}

function stringToBytes(s) {
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
  return buf;
}

loadInfo();
loadSessions();
