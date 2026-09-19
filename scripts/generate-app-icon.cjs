/* Generates a multi-size Windows icon from the project source logo. */
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'app-logo.svg'), 'utf8');
const output = path.join(root, 'packaging', 'icon.ico');

function render(size) {
  return new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

function createIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ data }) => data)]);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const images = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: render(size) }));
fs.writeFileSync(output, createIco(images));
