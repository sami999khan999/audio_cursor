const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'vscode_extentions', 'audio_cursor', 'src', 'voices.json');
const dest = path.join(__dirname, '..', 'src', 'shared', 'voices.json');

const data = fs.readFileSync(src, 'utf8');
fs.writeFileSync(dest, data, 'utf8');
console.log('Successfully copied voices.json to browser extension shared directory');
