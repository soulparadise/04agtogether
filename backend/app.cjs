const fs = require('node:fs');
const path = require('node:path');
const { createApplication } = require('./server.cjs');
const root = path.resolve(__dirname, '..');
const { release } = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
const { server } = createApplication({ frontendDir: path.join(root, 'frontend'), release });
// Passenger intercepts listen(); a standalone run uses PORT (3000 by default).
server.listen(Number(process.env.PORT || 3000));
