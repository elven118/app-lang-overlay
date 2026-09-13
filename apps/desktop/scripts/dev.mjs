import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const backendRoot = path.join(repoRoot, 'services', 'backend');
const backendSource = path.join(backendRoot, 'src');
const desktopRoot = path.resolve(__dirname, '..');
const venvPython = process.platform === 'win32' 
  ? path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
  : path.join(repoRoot, '.venv', 'bin', 'python');


function loadEnvironment(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnv(fs.readFileSync(filePath, 'utf-8'));
}

const backendEnv = {
  ...loadEnvironment(path.join(backendRoot, '.env')),
  ...process.env,
};
const desktopEnv = {
  ...loadEnvironment(path.join(desktopRoot, '.env')),
  ...process.env,
};

const defaultProfile = desktopEnv.OVERLAY_DEFAULT_PROFILE;
const wsHost = backendEnv.OVERLAY_BACKEND_HOST || '127.0.0.1';
const wsPort = String(backendEnv.OVERLAY_BACKEND_PORT || '8765');
const backendUrl = desktopEnv.OVERLAY_BACKEND_URL || `ws://${wsHost}:${wsPort}/v1/stream`;
const backendToken = desktopEnv.OVERLAY_BACKEND_TOKEN || backendEnv.OVERLAY_BACKEND_API_TOKEN || '';

const backendArgs = [
  '-m', 'overlay_backend'
];

const backendPython = fs.existsSync(venvPython) 
  ? venvPython 
  : (process.platform === 'win32' ? 'python' : 'python3');

const backend = spawn(backendPython, backendArgs, {
  stdio: 'inherit',
  cwd: repoRoot,
  env: {
    ...backendEnv,
    PYTHONPATH: [backendSource, backendEnv.PYTHONPATH].filter(Boolean).join(path.delimiter),
    OVERLAY_PROJECT_ROOT: repoRoot,
  }
});

const electronEnv = { ...desktopEnv };
delete electronEnv.ELECTRON_RUN_AS_NODE;
const electronExecutable = process.platform === 'win32'
  ? path.join(repoRoot, 'apps', 'desktop', 'node_modules', '.bin', 'electron.cmd')
  : path.join(repoRoot, 'apps', 'desktop', 'node_modules', '.bin', 'electron');

const electron = spawn(electronExecutable, ['.'], {
  stdio: 'inherit',
  cwd: desktopRoot,
  env: {
    ...electronEnv,
    ...(defaultProfile ? { OVERLAY_DEFAULT_PROFILE: defaultProfile } : {}),
    OVERLAY_BACKEND_URL: backendUrl,
    OVERLAY_BACKEND_TOKEN: backendToken,
  }
});

backend.on('exit', (code, signal) => {
  console.log(`[dev] backend exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
});

electron.on('exit', (code, signal) => {
  console.log(`[dev] electron exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
});

function shutdown() {
  backend.kill('SIGINT');
  electron.kill('SIGINT');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
