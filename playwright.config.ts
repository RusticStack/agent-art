// End-to-end tests of the built web UI (dist/ui) against a real agent-art server on a temp workspace
// and a free port (e2e/global-setup.ts). Never the user's workspace, never port 7420.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const stateFile = path.join(import.meta.dirname, 'e2e', '.state.json');
const baseURL = () => { try { return `http://127.0.0.1:${JSON.parse(fs.readFileSync(stateFile, 'utf8')).port}`; } catch { return undefined; } };
const grepGiven = process.argv.some((a) => a === '--grep' || a.startsWith('--grep=') || a === '-g');

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results',
  grepInvert: grepGiven ? undefined : /@shots/,
  use: {
    baseURL: baseURL(),
    viewport: { width: 1680, height: 980 },
    reducedMotion: 'reduce',
    launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
