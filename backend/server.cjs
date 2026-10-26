const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');

function createApplication({ frontendDir, release = 'development' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ service: '04agtogether', status: 'ok', release, transport: 'polling' });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  if (frontendDir) {
    app.use(express.static(frontendDir, { dotfiles: 'deny', index: false }));
    app.use((req, res, next) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && !path.extname(req.path) && req.accepts('html')) {
        res.set('Cache-Control', 'no-cache').sendFile('index.html', { root: frontendDir, dotfiles: 'deny' });
      } else next();
    });
  }
  app.use((_req, res) => res.status(404).end());
  const server = http.createServer(app);
  const io = new Server(server, {
    transports: ['polling'],
    allowUpgrades: false,
    serveClient: false,
    maxHttpBufferSize: 16 * 1024,
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (!origin) return callback(null, true);
      try { callback(null, new URL(origin).host === req.headers.host); }
      catch { callback(null, false); }
    }
  });
  // Infrastructure probe only; no rooms, messaging or video synchronization yet.
  io.on('connection', socket => {
    socket.on('infra:ping', callback => {
      if (typeof callback === 'function') callback({ service: '04agtogether', transport: socket.conn.transport.name });
    });
  });
  return { server, io };
}
module.exports = { createApplication };
