import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
let mode = process.argv[2];
if (mode === 'rollback' && process.env.RELEASE_ID === 'static') mode = 'static';
const sha = mode === 'rollback' ? process.env.RELEASE_ID : process.env.GITHUB_SHA;
const host = process.env.BEGET_SSH_HOST;
const port = process.env.BEGET_SSH_PORT || '22';
const ip = process.env.BEGET_IP;
if (!['deploy', 'rollback', 'first', 'static'].includes(mode) || (mode !== 'static' && !/^[a-f0-9]{40}$/.test(sha || ''))) throw new Error('Invalid release');
if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host || '') || !/^\d{1,5}$/.test(port)) throw new Error('Missing or invalid SSH host/port');
if (ip !== '45.130.41.94') throw new Error('BEGET_IP must match the verified 04agtogether address');
if (!process.env.BEGET_SSH_KEY || !process.env.BEGET_SSH_KNOWN_HOSTS) throw new Error('Missing SSH secrets');
const temporary = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), '04agtogether-ssh-'));
const keyPath = path.join(temporary, 'key');
const hostsPath = path.join(temporary, 'known_hosts');
await writeFile(keyPath, process.env.BEGET_SSH_KEY.trim() + '\n', { mode: 0o600 });
await writeFile(hostsPath, process.env.BEGET_SSH_KNOWN_HOSTS.trim() + '\n', { mode: 0o600 });
// Do not pass credentials to child process environments.
const childEnv = { ...process.env };
delete childEnv.BEGET_SSH_KEY;
delete childEnv.BEGET_SSH_KNOWN_HOSTS;
const options = ['-i', keyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${hostsPath}`, '-o', 'ConnectTimeout=15'];
const destination = `soulpab9@${host}`;
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: childEnv, stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
    if (input) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
try {
  if (mode === 'deploy' || mode === 'first') {
    const archive = await readFile(`artifacts/${sha}.tgz`);
    const digest = createHash('sha256').update(archive).digest('hex');
    await run('ssh', [...options, '-p', port, destination, `upload ${sha} ${digest}`], archive);
  }
  await run('ssh', [...options, '-p', port, destination, mode === 'static' ? 'restore-static' : `activate ${sha} ${mode} ${ip}`]);
} finally {
  // Clear key material even if transfer or activation fails; the runner is ephemeral.
  await writeFile(keyPath, '', { mode: 0o600 });
}
