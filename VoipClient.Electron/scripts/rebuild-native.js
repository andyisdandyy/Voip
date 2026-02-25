/**
 * afterPack hook — rebuilds native Node addons (opusscript) against the
 * exact Electron binary that was just packed, for the correct platform/arch.
 */
const { rebuild } = require('@electron/rebuild');
const path = require('path');

module.exports = async ({ appOutDir, electronVersion, platform, arch }) => {
  const projectDir = path.join(__dirname, '..');
  console.log(`[rebuild-native] Rebuilding native modules for Electron ${electronVersion} (${platform}/${arch})...`);
  await rebuild({
    buildPath: projectDir,
    electronVersion,
    arch,
    onlyModules: ['opusscript'],
    force: true,
  });
  console.log('[rebuild-native] Done.');
};
