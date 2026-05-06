#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

if (process.env.SKIP_AGENT_BUILD === '1') {
  console.log('agent build skipped because SKIP_AGENT_BUILD=1');
  process.exit(0);
}

const outputs = [
  'public/agent.exe',
  'public/agent-mac',
  'public/agent-mac-arm',
];

const missing = outputs.filter((file) => !fs.existsSync(path.join(root, file)));

if (missing.length === 0) {
  console.log('agent binaries already exist; skipping build');
  process.exit(0);
}

console.log('missing agent binaries: ' + missing.join(', '));
console.log('building agent binaries...');

const result = spawnSync('npm', ['run', 'build-agent-all'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.error('agent build failed; run npm run build-agent-all for details');
  process.exit(result.status || 1);
}
