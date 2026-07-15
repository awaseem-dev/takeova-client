// /ws — WebSocket layer for realtime panel push (round 8 contract)

const WebSocket = require('ws');
const { verifyToken } = require('../lib/auth');

const connections = new Map(); // userId -> Set<WebSocket>

function init(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    let user;
    try { user = await verifyToken(token); }
    catch (_) { ws.close(1008, 'invalid token'); return; }
    
    if (!connections.has(user.id)) connections.set(user.id, new Set());
    connections.get(user.id).add(ws);
    
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const interval = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30000);
    
    ws.on('close', () => {
      clearInterval(interval);
      connections.get(user.id)?.delete(ws);
      if (connections.get(user.id)?.size === 0) connections.delete(user.id);
    });
    
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch (_) {}
    });
    
    ws.send(JSON.stringify({ type: 'connected', userId: user.id }));
  });
}

function emitToUser(userId, message) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  const payload = JSON.stringify(message);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// Event types the frontend understands (round 8):
//   { type: 'stat', panel, slot, value }
//   { type: 'list_prepend', panel, card }
//   { type: 'list_update', panel, id, card }
//   { type: 'list_remove', panel, id }
//   { type: 'toast', message }

module.exports = { init, emitToUser };
