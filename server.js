const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ── HTTP server ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;
  const file = path.join(__dirname, 'public', url);

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(file);
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── WebSocket server ─────────────────────────────────────────
const wss = new WebSocket.Server({ server });

// Mapa de clientes: ws -> { name, color }
const clients = new Map();

// Cores fixas para apelidos (repetidas se necessário)
const COLORS = [
  '#f87171','#fb923c','#fbbf24','#a3e635',
  '#34d399','#22d3ee','#60a5fa','#a78bfa',
  '#f472b6','#e879f9','#94a3b8','#86efac'
];
let colorIndex = 0;

function nextColor() {
  const c = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return c;
}

function broadcast(data, exclude) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== exclude) {
      client.send(msg);
    }
  });
}

function broadcastAll(data) {
  broadcast(data, null);
}

function userList() {
  const list = [];
  clients.forEach(v => list.push({ name: v.name, color: v.color }));
  return list;
}

wss.on('connection', ws => {
  let registered = false;

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }

    // ── Registro ──────────────────────────────────────────
    if (data.type === 'join') {
      let name = String(data.name || '').trim().slice(0, 24);
      if (!name) name = 'Anonimo';

      // Garantir unicidade
      const taken = new Set();
      clients.forEach(v => taken.add(v.name.toLowerCase()));
      let base = name, i = 2;
      while (taken.has(name.toLowerCase())) {
        name = base + i++;
      }

      const color = nextColor();
      clients.set(ws, { name, color });
      registered = true;

      // Confirmar ao próprio usuário
      ws.send(JSON.stringify({
        type: 'welcome',
        name,
        color,
        onlineCount: clients.size,
        users: userList()
      }));

      // Avisar aos demais
      broadcast({
        type: 'user_join',
        name,
        color,
        onlineCount: clients.size,
        users: userList()
      }, ws);

      return;
    }

    if (!registered) return;
    const me = clients.get(ws);

    // ── Mensagem de chat ───────────────────────────────────
    if (data.type === 'chat') {
      const text = String(data.text || '').trim().slice(0, 500);
      if (!text) return;

      broadcastAll({
        type: 'chat',
        name: me.name,
        color: me.color,
        text,
        ts: Date.now()
      });
    }
  });

  ws.on('close', () => {
    if (!registered) return;
    const me = clients.get(ws);
    clients.delete(ws);
    broadcast({
      type: 'user_leave',
      name: me.name,
      color: me.color,
      onlineCount: clients.size,
      users: userList()
    }, null);
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log('Chat server running on port ' + PORT);
});