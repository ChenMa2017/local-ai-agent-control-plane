"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const pkg = require(path.join(root, "package.json"));
validatePackageMetadata(pkg);
const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const sourceName = `${pkg.name}-${pkg.version}-source.zip`;

const sourceFiles = [
  "package.json",
  "extension.js",
  "README.md",
  "REVIEW_BRIEF.md",
  "scripts/install-local.sh",
  "scripts/package-local.js",
  "scripts/package-local.sh"
];

const vsixExcludedFiles = new Set([
  "scripts/package-local.js",
  "scripts/package-local.sh"
]);

function validatePackageMetadata(pkg) {
  const safe = /^[A-Za-z0-9_.-]+$/;
  const safeVersion = /^[A-Za-z0-9_.+-]+$/;
  if (!safe.test(String(pkg.name || "")) || !safe.test(String(pkg.publisher || "")) || !safeVersion.test(String(pkg.version || ""))) {
    throw new Error("Unsafe package metadata in package.json");
  }
}

function dosDateTime(date) {
  let year = date.getFullYear();
  if (year < 1980) year = 1980;
  const dosTime = (date.getSeconds() >> 1) | (date.getMinutes() << 5) | (date.getHours() << 11);
  const dosDate = date.getDate() | ((date.getMonth() + 1) << 5) | ((year - 1980) << 9);
  return { dosDate, dosTime };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function zipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const { dosDate, dosTime } = dosDateTime(now);

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"));
    const input = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = zlib.deflateRawSync(input);
    const crc = crc32(input);

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(compressed.length),
      u32(input.length),
      u16(name.length),
      u16(0),
      name,
      compressed
    ]);
    localParts.push(local);

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(8),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(compressed.length),
      u32(input.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name
    ]);
    centralParts.push(central);
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0)
  ]);

  return Buffer.concat([...localParts, central, end]);
}

async function readFile(rel) {
  return fsp.readFile(path.join(root, rel));
}

function contentTypes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="sh" ContentType="text/x-shellscript" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="xml" ContentType="text/xml" />
</Types>
`;
}

function manifest() {
  const identityId = `${pkg.publisher}.${pkg.name}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${identityId}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${escapeXml(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description || "")}</Description>
    <Tags>codex,automation,watchdog,remote</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function makeSourceZip() {
  const entries = [];
  for (const rel of sourceFiles) {
    entries.push({ name: `${pkg.name}-${pkg.version}/${rel}`, data: await readFile(rel) });
  }
  const out = path.join(dist, sourceName);
  await fsp.writeFile(out, zipEntries(entries));
  return out;
}

async function makeVsix() {
  const entries = [
    { name: "[Content_Types].xml", data: contentTypes() },
    { name: "extension.vsixmanifest", data: manifest() }
  ];
  for (const rel of sourceFiles.filter((f) => !vsixExcludedFiles.has(f))) {
    entries.push({ name: `extension/${rel}`, data: await readFile(rel) });
  }
  const out = path.join(dist, vsixName);
  await fsp.writeFile(out, zipEntries(entries));
  return out;
}

async function main() {
  await fsp.mkdir(dist, { recursive: true });
  const source = await makeSourceZip();
  const vsix = await makeVsix();
  console.log(source);
  console.log(vsix);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
