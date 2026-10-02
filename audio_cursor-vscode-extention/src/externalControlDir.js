const os = require('os');
const path = require('path');

/**
 * Where every reader's socket and its description live: each VS Code window
 * (externalControl.js) and the standalone reader (bin/speak.js).
 * Not tmpdir()/audio-cursor: the host engine sweeps that folder.
 */
function controlDir() {
  return process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, 'audio-cursor')
    : path.join(os.tmpdir(), 'audio-cursor-control');
}

module.exports = { controlDir };
