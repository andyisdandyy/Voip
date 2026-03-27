// Rebuilds native N-API addons against the current Electron headers.
// Called by `npm run rebuild-native` or as part of the build pipeline.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const nativeDir = path.join(__dirname, '..', 'native', 'audio-loopback');
const bindingGyp = path.join(nativeDir, 'binding.gyp');

if (!fs.existsSync(bindingGyp)) {
  console.log('[rebuild-native] No binding.gyp found — skipping');
  process.exit(0);
}

// Only build on Windows — other platforms get the JS stub
if (process.platform !== 'win32') {
  console.log('[rebuild-native] Skipping native build (not Windows)');
  process.exit(0);
}

// Determine Electron version for node-gyp headers
let electronVersion;
try {
  const electronPkg = require('electron/package.json');
  electronVersion = electronPkg.version;
} catch {
  console.error('[rebuild-native] Cannot determine Electron version');
  process.exit(1);
}

const arch = process.arch; // x64, arm64, ia32
console.log(`[rebuild-native] Building audio-loopback for Electron ${electronVersion} (${arch})`);

// Use the project-local node-gyp binary so we get the latest version
// (older node-gyp doesn't recognise Visual Studio 2025).
const nodeGypBin = path.join(__dirname, '..', 'node_modules', '.bin', 'node-gyp');
const cmd = fs.existsSync(nodeGypBin + '.cmd') || fs.existsSync(nodeGypBin)
  ? `"${nodeGypBin}" rebuild --target=${electronVersion} --arch=${arch} --dist-url=https://electronjs.org/headers`
  : `npx node-gyp rebuild --target=${electronVersion} --arch=${arch} --dist-url=https://electronjs.org/headers`;

try {
  execSync(cmd, {
    cwd: nativeDir,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_disturl: 'https://electronjs.org/headers',
    },
  });
  console.log('[rebuild-native] Build succeeded');
} catch (err) {
  console.error('[rebuild-native] Build failed:', err.message);
  process.exit(1);
}
