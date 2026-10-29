import { checkLive } from './check-live.mjs';
checkLive(process.argv[2], process.argv[3], process.argv[4]).catch(() => { console.error('Release check failed: HTTPS, extension Origin, shared rooms or roles.'); process.exitCode = 1; });
