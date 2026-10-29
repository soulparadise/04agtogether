// Stable Passenger startup file; releases switch through the current symlink.
// Site-specific allowlist: public extension ID, never credentials.
process.env.EXTENSION_ORIGINS = 'chrome-extension://igpjafcbhhcandncnhdfpphkidmcpigh';
require('./current/backend/app.js');
