const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════
// ESTADO COMPARTILHADO
// ════════════════════════════════════════════════════════════
const COLORS = [
  '#f87171','#fb923c','#fbbf24','#a3e635',
  '#34d399','#22d3ee','#60a5fa','#a78bfa',
  '#f472b6','#e879f9','#94a3b8','#86efac'
];
let colorIndex = 0;
function nextColor() { return COLORS[(colorIndex++) % COLORS.length]; }

const history = [];
function pushHistory(msg) {
  history.push(msg);
  if (history.length > 100) history.shift();
}

// Clientes Socket.IO: socket -> { name, color }
const wsClients = new Map();

// Sessões Opera Mini: token -> { name, color, lastSeen }
const miniSessions = new Map();

// Limpa sessões Opera Mini inativas > 45s
setInterval(() => {
  const now = Date.now();
  miniSessions.forEach((sess, token) => {
    if (now - sess.lastSeen > 45000) {
      miniSessions.delete(token);
      const msg = { type:'user_leave', name:sess.name, color:sess.color, ts:Date.now() };
      pushHistory(msg);
      broadcastSocketIO({ ...msg, onlineCount: onlineCount() });
    }
  });
}, 15000);

// Broadcast para clientes Socket.IO
// CORRIGIDO: usa socket.connected em vez de readyState
function broadcastSocketIO(data) {
  const txt = JSON.stringify(data);
  wsClients.forEach((info, sock) => {
    if (sock.connected) sock.emit('message', txt);
  });
}

function takenNames() {
  const s = new Set();
  wsClients.forEach(v  => s.add(v.name.toLowerCase()));
  miniSessions.forEach(v => s.add(v.name.toLowerCase()));
  return s;
}
function uniqueName(raw) {
  let name = String(raw || '').trim().slice(0, 24) || 'Anonimo';
  const taken = takenNames();
  let base = name, i = 2;
  while (taken.has(name.toLowerCase())) name = base + (i++);
  return name;
}
function onlineCount() { return wsClients.size + miniSessions.size; }

function genToken() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 24; i++) t += c[Math.floor(Math.random() * c.length)];
  return t;
}

// ════════════════════════════════════════════════════════════
// HTTP SERVER
// ════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  if (req.url && req.url.indexOf('/socket.io') === 0) return;

  const urlFull = req.url || '/';
  const urlPath = urlFull.split('?')[0];

  // Rotas Opera Mini
  if (urlPath === '/mini/join' && req.method === 'POST') { handleMiniJoin(req, res); return; }
  if (urlPath === '/mini/chat')                          { handleMiniChat(req, res); return; }
  if (urlPath === '/mini/msgs')                          { handleMiniChat(req, res); return; }
  if (urlPath === '/mini/form')                          { handleMiniChat(req, res); return; }

  // Arquivos estáticos
  const filePath = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(__dirname, 'public', filePath);
  if (file.indexOf(path.join(__dirname, 'public')) !== 0) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(file);
    const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript' };
    res.writeHead(200, { 'Content-Type': (mime[ext] || 'text/plain') + '; charset=utf-8' });
    res.end(data);
  });
});

// ════════════════════════════════════════════════════════════
// ROTAS OPERA MINI
// ════════════════════════════════════════════════════════════

// POST /mini/join  — recebe nome, cria sessão, redireciona para o chat
function handleMiniJoin(req, res) {
  collectBody(req, body => {
    const params = parseQS(body);
    const name   = uniqueName(params.name || 'Anonimo');
    const color  = nextColor();
    const token  = genToken();
    miniSessions.set(token, { name, color, lastSeen: Date.now() });
    const msg = { type:'user_join', name, color, ts:Date.now() };
    pushHistory(msg);
    broadcastSocketIO({ ...msg, onlineCount: onlineCount() });
    res.writeHead(302, { 'Location': '/mini/chat?token=' + token });
    res.end();
  });
}

// GET  /mini/chat?token=T  — frameset: msgs em cima (auto-refresh), form embaixo
// GET  /mini/msgs?token=T  — só as mensagens (recarregado pelo meta refresh)
// POST /mini/chat          — recebe mensagem e redireciona de volta
function handleMiniChat(req, res) {
  const qs    = parseQS((req.url || '').split('?')[1] || '');
  const token = qs.token || '';
  const urlPath = (req.url || '').split('?')[0];

  // ── POST: salva mensagem, redireciona para o formulário ──
  if (req.method === 'POST') {
    collectBody(req, body => {
      const params = parseQS(body);
      const tk     = params.token || token;
      const text   = (params.text || '').trim().slice(0, 500);
      const sess   = miniSessions.get(tk);
      if (sess && text) {
        sess.lastSeen = Date.now();
        const msg = { type:'chat', name:sess.name, color:sess.color, text, ts:Date.now() };
        pushHistory(msg);
        broadcastSocketIO(msg);
      }
      // Redireciona para o frame do formulário — mantém o frameset intacto
      res.writeHead(302, { 'Location': '/mini/form?token=' + encodeURIComponent(tk) });
      res.end();
    });
    return;
  }

  // ── GET /mini/msgs — só as mensagens, com meta refresh ──
  if (urlPath === '/mini/msgs') {
    const sess = miniSessions.get(token);
    if (!sess) {
      // Sessão expirou: redireciona o frame pai para o login
      const html = '<html><head><meta http-equiv="refresh" content="0;url=/mini.html"></head><body></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    sess.lastSeen = Date.now();

    // Monta lista de mensagens
    let msgsHtml = '';
    const msgs = history.slice(-40);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.type === 'chat') {
        const own = (m.name === sess.name);
        const cor = m.color || '#aaa';
        const d   = new Date(m.ts || Date.now());
        const t   = (d.getHours()<10?'0':'') + d.getHours() + ':' + (d.getMinutes()<10?'0':'') + d.getMinutes();
        msgsHtml +=
          '<div style="margin:5px 0;padding:5px 8px;background:' + (own?'#0d2a40':'#162030') + ';border-left:3px solid ' + escHtml(cor) + '">' +
          '<b style="color:' + escHtml(cor) + '">' + escHtml(m.name) + '</b>' +
          ' <span style="color:#2a4a62;font-size:10px">' + t + '</span><br>' +
          escHtml(m.text) + '</div>';
      } else if (m.type === 'user_join') {
        msgsHtml += '<p style="text-align:center;color:#2a5060;font-size:11px;margin:2px 0"><i>' + escHtml(m.name) + ' entrou</i></p>';
      } else if (m.type === 'user_leave') {
        msgsHtml += '<p style="text-align:center;color:#2a5060;font-size:11px;margin:2px 0"><i>' + escHtml(m.name) + ' saiu</i></p>';
      }
    }
    if (!msgsHtml) msgsHtml = '<p style="text-align:center;color:#2a4a62;margin-top:20px"><i>Nenhuma mensagem ainda...</i></p>';

    const safeToken = encodeURIComponent(token);
    // meta refresh neste frame: só recarrega as mensagens, formulário não pisca
    const html =
      '<!DOCTYPE html><html><head>' +
      '<meta charset="UTF-8">' +
      '<meta http-equiv="refresh" content="4;url=/mini/msgs?token=' + safeToken + '">' +
      '<style>' +
      'body{margin:0;background:#0f1923;color:#d4dde8;font-family:courier,monospace;font-size:13px;padding:6px}' +
      '</style></head><body>' +
      '<div style="background:#0d1c2a;border-bottom:1px solid #1e3a52;padding:5px 8px;margin:-6px -6px 8px">' +
      '<b style="color:#4fc3f7;font-size:13px;letter-spacing:1px">CHATLIV RE</b>' +
      '<small style="color:#456070;margin-left:8px">' + onlineCount() + ' online</small>' +
      '<a href="/mini.html" style="float:right;color:#ef5350;font-size:11px">Sair</a>' +
      '</div>' +
      msgsHtml +
      '</body></html>';

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── GET /mini/form — só o formulário (frame de baixo, não recarrega) ──
  if (urlPath === '/mini/form') {
    const sess = miniSessions.get(token);
    if (!sess) {
      res.writeHead(302, { 'Location': '/mini.html' });
      res.end();
      return;
    }
    const html =
      '<!DOCTYPE html><html><head>' +
      '<meta charset="UTF-8">' +
      '<style>' +
      'body{margin:0;background:#0d1c2a;padding:8px}' +
      'form{display:table;width:100%;box-sizing:border-box}' +
      'input[type=text]{display:table-cell;width:100%;background:#0f1923;border:1px solid #1e3a52;' +
      'color:#d4dde8;padding:8px;font-family:courier,monospace;font-size:14px;box-sizing:border-box}' +
      'input[type=submit]{display:table-cell;width:50px;background:#0d3050;border:1px solid #4fc3f7;' +
      'color:#4fc3f7;font-size:16px;padding:8px;cursor:pointer}' +
      '</style></head><body>' +
      '<form action="/mini/chat" method="POST">' +
      '<input type="hidden" name="token" value="' + escHtml(token) + '">' +
      '<input type="text" name="text" placeholder="Digite uma mensagem..." maxlength="500" autocomplete="off">' +
      '<input type="submit" value="&#9658;">' +
      '</form>' +
      '</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── GET /mini/chat — frameset principal ──
  const sess = miniSessions.get(token);
  if (!sess) {
    res.writeHead(302, { 'Location': '/mini.html' });
    res.end();
    return;
  }
  const safeToken = encodeURIComponent(token);
  // Frameset: 80% mensagens (auto-refresh a cada 4s) + 20% formulário fixo
  const html =
    '<!DOCTYPE html><html><head>' +
    '<meta charset="UTF-8">' +
    '<title>ChatLivre</title>' +
    '</head>' +
    '<frameset rows="*,60" border="0" framespacing="0" frameborder="0">' +
    '<frame src="/mini/msgs?token=' + safeToken + '" name="msgs" scrolling="yes" noresize>' +
    '<frame src="/mini/form?token=' + safeToken + '" name="form" scrolling="no" noresize>' +
    '</frameset>' +
    '</html>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ════════════════════════════════════════════════════════════
// SOCKET.IO (Chrome, Firefox, browsers modernos)
// ════════════════════════════════════════════════════════════
const io = new Server(server, {
  allowEIO3: true,
  cors: { origin: '*' },
  pingTimeout:  60000,
  pingInterval: 20000,
  transports: ['polling', 'websocket'],
  httpCompression: false
});

io.on('connection', (socket) => {
  let registered = false;

  socket.on('message', (rawData) => {
    let data;
    try { data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData; } catch(e) { return; }
    if (data.type === 'poll_refresh') return;

    if (data.type === 'join') {
      if (registered) return;
      const name  = uniqueName(data.name);
      const color = nextColor();
      wsClients.set(socket, { name, color });
      registered = true;
      socket.emit('message', JSON.stringify({
        type:'welcome', name, color,
        onlineCount: onlineCount(),
        history: history.slice(-30)
      }));
      const joinMsg = { type:'user_join', name, color, ts:Date.now() };
      pushHistory(joinMsg);
      socket.broadcast.emit('message', JSON.stringify({ ...joinMsg, onlineCount: onlineCount() }));
      return;
    }

    if (!registered) return;
    const me = wsClients.get(socket);
    if (!me) return;

    if (data.type === 'chat') {
      const text = String(data.text || '').trim().slice(0, 500);
      if (!text) return;
      const msg = { type:'chat', name:me.name, color:me.color, text, ts:Date.now() };
      pushHistory(msg);
      io.emit('message', JSON.stringify(msg));
    }
  });

  socket.on('disconnect', () => {
    if (!registered) return;
    const me = wsClients.get(socket);
    if (!me) return;
    wsClients.delete(socket);
    const leaveMsg = { type:'user_leave', name:me.name, color:me.color, ts:Date.now() };
    pushHistory(leaveMsg);
    io.emit('message', JSON.stringify({ ...leaveMsg, onlineCount: onlineCount() }));
  });

  socket.on('error', () => wsClients.delete(socket));
});

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function parseQS(str) {
  const obj = {};
  if (!str) return obj;
  str.split('&').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    try {
      obj[decodeURIComponent(pair.slice(0, idx))] =
        decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    } catch(e) {}
  });
  return obj;
}
function collectBody(req, cb) {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end',  () => cb(b));
}
function escHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

server.listen(PORT, () => console.log('ChatLivre na porta ' + PORT));
