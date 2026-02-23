const GRID_SIZE = 64;
const CELL_SIZE = 10;
const CANVAS_SIZE = GRID_SIZE * CELL_SIZE;

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const socket = io();

canvas.width = CANVAS_SIZE;
canvas.height = CANVAS_SIZE;

let myId = null;
let players = [];
let playersById = new Map();

function drawGrid() {
  ctx.strokeStyle = "#dbe3f0";
  ctx.lineWidth = 1;

  for (let i = 0; i <= GRID_SIZE; i += 1) {
    const p = i * CELL_SIZE;

    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, CANVAS_SIZE);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(CANVAS_SIZE, p);
    ctx.stroke();
  }
}

function drawPlayers() {
  for (const player of players) {
    ctx.fillStyle = player.color;
    ctx.fillRect(player.x * CELL_SIZE, player.y * CELL_SIZE, CELL_SIZE, CELL_SIZE);

    if (player.id === myId) {
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 1;
      ctx.strokeRect(player.x * CELL_SIZE, player.y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
  }
}

function render() {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  drawGrid();
  drawPlayers();

  const me = playersById.get(myId);
  const total = players.length;
  if (me) {
    statusEl.textContent = `Ban: (${me.x}, ${me.y}) | Mau: ${me.color} | Online: ${total}`;
  } else {
    statusEl.textContent = `Dang ket noi... | Online: ${total}`;
  }
}

function keyToDirection(key) {
  if (key === "ArrowUp" || key === "w") {
    return "up";
  }
  if (key === "ArrowDown" || key === "s") {
    return "down";
  }
  if (key === "ArrowLeft" || key === "a") {
    return "left";
  }
  if (key === "ArrowRight" || key === "d") {
    return "right";
  }
  return null;
}

window.addEventListener("keydown", (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const direction = keyToDirection(key);

  if (!direction) {
    return;
  }

  event.preventDefault();
  socket.emit("move", { direction });
});

socket.on("connect", () => {
  myId = socket.id;
});

socket.on("updatePlayers", (nextPlayers) => {
  players = Array.isArray(nextPlayers) ? nextPlayers : [];
  playersById = new Map(players.map((player) => [player.id, player]));
  render();
});

render();
