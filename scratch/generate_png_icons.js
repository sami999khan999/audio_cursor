const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c >>> 0;
}

function calcCrc(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
}

function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(4 + 4 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crcBuf = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    buf.writeUInt32BE(calcCrc(crcBuf), 8 + len);
    return buf;
}

function encodePNG(width, height, rgbaBuffer) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    
    // IHDR
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const ihdrChunk = makeChunk('IHDR', ihdr);

    // IDAT
    const rowSize = width * 4;
    const rawData = Buffer.alloc(height * (rowSize + 1));
    for (let y = 0; y < height; y++) {
        rawData[y * (rowSize + 1)] = 0;
        rgbaBuffer.copy(rawData, y * (rowSize + 1) + 1, y * rowSize, (y + 1) * rowSize);
    }
    const compressed = zlib.deflateSync(rawData);
    const idatChunk = makeChunk('IDAT', compressed);

    // IEND
    const iendChunk = makeChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function lerpColor(c1, c2, t) {
    t = Math.max(0, Math.min(1, t));
    return [
        Math.round(c1[0] + (c2[0] - c1[0]) * t),
        Math.round(c1[1] + (c2[1] - c1[1]) * t),
        Math.round(c1[2] + (c2[2] - c1[2]) * t),
        Math.round(c1[3] + (c2[3] - c1[3]) * t)
    ];
}

function pointInPoly(px, py, vertices) {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const xi = vertices[i][0], yi = vertices[i][1];
        const xj = vertices[j][0], yj = vertices[j][1];
        const intersect = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function renderIcon(size) {
    const S = size;
    const buf = Buffer.alloc(S * S * 4);
    const SS = 4; // 4x4 super-sampling

    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;

            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const px = (x + (sx + 0.5) / SS) / S * 128;
                    const py = (y + (sy + 0.5) / SS) / S * 128;

                    // 1. Clean squircle container
                    const r = 32;
                    const dx = Math.max(0, Math.max(r - px, px - (128 - r)));
                    const dy = Math.max(0, Math.max(r - py, py - (128 - r)));
                    const distOutside = Math.hypot(dx, dy);
                    const inBox = (px >= 0 && px <= 128 && py >= 0 && py <= 128) && (distOutside <= r);

                    let cr = 0, cg = 0, cb = 0, ca = 0;

                    if (inBox) {
                        // Background: clean dark slate #141724
                        cr = 20; cg = 23; cb = 36; ca = 255;

                        // 2. Simple Sound Wave Arcs: center (38, 64)
                        const cx = 38, cy = 64;
                        const dToCenter = Math.hypot(px - cx, py - cy);
                        const angle = Math.atan2(py - cy, px - cx);

                        const waves = [
                            { r: 42, w: 7.2, maxA: 0.72, opacity: 1.0 },
                            { r: 58, w: 7.2, maxA: 0.68, opacity: 0.8 }
                        ];

                        for (const w of waves) {
                            if (Math.abs(angle) <= w.maxA && px > cx) {
                                const diff = Math.abs(dToCenter - w.r);
                                if (diff <= w.w / 2) {
                                    const waveCol = lerpColor([129, 140, 248, 255], [56, 189, 248, 255], (w.r - 35) / 30);
                                    const edgeAlpha = Math.max(0, 1 - (diff / (w.w / 2)) * 0.3) * w.opacity;
                                    cr = Math.round(cr * (1 - edgeAlpha) + waveCol[0] * edgeAlpha);
                                    cg = Math.round(cg * (1 - edgeAlpha) + waveCol[1] * edgeAlpha);
                                    cb = Math.round(cb * (1 - edgeAlpha) + waveCol[2] * edgeAlpha);
                                }
                            }
                        }

                        // 3. Simple Cursor Pointer Polygon
                        // Vertices: (34, 28) -> (72, 66) -> (54, 70) -> (66, 94) -> (56, 99) -> (44, 75) -> (34, 85) -> (34, 28)
                        const cursorPoly = [
                            [34, 28],
                            [72, 66],
                            [54, 70],
                            [66, 94],
                            [56, 99],
                            [44, 75],
                            [34, 85],
                            [34, 28]
                        ];

                        if (pointInPoly(px, py, cursorPoly)) {
                            const tCursor = (py - 28) / 71;
                            const curCol = lerpColor([129, 140, 248, 255], [56, 189, 248, 255], tCursor);
                            cr = curCol[0]; cg = curCol[1]; cb = curCol[2]; ca = 255;
                        }
                    }

                    rAcc += cr;
                    gAcc += cg;
                    bAcc += cb;
                    aAcc += ca;
                }
            }

            const totalSamples = SS * SS;
            const idx = (y * S + x) * 4;
            buf[idx] = Math.round(rAcc / totalSamples);
            buf[idx + 1] = Math.round(gAcc / totalSamples);
            buf[idx + 2] = Math.round(bAcc / totalSamples);
            buf[idx + 3] = Math.round(aAcc / totalSamples);
        }
    }

    return encodePNG(S, S, buf);
}

const srcIconsDir = path.join(__dirname, '..', 'src', 'icons');
const distIconsDir = path.join(__dirname, '..', 'dist', 'icons');
fs.mkdirSync(srcIconsDir, { recursive: true });
fs.mkdirSync(distIconsDir, { recursive: true });

const sizes = [16, 32, 48, 128];
sizes.forEach(size => {
    const pngBuf = renderIcon(size);
    const filename = `icon${size}.png`;
    fs.writeFileSync(path.join(srcIconsDir, filename), pngBuf);
    fs.writeFileSync(path.join(distIconsDir, filename), pngBuf);
    console.log(`✅ Generated ${filename} (${size}x${size})`);
});
