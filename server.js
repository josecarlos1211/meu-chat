const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// ── HTTP server ──────────────────────────────────────────────
// O Socket.IO injeta automaticamente a rota /socket.io/socket.io.js
// Este handler só precisa servir os arquivos estáticos da pasta public/
const server = http.createServer((req, res) => {
  // Ignora rotas do socket.io (tratadas pelo engine do socket.io)
  if (req.url && req.url.indexOf('/socket.io') === 0) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file    = path.join(__dirname, 'public', urlPath);

  // Previne path traversal
  if (file.indexOf(path.join(__dirname, 'public')) !== 0) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(file);
    const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── Socket.IO ────────────────────────────────────────────────
// transports: polling primeiro, depois upgrade para websocket
// Isso garante que Opera Mini (que só aceita polling) funcione
// e browsers modernos ainda usem WebSocket quando possível
const io = new Server(server, {
  allowEIO3: true,
  cors: { origin: '*' },
  pingTimeout:  60000,   // 60s sem resposta = desconectado
  pingInterval: 20000,   // ping a cada 20s para manter vivo pelo proxy
  transports: ['polling', 'websocket'],
  httpCompression: false // desliga compressão — Opera Mini às vezes não descomprime
});

// ── Estado global ────────────────────────────────────────────
const clients = new Map(); // socket.id -> { name, color }

const COLORS = [
  '#f87171','#fb923c','#fbbf24','#a3e635',
  '#34d399','#22d3ee','#60a5fa','#a78bfa',
  '#f472b6','#e879f9','#94a3b8','#86efac'
];
let colorIndex = 0;
function nextColor() { return COLORS[(colorIndex++) % COLORS.length]; }

function onlineCount() { return clients.size; }
function userList() {
  const list = [];
  clients.forEach(v => list.push({ name: v.name, color: v.color }));
  return list;
}
function takenNames() {
  const s = new Set();
  clients.forEach(v => s.add(v.name.toLowerCase()));
  return s;
}
function uniqueName(raw) {
  let name = String(raw || '').trim().slice(0, 24) || 'Anonimo';
  const taken = takenNames();
  let base = name, i = 2;
  while (taken.has(name.toLowerCase())) name = base + (i++);
  return name;
}

// Histórico das últimas 50 mensagens (para mostrar ao entrar)
const history = [];
function pushHistory(msg) {
  history.push(msg);
  if (history.length > 50) history.shift();
}

// ── Eventos Socket.IO ────────────────────────────────────────
io.on('connection', (socket) => {
  let registered = false;

  socket.on('message', (rawData) => {
    let data;
    try {
      data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    } catch(e) { return; }

    // Opera Mini envia poll_refresh para manter o canal vivo — só ignorar
    if (data.type === 'poll_refresh') return;

    // ── JOIN ─────────────────────────────────────────────
    if (data.type === 'join') {
      if (registered) return; // evita duplo registro
      const name  = uniqueName(data.name);
      const color = nextColor();
      clients.set(socket.id, { name, color });
      registered = true;

      // Boas-vindas com histórico para o próprio usuário
      socket.emit('message', JSON.stringify({
        type: 'welcome',
        name,
        color,
        onlineCount: onlineCount(),
        history: history.slice(-30)
      }));

      // Avisa os demais
      const joinMsg = { type:'user_join', name, color, onlineCount: onlineCount() };
      pushHistory({ type:'user_join', name, color, ts: Date.now() });
      socket.broadcast.emit('message', JSON.stringify(joinMsg));
      return;
    }

    if (!registered) return;
    const me = clients.get(socket.id);
    if (!me) return;

    // ── CHAT ─────────────────────────────────────────────
    if (data.type === 'chat') {
      const text = String(data.text || '').trim().slice(0, 500);
      if (!text) return;
      const msg = { type:'chat', name:me.name, color:me.color, text, ts:Date.now() };
      pushHistory(msg);
      io.emit('message', JSON.stringify(msg));
    }
  });

  // ── DISCONNECT ───────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!registered) return;
    const me = clients.get(socket.id);
    if (!me) return;
    clients.delete(socket.id);
    const leaveMsg = { type:'user_leave', name:me.name, color:me.color, onlineCount:onlineCount() };
    pushHistory({ type:'user_leave', name:me.name, color:me.color, ts: Date.now() });
    io.emit('message', JSON.stringify(leaveMsg));
  });

  socket.on('error', () => {
    clients.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log('ChatLivre rodando na porta ' + PORT);
});
