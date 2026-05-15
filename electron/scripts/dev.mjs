import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const venvPython = process.platform === 'win32' 
  ? path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
  : path.join(repoRoot, '.venv', 'bin', 'python');


function loadRuntimeConfig() {
  const configPath = path.join(repoRoot, 'config', 'runtime.json');
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

const runtime = loadRuntimeConfig();
const overlay = runtime.overlay || {};
const ocr = runtime.ocr || {};

const game = process.env.GAME_ID || overlay.game_id || 'demo';
const wsHost = process.env.OVERLAY_WS_HOST || overlay.ws_host || '127.0.0.1';
const wsPort = String(process.env.OVERLAY_WS_PORT || overlay.ws_port || '8765');
const inputMode = process.env.OVERLAY_INPUT_MODE || overlay.input_mode || 'ocr';
const intervalMs = String(process.env.OVERLAY_INTERVAL_MS || overlay.interval_ms || '900');
const ocrLang = process.env.OVERLAY_OCR_LANG || overlay.ocr_lang || 'en';
const tesseractCmd = process.env.TESSERACT_CMD || ocr.tesseract_cmd || '';

const backendArgs = [
  '-m', 'app_lang_overlay.cli', 'overlay-backend',
  '--game', game,
  '--host', wsHost,
  '--port', wsPort,
  '--input-mode', inputMode,
  '--interval-ms', intervalMs,
  '--ocr-lang', ocrLang
];

const backendPython = fs.existsSync(venvPython) 
  ? venvPython 
  : (process.platform === 'win32' ? 'python' : 'python3');

const backend = spawn(backendPython, backendArgs, {
  stdio: 'inherit',
  cwd: repoRoot
});

const electronEnv = { ...process.env };
delete electronEnv.ELECTRON_RUN_AS_NODE;

const electron = spawn('npx', ['electron', '.'], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
  shell: true,
  env: {
    ...electronEnv,
    ...(tesseractCmd ? { TESSERACT_CMD: tesseractCmd } : {}),
    GAME_ID: game,
    OVERLAY_WS_URL: `ws://${wsHost}:${wsPort}`
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
