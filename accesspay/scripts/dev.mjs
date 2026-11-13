// Runs the API server (restarts on file changes) and the Vite dev server together.
// Plain Node, so it works the same on Windows, macOS and Linux.
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';

// The API server builds links (payment links, checkout URLs) from PUBLIC_URL.
// In development the browser uses Vite's port, which forwards API calls to :3000.
const env = { ...process.env, PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:5173' };

const run = (cmd, args, name, useShell) => {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: useShell, env });
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    process.exit(code ?? 0);
  });
  return child;
};

const children = [
  // No shell here: Node's path can contain spaces ("C:\Program Files\nodejs\node.exe").
  run(process.execPath, ['--watch', 'server/main.ts'], 'server', false),
  // npx is a .cmd file on Windows, which needs a shell.
  run(isWindows ? 'npx.cmd' : 'npx', ['vite'], 'vite', isWindows),
];
process.on('SIGINT', () => children.forEach((c) => c.kill('SIGINT')));
