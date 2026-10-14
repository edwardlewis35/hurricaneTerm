// Validate shipped desktop icons without optional native image dependencies.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const results = [];
const check = (name, value) => results.push([!!value, name]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const load = path => readFileSync(root + path);

function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('Invalid PNG signature');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) throw new Error('Expected non-interlaced 8-bit RGBA PNG');
  const chunks = []; let end = false;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') end = true;
    offset += length + 12;
  }
  if (!end) throw new Error('PNG has no end chunk');
  const scan = inflateSync(Buffer.concat(chunks)), stride = width * 4;
  if (scan.length !== (stride + 1) * height) throw new Error('Unexpected PNG scanline length');
  const pixels = Buffer.alloc(stride * height);
  const paeth = (left, up, corner) => {
    const estimate = left + up - corner;
    const a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - corner);
    return a <= b && a <= c ? left : b <= c ? up : corner;
  };
  for (let y = 0; y < height; y++) {
    const filter = scan[y * (stride + 1)];
    if (filter > 4) throw new Error('Unknown PNG filter');
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, left = x >= 4 ? pixels[index - 4] : 0;
      const up = y ? pixels[index - stride] : 0, corner = x >= 4 && y ? pixels[index - stride - 4] : 0;
      const correction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      pixels[index] = (scan[y * (stride + 1) + x + 1] + correction) & 255;
    }
  }
  return { width, height, pixels };
}

function alphaBounds(image, threshold = 128) {
  let left = image.width, top = image.height, right = 0, bottom = 0, count = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.pixels[(y * image.width + x) * 4 + 3] > threshold) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); count++;
    }
  }
  return { left, top, right, bottom, count, width: right - left, height: bottom - top };
}

const config = JSON.parse(load('src-tauri/tauri.conf.json'));
const configured = config.bundle.icon.map(path => 'src-tauri/' + path);
check('Desktop bundle names exactly the intended six platform icons', configured.length === 6 && new Set(configured).size === 6);
const generated = load('assets/huricano-icon-generated.png');
check('Original imagegen output is preserved byte for byte', hash(generated) === 'ba8d8613391be52a1f52b29a920ea70c8f91fbe02a43e9bf99e0cdce66b0c3da');
decodePng(generated);
const master = decodePng(load('assets/huricano-icon.png'));
check('Normalized mascot master is 1024-square RGBA', master.width === 1024 && master.height === 1024);
const body = alphaBounds(master);
check('Icon body matches ChatGPT Dock scale within one pixel', Math.abs(body.width - 824) <= 1 && body.height <= 824 && body.height >= 800);
check('Icon body has balanced transparent margins', Math.abs((body.left + body.right) / 2 - 512) <= 1 && Math.abs((body.top + body.bottom) / 2 - 512) <= 1);
check('Icon keeps rounded-square corner transparency and clear outside padding', [0, master.width - 1, (master.height - 1) * master.width, master.width * master.height - 1].every(i => master.pixels[i * 4 + 3] < 16) && alphaBounds(master, 16).count / (master.width * master.height) < 0.65);
const pngSizes = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 };
for (const [file, size] of Object.entries(pngSizes)) {
  const image = decodePng(load('src-tauri/icons/' + file));
  const bounds = alphaBounds(image);
  check(`Bundle ${file} has the required RGBA dimensions`, image.width === size && image.height === size);
  check(`Bundle ${file} preserves mascot scale and centered padding`, Math.abs(bounds.width / size - 824 / 1024) <= 0.05 && Math.abs((bounds.left + bounds.right) / 2 - size / 2) <= 1);
}
check('Home/favicon uses the exact same 256 px bundle icon', load('src/huricano-icon.png').equals(load('src-tauri/icons/128x128@2x.png')));

const icns = load('src-tauri/icons/icon.icns');
check('ICNS container length and signature are valid', icns.toString('ascii', 0, 4) === 'icns' && icns.readUInt32BE(4) === icns.length);
const entries = new Map(); let icnsEnd = 8;
while (icnsEnd < icns.length) {
  const type = icns.toString('ascii', icnsEnd, icnsEnd + 4), length = icns.readUInt32BE(icnsEnd + 4);
  if (length < 8 || icnsEnd + length > icns.length) throw new Error('Invalid ICNS record');
  entries.set(type, icns.subarray(icnsEnd + 8, icnsEnd + length)); icnsEnd += length;
}
check('ICNS records fill the entire container', icnsEnd === icns.length);
for (const [type, size] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]) {
  const image = decodePng(entries.get(type));
  check(`macOS ICNS ${type} includes its ${size} px representation`, image.width === size && image.height === size);
}
const macPixels = decodePng(entries.get('ic10')).pixels;
let sameAlpha = true, maxColorRounding = 0;
for (let index = 0; index < master.pixels.length; index += 4) {
  const alpha = master.pixels[index + 3];
  if (alpha !== macPixels[index + 3]) sameAlpha = false;
  // ICNS encoding rounds premultiplied RGB. Compare composited contribution,
  // so RGB values beneath nearly transparent shadow pixels do not look altered.
  for (let channel = 0; channel < 3; channel++) maxColorRounding = Math.max(maxColorRounding, Math.abs(master.pixels[index + channel] - macPixels[index + channel]) * alpha / 255);
}
check('macOS largest icon preserves master alpha and colors within encoder rounding', sameAlpha && maxColorRounding <= 2);
check('macOS legacy 16/32 px representations include alpha masks', entries.get('s8mk')?.length === 16 * 16 && entries.get('l8mk')?.length === 32 * 32);

const ico = load('src-tauri/icons/icon.ico');
check('Windows ICO has a valid icon directory', ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 6);
const icoSizes = [];
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const index = 6 + i * 16, width = ico[index] || 256, height = ico[index + 1] || 256;
  const length = ico.readUInt32LE(index + 8), offset = ico.readUInt32LE(index + 12);
  const data = ico.subarray(offset, offset + length); icoSizes.push(width);
  check(`Windows ${width} px icon has a complete square payload`, width === height && offset >= 6 + 6 * 16 && data.length === length && length > 0);
  if (width === 256) {
    const image = decodePng(data);
    check('Windows largest representation uses the same normalized mascot pixels', image.width === 256 && image.height === 256 && image.pixels.equals(decodePng(load('src-tauri/icons/128x128@2x.png')).pixels));
  }
}
check('Windows small and high-DPI icon sizes are all present', icoSizes.join(',') === '16,24,32,48,64,256');
const oldHashes = { 'icon.png': 'ed88c9d81c6bff1a5e8b8949b813bc9b6a2f610b8d322b9fd01c674019a0876e', 'icon.icns': '98104b0b1d2cb5721467cd30336a2de79da60a36da8d715fb4d9f1338602d453', 'icon.ico': '8471e99950505057726c2d11c94c19c02269aa0495af16a118d3188e137fda4e' };
check('Every desktop format replaced the previous application icon', Object.entries(oldHashes).every(([file, digest]) => hash(load('src-tauri/icons/' + file)) !== digest));
check('Desktop source tree excludes unused mobile and Windows Store outputs', readdirSync(root + 'src-tauri/icons').length === 6);
for (const [pass, name] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
console.log(`\n${results.filter(([pass]) => pass).length}/${results.length} PASS`);
if (results.some(([pass]) => !pass)) process.exitCode = 1;
