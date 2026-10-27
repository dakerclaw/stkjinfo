'use strict';
/**
 * 项目管理应用 - 后端服务
 * 零依赖：Node.js 内置 http + node:sqlite
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { db, DB_FILE, DATA_DIR, FIELDS } = require('./db');
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('./xlsx');
const { normHeader, buildHeaderMap, isBlank, USER_IMPORT_FIELDS } = require('./import-map');

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ============================================================ 工具函数 */

const nowStr = () => new Date().toLocaleString('sv-SE').replace('T', ' ');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
/** 定长比较，避免时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 带 HTTP 状态码的“客户端错误”。
 * 顶层 catch 会按 status 返回 4xx（而不是一律 500），业务代码只需抛出即可。
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 各文本字段的长度上限：防止超长内容撑爆列表 / 导出 / 审计日志 */
const TEXT_LIMITS = {
  project_no: 100, product_code: 100, project_type: 100,
  base: 100, process_code: 100, work_order: 100, coke_type: 100,
  description: 1000, remark: 2000,
};

/** 文本清洗：去掉控制字符（含换行，避免污染表格与日志）并截断到上限 */
function cleanText(v, max = 200) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/* ============================================================ 角色与权限 */
/**
 * 三种角色：
 *   sys_admin 系统管理员（仅 username = 'admin'）—— 拥有全部权限，账号不可删除/降级
 *   admin     管理员 —— 查看全部数据；数据增删改；普通用户管理
 *   user      普通用户 —— 仅查看/新增/修改自己录入的数据，无项目与用户管理权
 */
const ROLES = {
  sys_admin: { label: '系统管理员', level: 3 },
  admin: { label: '管理员', level: 2 },
  user: { label: '普通用户', level: 1 },
};
const isAdmin = (u) => !!u && (u.role === 'admin' || u.role === 'sys_admin');
const isSysAdmin = (u) => !!u && u.role === 'sys_admin';

/* ============================================================ 会话管理 */
/* 会话持久化到数据库：重启服务 / 更新部署后登录状态不丢失。
   超时规则：连续 7 天未活跃自动失效（每次请求都会刷新 last_seen）。 */
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 天未活跃失效
const SESSION_TOUCH_INTERVAL = 1000 * 60 * 10; // last_seen 写库节流：10 分钟内不重复写

const stmtSessionGet = db.prepare('SELECT user_id, created_at, last_seen FROM sessions WHERE token = ?');
const stmtSessionInsert = db.prepare(
  'INSERT INTO sessions (token, user_id, created_at, last_seen, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)'
);
const stmtSessionDelete = db.prepare('DELETE FROM sessions WHERE token = ?');
const stmtSessionDeleteByUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const stmtSessionTouch = db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?');
const stmtSessionCleanExpired = db.prepare('DELETE FROM sessions WHERE last_seen < ?');
// 热点语句：每个请求都要查当前用户，提前 prepare 避免重复解析 SQL
const stmtUserById = db.prepare(
  'SELECT id, username, real_name, role, status, pwd_changed FROM users WHERE id = ?'
);

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  stmtSessionInsert.run(
    token,
    userId,
    now,
    now,
    String((req && req.headers['user-agent']) || '').slice(0, 200) || null,
    (req && req.socket && req.socket.remoteAddress) || null
  );
  return token;
}
function destroySession(token) {
  if (token) stmtSessionDelete.run(token);
}
/** 踢掉某用户的全部会话（停用 / 改密 / 删除账号时调用） */
function destroyUserSessions(userId) {
  stmtSessionDeleteByUser.run(userId);
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i <= 0) return;
    const key = p.slice(0, i).trim();
    const val = p.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      // 非法百分号转义（如 "sid=%"）：保留原始值，后续按无效 token 处理，
      // 不能因为一个畸形 Cookie 把整个请求变成 500
      out[key] = val;
    }
  });
  return out;
}
/** 从 Cookie 或 Authorization: Bearer 中取当前登录用户 */
function currentUser(req) {
  const cookies = parseCookies(req);
  let token = cookies.sid;
  const auth = req.headers.authorization || '';
  if (!token && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) return null;
  const s = stmtSessionGet.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.last_seen > SESSION_TTL) {
    stmtSessionDelete.run(token);
    return null;
  }
  // 节流写入：只有距上次活跃超过 10 分钟才更新 last_seen，避免每个请求都写库
  if (now - s.last_seen > SESSION_TOUCH_INTERVAL) {
    stmtSessionTouch.run(now, token);
  }
  const u = stmtUserById.get(s.user_id);
  if (!u || u.status !== 1) return null;
  return u;
}
/* 启动时清理过期会话 */
stmtSessionCleanExpired.run(Date.now() - SESSION_TTL);

/* ============================================================ 审计字段 */
/** 数据归属过滤：管理员看全部，普通用户只看自己 */
function ownerFilter(user, alias = '') {
  if (isAdmin(user)) return null;
  return { sql: `${alias}created_by_id = ?`, arg: user.id };
}

/* 全局安全响应头。
   script-src 保留 'unsafe-inline' 是因为界面大量使用内联事件属性（onclick="..."），
   而 CSP 无法对事件属性做白名单；所有动态文本均已 HTML 转义（见 app.js 的 esc()），
   列表中的项目编号改为 data-* + 事件委托传递，不再拼进 JS 字符串。 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',      // 禁止浏览器 MIME 嗅探
  'X-Frame-Options': 'SAMEORIGIN',          // 防点击劫持（禁止被第三方页面内嵌）
  'Referrer-Policy': 'same-origin',         // 跨站请求不带 Referer
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'",
};

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}
const ok = (res, data = {}) => send(res, 200, { success: true, ...data });
const fail = (res, status, message) => send(res, status, { success: false, message });

/**
 * 读取 JSON 请求体。
 * 超限时不再 destroy 连接（会导致客户端只看到 "fetch failed"），而是丢弃后续数据、
 * 排空请求流后返回 413，让前端能拿到可读的错误提示。
 */
function readBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;            // 已超限：丢弃，但继续排空
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        raw = '';                      // 立即释放已缓存的部分
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        return reject(new HttpError(413, `请求体过大（上限 ${Math.round(limitBytes / 1048576)} MB）`));
      }
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 读取二进制请求体（Excel 文件上传） */
function readRawBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;           // 已超限：丢弃后续数据，但继续排空以便正常回包
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;            // 立即释放已缓存的部分
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new HttpError(413, '文件过大（上限 20 MB），请拆分后重试'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** 输出 Excel 文件下载 */
function sendXlsx(res, buffer, filename) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition':
      `attachment; filename="stkj.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(buffer);
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const cell = (v) => (v === null || v === undefined ? '' : v);

/** 把查询条件构建从分页列表里抽出来，供导出复用 */
function buildDataWhere(params, user) {
  const { clause, args } = buildFilters(params, DATA_FILTERS);
  const where = clause ? [clause.replace(/^ WHERE /, '')] : [];
  where.push('deleted_at IS NULL'); // 软删除行不出现在任何业务查询里

  const from = params.get('date_from');
  const to = params.get('date_to');
  if (from) { where.push("IFNULL(entry_date,'') >= ?"); args.push(from); }
  if (to) { where.push("IFNULL(entry_date,'') <= ?"); args.push(to); }

  const kw = params.get('q');
  if (kw && kw.trim()) {
    const like = `%${kw.trim()}%`;
    where.push(`(project_no LIKE ? OR product_code LIKE ? OR IFNULL(base,'') LIKE ? OR IFNULL(process_code,'') LIKE ? OR IFNULL(work_order,'') LIKE ? OR IFNULL(coke_type,'') LIKE ? OR IFNULL(remark,'') LIKE ?)`);
    args.push(like, like, like, like, like, like, like);
  }

  const of = ownerFilter(user);
  if (of) { where.push(of.sql); args.push(of.arg); }

  return { w: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
}

/**
 * 解析 ids 查询参数（逗号分隔的记录 id），用于「导出已勾选的行」。
 * 返回去重后的 id 数组；超过上限或含非法片段时返回 null（区别于「未提供」的空数组）。
 */
function parseIdParam(raw, cap) {
  if (!raw || !raw.trim()) return [];
  const parts = raw.split(',');
  if (parts.length > cap) return null;
  const ids = [];
  for (const s of parts) {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n <= 0) return null;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

/** 导出检测数据为 Excel（按当前筛选条件，或指定的已勾选 ids） */
function exportDataXlsx(res, params, user) {
  const { w, args } = buildDataWhere(params, user);
  const ids = parseIdParam(params.get('ids'), 2000);
  if (ids === null) return fail(res, 400, 'ids 参数不合法或超出数量上限（2000）');
  let cond = '';
  const idArgs = [];
  if (ids.length) {
    cond = ` id IN (${ids.map(() => '?').join(',')})`;
    idArgs.push(...ids);
  }
  const full = cond ? (w ? `${w} AND${cond}` : ` WHERE${cond}`) : w;
  const rows = db.prepare(`SELECT * FROM project_data${full} ORDER BY id DESC`).all(...args, ...idArgs);
  const table = [FIELDS.map((f) => f.label), ...rows.map((r) => FIELDS.map((f) => cell(r[f.key])))];
  sendXlsx(res, xlsx.build(table, '项目数据'), `项目数据_${todayStr()}.xlsx`);
}

/**
 * 项目列表 / 导出的共用查询：筛选、排序、数据条数统计完全同口径。
 * 数据条数与最近录入日期用 LEFT JOIN + GROUP BY 一次算完（替代每行两个相关子查询），
 * 并对普通用户按 created_by_id 过滤，避免导出时泄露他人数据的数量与时间。
 */
function queryProjects(params, user) {
  const { clause, args } = buildFilters(params, ['project_no', 'product_code', 'project_type']);
  // 软删除行不出现；条件无占位符，追加在 clause 之后不影响参数顺序
  const parts = [clause ? clause.replace(/^ WHERE /, '') : '', 'p.deleted_at IS NULL'];
  const allArgs = [...args];

  const st = (params.get('status') || '').trim();
  if (st !== '') {
    const vals = st.split(',').map((s) => s.trim()).filter((s) => s === '0' || s === '1');
    if (vals.length) {
      parts.push(`p.status IN (${vals.map(() => '?').join(',')})`);
      allArgs.push(...vals.map(Number));
    }
  }
  const q = params.get('q');
  if (q && q.trim()) {
    parts.push("(p.project_no LIKE ? OR p.product_code LIKE ? OR p.project_type LIKE ? OR IFNULL(p.description,'') LIKE ?)");
    const like = `%${q.trim()}%`;
    allArgs.push(like, like, like, like);
  }
  // 指定 ids（导出已勾选的项目）：与其它筛选是 AND 交集
  const ids = parseIdParam(params.get('ids'), 500);
  if (ids === null) return { error: 'ids 参数不合法或超出数量上限（500）' };
  if (ids.length) {
    parts.push(`p.id IN (${ids.map(() => '?').join(',')})`);
    allArgs.push(...ids);
  }
  const where = parts.filter(Boolean).length ? ` WHERE ${parts.filter(Boolean).join(' AND ')}` : '';

  const of = ownerFilter(user, 'd.');
  const join = ` LEFT JOIN project_data d ON d.project_no = p.project_no AND d.deleted_at IS NULL${of ? ` AND ${of.sql}` : ''}`;
  const ownArgs = of ? [of.arg] : [];

  const sortable = new Set([
    'project_no', 'product_code', 'project_type', 'description', 'status',
    'id', 'created_at', 'updated_at', 'data_count', 'last_entry',
  ]);
  const aliasKeys = new Set(['data_count', 'last_entry']);
  const order = buildOrder(params, ' ORDER BY p.id DESC', sortable, 'p.', aliasKeys);

  const rows = db
    .prepare(
      `SELECT p.*, COUNT(d.id) AS data_count, MAX(d.entry_date) AS last_entry
       FROM projects p${join}${where}
       GROUP BY p.id${order}`
    )
    .all(...ownArgs, ...allArgs);
  return { rows };
}

/** 导出项目档案为 Excel（与列表同口径：同样的筛选、排序与归属统计） */
function exportProjectsXlsx(res, params, user) {
  const { rows, error } = queryProjects(params, user);
  if (error) return fail(res, 400, error);
  const header = ['项目编号', '产品代码', '项目类型', '项目简介', '数据量', '最新录入日期', '状态'];
  const table = [
    header,
    ...rows.map((r) => [
      cell(r.project_no), cell(r.product_code), cell(r.project_type), cell(r.description),
      Number(r.data_count || 0), cell(r.last_entry), r.status === 0 ? '已归档' : '进行中',
    ]),
  ];
  sendXlsx(res, xlsx.build(table, '项目列表'), `项目列表_${todayStr()}.xlsx`);
}

/** 按勾选字段生成导入模板（Excel） */
function exportTemplateXlsx(res, params) {
  const wanted = (params.get('fields') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const keySet = new Set(wanted);
  const fields = wanted.length ? FIELDS.filter((f) => keySet.has(f.key)) : FIELDS;
  if (!fields.length) return fail(res, 400, '未选择任何字段');
  const sample = (k, f) => {
    if (k === 'project_no') return 'PJ-2026-001';
    if (k === 'product_code') return 'GC-A1';
    if (k === 'base') return '江西紫宸科技有限公司';
    if (k === 'process_code') return 'PR-10';
    if (k === 'work_order') return 'WO-20260101';
    if (k === 'coke_type') return '针状焦';
    if (k === 'entry_date') return todayStr();
    return f.type === 'number' ? '' : '';
  };
  const table = [fields.map((f) => f.label), fields.map((f) => sample(f.key, f))];
  sendXlsx(res, xlsx.build(table, '导入模板'), `项目数据导入模板_${todayStr()}.xlsx`);
}

/* ---------- Excel 导入：解析后缓存待确认批次 ---------- */
const importTokens = new Map(); // token -> { kind:'data'|'project', rows, user, at }
const IMPORT_TTL = 30 * 60 * 1000;
/** 单次导入行数上限：防止「合法但超大」的表格把内存与事务打满 */
const MAX_IMPORT_ROWS = 50000;

function newImportToken(rows, user, kind = 'data', lines = null) {
  // 清理过期批次
  const now = Date.now();
  for (const [k, v] of importTokens) if (now - v.at > IMPORT_TTL) importTokens.delete(k);
  // 上限保护：超过 100 个批次时淘汰最旧的
  if (importTokens.size >= 100) {
    const oldest = [...importTokens.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) importTokens.delete(oldest[0]);
  }
  const token = crypto.randomBytes(16).toString('hex');
  importTokens.set(token, { kind, rows, lines, user: user.username, at: now });
  return token;
}

/** 通用：解析上传的 Excel，按给定字段集合识别表头并转成 {字段key: 值} 行 */
async function parseUpload(req, fields, requiredLabels) {
  let buf;
  try {
    buf = await readRawBody(req);
  } catch (e) {
    return { error: e.message || '文件读取失败，请重试' };
  }
  if (!buf.length) return { error: '没有收到文件内容' };

  let table;
  try {
    table = xlsx.parse(buf);
  } catch (e) {
    return { error: e.message || '无法解析该 Excel 文件' };
  }
  if (table.length < 2) return { error: 'Excel 文件为空或只有表头，请检查内容' };

  const headers = table[0];
  const headerMap = buildHeaderMap(fields);
  const matched = [];
  const unknown = [];
  headers.forEach((h) => {
    if (!String(h).trim()) return;
    const key = headerMap.get(normHeader(h));
    if (key) matched.push({ col: String(h), key });
    else unknown.push(String(h));
  });

  const missingRequired = requiredLabels.filter(
    (label) => !matched.some((m) => m.key === (fields.find((f) => f.label === label) || {}).key)
  );

  const dataRows = table.slice(1).filter((r) => r.some((c) => !isBlank(c)));
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return { error: `单次最多导入 ${MAX_IMPORT_ROWS.toLocaleString('en-US')} 行，请拆分文件后重试（当前 ${dataRows.length} 行）` };
  }
  const rows = [];
  const lines = [];
  dataRows.forEach((r, i) => {
    const out = {};
    let filled = 0;
    headers.forEach((h, idx) => {
      const key = headerMap.get(normHeader(h));
      if (!key || isBlank(r[idx])) return;
      out[key] = r[idx] === undefined ? '' : r[idx];
      filled++;
    });
    if (!filled) return;
    rows.push(out);
    lines.push(i + 2); // 对应真实 Excel 行号（第 1 行是表头）
  });

  return {
    dataRows: dataRows.length,
    rows,
    lines, // 与 rows 一一对应，供错误提示定位行号（不污染行数据本身）
    matched,
    unknown,
    missingRequired,
    parsedKeys: new Set(matched.map((m) => m.key)),
  };
}

/** 上传 Excel → 解析、识别表头、返回预览统计与批次 token */
async function previewImportFile(res, req, user) {
  const p = await parseUpload(req, FIELDS, ['项目编号', '产品代码']);
  if (p.error) return fail(res, 400, p.error);

  const rows = p.rows.filter((o) => o.project_no || o.product_code);
  // 缺必填表头时仍返回预览（行数为 0），让界面明确提示缺少哪些列
  if (!rows.length && !p.missingRequired.length) return fail(res, 400, '没有可导入的有效数据行');

  const token = newImportToken(rows, user, 'data');
  ok(res, {
    token,
    rowCount: rows.length,
    dataRows: p.dataRows,
    matched: p.matched,
    unknown: p.unknown,
    missingRequired: p.missingRequired,
    blankLabels: FIELDS.filter((f) => !p.parsedKeys.has(f.key)).map((f) => f.label),
  });
}

/** 确认导入：按 token 取出已解析的批次写入数据库 */
function importByToken(res, body, user) {
  const token = String(body.token || '');
  const item = importTokens.get(token);
  if (!item) return fail(res, 400, '导入批次已过期，请重新选择 Excel 文件');
  if (item.user !== user.username) return fail(res, 403, '无权导入该批次数据');
  if (item.kind === 'project') {
    // 权限在会话期间可能被调整，按当前操作人重新判定（与用户导入一致）
    if (!isAdmin(user)) return fail(res, 403, '仅管理员可导入项目');
    const out = performProjectImport(item.rows, String(body.duplicate_action || '').toLowerCase(), user);
    if (out.dup) {
      return send(res, 409, {
        success: false,
        code: 'DUPLICATE_KEY',
        message: `有 ${out.dup.count} 个项目编号已存在`,
        duplicate: out.dup,
      });
    }
    importTokens.delete(token);
    return ok(res, out.result);
  }

  if (item.kind === 'user') {
    // 权限在会话期间可能被调整，按当前操作人重新判定
    if (!isAdmin(user)) return fail(res, 403, '仅管理员可导入用户');
    const out = performUserImport(item.rows, String(body.duplicate_action || '').toLowerCase(), user, item.lines);
    if (out.dup) {
      return send(res, 409, {
        success: false,
        code: 'DUPLICATE_KEY',
        message: `有 ${out.dup.count} 个账号已存在`,
        duplicate: out.dup,
      });
    }
    importTokens.delete(token);
    return ok(res, out.result);
  }

  const out = performImport(item.rows, user, String(body.duplicate_action || '').toLowerCase());
  if (out.dup) {
    // 重复待确认，保留批次，等用户选择覆盖/追加
    return send(res, 409, {
      success: false,
      code: 'DUPLICATE_KEY',
      message: `有 ${out.dup.count} 行数据与系统已有记录重复`,
      duplicate: out.dup,
    });
  }
  importTokens.delete(token);
  return ok(res, out.result);
}

/* ---------- 项目列表导入 ---------- */

const PROJECT_IMPORT_FIELDS = [
  { key: 'project_no', label: '项目编号', type: 'text' },
  { key: 'product_code', label: '产品代码', type: 'text' },
  { key: 'project_type', label: '项目类型', type: 'text' },
  { key: 'description', label: '项目简介', type: 'text' },
  { key: 'status', label: '状态', type: 'text' },
];

/** 项目导入模板 */
function exportProjectTemplateXlsx(res) {
  const table = [
    PROJECT_IMPORT_FIELDS.map((f) => f.label),
    ['PJ-2026-001', 'GC-A1', '量产', '示例：客户定制规格，按工单全程追溯', '进行中'],
  ];
  sendXlsx(res, xlsx.build(table, '导入模板'), `项目列表导入模板_${todayStr()}.xlsx`);
}

/** 上传项目 Excel → 预览 */
async function previewProjectImportFile(res, req, user) {
  const p = await parseUpload(req, PROJECT_IMPORT_FIELDS, ['项目编号', '产品代码', '项目类型']);
  if (p.error) return fail(res, 400, p.error);

  const rows = p.rows.filter((o) => o.project_no);
  if (!rows.length && !p.missingRequired.length) return fail(res, 400, '没有可导入的有效数据行');

  // 与库中已有项目比对，预览即告知将新增 / 已存在各多少
  const existSet = new Set(db.prepare('SELECT project_no FROM projects').all().map((r) => r.project_no));
  let willInsert = 0;
  let willDup = 0;
  for (const r of rows) {
    if (existSet.has(String(r.project_no).trim())) willDup++;
    else willInsert++;
  }

  const token = newImportToken(rows, user, 'project');
  ok(res, {
    token,
    kind: 'project',
    rowCount: rows.length,
    dataRows: p.dataRows,
    matched: p.matched,
    unknown: p.unknown,
    missingRequired: p.missingRequired,
    blankLabels: PROJECT_IMPORT_FIELDS.filter((f) => !p.parsedKeys.has(f.key)).map((f) => f.label),
    willInsert,
    willDup,
  });
}

/** 状态文本 → 1/0 */
function parseStatus(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return 1;
  if (/^(0|停用|已停|归档|已归档|关闭|否|no|false|n)$/i.test(s)) return 0;
  return 1;
}

/**
 * 项目导入落库：
 *   duplicate_action = 'overwrite' 时覆盖同编号项目的其余字段；'skip' 跳过已存在的；
 *   未指定且存在重复 → 返回 dup 让前端确认。
 */
function performProjectImport(rows, action, actor = null) {
  // 唯一索引覆盖软删除行：回收站里的同编号项目也按「已存在」处理，避免 INSERT 撞 UNIQUE
  const existMap = new Map(
    db.prepare('SELECT id, project_no, deleted_at FROM projects').all().map((p) => [p.project_no, p])
  );
  let inserted = 0;
  let overwritten = 0;
  let skipped = 0;
  const errors = [];
  const dupRows = [];
  const seenInFile = new Set();

  db.exec('BEGIN');
  try {
    rows.forEach((raw, i) => {
      const line = i + 2;
      const project_no = String(raw.project_no || '').trim();
      if (!project_no) {
        errors.push(`第 ${line} 行：缺少项目编号`);
        return;
      }
      if (seenInFile.has(project_no)) {
        errors.push(`第 ${line} 行：项目编号 ${project_no} 在文件中重复出现`);
        return;
      }
      seenInFile.add(project_no);

      const exist = existMap.get(project_no);
      if (exist) {
        if (!action) {
          dupRows.push({ line, project_no, existingId: exist.id });
          return;
        }
        if (action === 'skip') {
          skipped++;
          return;
        }
        // overwrite：仅覆盖文件里实际提供的字段
        const patch = {};
        for (const k of ['product_code', 'project_type', 'description']) {
          const v = raw[k];
          if (v === null || v === undefined || String(v).trim() === '') continue;
          patch[k] = String(v).trim();
        }
        if ('status' in raw && String(raw.status).trim() !== '') patch.status = parseStatus(raw.status);
        patch.updated_at = nowStr();
        // 覆盖到回收站里的同名项目时顺带复活（从回收站移回）
        if (exist.deleted_at) patch.deleted_at = null;
        if (Object.keys(patch).length > (exist.deleted_at ? 1 : 0)) {
          update('projects', exist.id, patch, { touch: false });
          overwritten++;
        } else {
          skipped++;
        }
        return;
      }

      const row = {
        project_no,
        product_code: String(raw.product_code || '').trim(),
        project_type: String(raw.project_type || '').trim(),
        description: String(raw.description || '').trim() || null,
        status: 'status' in raw ? parseStatus(raw.status) : 1,
      };
      const miss = [];
      if (!row.product_code) miss.push('产品代码');
      if (!row.project_type) miss.push('项目类型');
      if (miss.length) {
        errors.push(`第 ${line} 行：${miss.join('、')}不能为空`);
        return;
      }
      insert('projects', row);
      existMap.set(project_no, 1);
      inserted++;
    });

    if (dupRows.length > 0) {
      db.exec('ROLLBACK');
      return {
        dup: { mode: 'project', count: dupRows.length, total: rows.length, rows: dupRows.slice(0, 50) },
      };
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  logAudit(actor, 'import', 'project', null, `Excel 导入项目：新增 ${inserted}、覆盖 ${overwritten}、跳过 ${skipped}、失败 ${errors.length}`);
  return { result: { inserted, overwritten, skipped, failed: errors.length, errors: errors.slice(0, 20) } };
}

/** 把查询参数转成 WHERE 条件（多选支持逗号分隔） */
function buildFilters(params, allowed) {
  const where = [];
  const args = [];
  for (const key of allowed) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') continue;
    const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (values.length === 0) continue;
    where.push(`${key} IN (${values.map(() => '?').join(',')})`);
    args.push(...values);
  }
  return { clause: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
}

/**
 * 生成 ORDER BY 子句。
 *   allowed  ：允许排序的列（必须是白名单内的标识符，防注入）
 *   defaultOrder：未指定或列不合法时的默认排序
 * 处理三件事：
 *   1. NULL 统一排最后，且不随方向翻转（`col IS NULL` 永为 0/1 升序）
 *   2. 用 id 兜底，保证同值时顺序稳定、翻页不跳动
 *   3. 数值列显式 CAST，避免字符串列按字典序排（"10" < "9"）
 */
function buildOrder(params, defaultOrder, allowed, prefix = '', aliasKeys = null) {
  const sort = params.get('sort');
  const dir = (params.get('dir') || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const allow = allowed || new Set([...FIELDS.map((f) => f.key), 'id', 'created_by', 'updated_by', 'created_at', 'updated_at']);
  if (!sort || !allow.has(sort)) return defaultOrder;

  // 数值型列：status 是整型，其余按 FIELDS 声明判断
  const numericKeys = new Set(['status', 'id']);
  for (const f of FIELDS) if (f.type === 'number') numericKeys.add(f.key);
  // 查询里定义的别名不能加表前缀（p.data_count 会找不到列）
  const isAlias = !!(aliasKeys && aliasKeys.has(sort));
  const col = isAlias ? sort : `${prefix}${sort}`;
  const expr = numericKeys.has(sort) ? `CAST(${col} AS REAL)` : col;

  // id 兜底方向与主排序一致，让「降序」看起来是整体倒序而不是每组内部正序
  return ` ORDER BY ${col} IS NULL ASC, ${expr} ${dir}, ${prefix}id ${dir}`;
}

const DATA_KEYS = FIELDS.map((f) => f.key);

function pickData(body, { requireNo = true } = {}) {
  const row = {};
  for (const key of DATA_KEYS) {
    if (!(key in body)) continue;
    let v = body[key];
    if (v === '' || v === null || v === undefined) {
      row[key] = null;
      continue;
    }
    const meta = FIELDS.find((f) => f.key === key);
    if (meta.type === 'number') {
      const n = Number(v);
      // 指标字段统一保留 2 位小数（四舍五入），见 db.js ROUND2_KEYS
      row[key] = Number.isFinite(n) ? (meta.round2 ? Math.round(n * 100) / 100 : n) : null;
    } else {
      // 文本字段统一清洗：去控制字符、截断超长内容，避免脏数据进入列表与导出
      row[key] = cleanText(v, TEXT_LIMITS[key] || 200);
    }
  }
  if (requireNo && !row.project_no) throw new Error('项目编号为必填项');
  if (requireNo && !row.product_code) throw new Error('产品代码为必填项');
  return row;
}

function insert(table, row, conflictNoop = false) {
  const keys = Object.keys(row);
  const sql = `INSERT ${conflictNoop ? 'OR IGNORE ' : ''}INTO ${table} (${keys.join(',')}) VALUES (${keys
    .map(() => '?')
    .join(',')})`;
  const info = db.prepare(sql).run(...keys.map((k) => row[k]));
  return info;
}

function update(table, id, row, { touch = true } = {}) {
  const keys = Object.keys(row);
  if (keys.length === 0) return;
  // users 表没有 updated_at 列
  const tail = touch ? ', updated_at = ?' : '';
  const args = touch ? [...keys.map((k) => row[k]), nowStr(), id] : [...keys.map((k) => row[k]), id];
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}${tail} WHERE id = ?`).run(...args);
}

/* ============================================================ 审计日志 */

const stmtAuditInsert = db.prepare(
  'INSERT INTO audit_logs (user_id, username, action, entity, entity_id, summary, changes) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

/**
 * 写一条操作日志。任何失败都不应影响主业务流程，故整体吞异常。
 * changes 传对象时序列化为 JSON（{字段: {from, to}}），供追溯字段级改动。
 */
function logAudit(user, action, entity, entityId, summary, changes = null) {
  try {
    stmtAuditInsert.run(
      user && user.id ? user.id : null,
      user && user.username ? user.username : null,
      action, entity, entityId == null ? null : Number(entityId),
      String(summary || ''), changes ? JSON.stringify(changes) : null
    );
  } catch { /* 审计失败不阻塞业务 */ }
}

/** 对比修改前后的行，生成 {字段: {from, to}} 变更集（只含发生变化的字段） */
function diffRows(cur, next, keys) {
  const out = {};
  for (const k of keys) {
    if (!(k in next)) continue;
    const a = cur[k] === undefined || cur[k] === null ? '' : cur[k];
    const b = next[k] === undefined || next[k] === null ? '' : next[k];
    if (String(a) !== String(b)) out[k] = { from: a, to: b };
  }
  return out;
}

/* ============================================================ 回收站清理 */

/** 软删除保留天数：超过后由清理任务物理删除 */
const SOFT_DELETE_KEEP_DAYS = 30;

const stmtPurgeData = db.prepare(
  `DELETE FROM project_data WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now','localtime','-${SOFT_DELETE_KEEP_DAYS} days')`
);
const stmtPurgeProjects = db.prepare(
  `DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now','localtime','-${SOFT_DELETE_KEEP_DAYS} days')`
);
const stmtPurgeAudit = db.prepare(
  'DELETE FROM audit_logs WHERE created_at < datetime(\'now\',\'localtime\',\'-180 days\')'
);

/** 物理清理：超期软删除的行、180 天前的审计日志、过期会话。启动时跑一次，之后每 6 小时一次 */
function purgeExpired() {
  try {
    const d = stmtPurgeData.run().changes;
    const p = stmtPurgeProjects.run().changes;
    stmtPurgeAudit.run();
    // 会话原本只在启动时清理：长期运行会不断累积已过期但未删除的行
    const s = stmtSessionCleanExpired.run(Date.now() - SESSION_TTL).changes;
    if (d || p) console.log(`[purge] 清理超期软删除：数据 ${d} 条，项目 ${p} 个`);
    if (s) console.log(`[purge] 清理过期会话 ${s} 条`);
  } catch (e) { console.error('[purge] 清理失败：', e.message); }
}
purgeExpired();
setInterval(purgeExpired, 6 * 3600 * 1000).unref();

/* ============================================================ 静态资源 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 可压缩类型：文本类资源体积大（app.js 约 100KB），压缩后可省 70% 以上 */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)\b|image\/svg)/;
/** 静态文件内存缓存：key = 绝对路径，value = { mtimeMs, size, etag, type, raw, gzip?, br? } */
const staticCache = new Map();

function buildStaticEntry(filePath, data, stat) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: data.length,
    type,
    etag: `W/"${data.length.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    raw: data,
  };
  // 压缩结果与文件内容一起缓存，避免每个请求重复压缩
  if (COMPRESSIBLE.test(type) && data.length > 1024) {
    entry.gzip = zlib.gzipSync(data, { level: 6 });
    entry.br = zlib.brotliCompressSync(data, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    });
  }
  if (staticCache.size >= 64) staticCache.clear(); // public/ 文件数很少，超限直接重置
  staticCache.set(filePath, entry);
  return entry;
}

/** 输出静态资源：协商 br/gzip、带 ETag 与 Last-Modified，命中时返回 304 */
function sendStaticEntry(req, res, entry) {
  const headers = {
    'Content-Type': entry.type,
    // no-cache 不是不缓存，而是每次都带 ETag 回来校验：代码更新立即生效，未变则 304 无正文
    'Cache-Control': 'no-cache',
    ETag: entry.etag,
    'Last-Modified': new Date(entry.mtimeMs).toUTCString(),
    ...SECURITY_HEADERS,
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((v) => v.trim() === entry.etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  let body = entry.raw;
  let encoding = null;
  const ae = String(req.headers['accept-encoding'] || '');
  if (entry.br && /\bbr\b/.test(ae)) { body = entry.br; encoding = 'br'; }
  else if (entry.gzip && /\bgzip\b/.test(ae)) { body = entry.gzip; encoding = 'gzip'; }
  if (entry.gzip || entry.br) headers.Vary = 'Accept-Encoding';
  if (encoding) headers['Content-Encoding'] = encoding;
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** SPA 回退：未知路径统一返回 index.html */
function serveIndex(req, res) {
  const filePath = path.join(PUBLIC_DIR, 'index.html');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return fail(res, 404, '页面不存在');
    const cached = staticCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return sendStaticEntry(req, res, cached);
    }
    fs.readFile(filePath, (e2, html) => {
      if (e2) return fail(res, 404, '页面不存在');
      sendStaticEntry(req, res, buildStaticEntry(filePath, html, stat));
    });
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '仅支持 GET / HEAD');
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return fail(res, 400, '路径不合法');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel);
  // 前缀判断必须带路径分隔符，否则 public-x/ 这类兄弟目录会被误判为 public/ 之内
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, '禁止访问');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return serveIndex(req, res);
    const cached = staticCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return sendStaticEntry(req, res, cached);
    }
    fs.readFile(filePath, (e2, data) => {
      if (e2) return serveIndex(req, res);
      sendStaticEntry(req, res, buildStaticEntry(filePath, data, stat));
    });
  });
}

/* ============================================================ 业务路由 */

const PROJECT_FILTERS = ['project_no', 'product_code', 'project_type', 'status', 'q'];
const DATA_FILTERS = ['project_no', 'product_code', 'base', 'process_code', 'work_order', 'coke_type'];

/* ---------- 元数据 ---------- */
/** 元数据缓存：任何写操作后失效。页面每次切换都会拉 /api/meta，缓存可省掉 5~7 条 DISTINCT 查询 */
let metaVersion = 0;
const metaCache = new Map(); // `${userId}` -> { version, data }

function invalidateMeta() {
  metaVersion += 1;
  metaCache.clear();
}

const cmpText = (a, b) => String(a).localeCompare(String(b), 'zh-CN');

function getMeta(res, user) {
  const key = String(user.id);
  const hit = metaCache.get(key);
  if (hit && hit.version === metaVersion) return ok(res, hit.data);

  const admin = isAdmin(user);
  const types = db
    .prepare(`SELECT DISTINCT project_type AS v FROM projects WHERE deleted_at IS NULL AND project_type <> '' ORDER BY v`)
    .all().map((r) => r.v);

  // 普通用户的筛选下拉只列自己数据中出现过的值，避免泄露他人数据。
  // 4~5 条 DISTINCT 合并成一条 UNION ALL，减少往返；结果在内存里分组排序。
  // 注意：每个分支都要 DISTINCT，否则同值会按数据行数重复出现，下拉框里就是一堆重复项。
  const of = ownerFilter(user);
  const w = of ? ` WHERE ${of.sql} AND deleted_at IS NULL` : ' WHERE deleted_at IS NULL';
  const args = of ? [of.arg] : [];
  const cols = ['base', 'process_code', 'work_order', 'coke_type'];
  if (!admin) cols.push('product_code');
  const unionSql = cols
    .map((c) => `SELECT DISTINCT '${c}' AS k, ${c} AS v FROM project_data${w} AND ${c} IS NOT NULL AND ${c} <> ''`)
    .join(' UNION ALL ');
  const optRows = db.prepare(unionSql).all(...cols.flatMap(() => args));
  // 兜底去重：即使 SQL 侧没有 DISTINCT，下拉框也不会出现重复项
  const pick = (k) => [...new Set(optRows.filter((r) => r.k === k).map((r) => r.v))].sort(cmpText);

  // 项目编号 → 产品代码，供录入时自动带出（项目编号列表也由此派生，省一条查询）
  const projectMap = db
    .prepare('SELECT project_no, product_code FROM projects WHERE deleted_at IS NULL ORDER BY project_no')
    .all();

  const data = {
    fields: FIELDS,
    options: {
      types,
      bases: pick('base'),
      processes: pick('process_code'),
      workOrders: pick('work_order'),
      cokeTypes: pick('coke_type'),
      productCodes: admin
        ? [...new Set(projectMap.map((r) => r.product_code).filter(Boolean))].sort(cmpText)
        : pick('product_code'),
      projectNos: projectMap.map((r) => r.project_no),
    },
    projectMap,
    roles: Object.entries(ROLES).map(([k, v]) => ({ key: k, label: v.label })),
    permissions: {
      canManageProjects: admin,
      canDeleteData: admin,
      canManageUsers: admin,
      canManageAdmins: isSysAdmin(user),
      canViewAudit: isSysAdmin(user),
      canManageDatabase: isSysAdmin(user),
      seeAllData: admin,
    },
  };

  if (metaCache.size > 200) metaCache.clear(); // 用户数异常增长时兜底
  metaCache.set(key, { version: metaVersion, data });
  ok(res, data);
}

/* ---------- 项目列表 ---------- */
function listProjects(res, params, user) {
  const { rows, error } = queryProjects(params, user);
  if (error) return fail(res, 400, error);
  ok(res, { rows, total: rows.length });
}

function getProject(res, id) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return fail(res, 404, '项目不存在');
  ok(res, { row });
}

function createProject(res, body, user) {
  const row = {
    project_no: cleanText(body.project_no, TEXT_LIMITS.project_no),
    product_code: cleanText(body.product_code, TEXT_LIMITS.product_code),
    project_type: cleanText(body.project_type, TEXT_LIMITS.project_type),
    description: cleanText(body.description, TEXT_LIMITS.description) || null,
    status: body.status === 0 || body.status === '0' ? 0 : 1,
  };
  if (!row.project_no) return fail(res, 400, '项目编号不能为空');
  if (!row.product_code) return fail(res, 400, '产品代码不能为空');
  if (!row.project_type) return fail(res, 400, '项目类型不能为空');
  const existed = db.prepare('SELECT id FROM projects WHERE project_no = ? AND deleted_at IS NULL').get(row.project_no);
  if (existed) return fail(res, 409, `项目编号 ${row.project_no} 已存在`);
  // 唯一索引覆盖软删除行：同名项目在回收站里时给出明确指引
  const tomb = db.prepare('SELECT id FROM projects WHERE project_no = ? AND deleted_at IS NOT NULL').get(row.project_no);
  if (tomb) return fail(res, 409, `项目编号 ${row.project_no} 已存在于回收站，请先恢复或彻底删除后再新建`);
  const info = insert('projects', row);
  const id = Number(info.lastInsertRowid);
  logAudit(user, 'create', 'project', id, `新增项目 ${row.project_no}（${row.product_code} / ${row.project_type}）`);
  ok(res, { id });
}

function updateProject(res, id, body, user) {
  const cur = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!cur) return fail(res, 404, '项目不存在');
  const row = {};
  for (const k of ['project_no', 'product_code', 'project_type', 'description', 'status']) {
    if (!(k in body)) continue;
    if (k === 'status') {
      row.status = body.status === 0 || body.status === '0' ? 0 : 1;
    } else {
      const v = cleanText(body[k], TEXT_LIMITS[k] || 200);
      row[k] = v || (k === 'description' ? null : '');
    }
  }
  if ('project_no' in row) {
    if (!row.project_no) return fail(res, 400, '项目编号不能为空');
    const dup = db.prepare('SELECT id FROM projects WHERE project_no = ? AND id <> ?').get(row.project_no, id);
    if (dup) return fail(res, 409, `项目编号 ${row.project_no} 已存在`);
  }
  if ('product_code' in row && !row.product_code) return fail(res, 400, '产品代码不能为空');
  if ('project_type' in row && !row.project_type) return fail(res, 400, '项目类型不能为空');
  // 改项目编号需要同时改写子表，放在同一事务里：任一失败则整体回滚，避免项目与数据脱钩
  db.exec('BEGIN');
  try {
    if (row.project_no && row.project_no !== cur.project_no) {
      db.prepare('UPDATE project_data SET project_no = ?, updated_at = ? WHERE project_no = ?').run(
        row.project_no, nowStr(), cur.project_no
      );
    }
    update('projects', id, row);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logAudit(user, 'update', 'project', id, `修改项目 ${row.project_no || cur.project_no}`, diffRows(cur, row, Object.keys(row)));
  ok(res);
}

/**
 * 批量修改项目状态（仅管理员）。
 * body: { ids: number[], status: 0 | 1 }
 * 单条 SQL 的 IN 更新即可保证原子性；返回实际改动的行数（含已是目标状态的行）。
 */
function batchUpdateProjectStatus(res, body, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可修改项目');
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))] : [];
  if (ids.length === 0) return fail(res, 400, '请选择要修改的项目');
  const status = body.status === 0 || body.status === '0' ? 0 : body.status === 1 || body.status === '1' ? 1 : null;
  if (status === null) return fail(res, 400, '状态值不合法，仅支持 0（已归档）或 1（进行中）');
  if (ids.length > 500) return fail(res, 400, '单次最多修改 500 个项目');

  const marks = ids.map(() => '?').join(',');
  const info = db
    .prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id IN (${marks}) AND deleted_at IS NULL`)
    .run(status, nowStr(), ...ids);
  logAudit(user, 'status', 'project', null, `批量修改 ${info.changes} 个项目状态为 ${status === 1 ? '进行中' : '已归档'}`, { ids, status });
  ok(res, { updated: info.changes, status });
}

/**
 * 批量删除项目（仅管理员）。与单个删除一致：级联软删除所选项目下的全部数据记录。
 * body: { ids: number[] }，事务内完成，返回 { removed, removedData }。
 * 软删除仅打 deleted_at 标记，30 天内可在回收站恢复，超期物理清理。
 */
function bulkDeleteProjects(res, body, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可删除项目');
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))] : [];
  if (ids.length === 0) return fail(res, 400, '请选择要删除的项目');
  if (ids.length > 500) return fail(res, 400, '单次最多删除 500 个项目');
  const marks = ids.map(() => '?').join(',');
  const pros = db.prepare(`SELECT id, project_no FROM projects WHERE id IN (${marks}) AND deleted_at IS NULL`).all(...ids);
  const pnos = pros.map((p) => p.project_no);
  let removedData = 0;
  db.exec('BEGIN');
  try {
    const now = nowStr();
    for (const pno of pnos) {
      removedData += db.prepare('SELECT COUNT(*) AS c FROM project_data WHERE project_no = ? AND deleted_at IS NULL').get(pno).c;
    }
    if (pnos.length) {
      const pm = pnos.map(() => '?').join(',');
      db.prepare(`UPDATE project_data SET deleted_at = ? WHERE project_no IN (${pm}) AND deleted_at IS NULL`).run(now, ...pnos);
    }
    const info = db.prepare(`UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id IN (${marks}) AND deleted_at IS NULL`).run(now, now, ...ids);
    db.exec('COMMIT');
    logAudit(user, 'soft_delete', 'project', null,
      `批量删除 ${info.changes} 个项目（${pros.map((p) => p.project_no).join('、')}）及其 ${removedData} 条数据`, { ids });
    ok(res, { removed: info.changes, removedData });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function deleteProject(res, id, user) {
  const cur = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!cur) return fail(res, 404, '项目不存在');
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM project_data WHERE project_no = ? AND deleted_at IS NULL').get(cur.project_no).c;
  const now = nowStr();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, id);
    db.prepare('UPDATE project_data SET deleted_at = ? WHERE project_no = ? AND deleted_at IS NULL').run(now, cur.project_no);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logAudit(user, 'soft_delete', 'project', id, `删除项目 ${cur.project_no} 及其 ${cnt} 条数据`);
  ok(res, { removedData: cnt });
}

/* ---------- 项目数据 ---------- */
function listData(res, params, user) {
  const { w, args } = buildDataWhere(params, user);

  const page = Math.max(1, Number(params.get('page') || 1));
  const pageSize = Math.min(500, Math.max(10, Number(params.get('pageSize') || 50)));
  const offset = (page - 1) * pageSize;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM project_data${w}`).get(...args).c;
  const rows = db
    .prepare(`SELECT * FROM project_data${w}${buildOrder(params, ' ORDER BY id DESC')} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, offset);
  ok(res, { rows, total, page, pageSize });
}

/**
 * 数据页筛选联动：按当前筛选条件返回六个下拉的可选值。
 * 每列都排除自身条件（否则选中后同列其他值会消失、无法切换），
 * 其余条件（含关键词 / 日期 / 权限）全部参与过滤，因此结果与选择顺序无关。
 */
function dataFacets(res, params, user) {
  const dims = [
    ['projectNos', 'project_no'],
    ['productCodes', 'product_code'],
    ['bases', 'base'],
    ['processes', 'process_code'],
    ['workOrders', 'work_order'],
    ['cokeTypes', 'coke_type'],
  ];
  const options = {};
  for (const [name, col] of dims) {
    const p = new URLSearchParams(params);
    [col, 'page', 'pageSize', 'sort', 'dir', 'ids', 'onlySelected'].forEach((k) => p.delete(k));
    const { w, args } = buildDataWhere(p, user);
    const sql = `SELECT DISTINCT ${col} AS v FROM project_data${w} AND ${col} IS NOT NULL AND ${col} <> ''`;
    options[name] = db.prepare(sql).all(...args).map((r) => r.v).sort(cmpText);
  }
  ok(res, { options });
}

function getData(res, id, user) {
  const row = db.prepare('SELECT * FROM project_data WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return fail(res, 404, '数据记录不存在');
  if (!isAdmin(user) && row.created_by_id !== user.id) return fail(res, 403, '无权查看该数据记录');
  ok(res, { row });
}

/** 校验项目编号存在（软删除的项目视为不存在，不能继续录入数据），并返回该项目以同步产品代码 */
function requireProject(projectNo) {
  const p = db.prepare('SELECT * FROM projects WHERE project_no = ? AND deleted_at IS NULL').get(projectNo);
  return p || null;
}

/* ---------- 唯一键：项目编号 + 产品代码 + 所属公司 + 工序 + 工单号 ---------- */
const DUP_KEYS = ['project_no', 'product_code', 'base', 'process_code', 'work_order'];
const DUP_LABELS = {
  project_no: '项目编号', product_code: '产品代码',
  base: '所属公司', process_code: '工序', work_order: '工单号',
};

/** 五个字段是否全部有值（缺任意一项则不参与重复判定） */
function hasFullKey(row) {
  return DUP_KEYS.every((k) => {
    const v = row[k];
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
}

/** 查找五元组已存在的记录，并顺带带回总条数（一条 SQL 完成 count + 取样） */
function findDuplicate(key) {
  return db
    .prepare(
      `SELECT *, COUNT(*) OVER () AS dup_count FROM project_data
       WHERE deleted_at IS NULL AND project_no = ? AND product_code = ? AND IFNULL(base,'') = ?
         AND IFNULL(process_code,'') = ? AND IFNULL(work_order,'') = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(key.project_no, key.product_code, key.base || '', key.process_code || '', key.work_order || '');
}

/** 拼出五元组的可读描述 */
function describeKey(key) {
  return DUP_KEYS.map((k) => `${DUP_LABELS[k]}「${key[k] || '空'}」`).join(' · ');
}

/**
 * 新增数据：
 *   duplicateAction = 'overwrite' 覆盖已有记录（保留原 id 与录入人）
 *                   = 'append'    作为新记录追加
 *                   未指定时，如五元组重复则返回 409 让前端询问
 */
function createData(res, body, user) {
  let row;
  try {
    // 产品代码不强制：由项目编号从项目档案带出
    row = pickData(body, { requireNo: false });
  } catch (e) {
    return fail(res, 400, e.message);
  }
  if (!row.project_no) return fail(res, 400, '项目编号为必填项');
  const proj = requireProject(row.project_no);
  if (!proj) return fail(res, 400, `项目编号 ${row.project_no} 不存在，请先在项目列表中创建该项目`);
  row.product_code = proj.product_code; // 以项目档案为准，避免不一致
  if (!('entry_date' in row) || !row.entry_date) row.entry_date = new Date().toISOString().slice(0, 10);

  // 五项齐全才做重复判定
  const action = String(body.duplicate_action || '').toLowerCase();
  let existing = null;
  if (hasFullKey(row)) existing = findDuplicate(row);
  if (existing && !action) {
    // 让前端确认：覆盖 or 追加
    return send(res, 409, {
      success: false,
      code: 'DUPLICATE_KEY',
      message: '系统已有相同数据',
      duplicate: {
        id: existing.id,
        count: existing.dup_count,
        key: describeKey(row),
        created_by: existing.created_by,
        entry_date: existing.entry_date,
        updated_at: existing.updated_at,
        owner: existing.created_by_id === user.id,
      },
    });
  }

  if (existing && action === 'overwrite') {
    // 覆盖权限：与「修改」一致，普通用户只能覆盖自己录入的记录
    if (!isAdmin(user) && existing.created_by_id !== user.id) {
      return fail(res, 403, `该记录由「${existing.created_by || '他人'}」录入，无权覆盖；如需修改请联系管理员`);
    }
    // 覆盖：仅更新本次提交的字段，保留 id 与录入人
    const patch = { ...row };
    delete patch.created_by;
    delete patch.created_by_id;
    patch.updated_by = user.username;
    update('project_data', existing.id, patch);
    logAudit(user, 'update', 'data', existing.id,
      `覆盖录入数据（${existing.project_no} / 工单 ${existing.work_order || '-'}）`, diffRows(existing, patch, Object.keys(patch)));
    return ok(res, { id: existing.id, mode: 'overwrite', previous: existing.id });
  }

  row.created_by = user.username;
  row.created_by_id = user.id;
  row.updated_by = user.username;
  const info = insert('project_data', row);
  const newId = Number(info.lastInsertRowid);
  logAudit(user, 'create', 'data', newId, `录入数据（${row.project_no} / 工单 ${row.work_order || '-'} / 日期 ${row.entry_date}）`);
  ok(res, { id: newId, mode: existing ? 'append' : 'create' });
}

function updateData(res, id, body, user) {
  const cur = db.prepare('SELECT * FROM project_data WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!cur) return fail(res, 404, '数据记录不存在');
  // 普通用户只能改自己录入的记录
  if (!isAdmin(user) && cur.created_by_id !== user.id) return fail(res, 403, '无权修改他人录入的数据');

  let row;
  try {
    row = pickData(body, { requireNo: false });
  } catch (e) {
    return fail(res, 400, e.message);
  }

  delete row.product_code; // 产品代码始终由项目编号决定，不接受单独提交
  if (!row.project_no) {
    delete row.project_no;
    row.product_code = cur.product_code;
  } else {
    const proj = requireProject(row.project_no);
    if (!proj) return fail(res, 400, `项目编号 ${row.project_no} 不存在`);
    row.product_code = proj.product_code;
  }
  row.updated_by = user.username;
  update('project_data', id, row);
  logAudit(user, 'update', 'data', id, `修改数据（${cur.project_no} / 工单 ${cur.work_order || '-'}）`, diffRows(cur, row, Object.keys(row)));
  ok(res);
}

function deleteData(res, id, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可删除数据记录');
  // 软删除：仅打标记，可在回收站恢复
  const cur = db.prepare('SELECT * FROM project_data WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!cur) return fail(res, 404, '数据记录不存在');
  db.prepare('UPDATE project_data SET deleted_at = ? WHERE id = ?').run(nowStr(), id);
  logAudit(user, 'soft_delete', 'data', id, `删除数据（${cur.project_no} / 工单 ${cur.work_order || '-'} / 日期 ${cur.entry_date}）`);
  ok(res);
}

function bulkDeleteData(res, body, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可删除数据记录');
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))] : [];
  if (ids.length === 0) return fail(res, 400, '请选择要删除的记录');
  if (ids.length > 500) return fail(res, 400, '单次最多删除 500 条记录');
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, project_no, work_order FROM project_data WHERE id IN (${marks}) AND deleted_at IS NULL`).all(...ids);
  if (rows.length === 0) return fail(res, 404, '数据记录不存在');
  const stmt = db.prepare('UPDATE project_data SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const id of ids) n += stmt.run(nowStr(), id).changes;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logAudit(user, 'soft_delete', 'data', null, `批量删除 ${n} 条数据（${rows.map((r) => r.project_no).slice(0, 5).join('、')}${rows.length > 5 ? ' 等' : ''}）`, { ids });
  ok(res, { deleted: n });
}

/* ---------- 回收站 ---------- */

/** 回收站列表（仅管理员）：项目与其数据不重复列出——随项目删除的数据在恢复项目时一并恢复 */
function listRecycle(res, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可查看回收站');
  const projects = db
    .prepare(
      `SELECT p.id, p.project_no, p.product_code, p.project_type, p.status, p.deleted_at,
              (SELECT COUNT(*) FROM project_data d WHERE d.project_no = p.project_no AND d.deleted_at IS NOT NULL) AS data_count
       FROM projects p WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`
    )
    .all();
  const datas = db
    .prepare(
      `SELECT id, project_no, product_code, work_order, entry_date, created_by, deleted_at
       FROM project_data
       WHERE deleted_at IS NOT NULL
         AND project_no NOT IN (SELECT project_no FROM projects WHERE deleted_at IS NOT NULL)
       ORDER BY deleted_at DESC LIMIT 1000`
    )
    .all();
  ok(res, { projects, datas, keepDays: SOFT_DELETE_KEEP_DAYS });
}

/** 从回收站恢复（仅管理员）。body: { entity: 'project' | 'data', ids: number[] } */
function restoreRecycle(res, body, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可恢复数据');
  const entity = body.entity === 'data' ? 'data' : body.entity === 'project' ? 'project' : null;
  if (!entity) return fail(res, 400, 'entity 需为 project 或 data');
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))] : [];
  if (ids.length === 0) return fail(res, 400, '请选择要恢复的记录');
  if (ids.length > 500) return fail(res, 400, '单次最多恢复 500 条');
  const marks = ids.map(() => '?').join(',');

  if (entity === 'project') {
    const pros = db.prepare(`SELECT id, project_no FROM projects WHERE id IN (${marks}) AND deleted_at IS NOT NULL`).all(...ids);
    if (pros.length === 0) return fail(res, 404, '项目不存在或不在回收站中');
    const pnos = pros.map((p) => p.project_no);
    const pm = pnos.map(() => '?').join(',');
    db.exec('BEGIN');
    try {
      const now = nowStr();
      const p = db.prepare(`UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id IN (${marks}) AND deleted_at IS NOT NULL`).run(now, ...ids);
      // 项目恢复时，随它一起被软删除的数据一并恢复
      const d = db.prepare(`UPDATE project_data SET deleted_at = NULL WHERE project_no IN (${pm}) AND deleted_at IS NOT NULL`).run(...pnos);
      db.exec('COMMIT');
      logAudit(user, 'restore', 'project', null, `从回收站恢复 ${p.changes} 个项目（${pnos.join('、')}）及其 ${d.changes} 条数据`, { ids });
      return ok(res, { restored: p.changes, restoredData: d.changes });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const n = db.prepare(`UPDATE project_data SET deleted_at = NULL WHERE id IN (${marks}) AND deleted_at IS NOT NULL`).run(...ids).changes;
  if (n === 0) return fail(res, 404, '数据记录不存在或不在回收站中');
  logAudit(user, 'restore', 'data', null, `从回收站恢复 ${n} 条数据`, { ids });
  ok(res, { restored: n, restoredData: 0 });
}

/** 彻底删除（仅管理员，不可恢复）。body: { entity: 'project' | 'data', ids: number[] } */
function purgeRecycle(res, body, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可彻底删除数据');
  const entity = body.entity === 'data' ? 'data' : body.entity === 'project' ? 'project' : null;
  if (!entity) return fail(res, 400, 'entity 需为 project 或 data');
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))] : [];
  if (ids.length === 0) return fail(res, 400, '请选择要彻底删除的记录');
  if (ids.length > 500) return fail(res, 400, '单次最多删除 500 条');
  const marks = ids.map(() => '?').join(',');

  if (entity === 'project') {
    const pros = db.prepare(`SELECT id, project_no FROM projects WHERE id IN (${marks}) AND deleted_at IS NOT NULL`).all(...ids);
    if (pros.length === 0) return fail(res, 404, '项目不存在或不在回收站中');
    const pnos = pros.map((p) => p.project_no);
    const pm = pnos.map(() => '?').join(',');
    db.exec('BEGIN');
    try {
      const d = db.prepare(`DELETE FROM project_data WHERE project_no IN (${pm}) AND deleted_at IS NOT NULL`).run(...pnos);
      const p = db.prepare(`DELETE FROM projects WHERE id IN (${marks}) AND deleted_at IS NOT NULL`).run(...ids);
      db.exec('COMMIT');
      logAudit(user, 'purge', 'project', null, `彻底删除 ${p.changes} 个项目（${pnos.join('、')}）及其 ${d.changes} 条数据`, { ids });
      return ok(res, { purged: p.changes, purgedData: d.changes });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const n = db.prepare(`DELETE FROM project_data WHERE id IN (${marks}) AND deleted_at IS NOT NULL`).run(...ids).changes;
  if (n === 0) return fail(res, 404, '数据记录不存在或不在回收站中');
  logAudit(user, 'purge', 'data', null, `彻底删除 ${n} 条数据`, { ids });
  ok(res, { purged: n, purgedData: 0 });
}

/**
 * 归一化导入值：
 *  - 空值（空串 / 空格 / - / N/A / 未检测 等）→ undefined（留空）
 *  - 数值字段包含非数字字符（如 "12.3abc"、"<0.01"）→ 尝试提取数字，失败则留空
 */
const BLANK_RE = /^(|\s*|-{1,2}|\/|—|n\/?a|null|nan|无|未检|未检测|未测|待检)$/i;

function normalizeImportValue(key, value) {
  const meta = FIELDS.find((f) => f.key === key);
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (BLANK_RE.test(s)) return undefined;

  if (meta && meta.type === 'number') {
    // 去掉千分位、百分号、空白与比较符，保留数字、小数点、负号、科学计数
    const cleaned = s.replace(/[,，\s%]/g, '').replace(/^[<>≤≥约~]+/, '');
    const m = cleaned.match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
    if (!m) return undefined; // 纯文本 → 留空
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : undefined;
  }
  return s;
}

/**
 * CSV 导入：body.rows = [{...}, ...]，按表头中文名或字段名匹配；允许只提供部分指标字段
 * duplicate_action：
 *   'overwrite' 覆盖已有记录；'append' 全部追加；未指定时若命中重复则返回 409 让前端询问
 */
function performImport(rows, user, action) {
  const labelMap = new Map(FIELDS.map((f) => [f.label, f.key]));
  const keySet = new Set(DATA_KEYS);
  let inserted = 0;
  let overwritten = 0;
  const errors = [];
  const dupRows = [];       // 命中的重复行（供前端确认）
  const filledCount = {};   // 每个字段被成功填充的次数
  let blankTotal = 0;       // 留空的单元格总数

  // 预取全部项目，便于补全产品代码并校验项目编号
  const projectMap = new Map(
    db.prepare('SELECT project_no, product_code FROM projects').all().map((p) => [p.project_no, p.product_code])
  );

  db.exec('BEGIN');
  try {
    rows.forEach((raw, i) => {
      const mapped = {};
      for (const [k, v] of Object.entries(raw)) {
        const key = labelMap.get(String(k).trim()) || (keySet.has(k) ? k : null);
        if (!key) continue;
        const norm = normalizeImportValue(key, v);
        if (norm === undefined) continue; // 留空，不写入
        mapped[key] = norm;
      }
      blankTotal += DATA_KEYS.filter((k) => !(k in mapped)).length;

      try {
        if (!mapped.project_no) throw new Error('缺少项目编号');
        const row = pickData(mapped, { requireNo: false });
        if (!projectMap.has(row.project_no)) {
          throw new Error(`项目编号 ${row.project_no} 不存在`);
        }
        row.product_code = projectMap.get(row.project_no); // 以项目档案为准
        if (!row.entry_date) row.entry_date = new Date().toISOString().slice(0, 10);

        // 五项齐全且已存在同键记录 → 视 duplicate_action 决定（一次查询取回记录与总数）
        let existing = null;
        if (hasFullKey(row)) existing = findDuplicate(row);

        // 覆盖权限：与单条修改一致，普通用户只能覆盖自己录入的记录
        if (existing && !isAdmin(user) && existing.created_by_id !== user.id) {
          errors.push(`第 ${i + 2} 行：该记录由「${existing.created_by || '他人'}」录入，无权覆盖；如需修改请联系管理员`);
          return;
        }

        if (existing && !action) {
          // 先不写库，交给前端确认；继续收集其余重复行
          dupRows.push({
            line: i + 2,
            project_no: row.project_no,
            base: row.base,
            process_code: row.process_code,
            work_order: row.work_order,
            existingId: existing.id,
            existingOwner: existing.created_by,
            own: existing.created_by_id === user.id,
            key: describeKey(row),
          });
          return;
        }

        if (existing && action === 'overwrite') {
          const patch = { ...row };
          delete patch.created_by;
          delete patch.created_by_id;
          patch.updated_by = user.username;
          update('project_data', existing.id, patch);
          overwritten++;
          for (const k of Object.keys(patch)) filledCount[k] = (filledCount[k] || 0) + 1;
          return;
        }

        row.created_by = user.username;
        row.created_by_id = user.id;
        row.updated_by = user.username;
        insert('project_data', row);
        inserted++;
        for (const k of Object.keys(row)) filledCount[k] = (filledCount[k] || 0) + 1;
      } catch (e) {
        errors.push(`第 ${i + 2} 行：${e.message}`);
      }
    });
    // 命中重复且用户尚未选择处理方式 → 整体回滚，只回报冲突信息
    if (dupRows.length > 0) {
      db.exec('ROLLBACK');
      return {
        dup: {
          mode: 'batch',
          count: dupRows.length,
          total: rows.length,
          rows: dupRows.slice(0, 50),
          key: dupRows[0].key,
          sample: dupRows[0].key,
        },
      };
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const blankFields = FIELDS.filter((f) => !filledCount[f.key]).map((f) => f.label);
  logAudit(user, 'import', 'data', null, `Excel 导入数据：新增 ${inserted}、覆盖 ${overwritten}、失败 ${errors.length}`);
  return {
    result: {
      inserted,
      overwritten,
      failed: errors.length,
      errors: errors.slice(0, 20),
      blankCells: blankTotal,
      blankFields,
    },
  };
}

/** JSON 导入入口：body.rows */
function importData(res, body, user) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return fail(res, 400, '没有可导入的数据');
  if (rows.length > MAX_IMPORT_ROWS) {
    return fail(res, 400, `单次最多导入 ${MAX_IMPORT_ROWS} 行，请拆分后重试`);
  }
  return finishImport(res, rows, String(body.duplicate_action || '').toLowerCase(), user);
}

/** 统一的导入收尾：处理 409 冲突与成功响应 */
function finishImport(res, rows, action, user) {
  const out = performImport(rows, user, action);
  if (out.dup) {
    return send(res, 409, {
      success: false,
      code: 'DUPLICATE_KEY',
      message: `有 ${out.dup.count} 行数据与系统已有记录重复`,
      duplicate: out.dup,
    });
  }
  return ok(res, out.result);
}

/* ---------- 统计 ---------- */
function getStats(res, user) {
  const of = ownerFilter(user);
  const w = of ? ` WHERE ${of.sql} AND deleted_at IS NULL` : ' WHERE deleted_at IS NULL';
  const args = of ? [of.arg] : [];

  const projectCount = db.prepare('SELECT COUNT(*) AS c FROM projects WHERE deleted_at IS NULL').get().c;
  const dataCount = db.prepare(`SELECT COUNT(*) AS c FROM project_data${w}`).get(...args).c;
  const typeCount = db.prepare(`SELECT COUNT(DISTINCT project_type) AS c FROM projects WHERE deleted_at IS NULL`).get().c;
  const baseCount = db
    .prepare(`SELECT COUNT(DISTINCT base) AS c FROM project_data${w} AND base IS NOT NULL AND base <> ''`)
    .get(...args).c;
  const qtySum = db.prepare(`SELECT IFNULL(SUM(quantity),0) AS s FROM project_data${w}`).get(...args).s;
  const byType = db.prepare(`SELECT project_type AS name, COUNT(*) AS value FROM projects WHERE deleted_at IS NULL GROUP BY project_type ORDER BY value DESC`).all();
  // 产品代码 / 统计日期（录入日期）数据量分布
  const byProduct = db
    .prepare(`SELECT IFNULL(NULLIF(product_code,''),'未填') AS name, COUNT(*) AS value FROM project_data${w} GROUP BY IFNULL(NULLIF(product_code,''),'未填') ORDER BY value DESC, name`)
    .all(...args);
  const byDate = db
    .prepare(`SELECT IFNULL(NULLIF(entry_date,''),'未填') AS name, COUNT(*) AS value FROM project_data${w} GROUP BY IFNULL(NULLIF(entry_date,''),'未填') ORDER BY name DESC`)
    .all(...args);
  // 项目状态分布：1 进行中 / 0 已归档（固定顺序，保证没有数据时也能显示两项）
  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS value FROM projects WHERE deleted_at IS NULL GROUP BY status')
    .all();
  const statusMap = new Map(statusRows.map((r) => [Number(r.status), r.value]));
  const byStatus = [
    { name: '进行中', value: statusMap.get(1) || 0, status: 1 },
    { name: '已归档', value: statusMap.get(0) || 0, status: 0 },
  ];
  const recent = db
    .prepare(`SELECT id, project_no, product_code, work_order, entry_date, quantity FROM project_data${w} ORDER BY id DESC LIMIT 8`)
    .all(...args);
  ok(res, { stats: { projectCount, dataCount, typeCount, baseCount, qtySum, byType, byProduct, byDate, byStatus, recent } });
}

/* ---------- 审计日志查询（仅管理员） ---------- */

/** 审计日志列表：按时间倒序分页，支持对象 / 动作 / 关键词 / 日期区间筛选 */
function listAuditLogs(res, params, user) {
  if (!isSysAdmin(user)) return fail(res, 403, '仅系统管理员可查看审计日志');

  const where = [];
  const args = [];
  const entity = (params.get('entity') || '').trim();
  if (entity) {
    if (!['project', 'data', 'user', 'database'].includes(entity)) {
      return fail(res, 400, 'entity 仅支持 project / data / user / database');
    }
    where.push('entity = ?');
    args.push(entity);
  }
  const action = (params.get('action') || '').trim();
  if (action) {
    const allowed = ['create', 'update', 'soft_delete', 'restore', 'purge', 'import', 'status', 'export', 'backup'];
    if (!allowed.includes(action)) return fail(res, 400, 'action 参数不合法');
    where.push('action = ?');
    args.push(action);
  }
  const q = (params.get('q') || '').trim();
  if (q) {
    const like = `%${q}%`;
    where.push('(IFNULL(username,\'\') LIKE ? OR summary LIKE ?)');
    args.push(like, like);
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const from = (params.get('date_from') || '').trim();
  const to = (params.get('date_to') || '').trim();
  if (from) {
    if (!DATE_RE.test(from)) return fail(res, 400, 'date_from 需为 YYYY-MM-DD');
    where.push('created_at >= ?');
    args.push(`${from} 00:00:00`);
  }
  if (to) {
    if (!DATE_RE.test(to)) return fail(res, 400, 'date_to 需为 YYYY-MM-DD');
    where.push('created_at <= ?');
    args.push(`${to} 23:59:59`);
  }

  const page = Math.max(1, Number(params.get('page') || 1));
  const pageSize = Math.min(200, Math.max(10, Number(params.get('pageSize') || 50)));
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs${w}`).get(...args).c;
  const rows = db
    .prepare(`SELECT id, user_id, username, action, entity, entity_id, summary, changes, created_at
              FROM audit_logs${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  ok(res, { rows, total, page, pageSize, keepDays: 180 });
}

/* ============================================================ 数据库维护（仅系统管理员） */
/**
 * 导出：VACUUM INTO 生成一致性快照，不锁库、不中断服务。
 * 备份：写入 <应用目录>/backups/app-<时间>.db，与 deploy/backup.cjs 命名一致，共用 14 份轮转。
 * 导入：不替换数据库文件、不重启服务；逐表按列名交集复制，事务提交，导入前自动备份。
 */

const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(path.dirname(DATA_DIR), 'backups');
const DB_TMP_DIR = path.join(DATA_DIR, '.tmp');
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const MAX_DB_IMPORT_BYTES = 20 * 1024 * 1024;
const DB_TABLES = ['users', 'projects', 'project_data', 'audit_logs'];
const BACKUP_NAME_RE = /^app-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d+)?\.db$/;
const DB_IMPORT_TTL = 30 * 60 * 1000;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** 与 deploy/backup.cjs 一致：UTC 时间，冒号换成短横线 */
function dbStamp(d = new Date()) {
  return d.toISOString().replace(/[T:]/g, '-').slice(0, 19);
}
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 生成一份一致性快照（SQLite 原生 VACUUM INTO） */
function vacuumInto(target) {
  db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`);
}

function uniqueBackupPath() {
  ensureDir(BACKUP_DIR);
  const stamp = dbStamp();
  let target = path.join(BACKUP_DIR, `app-${stamp}.db`);
  for (let i = 2; fs.existsSync(target); i++) {
    target = path.join(BACKUP_DIR, `app-${stamp}-${i}.db`);
  }
  return target;
}

function listBackups() {
  ensureDir(BACKUP_DIR);
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .sort()
    .reverse()
    .map((name) => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: st.size, mtime: localStamp(st.mtime) };
    });
}

/** 只保留最近 BACKUP_KEEP 份（与自动备份共用同一套命名） */
function pruneBackups() {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_NAME_RE.test(f)).sort().reverse();
  const removed = [];
  for (const f of files.slice(BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); removed.push(f); } catch { /* ignore */ }
  }
  return { kept: Math.min(files.length, BACKUP_KEEP), removed };
}

/** 输出二进制下载 */
function sendFile(res, buffer, filename, type = 'application/octet-stream') {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition':
      `attachment; filename="stkj-db.db"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(buffer);
}

function databaseCounts() {
  return {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    projects: db.prepare('SELECT COUNT(*) AS c FROM projects').get().c,
    projectData: db.prepare('SELECT COUNT(*) AS c FROM project_data').get().c,
    auditLogs: db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c,
    sessions: db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c,
  };
}

function getDatabaseInfo(res) {
  const st = fs.statSync(DB_FILE);
  ok(res, {
    size: st.size,
    mtime: localStamp(st.mtime),
    counts: databaseCounts(),
    backups: listBackups(),
    keep: BACKUP_KEEP,
  });
}

function exportDatabase(res, user) {
  ensureDir(DB_TMP_DIR);
  const file = path.join(DB_TMP_DIR, `export-${crypto.randomBytes(8).toString('hex')}.db`);
  try {
    vacuumInto(file);
    const buf = fs.readFileSync(file);
    logAudit(user, 'export', 'database', null, `导出数据库（${(buf.length / 1024).toFixed(1)} KB）`);
    sendFile(res, buf, `stkj-${dbStamp()}.db`, 'application/x-sqlite3');
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

function createBackup(res, user) {
  const target = uniqueBackupPath();
  vacuumInto(target);
  const size = fs.statSync(target).size;
  const pruned = pruneBackups();
  logAudit(user, 'backup', 'database', null, `手动备份数据库（${(size / 1024).toFixed(1)} KB）`, {
    file: path.basename(target), size,
  });
  ok(res, { file: path.basename(target), size, backups: listBackups(), keep: BACKUP_KEEP, removed: pruned.removed });
}

function downloadBackup(res, rawName) {
  let name = rawName;
  try { name = decodeURIComponent(rawName); } catch { /* 保持原样 */ }
  if (!BACKUP_NAME_RE.test(name)) return fail(res, 400, '备份文件名不合法');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) return fail(res, 404, '备份文件不存在');
  sendFile(res, fs.readFileSync(file), name, 'application/x-sqlite3');
}

/* ---------- 导入 ---------- */

const dbImportBatches = new Map(); // token -> { file, user, at }

function cleanupDbImportBatches() {
  const now = Date.now();
  for (const [token, b] of dbImportBatches) {
    if (now - b.at > DB_IMPORT_TTL) {
      try { fs.unlinkSync(b.file); } catch { /* ignore */ }
      dbImportBatches.delete(token);
    }
  }
}

/** 启动时清理上次残留的临时文件（超过 1 小时） */
try {
  if (fs.existsSync(DB_TMP_DIR)) {
    const now = Date.now();
    for (const f of fs.readdirSync(DB_TMP_DIR)) {
      const p = path.join(DB_TMP_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > 3600e3) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
} catch { /* ignore */ }

function openReadOnly(file) {
  try { return new DatabaseSync(file, { readOnly: true }); }
  catch { return new DatabaseSync(file); }
}

/**
 * 校验上传的 .db 并读出摘要：
 *   文件头 / integrity_check / 必要表 / 账号与数据量 / 是否存在管理员
 * 任何不满足都抛 HttpError(400)，由调用方转成可读提示。
 */
function inspectSourceDatabase(file) {
  if (!fs.existsSync(file)) throw new HttpError(400, '文件不存在或已被清理');
  const size = fs.statSync(file).size;
  if (size < 4096) throw new HttpError(400, '文件过小，不是有效的 SQLite 数据库');
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('utf8') !== 'SQLite format 3\u0000') {
      throw new HttpError(400, '不是有效的 SQLite 数据库文件（.db）');
    }
  } finally { fs.closeSync(fd); }

  let sdb;
  try { sdb = openReadOnly(file); }
  catch (e) { throw new HttpError(400, `无法打开数据库：${e.message}`); }
  try {
    const check = sdb.prepare('PRAGMA integrity_check').all();
    const result = check[0] ? Object.values(check[0])[0] : '';
    if (String(result).toLowerCase() !== 'ok') {
      throw new HttpError(400, `数据库完整性检查未通过：${String(result).slice(0, 160)}`);
    }
    const tables = new Set(
      sdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const missing = ['users', 'projects', 'project_data'].filter((t) => !tables.has(t));
    if (missing.length) throw new HttpError(400, `数据库缺少必要的数据表：${missing.join('、')}`);

    const counts = {};
    for (const t of DB_TABLES) {
      counts[t] = tables.has(t) ? sdb.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c : 0;
    }
    const users = sdb
      .prepare('SELECT username, real_name, role, status FROM users ORDER BY id')
      .all()
      .map((u) => ({
        ...u,
        role: u.username === 'admin' && u.role === 'admin'
          ? 'sys_admin'
          : ['sys_admin', 'admin', 'user'].includes(u.role) ? u.role : 'user',
      }));
    const admins = users.filter((u) => u.role === 'sys_admin' || u.role === 'admin');
    if (!admins.length) {
      throw new HttpError(400, '该数据库中没有可用的管理员账号，导入后将无法登录，已拒绝导入');
    }
    return {
      size,
      counts,
      userTotal: users.length,
      admins: admins.map((u) => u.username),
      users: users.slice(0, 50),
    };
  } finally {
    try { sdb.close(); } catch { /* ignore */ }
  }
}

async function previewDatabaseImport(res, req, user) {
  cleanupDbImportBatches();
  let buf;
  try {
    buf = await readRawBody(req, MAX_DB_IMPORT_BYTES);
  } catch (e) {
    return fail(res, e.status || 400, e.message || '文件读取失败，请重试');
  }
  if (!buf.length) return fail(res, 400, '没有收到文件内容');

  ensureDir(DB_TMP_DIR);
  const token = crypto.randomBytes(16).toString('hex');
  const file = path.join(DB_TMP_DIR, `import-${token}.db`);
  fs.writeFileSync(file, buf);
  try {
    const summary = inspectSourceDatabase(file);
    dbImportBatches.set(token, { file, user: user.username, at: Date.now() });
    ok(res, { token, summary });
  } catch (e) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    return fail(res, e.status || 400, e.message || '无法解析该数据库文件');
  }
}

/** 把源库逐表复制进当前库：按列名取交集，兼容旧版本缺列；整段事务，失败自动回滚 */
function applyDatabaseImport(file, user, { keepAdmin = true } = {}) {
  const summary = inspectSourceDatabase(file);
  const before = databaseCounts();
  // 当前操作人的完整账号行：keepAdmin 时用它保证导入后仍能登录
  const currentAdmin = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const sdb = openReadOnly(file);
  let backupPath;
  try {
    const payload = {};
    for (const t of DB_TABLES) {
      const srcCols = sdb.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const dstCols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      // 旧版本可能没有 audit_logs 表：按空表处理（导入后审计日志为空）
      if (!srcCols.length) {
        payload[t] = { cols: [], rows: [] };
        continue;
      }
      const cols = dstCols.filter((c) => srcCols.includes(c));
      if (!cols.length) throw new HttpError(400, `数据表 ${t} 与当前版本结构不兼容`);
      const quoted = cols.map((c) => `"${c}"`).join(', ');
      payload[t] = { cols, rows: sdb.prepare(`SELECT ${quoted} FROM ${t}`).all() };
    }

    // 先备份当前数据，再动库：即使导入失败或回滚，也有可恢复的副本
    backupPath = uniqueBackupPath();
    vacuumInto(backupPath);

    db.exec('BEGIN IMMEDIATE');
    try {
      // 子表在前，避免未来加外键后删除顺序出错
      for (const t of ['project_data', 'projects', 'audit_logs', 'sessions', 'users']) {
        db.exec(`DELETE FROM ${t}`);
      }
      for (const t of DB_TABLES) {
        const { cols, rows } = payload[t];
        if (!rows.length) continue;
        const sql = `INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols
          .map(() => '?')
          .join(',')})`;
        const stmt = db.prepare(sql);
        for (const row of rows) {
          stmt.run(...cols.map((c) => (typeof row[c] === 'bigint' ? Number(row[c]) : row[c])));
        }
      }
      // 与 db.js 启动时的规范化保持一致
      db.exec(`UPDATE users SET role = 'sys_admin' WHERE username = 'admin' AND role = 'admin'`);
      db.exec(`UPDATE users SET role = 'user' WHERE role NOT IN ('sys_admin','admin','user')`);
      // 旧库没有归属人的数据：挂到最早的管理员账号下（与 db.js 启动逻辑一致）
      const orphan = db.prepare('SELECT COUNT(*) AS c FROM project_data WHERE created_by_id IS NULL').get().c;
      if (orphan > 0) {
        const owner = db
          .prepare(`SELECT id, username FROM users WHERE role IN ('sys_admin','admin') ORDER BY id LIMIT 1`)
          .get();
        if (owner) {
          db.prepare('UPDATE project_data SET created_by_id = ?, created_by = ? WHERE created_by_id IS NULL')
            .run(owner.id, owner.username);
        }
      }
      // 保证导入后仍能用当前密码登录：保留导入操作人的账号（密码 / 盐 / 状态），并确保为系统管理员
      if (keepAdmin && currentAdmin) {
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(currentAdmin.username);
        if (existing) {
          db.prepare(
            `UPDATE users SET password_hash = ?, salt = ?, role = 'sys_admin', status = 1, pwd_changed = ? WHERE id = ?`
          ).run(currentAdmin.password_hash, currentAdmin.salt, currentAdmin.pwd_changed, existing.id);
        } else {
          db.prepare(
            `INSERT INTO users (username, password_hash, salt, real_name, role, status, remark, pwd_changed, created_at, last_login)
             VALUES (?, ?, ?, ?, 'sys_admin', 1, ?, ?, ?, ?)`
          ).run(
            currentAdmin.username, currentAdmin.password_hash, currentAdmin.salt, currentAdmin.real_name,
            currentAdmin.remark, currentAdmin.pwd_changed, currentAdmin.created_at, currentAdmin.last_login
          );
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  } finally {
    try { sdb.close(); } catch { /* ignore */ }
  }

  // 事务已提交：清理缓存、轮转备份、记录审计
  invalidateMeta();
  pruneBackups();
  const after = databaseCounts();
  logAudit(
    { username: user.username }, 'import', 'database', null,
    `导入数据库：用户 ${after.users} / 项目 ${after.projects} / 数据 ${after.projectData} 条`,
    { before, after, backup: path.basename(backupPath), source: '上传 .db 文件', keepAdmin: !!keepAdmin }
  );
  return {
    backup: path.basename(backupPath),
    before,
    after,
    admins: summary.admins,
    keepAdmin: !!keepAdmin && !!currentAdmin,
    keptAdmin: currentAdmin ? currentAdmin.username : null,
  };
}

function confirmDatabaseImport(res, body, user) {
  const token = String(body.token || '');
  const item = dbImportBatches.get(token);
  if (!item) return fail(res, 400, '导入批次已过期，请重新选择数据库文件');
  if (item.user !== user.username) return fail(res, 403, '无权导入该批次');
  dbImportBatches.delete(token);

  let out;
  try {
    out = applyDatabaseImport(item.file, user, { keepAdmin: body.keep_admin !== false });
  } catch (e) {
    const status = Number(e && e.status) || 500;
    const msg = status >= 400 && status < 500 ? e.message : `导入失败：${e.message}`;
    return fail(res, status, msg);
  } finally {
    try { fs.unlinkSync(item.file); } catch { /* ignore */ }
  }
  // 所有会话已被清空（导入的账号体系生效），顺手清掉当前浏览器的 Cookie
  return send(res, 200, { success: true, ...out }, {
    'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
  });
}

/* ---------- 用户批量导入 ---------- */

/** 账号校验规则（与 createUser 保持一致） */
const USERNAME_RE = /^[A-Za-z0-9_.@-]{2,32}$/;

/** 角色文本 → role 值；无法识别返回 null（只接受完整写法，避免「管理」这类简写误判） */
function parseRole(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return 'user';
  if (/^(系统管理员|超级管理员|sys_?admin|superadmin|root)$/i.test(s)) return 'sys_admin';
  if (/^(管理员|admin|administrator)$/i.test(s)) return 'admin';
  if (/^(普通用户|用户|user|member|guest)$/i.test(s)) return 'user';
  return null;
}

/** 用户导入模板（角色/状态列按权限裁剪，避免给出无权填写的示例） */
function exportUserTemplateXlsx(res, user) {
  const role = isSysAdmin(user) ? '管理员' : '普通用户';
  const table = [USER_IMPORT_FIELDS.map((f) => f.label), ['zhangsan', '张三', role, '启用', '示例：生产部']];
  sendXlsx(res, xlsx.build(table, '导入模板'), `用户导入模板_${todayStr()}.xlsx`);
}

/**
 * 逐行校验，预览和落库共用同一套规则：
 *   allowAdmin = 当前操作人是否可导入「管理员」角色
 * 返回 { clean[], errors[] }，clean 每项为可直接入库的字段对象
 */
function validateUserRows(rows, allowAdmin, lines) {
  const clean = [];
  const errors = [];
  const seen = new Set();
  rows.forEach((raw, i) => {
    // 行号优先取解析阶段记录的真实 Excel 行号
    const line = (lines && lines[i]) || i + 2;
    const username = String(raw.username || '').trim();
    if (!username) {
      errors.push(`第 ${line} 行：缺少账号`);
      return;
    }
    if (!USERNAME_RE.test(username)) {
      errors.push(`第 ${line} 行：账号「${username}」格式不正确，需为 2-32 位字母、数字或 _ . @ -`);
      return;
    }
    if (seen.has(username.toLowerCase())) {
      errors.push(`第 ${line} 行：账号 ${username} 在文件中重复出现`);
      return;
    }
    seen.add(username.toLowerCase());

    // roleGiven=false 表示文件未提供角色，覆盖已有账号时保持原角色不变
    const roleGiven = String(raw.role === null || raw.role === undefined ? '' : raw.role).trim() !== '';
    const role = parseRole(raw.role);
    if (role === null) {
      errors.push(`第 ${line} 行：角色「${String(raw.role).trim()}」无法识别，请填写「普通用户」或「管理员」`);
      return;
    }
    if (role === 'sys_admin') {
      errors.push(`第 ${line} 行：不支持通过导入创建系统管理员`);
      return;
    }
    if (role === 'admin' && !allowAdmin) {
      errors.push(`第 ${line} 行：仅系统管理员可导入管理员账号`);
      return;
    }

    clean.push({
      line,
      username,
      roleGiven,
      real_name: String(raw.real_name || '').trim() || null,
      role,
      status: parseStatus(raw.status),
      remark: String(raw.remark || '').trim() || null,
    });
  });
  return { clean, errors };
}

/** 上传用户 Excel → 预览（不改库），返回批次 token 与新增/已存在统计 */
async function previewUserImportFile(res, req, user) {
  const p = await parseUpload(req, USER_IMPORT_FIELDS, ['账号']);
  if (p.error) return fail(res, 400, p.error);

  // 保留每条数据行对应的真实 Excel 行号，过滤时一并过滤
  const keep = p.rows.map((o, i) => (String(o.username || '').trim() ? i : -1)).filter((i) => i >= 0);
  const rows = keep.map((i) => p.rows[i]);
  const lines = keep.map((i) => p.lines[i]);
  if (!rows.length && !p.missingRequired.length) return fail(res, 400, '没有可导入的有效数据行');

  const { clean, errors } = validateUserRows(rows, isSysAdmin(user), lines);
  const existSet = new Set(db.prepare('SELECT username FROM users').all().map((r) => r.username.toLowerCase()));
  let willInsert = 0;
  let willDup = 0;
  for (const r of clean) {
    if (existSet.has(r.username.toLowerCase())) willDup++;
    else willInsert++;
  }

  const token = newImportToken(rows, user, 'user', lines);
  ok(res, {
    token,
    kind: 'user',
    rowCount: rows.length,
    dataRows: p.dataRows,
    matched: p.matched,
    unknown: p.unknown,
    missingRequired: p.missingRequired,
    blankLabels: USER_IMPORT_FIELDS.filter((f) => !p.parsedKeys.has(f.key)).map((f) => f.label),
    willInsert,
    willDup,
    errorCount: errors.length,
    errors: errors.slice(0, 20),
  });
}

/**
 * 用户导入落库：
 *   duplicate_action = 'overwrite' 覆盖已存在账号的姓名/角色/状态/备注（不动密码）；
 *   'skip' 跳过已存在账号；未指定且存在重复 → 返回 dup 让前端确认。
 * 新用户密码一律为账号本身（pwd_changed = 0，登录后会提示修改）。
 */
function performUserImport(rows, action, actor, lines) {
  const { clean, errors } = validateUserRows(rows, isSysAdmin(actor), lines);
  const existMap = new Map(db.prepare('SELECT id, username, role FROM users').all().map((u) => [u.username.toLowerCase(), u]));
  let inserted = 0;
  let overwritten = 0;
  let skipped = 0;
  const dupRows = [];

  db.exec('BEGIN');
  try {
    for (const r of clean) {
      const cur = existMap.get(r.username.toLowerCase());
      if (cur) {
        // 系统管理员账号一律不允许通过导入改写（含不改动作的预览阶段）
        if (cur.role === 'sys_admin') {
          errors.push(`第 ${r.line} 行：${cur.username} 是系统管理员账号，不可通过导入修改`);
          continue;
        }
        // 非系统管理员无权改写其他管理员；但可以改写自己的账号
        if (cur.role === 'admin' && !isSysAdmin(actor) && cur.id !== actor.id) {
          errors.push(`第 ${r.line} 行：${cur.username} 是管理员账号，仅系统管理员可修改`);
          continue;
        }
        if (!action) {
          dupRows.push({ line: r.line, username: cur.username, existingId: cur.id });
          continue;
        }
        if (action === 'skip') {
          skipped++;
          continue;
        }
        const patch = { status: r.status };
        if (r.real_name) patch.real_name = r.real_name;
        if (r.remark) patch.remark = r.remark;
        // 角色只在文件明确提供时才变更，避免覆盖时把管理员降级为普通用户
        if (r.roleGiven && r.role !== cur.role) {
          if (!isSysAdmin(actor)) {
            errors.push(`第 ${r.line} 行：仅系统管理员可变更角色（${cur.username}）`);
            continue;
          }
          patch.role = r.role;
        }
        update('users', cur.id, patch, { touch: false });
        // 停用后强制退出该用户已登录的会话
        if (r.status === 0) destroyUserSessions(cur.id);
        overwritten++;
        continue;
      }

      const salt = makeSalt();
      insert('users', {
        username: r.username,
        salt,
        password_hash: hashPassword(r.username, salt), // 初始密码 = 账号
        real_name: r.real_name,
        role: r.role,
        status: r.status,
        remark: r.remark,
        pwd_changed: 0,
      });
      existMap.set(r.username.toLowerCase(), { id: 1, username: r.username, role: r.role });
      inserted++;
    }

    if (dupRows.length > 0) {
      db.exec('ROLLBACK');
      return {
        dup: { mode: 'user', count: dupRows.length, total: clean.length, rows: dupRows.slice(0, 50) },
      };
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  logAudit(actor, 'import', 'user', null, `Excel 导入用户：新增 ${inserted}、覆盖 ${overwritten}、跳过 ${skipped}、失败 ${errors.length}`);
  return { result: { inserted, overwritten, skipped, failed: errors.length, errors: errors.slice(0, 20) } };
}

/* ---------- 用户 ---------- */
function listUsers(res) {
  const rows = db
    .prepare(`SELECT u.id, u.username, u.real_name, u.role, u.status, u.remark,
                     u.created_at, u.last_login, u.pwd_changed,
                     (SELECT COUNT(*) FROM project_data d WHERE d.created_by_id = u.id) AS data_count
              FROM users u ORDER BY u.id`)
    .all();
  ok(res, { rows });
}

/** 新增用户：密码默认为账号 */
function createUser(res, body, user) {
  const username = (body.username || '').trim();
  if (!username) return fail(res, 400, '账号不能为空');
  if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(username)) {
    return fail(res, 400, '账号需为 2-32 位字母、数字或 _ . @ -');
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return fail(res, 409, '账号已存在');

  // 角色：仅系统管理员可创建管理员；其他人只能创建普通用户
  let role = 'user';
  if (body.role === 'admin') {
    if (!isSysAdmin(user)) return fail(res, 403, '仅系统管理员可创建管理员账号');
    role = 'admin';
  }

  const password = String(body.password || '').trim() || username; // 密码默认为账号
  const salt = makeSalt();
  insert('users', {
    username,
    salt,
    password_hash: hashPassword(password, salt),
    real_name: (body.real_name || '').trim() || null,
    role,
    status: body.status === 0 ? 0 : 1,
    remark: (body.remark || '').trim() || null,
    pwd_changed: body.password ? 1 : 0, // 未指定密码 → 记为初始密码
  });
  logAudit(user, 'create', 'user', null, `新增用户 ${username}（${role === 'admin' ? '管理员' : '普通用户'}）`);
  ok(res, { username, role, defaultPassword: !body.password });
}

function updateUser(res, id, body, actor) {
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!cur) return fail(res, 404, '用户不存在');
  if (cur.role === 'sys_admin') return fail(res, 403, '系统管理员账号不可修改');
  if (!isSysAdmin(actor) && cur.role === 'admin') return fail(res, 403, '仅系统管理员可修改管理员账号');

  const row = {};
  if ('real_name' in body) row.real_name = (body.real_name || '').trim() || null;
  if ('remark' in body) row.remark = (body.remark || '').trim() || null;
  if ('status' in body) row.status = body.status === 0 ? 0 : 1;
  if ('role' in body) {
    const next = body.role === 'admin' ? 'admin' : 'user';
    if (next !== cur.role && !isSysAdmin(actor)) return fail(res, 403, '仅系统管理员可变更角色');
    row.role = next;
  }
  if (body.reset_password) {
    // 重置为账号（初始密码）
    row.salt = makeSalt();
    row.password_hash = hashPassword(cur.username, row.salt);
    row.pwd_changed = 0;
  } else if (body.password) {
    if (String(body.password).length < 4) return fail(res, 400, '密码至少 4 位');
    row.salt = makeSalt();
    row.password_hash = hashPassword(body.password, row.salt);
    row.pwd_changed = 1;
  }
  // 只有「停用 / 变更角色 / 改密」才需要强制下线；
  // 仅修改姓名或备注不应打断对方正在进行的操作（之前无条件踢人会误伤）。
  const needKick =
    ('status' in row && row.status === 0 && cur.status !== 0) ||
    ('role' in row && row.role !== cur.role) ||
    !!body.reset_password || !!body.password;
  update('users', id, row, { touch: false });
  if (needKick) destroyUserSessions(id);
  const acts = [];
  if ('status' in row) acts.push(row.status === 1 ? '启用' : '停用');
  if ('role' in row && row.role !== cur.role) acts.push(`角色改为${row.role === 'admin' ? '管理员' : '普通用户'}`);
  if (body.reset_password) acts.push('重置密码为初始密码');
  else if (body.password) acts.push('修改密码');
  logAudit(actor, 'update', 'user', id, `修改用户 ${cur.username}：${acts.join('、') || '资料'}`, diffRows(cur, row, Object.keys(row)));
  ok(res);
}

function deleteUser(res, id, actor) {
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!cur) return fail(res, 404, '用户不存在');
  if (cur.role === 'sys_admin') return fail(res, 403, '系统管理员账号不可删除');
  if (!isSysAdmin(actor) && cur.role === 'admin') return fail(res, 403, '仅系统管理员可删除管理员账号');
  if (cur.id === actor.id) return fail(res, 400, '不能删除当前登录的账号');

  const dataCount = db.prepare('SELECT COUNT(*) AS c FROM project_data WHERE created_by_id = ?').get(id).c;
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  destroyUserSessions(id);
  logAudit(actor, 'soft_delete', 'user', id, `删除用户 ${cur.username}（其名下 ${dataCount} 条数据保留）`);
  ok(res, { removedUser: true, dataCount });
}

/* ============================================================ 路由分发 */

/* ---------- 登录相关（无需鉴权） ---------- */
/** 登录失败计数，防止暴力猜解：同一账号连续失败 5 次锁定 5 分钟 */
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const loginFails = new Map(); // username -> { count, firstAt, lockedUntil }

function login(res, body, req) {
  const username = (body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return fail(res, 400, '请输入账号和密码');

  const rec = loginFails.get(username);
  if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    return fail(res, 429, `密码错误次数过多，请 ${mins} 分钟后再试`);
  }

  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // 账号不存在与密码错误返回同一提示，避免账号枚举
  if (!u || !safeEqual(hashPassword(password, u.salt), u.password_hash)) {
    const now = Date.now();
    const cur = loginFails.get(username);
    // 超过统计窗口（5 分钟）则重新计数
    const next = !cur || now - cur.firstAt > LOCK_MS
      ? { count: 1, firstAt: now, lockedUntil: 0 }
      : { ...cur, count: cur.count + 1 };
    if (next.count >= MAX_FAILS) next.lockedUntil = now + LOCK_MS;
    loginFails.set(username, next);
    // 兜底：清理已过统计窗口的旧记录，避免长期运行后 Map 无限增长
    if (loginFails.size > 1000) {
      for (const [k, v] of loginFails) {
        if (now - v.firstAt > LOCK_MS && (!v.lockedUntil || now > v.lockedUntil)) loginFails.delete(k);
      }
    }
    const left = MAX_FAILS - next.count;
    return fail(res, 401, left > 0 ? `账号或密码错误，还可尝试 ${left} 次` : '密码错误次数过多，请 5 分钟后再试');
  }
  loginFails.delete(username);
  if (u.status !== 1) return fail(res, 403, '该账号已停用，请联系管理员');

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowStr(), u.id);
  const token = createSession(u.id, req);
  send(res, 200, {
    success: true,
    user: {
      id: u.id, username: u.username, real_name: u.real_name,
      role: u.role, roleLabel: ROLES[u.role]?.label || u.role,
      pwd_changed: u.pwd_changed,
    },
  }, {
    'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`,
  });
}

function logout(req, res) {
  destroySession(parseCookies(req).sid);
  send(res, 200, { success: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
}

function me(res, user) {
  ok(res, {
    user: {
      id: user.id, username: user.username, real_name: user.real_name,
      role: user.role, roleLabel: ROLES[user.role]?.label || user.role,
      pwd_changed: user.pwd_changed,
    },
  });
}

/** 自助修改密码 */
function changePassword(res, body, user, req) {
  const oldPwd = String(body.old_password || '');
  const newPwd = String(body.new_password || '');
  if (!oldPwd || !newPwd) return fail(res, 400, '请填写原密码与新密码');
  if (newPwd.length < 4) return fail(res, 400, '新密码至少 4 位');
  if (newPwd === oldPwd) return fail(res, 400, '新密码不能与原密码相同');

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!u || !safeEqual(hashPassword(oldPwd, u.salt), u.password_hash)) {
    return fail(res, 400, '原密码不正确');
  }
  const salt = makeSalt();
  db.prepare('UPDATE users SET password_hash = ?, salt = ?, pwd_changed = 1 WHERE id = ?').run(
    hashPassword(newPwd, salt), salt, user.id
  );
  // 改密后使该账号已有的全部会话失效（防止密码泄露期间被他人长期持有登录态），
  // 再为当前设备补发一个新会话，避免本机也被踢下线
  destroyUserSessions(user.id);
  const token = createSession(user.id, req);
  send(res, 200, { success: true }, {
    'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`,
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const q = url.searchParams;
  const seg = p.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  /* ---- 免登录接口 ---- */
  if (p === '/api/auth/login' && m === 'POST') return login(res, await readBody(req), req);
  if (p === '/api/auth/logout' && m === 'POST') return logout(req, res);

  /* ---- 以下接口均需登录 ---- */
  const user = currentUser(req);
  if (!user) return fail(res, 401, '未登录或登录已失效，请重新登录');

  if (p === '/api/auth/me' && m === 'GET') return me(res, user);
  if (p === '/api/auth/password' && m === 'POST') return changePassword(res, await readBody(req), user, req);

  if (m === 'GET' && p === '/api/meta') return getMeta(res, user);
  if (m === 'GET' && p === '/api/stats') return getStats(res, user);
  // 审计日志：只读，保留 180 天
  if (m === 'GET' && p === '/api/audit-logs') return listAuditLogs(res, q, user);

  // 数据库维护（导出 / 导入 / 备份，仅系统管理员）
  if (p.startsWith('/api/admin/db/')) {
    if (!isSysAdmin(user)) return fail(res, 403, '仅系统管理员可维护数据库');
    if (p === '/api/admin/db/info' && m === 'GET') return getDatabaseInfo(res);
    if (p === '/api/admin/db/export' && m === 'GET') return exportDatabase(res, user);
    if (p === '/api/admin/db/import-preview' && m === 'POST') return previewDatabaseImport(res, req, user);
    if (p === '/api/admin/db/import-confirm' && m === 'POST') {
      return confirmDatabaseImport(res, await readBody(req), user);
    }
    if (p === '/api/admin/db/backup' && m === 'POST') return createBackup(res, user);
    if (p === '/api/admin/db/backups' && m === 'GET') return ok(res, { backups: listBackups(), keep: BACKUP_KEEP });
    if (seg[0] === 'admin' && seg[1] === 'db' && seg[2] === 'backups' && seg[3] && m === 'GET') {
      return downloadBackup(res, seg[3]);
    }
    return fail(res, 404, '接口不存在');
  }

  // 回收站（仅管理员）
  if (p === '/api/recycle' && m === 'GET') return listRecycle(res, user);
  if (p === '/api/recycle/restore' && m === 'POST') return restoreRecycle(res, await readBody(req), user);
  if (p === '/api/recycle/purge' && m === 'POST') return purgeRecycle(res, await readBody(req), user);

  // projects：全员可查看；增删改仅管理员
  if (p === '/api/projects') {
    if (m === 'GET') return listProjects(res, q, user);
    if (m === 'POST') {
      if (!isAdmin(user)) return fail(res, 403, '仅管理员可新增项目');
      return createProject(res, await readBody(req), user);
    }
  }
  if (p === '/api/projects/export' && m === 'GET') return exportProjectsXlsx(res, q, user);
  // 项目列表导入：与数据导入一致，仅管理员可操作（项目档案的增删改本来就是管理员权限）
  if (p === '/api/projects/template' && m === 'GET') {
    if (!isAdmin(user)) return fail(res, 403, '仅管理员可导入项目');
    return exportProjectTemplateXlsx(res);
  }
  if (p === '/api/projects/import-file' && m === 'POST') {
    if (!isAdmin(user)) return fail(res, 403, '仅管理员可导入项目');
    return previewProjectImportFile(res, req, user);
  }
  if (p === '/api/projects/import-confirm' && m === 'POST') {
    if (!isAdmin(user)) return fail(res, 403, '仅管理员可导入项目');
    return importByToken(res, await readBody(req), user);
  }
  if (p === '/api/projects/batch-status' && m === 'POST') {
    return batchUpdateProjectStatus(res, await readBody(req), user);
  }
  if (p === '/api/projects/bulk-delete' && m === 'POST') {
    return bulkDeleteProjects(res, await readBody(req), user);
  }
  // 注意：batch-status / bulk-delete 必须在下方 seg[1] 的 id 分支之前拦截，否则会被当成 id 解析成 NaN
  if (seg[0] === 'projects' && seg[1]) {
    const id = Number(seg[1]);
    if (m === 'GET') return getProject(res, id);
    if (m === 'PUT' || m === 'PATCH') {
      if (!isAdmin(user)) return fail(res, 403, '仅管理员可修改项目');
      return updateProject(res, id, await readBody(req), user);
    }
    if (m === 'DELETE') {
      if (!isAdmin(user)) return fail(res, 403, '仅管理员可删除项目');
      return deleteProject(res, id, user);
    }
  }

  // project data：查看受归属限制；新增/修改需登录；删除仅管理员
  if (p === '/api/data') {
    if (m === 'GET') return listData(res, q, user);
    if (m === 'POST') return createData(res, await readBody(req), user);
  }
  // Excel 导出 / 上传解析（需登录，导出受归属过滤限制）
  if (p === '/api/data/export' && m === 'GET') return exportDataXlsx(res, q, user);
  // 筛选联动：返回各下拉在当前筛选下的可选值
  if (p === '/api/data/facets' && m === 'GET') return dataFacets(res, q, user);
  if (p === '/api/data/template' && m === 'GET') return exportTemplateXlsx(res, q);
  if (p === '/api/data/import-file' && m === 'POST') return previewImportFile(res, req, user);
  if (p === '/api/data/import-confirm' && m === 'POST') {
    return importByToken(res, await readBody(req), user);
  }
  if (p === '/api/data/bulk-delete' && m === 'POST') return bulkDeleteData(res, await readBody(req), user);
  if (p === '/api/data/import' && m === 'POST') return importData(res, await readBody(req), user);
  if (seg[0] === 'data' && seg[1] && !['export', 'template', 'import-file', 'import-confirm', 'bulk-delete', 'import'].includes(seg[1])) {
    const id = Number(seg[1]);
    if (m === 'GET') return getData(res, id, user);
    if (m === 'PUT' || m === 'PATCH') return updateData(res, id, await readBody(req), user);
    if (m === 'DELETE') return deleteData(res, id, user);
  }

  // users：普通用户管理权限仅管理员及以上
  if (seg[0] === 'users') {
    if (!isAdmin(user)) return fail(res, 403, '仅管理员可管理用户');
    if (p === '/api/users') {
      if (m === 'GET') return listUsers(res);
      if (m === 'POST') return createUser(res, await readBody(req), user);
    }
    // 用户批量导入（三个子路径都要在 id 分支之前拦截）
    if (p === '/api/users/template' && m === 'GET') return exportUserTemplateXlsx(res, user);
    if (p === '/api/users/import-file' && m === 'POST') return previewUserImportFile(res, req, user);
    if (p === '/api/users/import-confirm' && m === 'POST') {
      return importByToken(res, await readBody(req), user);
    }
    const id = Number(seg[1]);
    if (m === 'PUT' || m === 'PATCH') return updateUser(res, id, await readBody(req), user);
    if (m === 'DELETE') return deleteUser(res, id, user);
  }

  return fail(res, 404, '接口不存在');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      // 写操作后让 /api/meta 缓存失效，保证筛选下拉及时反映新增的项目 / 公司 / 工单
      if (req.method !== 'GET' && req.method !== 'HEAD') invalidateMeta();
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    // 客户端错误（非法 JSON、请求体过大等）按自身状态码返回，只有真正的服务端异常才是 500
    const status = Number(e && e.status);
    if (status >= 400 && status < 500) {
      if (!res.headersSent) fail(res, status, e.message || '请求不合法');
      else res.end();
      return;
    }
    console.error('[ERROR]', req.method, url.pathname, e);
    // 只把错误细节写日志，不回传给客户端，避免泄露 SQL / 表结构 / 文件路径等信息
    if (!res.headersSent) fail(res, 500, '服务器内部错误，请稍后重试或联系管理员');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  项目管理应用已启动`);
  console.log(`  访问地址: http://${HOST}:${PORT}`);
  console.log(`  数据库  : ${DB_FILE}\n`);
});

/* ---------- 优雅退出：把 WAL 中的数据落盘，避免停服丢失写入 ---------- */
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n  收到 ${signal}，正在关闭 ...`);
  server.close(() => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.close();
      console.log('  数据库已安全关闭');
    } catch (e) {
      console.error('  关闭数据库出错:', e.message);
    }
    process.exit(0);
  });
  // 兜底：10 秒内没关完就强制退出
  setTimeout(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); db.close(); } catch {}
    process.exit(0);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { server, db, hashPassword, makeSalt };
