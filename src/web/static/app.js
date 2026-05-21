// First-cut SPA. Lists sessions; clicking one will (in a follow-up commit)
// open the /ws/<node>/<name> WebSocket and attach an xterm.js terminal.

const statusEl = document.getElementById("status");
const listEl = document.getElementById("sessions-list");

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
      li.dataset.url = row.url;
      li.addEventListener("click", () => openSession(row));
    }
    listEl.appendChild(li);
  }
}

function openSession(row) {
  // Placeholder — the /ws bridge lands in a follow-up commit.
  // For now we just mark active + show the URL so manual testing is possible.
  for (const el of listEl.querySelectorAll("li.active")) el.classList.remove("active");
  for (const el of listEl.querySelectorAll("li")) {
    if (el.dataset && el.dataset.url === row.url) el.classList.add("active");
  }
  const panel = document.getElementById("terminal-panel");
  const title = document.getElementById("terminal-title");
  panel.hidden = false;
  title.textContent = `${row.node}/${row.session.name} — wss://${location.host}/ws/${encodeURIComponent(row.node)}/${encodeURIComponent(row.session.name)} (bridge pending)`;
}

loadInfo();
loadSessions();
