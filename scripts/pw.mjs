// Playwright launcher: keeps browser downloads out of the user profile (C:\dev-overflow\playwright on
// this machine), then runs the Playwright CLI with the given arguments.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('C:\\dev-overflow')) process.env.PLAYWRIGHT_BROWSERS_PATH = 'C:\\dev-overflow\\playwright';
const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root, env: process.env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
