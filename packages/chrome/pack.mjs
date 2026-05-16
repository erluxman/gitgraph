import { createReadStream, createWriteStream, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { pipeline as _pipeline } from "node:stream";

const pipeline = promisify(_pipeline);
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "dist");
const outPath = resolve(__dirname, "gitgraph-chrome-0.1.0.zip");

// CRC32 table — built once and reused. Declared up here so crc32() can
// reference it without hitting a temporal-dead-zone error when called
// from the top-level loop below.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * Minimal ZIP writer (store + deflate). Avoids pulling in a dependency
 * just to bundle the Chrome extension for "Load unpacked" or Web Store
 * submission. Output is uncompressed source maps stripped — they bloat
 * the .zip and Chrome doesn't read them in a published install anyway.
 */

const files = collectFiles(distDir).filter((f) => !f.endsWith(".map"));

const records = [];
let offset = 0;
const chunks = [];

for (const abs of files) {
  const rel = relative(distDir, abs).replaceAll("\\", "/");
  const data = await readBuffer(abs);
  const compressed = await deflate(data);
  const crc = crc32(data);

  const useDeflate = compressed.length < data.length;
  const stored = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0;

  const nameBytes = Buffer.from(rel, "utf8");
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version
  local.writeUInt16LE(0, 6);             // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);            // mtime
  local.writeUInt16LE(0, 12);            // mdate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(stored.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);            // extra length
  nameBytes.copy(local, 30);

  chunks.push(local, stored);
  records.push({ rel, nameBytes, method, crc, compressed: stored.length, uncompressed: data.length, offset });
  offset += local.length + stored.length;
}

const centralStart = offset;
const central = [];
for (const r of records) {
  const cdh = Buffer.alloc(46 + r.nameBytes.length);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);              // version made by
  cdh.writeUInt16LE(20, 6);              // version needed
  cdh.writeUInt16LE(0, 8);               // flags
  cdh.writeUInt16LE(r.method, 10);
  cdh.writeUInt16LE(0, 12);              // mtime
  cdh.writeUInt16LE(0, 14);              // mdate
  cdh.writeUInt32LE(r.crc, 16);
  cdh.writeUInt32LE(r.compressed, 20);
  cdh.writeUInt32LE(r.uncompressed, 24);
  cdh.writeUInt16LE(r.nameBytes.length, 28);
  cdh.writeUInt16LE(0, 30);              // extra length
  cdh.writeUInt16LE(0, 32);              // comment length
  cdh.writeUInt16LE(0, 34);              // disk num
  cdh.writeUInt16LE(0, 36);              // internal attrs
  cdh.writeUInt32LE(0, 38);              // external attrs
  cdh.writeUInt32LE(r.offset, 42);
  r.nameBytes.copy(cdh, 46);
  central.push(cdh);
  offset += cdh.length;
}

const centralSize = offset - centralStart;
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);                // disk
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(records.length, 8);
eocd.writeUInt16LE(records.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(centralStart, 16);
eocd.writeUInt16LE(0, 20);               // comment length

const out = Buffer.concat([...chunks, ...central, eocd]);
await import("node:fs/promises").then((m) => m.writeFile(outPath, out));

const totalKb = (out.length / 1024).toFixed(1);
console.log(`gitgraph-chrome-0.1.0.zip · ${records.length} files · ${totalKb} KB`);
console.log(`→ ${outPath}`);

// --- helpers ---

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...collectFiles(abs));
    else out.push(abs);
  }
  return out;
}

async function readBuffer(path) {
  const chunks = [];
  for await (const chunk of createReadStream(path)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function deflate(buf) {
  return new Promise((resolve, reject) => {
    const out = [];
    const z = createDeflateRaw({ level: 9 });
    z.on("data", (c) => out.push(c));
    z.on("end", () => resolve(Buffer.concat(out)));
    z.on("error", reject);
    z.end(buf);
  });
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Silence the unused-import noise.
void pipeline;
