const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { createRoomManager } = require('./rooms.cjs');
const { randomBytes } = require('node:crypto');

function createApplication({ frontendDir, release = 'development', roomOptions, developmentDiagnostics = false, extensionOrigins = [] } = {}) {
  const allowedExtensions = new Set(extensionOrigins.filter(origin => /^chrome-extension:\/\/[a-p]{32}$/.test(origin)));
  const app = express();
  const instance = randomBytes(8).toString('hex'); // Public process marker, never PID or credentials.
  app.disable('x-powered-by');
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ service: '04agtogether', status: 'ok', release, transport: 'polling', instance });
  });
  for (const [route, method] of [['/api/rooms/join', 'joinByLogin'], ['/api/rooms/access', 'configureLogin']]) {
    app.post(route, (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      const origin = req.headers.origin;
      let sameOrigin = !origin;
      try { sameOrigin ||= new URL(origin).host === req.headers.host; } catch {}
      if (!sameOrigin && !allowedExtensions.has(origin)) return res.status(403).json({ ok: false, error: { message: 'Недоверенный источник запроса.' } });
      if (allowedExtensions.has(origin)) { res.set('Access-Control-Allow-Origin', origin); res.vary('Origin'); }
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || req.headers['x-forwarded-ssl'] === 'on' || req.headers.https === 'on';
      if (!secure && !(release === 'development' && loopback)) return res.status(400).json({ ok: false, error: { message: 'Откройте сайт по HTTPS, чтобы передать пароль безопасно.' } });
      if (!req.is('application/json')) return res.status(415).json({ ok: false, error: { message: 'Нужен JSON-запрос.' } });
      next();
    }, express.json({ limit: '4kb' }), async (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ ok: false, error: { message: 'Некорректный запрос.' } });
      try {
        const reply = await rooms[method](req.body, req.socket.remoteAddress || 'unknown');
        res.status(reply.error?.code === 'RATE_LIMIT' ? 429 : 200).json(reply);
      } catch { res.status(500).json({ ok: false, error: { message: 'Не удалось выполнить запрос. Повторите позже.' } }); }
    });
    app.options(route, (req, res) => {
      if (!allowedExtensions.has(req.headers.origin)) return res.status(403).end();
      res.set({ 'Access-Control-Allow-Origin': req.headers.origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }).vary('Origin').status(204).end();
    });
  }
  app.use('/api/rooms', (error, _req, res, _next) => res.status(400).json({ ok: false, error: { message: 'Некорректный или слишком большой запрос.' } }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  if (frontendDir) {
    app.use('/downloads', (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      if (/^\/04agtogether-extension(?:-v\d+(?:\.\d+){1,3})?\.zip$/.test(req.path)) {
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename="${path.basename(req.path)}"`);
      } else if (req.path !== '/extension.json') return res.status(404).end();
      next();
    }, express.static(path.join(frontendDir, 'downloads'), { dotfiles: 'deny', index: false, etag: false, lastModified: false }), (_req, res) => res.status(404).end());
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
    cors: { origin: (origin, callback) => callback(null, allowedExtensions.has(origin)), methods: ['GET', 'POST'] },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (allowedExtensions.has(origin)) return callback(null, true);
      if (!origin) return callback(null, true);
      try { callback(null, new URL(origin).host === req.headers.host); }
      catch { callback(null, false); }
    }
  });
  const rooms = createRoomManager(io, { ...roomOptions, developmentDiagnostics });
  server.once('close', rooms.close);
  io.on('connection', socket => {
    rooms.register(socket);
    socket.on('infra:ping', callback => {
      if (typeof callback === 'function') callback({ service: '04agtogether', transport: socket.conn.transport.name, instance });
    });
  });
  return { server, io, rooms };
}
module.exports = { createApplication };
