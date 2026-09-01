const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

// 1. MsEdgeTTS implementation (Floating point Number)
function msEdgeTTSCalc() {
    const ticks = Math.floor(Date.now() / 1000) + 11644473600;
    const rounded = ticks - (ticks % 300);
    const windowsTicks = rounded * 10000000;
    const str = `${windowsTicks}${TRUSTED_CLIENT_TOKEN}`;
    const hash = crypto.createHash('sha256').update(str).digest('hex').toUpperCase();
    return { str, hash };
}

// 2. BigInt implementation
function bigIntCalc() {
    const ticks = BigInt(Math.floor(Date.now() / 1000) + 11644473600);
    const rounded = ticks - (ticks % 300n);
    const windowsTicks = rounded * 10000000n;
    const str = `${windowsTicks}${TRUSTED_CLIENT_TOKEN}`;
    const hash = crypto.createHash('sha256').update(str).digest('hex').toUpperCase();
    return { str, hash };
}

console.log('MsEdgeTTS calc:', msEdgeTTSCalc());
console.log('BigInt calc:   ', bigIntCalc());
