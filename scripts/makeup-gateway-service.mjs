import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const logDirectory = join(projectRoot, '.runtime-logs');
const cloudflared = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const githubRepository = 'ChenXL916/Jskzpbb';
const runtimeBranch = 'makeup-runtime';
const runtimePath = 'runtime/backend-origin.json';
const apiHealthUrl = 'http://127.0.0.1:3002/api/health';
const webHealthUrl = 'http://127.0.0.1:8088/';
const publicHealthPath = '/api/health';

const ownedChildren = new Set();

export function extractQuickTunnelOrigin(text) {
  const match = String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match?.[0] ?? null;
}

async function healthy(url, timeoutMs = 5_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url, label, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await healthy(url)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`${label} did not become healthy: ${url}`);
}

async function openLog(name) {
  await mkdir(logDirectory, { recursive: true });
  return open(join(logDirectory, name), 'a');
}

async function spawnLogged(command, args, name, env = {}) {
  const output = await openLog(`${name}.out.log`);
  const error = await openLog(`${name}.err.log`);
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', output.fd, error.fd]
  });
  ownedChildren.add(child);
  child.once('exit', () => ownedChildren.delete(child));
  child.once('exit', () => {
    void output.close();
    void error.close();
  });
  return child;
}

async function ensureInfrastructure() {
  const keepalive = spawn(
    'wsl.exe',
    [
      '-d',
      'Ubuntu-24.04',
      '--',
      'sh',
      '-lc',
      'docker start jishi-scheduling-postgres-1 jishi-scheduling-redis-1 jishi-scheduling-minio-1 >/dev/null 2>&1 || true; exec sleep infinity'
    ],
    { cwd: projectRoot, windowsHide: true, stdio: 'ignore' }
  );
  ownedChildren.add(keepalive);
  keepalive.once('exit', () => ownedChildren.delete(keepalive));
}

async function ensureApi() {
  if (await healthy(apiHealthUrl)) return;
  await spawnLogged('node', ['apps/api/dist/main.js'], 'public-api');
  await waitForHealth(apiHealthUrl, 'Makeup API');
}

async function ensureWeb() {
  if (await healthy(webHealthUrl)) return;
  await spawnLogged(
    'pnpm.cmd',
    ['--filter', '@jishi/web', 'start'],
    'public-web',
    {
      PORT: '8088',
      HOSTNAME: '0.0.0.0',
      NEXT_PUBLIC_API_URL: '/api',
      INTERNAL_API_ORIGIN: 'http://127.0.0.1:3002'
    }
  );
  await waitForHealth(webHealthUrl, 'Makeup web');
  await waitForHealth('http://127.0.0.1:8088/api/health', 'Same-origin API gateway');
}

async function run(command, args, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', rejectRun);
    child.once('exit', (code) => {
      if (code === 0) resolveRun(stdout);
      else rejectRun(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function ghJson(args, input) {
  const text = await run('gh', ['api', ...args], input);
  return text.trim() ? JSON.parse(text) : null;
}

async function ensureRuntimeBranch() {
  try {
    await ghJson([`repos/${githubRepository}/git/ref/heads/${runtimeBranch}`]);
    return;
  } catch {
    const repository = await ghJson([`repos/${githubRepository}`]);
    const base = await ghJson([
      `repos/${githubRepository}/git/ref/heads/${repository.default_branch}`
    ]);
    await ghJson(
      ['--method', 'POST', `repos/${githubRepository}/git/refs`, '--input', '-'],
      JSON.stringify({ ref: `refs/heads/${runtimeBranch}`, sha: base.object.sha })
    );
  }
}

async function publishOrigin(origin) {
  await ensureRuntimeBranch();
  let existing = null;
  try {
    existing = await ghJson([
      `repos/${githubRepository}/contents/${runtimePath}?ref=${runtimeBranch}`
    ]);
    const current = JSON.parse(
      Buffer.from(existing.content.replace(/\s/g, ''), 'base64').toString('utf8')
    );
    if (current.origin === origin) return;
  } catch {
    existing = null;
  }

  const payload = {
    message: 'chore(runtime): update makeup gateway origin',
    branch: runtimeBranch,
    content: Buffer.from(
      JSON.stringify(
        {
          origin,
          service: 'jishi-makeup-scheduling',
          updated_at: new Date().toISOString()
        },
        null,
        2
      ) + '\n',
      'utf8'
    ).toString('base64')
  };
  if (existing?.sha) payload.sha = existing.sha;
  await ghJson(
    ['--method', 'PUT', `repos/${githubRepository}/contents/${runtimePath}`, '--input', '-'],
    JSON.stringify(payload)
  );
}

async function startTunnel() {
  await mkdir(logDirectory, { recursive: true });
  const outPath = join(logDirectory, 'public-tunnel.out.log');
  const errPath = join(logDirectory, 'public-tunnel.err.log');
  const output = await open(outPath, 'a');
  const error = await open(errPath, 'a');
  const child = spawn(
    cloudflared,
    ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:8088'],
    { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  ownedChildren.add(child);
  child.once('exit', () => ownedChildren.delete(child));

  let combined = '';
  let settled = false;
  const origin = await new Promise((resolveOrigin, rejectOrigin) => {
    const timer = setTimeout(() => {
      if (!settled) rejectOrigin(new Error('Cloudflare quick tunnel URL was not produced.'));
    }, 60_000);
    const receive = (chunk, handle) => {
      const text = chunk.toString('utf8');
      void handle.write(text);
      combined = `${combined}${text}`.slice(-20_000);
      const found = extractQuickTunnelOrigin(combined);
      if (found && !settled) {
        settled = true;
        clearTimeout(timer);
        resolveOrigin(found);
      }
    };
    child.stdout.on('data', (chunk) => receive(chunk, output));
    child.stderr.on('data', (chunk) => receive(chunk, error));
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectOrigin(new Error(`Cloudflare quick tunnel exited before startup (${code}).`));
      }
    });
  });

  await publishOrigin(origin);
  await waitForHealth(`${origin}${publicHealthPath}`, 'Public makeup gateway', 30);
  return new Promise((resolveExit) => {
    child.once('exit', resolveExit);
  });
}

async function main() {
  await ensureInfrastructure();
  for (;;) {
    try {
      await ensureApi();
      await ensureWeb();
      await startTunnel();
    } catch (error) {
      const log = await openLog('gateway-service.err.log');
      await log.write(`${new Date().toISOString()} ${error.stack ?? error}\n`);
      await log.close();
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000));
  }
}

function shutdown() {
  for (const child of ownedChildren) {
    try {
      child.kill();
    } catch {
      // Process already stopped.
    }
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
