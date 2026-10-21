'use strict';
/**
 * 极简 XLSX 读写（零第三方依赖，基于 node:zlib + 手写 ZIP 容器 + 手写 XML 解析）
 *
 *   parse(buffer)            -> string[][]   解析第一个工作表
 *   build(rows, sheetName)   -> Buffer       生成 xlsx
 *
 * 生成时使用 inlineStr（内联字符串），不依赖 sharedStrings；
 * 解析时同时支持 inlineStr、sharedStrings、数值、布尔。
 */
const zlib = require('node:zlib');

/* ============================================================ CRC32 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ============================================================ ZIP 读取 */

/** 解析 ZIP，返回 { 文件名: Buffer } */
function zipRead(buf) {
  // 从尾部向前找 End Of Central Directory 签名 PK\5\6
  let eocd = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 Excel 文件（.xlsx 结构损坏）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = Object.create(null);

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (localOff + 30 <= buf.length) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + compSize);
      try {
        out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
      } catch (e) {
        throw new Error(`Excel 文件解压失败（${name}）：${e.message}`);
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ============================================================ ZIP 写入 */

/** 把 { 文件名: 文本内容 } 打包成 xlsx（deflate 压缩） */
function zipWrite(files) {
  const names = Object.keys(files);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const data = Buffer.from(files[name], 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x800, 6); // flags: UTF-8 文件名
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt16LE(0, 10); // 修改时间
    lh.writeUInt16LE(0, 12); // 修改日期
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x800, 8); // flags
    ch.writeUInt16LE(8, 10); // method
    ch.writeUInt16LE(0, 12); // time
    ch.writeUInt16LE(0, 14); // date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk number start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(ch, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // 当前磁盘编号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘
  eocd.writeUInt16LE(names.length, 8); // 本磁盘条目数
  eocd.writeUInt16LE(names.length, 10); // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* ============================================================ XML 工具 */

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&'); // &amp; 必须最后替换
}

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 列引用 "A1"/"AB12" → 列索引（0 基） */
function colIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(String(ref || ''));
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 列索引（0 基）→ "A"/"AB" */
function colName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ============================================================ 解析工作表 */

function parseSharedStrings(xml) {
  const list = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const ts = m[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
    list.push(ts.map((x) => decodeXml(x.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))).join(''));
  }
  return list;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const inner = rm[1] || '';
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(inner))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const rAttr = /(?:^|\s)r="([^"]*)"/.exec(attrs);
      const tAttr = /(?:^|\s)t="([^"]*)"/.exec(attrs);
      const ci = colIndex(rAttr ? rAttr[1] : '');
      if (ci < 0) continue;

      const type = tAttr ? tAttr[1] : 'n';
      let v = '';
      if (type === 'inlineStr') {
        const tm = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        v = tm ? decodeXml(tm[1]) : '';
      } else {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        v = vm ? decodeXml(vm[1]) : '';
        if (type === 's') {
          v = sharedStrings[Number(v)] !== undefined ? sharedStrings[Number(v)] : '';
        } else if (type === 'b') {
          v = v === '1' ? 'TRUE' : 'FALSE';
        }
      }
      cells[ci] = v;
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** 解析 xlsx，返回二维数组（第一行通常为表头） */
function parse(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : input instanceof ArrayBuffer
      ? Buffer.from(input)
      : Buffer.from(input.buffer || input);
  const entries = zipRead(buf);

  const ssXml = entries['xl/sharedStrings.xml'];
  const shared = ssXml ? parseSharedStrings(ssXml.toString('utf8')) : [];

  let sheetName = 'xl/worksheets/sheet1.xml';
  if (!entries[sheetName]) {
    sheetName = Object.keys(entries).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  }
  if (!sheetName) throw new Error('Excel 文件中没有找到工作表');

  let rows = parseSheet(entries[sheetName].toString('utf8'), shared);

  // 补齐每行列数（跳过列会留下空洞），并去掉尾部全空行
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  rows = rows.map((r) => {
    const a = new Array(width);
    for (let i = 0; i < width; i++) a[i] = r[i] === undefined ? '' : r[i];
    return a;
  });
  while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();

  return rows;
}

/* ============================================================ 生成工作表 */

function sheetXml(rows) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
  );
  rows.forEach((row, ri) => {
    const r = ri + 1;
    out.push(`<row r="${r}">`);
    row.forEach((val, ci) => {
      if (val === null || val === undefined || val === '') return;
      const ref = colName(ci) + r;
      if (typeof val === 'number' && isFinite(val)) {
        out.push(`<c r="${ref}"><v>${val}</v></c>`);
      } else {
        out.push(
          `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`
        );
      }
    });
    out.push('</row>');
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
  + `<Default Extension="xml" ContentType="application/xml"/>`
  + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
  + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  + `</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
  + `</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`
  + `</Relationships>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets><sheet name="${escXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
    + `</workbook>`;
}

/** 生成 xlsx。rows 为二维数组，数字单元格按数值写入，其余按文本写入 */
function build(rows, sheetName = 'Sheet1') {
  const name = String(sheetName || 'Sheet1').slice(0, 31);
  return zipWrite({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'xl/workbook.xml': workbookXml(name),
    'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
    'xl/worksheets/sheet1.xml': sheetXml(rows),
  });
}

module.exports = { build, parse, crc32 };
