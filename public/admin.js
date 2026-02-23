const el = {
  token: document.getElementById("token"),
  applyToken: document.getElementById("applyToken"),
  authStatus: document.getElementById("authStatus"),
  healthOk: document.getElementById("healthOk"),
  healthPlayers: document.getElementById("healthPlayers"),
  healthRedis: document.getElementById("healthRedis"),
  uptime: document.getElementById("uptime"),
  pid: document.getElementById("pid"),
  playersOnline: document.getElementById("playersOnline"),
  socketsOnline: document.getElementById("socketsOnline"),
  counters: document.getElementById("counters"),
  lastUpdate: document.getElementById("lastUpdate"),
  error: document.getElementById("error"),
};

const state = {
  token: "",
};

function setText(node, value) {
  node.textContent = String(value);
}

function renderCounters(counters) {
  const entries = Object.entries(counters || {});
  el.counters.innerHTML = "";

  for (const [key, value] of entries) {
    const box = document.createElement("div");
    box.className = "counter";
    box.innerHTML = `<div class="k">${key}</div><div class="v">${value}</div>`;
    el.counters.appendChild(box);
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

async function refresh() {
  const health = await fetchJson("/api/health");
  if (health.ok && health.data) {
    setText(el.healthOk, health.data.ok);
    setText(el.healthPlayers, health.data.players);
    setText(el.healthRedis, health.data.redisEnabled);
  }

  const headers = {};
  if (state.token) {
    headers["x-stats-token"] = state.token;
  }

  const stats = await fetchJson("/api/stats", { headers });
  if (stats.ok && stats.data) {
    setText(el.uptime, `${stats.data.uptimeSec}s`);
    setText(el.pid, stats.data.pid);
    setText(el.playersOnline, stats.data.playersOnline);
    setText(el.socketsOnline, stats.data.socketsOnline);
    renderCounters(stats.data.counters);
    setText(el.error, "-");
  } else {
    setText(el.error, `Stats error ${stats.status}. Kiem tra token.`);
  }

  setText(el.lastUpdate, new Date().toLocaleString());
}

el.applyToken.addEventListener("click", () => {
  state.token = el.token.value.trim();
  if (state.token) {
    setText(el.authStatus, "Dang su dung /stats voi token.");
  } else {
    setText(el.authStatus, "Dang su dung /stats khong token.");
  }
  refresh();
});

refresh();
setInterval(refresh, 2000);
