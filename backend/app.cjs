const fs = require('node:fs');
const path = require('node:path');
const { createApplication } = require('./server.cjs');
const root = path.resolve(__dirname, '..');
const { release } = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
// Deployment remains opt-in: no extension Origin is allowed by default.
const extensionOrigins = (process.env.EXTENSION_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const { server } = createApplication({ frontendDir: path.join(root, 'frontend'), release, extensionOrigins, roomOptions: { stateDirectory: process.env.ROOM_STATE_DIR } });
// Passenger intercepts listen(); a standalone run uses PORT (3000 by default).
server.listen(Number(process.env.PORT || 3000));
