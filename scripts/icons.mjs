// Draws the Zipline icon (a cable with a rider on a teal→lime tile) as PNGs.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const mix = (a, b, t) => Math.round(a + (b - a) * t);

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 128, r = 30 * s;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // Cable from (22,34) to (106,86); rider hangs below its midpoint.
  const [x0, y0, x1, y1] = [22 * s, 34 * s, 106 * s, 86 * s];
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
  const rider = [66 * s, 94 * s], riderR = 11 * s;
  const cable = Math.max(1.2, 6 * s);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = x + 0.5, fy = y + 0.5, i = (y * size + x) * 4;
    if (!inRounded(fx, fy)) continue;
    const t = (fx + fy) / (2 * size);
    let [R, G, B] = [mix(15, 183, t), mix(157, 227, t), mix(138, 77, t)];
    const u = Math.max(0, Math.min(1, ((fx - x0) * dx + (fy - y0) * dy) / len2));
    const dist = Math.hypot(fx - (x0 + u * dx), fy - (y0 + u * dy));
    if (dist <= cable / 2) [R, G, B] = [255, 255, 255];
    const hanger = Math.abs(fx - rider[0]) <= Math.max(0.8, 2.5 * s) && fy > 60 * s && fy < rider[1];
    if (hanger || (fx - rider[0]) ** 2 + (fy - rider[1]) ** 2 <= riderR ** 2) [R, G, B] = [255, 255, 255];
    px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(new URL("../apps/foxpilot/public/icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`../apps/foxpilot/public/icons/icon-${size}.png`, import.meta.url), icon(size));
console.log("icons written");
