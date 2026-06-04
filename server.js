const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Server } = require('socket.io'); // Trocado de 'ws' para 'socket.io'

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

// ── Socket.IO Server ─────────────────────────────────────────
// Configurado com 'allowEIO3' e CORS aberto para garantir máxima
// compatibilidade com o mecanismo de Polling do Opera Mini.
const io = new Server(server, {
  allowEIO3: true,
  cors: { origin: "*" }
});

// Mapa de clientes: socket.id -> { name, color }
const clients = new Map();

// Cores fixas para apelidos
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

function userList() {
  const list = [];
  clients.forEach(v => list.push({ name: v.name, color: v.color }));
  return list;
}

io.on('connection', (socket) => {
  let registered = false;

  socket.on('message', (rawData) => {
    let data;
    try { 
      // O Socket.IO às vezes decodifica o JSON automaticamente dependendo do cliente
      data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData; 
    } catch(e) { return; }

    // ── Registro ──────────────────────────────────────────
    if (data.type === 'join') {
      let name = String(data.name || '').trim().slice(0, 24);
      if (!name) name = 'Anonimo';

      // Garantir unicidade do nome
      const taken = new Set();
      clients.forEach(v => taken.add(v.name.toLowerCase()));
      let base = name, i = 2;
      while (taken.has(name.toLowerCase())) {
        name = base + i++;
      }

      const color = nextColor();
      clients.set(socket.id, { name, color });
      registered = true;

      // Confirmar ao próprio usuário
      socket.emit('message', JSON.stringify({
        type: 'welcome',
        name,
        color,
        onlineCount: clients.size,
        users: userList()
      }));

      // Avisar aos demais usuários
      socket.broadcast.emit('message', JSON.stringify({
        type: 'user_join',
        name,
        color,
        onlineCount: clients.size,
        users: userList()
      }));

      return;
    }

    if (!registered) return;
    const me = clients.get(socket.id);

    // ── Mensagem de chat ───────────────────────────────────
    if (data.type === 'chat') {
      const text = String(data.text || '').trim().slice(0, 500);
      if (!text) return;

      // Envia para todos na sala
      io.emit('message', JSON.stringify({
        type: 'chat',
        name: me.name,
        color: me.color,
        text,
        ts: Date.now()
      }));
    }
  });

  // Trata a desconexão do usuário
  socket.on('disconnect', () => {
    if (!registered) return;
    const me = clients.get(socket.id);
    clients.delete(socket.id);
    
    // Avisa os outros que o usuário saiu
    io.emit('message', JSON.stringify({
      type: 'user_leave',
      name: me.name,
      color: me.color,
      onlineCount: clients.size,
      users: userList()
    }));
  });
});

server.listen(PORT, () => {
  console.log('Chat server running on port ' + PORT);
});
