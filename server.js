'use strict';
/**
 * 项目管理应用 - 后端服务
 * 零依赖：Node.js 内置 http + node:sqlite
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DB_FILE, FIELDS } = require('./db');
const xlsx = require('./xlsx');
const { normHeader, buildHeaderMap, isBlank } = require('./import-map');

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
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12 小时
const sessions = new Map(); // token -> { userId, createdAt, lastSeen }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now(), lastSeen: Date.now() });
  return token;
}
function destroySession(token) {
  if (token) sessions.delete(token);
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
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
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = Date.now();
  const u = db
    .prepare('SELECT id, username, real_name, role, status, pwd_changed FROM users WHERE id = ?')
    .get(s.userId);
  if (!u || u.status !== 1) return null;
  return u;
}

/* ============================================================ 审计字段 */
/** 数据归属过滤：管理员看全部，普通用户只看自己 */
function ownerFilter(user, alias = '') {
  if (isAdmin(user)) return null;
  return { sql: `${alias}created_by_id = ?`, arg: user.id };
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}
const ok = (res, data = {}) => send(res, 200, { success: true, ...data });
const fail = (res, status, message) => send(res, status, { success: false, message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
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
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('文件过大，请拆分后重试'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
  });
  res.end(buffer);
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const cell = (v) => (v === null || v === undefined ? '' : v);

/** 把查询条件构建从分页列表里抽出来，供导出复用 */
function buildDataWhere(params, user) {
  const { clause, args } = buildFilters(params, DATA_FILTERS);
  const where = clause ? [clause.replace(/^ WHERE /, '')] : [];

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

/** 导出检测数据为 Excel（按当前筛选条件） */
function exportDataXlsx(res, params, user) {
  const { w, args } = buildDataWhere(params, user);
  const rows = db.prepare(`SELECT * FROM project_data${w} ORDER BY id DESC`).all(...args);
  const table = [FIELDS.map((f) => f.label), ...rows.map((r) => FIELDS.map((f) => cell(r[f.key])))];
  sendXlsx(res, xlsx.build(table, '项目数据'), `项目数据_${todayStr()}.xlsx`);
}

/** 导出项目档案为 Excel */
function exportProjectsXlsx(res, params) {
  const { clause, args } = buildFilters(params, ['project_no', 'product_code', 'project_type']);
  const parts = [clause ? clause.replace(/^ WHERE /, '') : ''];
  const allArgs = [...args];
  const q = params.get('q');
  if (q && q.trim()) {
    parts.push("(project_no LIKE ? OR product_code LIKE ? OR project_type LIKE ? OR IFNULL(description,'') LIKE ?)");
    const like = `%${q.trim()}%`;
    allArgs.push(like, like, like, like);
  }
  const where = parts.filter(Boolean).length ? ` WHERE ${parts.filter(Boolean).join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM project_data d WHERE d.project_no = p.project_no) AS data_count,
              (SELECT MAX(d.entry_date) FROM project_data d WHERE d.project_no = p.project_no) AS last_entry
       FROM projects p${where} ORDER BY p.id DESC`
    )
    .all(...allArgs);
  const header = ['项目编号', '产品代码', '项目类型', '项目简介', '数据量', '最新录入日期', '状态'];
  const table = [
    header,
    ...rows.map((r) => [
      cell(r.project_no), cell(r.product_code), cell(r.project_type), cell(r.description),
      Number(r.data_count || 0), cell(r.last_entry), r.status === 0 ? '停用' : '启用',
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
const importTokens = new Map(); // token -> { rows, user, at }
const IMPORT_TTL = 30 * 60 * 1000;

function newImportToken(rows, user) {
  // 清理过期批次
  const now = Date.now();
  for (const [k, v] of importTokens) if (now - v.at > IMPORT_TTL) importTokens.delete(k);
  // 上限保护：超过 100 个批次时淘汰最旧的
  if (importTokens.size >= 100) {
    const oldest = [...importTokens.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) importTokens.delete(oldest[0]);
  }
  const token = crypto.randomBytes(16).toString('hex');
  importTokens.set(token, { rows, user: user.username, at: now });
  return token;
}

/** 上传 Excel → 解析、识别表头、返回预览统计与批次 token */
async function previewImportFile(res, req, user) {
  const buf = await readRawBody(req);
  if (!buf.length) return fail(res, 400, '没有收到文件内容');

  let table;
  try {
    table = xlsx.parse(buf);
  } catch (e) {
    return fail(res, 400, e.message || '无法解析该 Excel 文件');
  }
  if (table.length < 2) return fail(res, 400, 'Excel 文件为空或只有表头，请检查内容');

  const headers = table[0];
  const headerMap = buildHeaderMap();
  const matched = [];
  const unknown = [];
  headers.forEach((h) => {
    if (!String(h).trim()) return;
    const key = headerMap.get(normHeader(h));
    if (key) matched.push({ col: String(h), key });
    else unknown.push(String(h));
  });

  const keyOf = (label) => (FIELDS.find((f) => f.label === label) || {}).key;
  const missingRequired = ['项目编号', '产品代码'].filter(
    (label) => !matched.some((m) => m.key === keyOf(label))
  );

  const dataRows = table.slice(1).filter((r) => r.some((c) => !isBlank(c)));
  const rows = dataRows
    .map((r) => {
      const raw = {};
      headers.forEach((h, i) => { raw[h] = r[i] === undefined ? '' : r[i]; });
      return raw;
    })
    .map((raw) => {
      const out = {};
      for (const [col, val] of Object.entries(raw)) {
        const key = headerMap.get(normHeader(col));
        if (!key || isBlank(val)) continue;
        out[key] = val;
      }
      return out;
    })
    .filter((o) => o.project_no || o.product_code);

  // 缺必填表头时仍返回预览（行数为 0），让界面明确提示缺少哪些列
  if (!rows.length && !missingRequired.length) return fail(res, 400, '没有可导入的有效数据行');

  const token = newImportToken(rows, user);
  ok(res, {
    token,
    rowCount: rows.length,
    dataRows: dataRows.length,
    matched,
    unknown,
    missingRequired,
    blankLabels: FIELDS.filter((f) => !matched.some((m) => m.key === f.key)).map((f) => f.label),
  });
}

/** 确认导入：按 token 取出已解析的批次写入数据库 */
function importByToken(res, body, user) {
  const token = String(body.token || '');
  const item = importTokens.get(token);
  if (!item) return fail(res, 400, '导入批次已过期，请重新选择 Excel 文件');
  if (item.user !== user.username) return fail(res, 403, '无权导入该批次数据');

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

function buildOrder(params, defaultOrder) {
  const sort = params.get('sort');
  const dirRaw = (params.get('dir') || 'asc').toLowerCase();
  const dir = dirRaw === 'desc' ? 'DESC' : 'ASC';
  const allowedSort = new Set([...FIELDS.map((f) => f.key), 'id', 'created_at', 'updated_at']);
  if (sort && allowedSort.has(sort)) return ` ORDER BY ${sort} IS NULL, ${sort} ${dir}`;
  return defaultOrder;
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
      row[key] = Number.isFinite(n) ? n : null;
    } else {
      row[key] = String(v).trim();
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

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { success: false, message: '禁止访问' });
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return send(res, 404, { success: false, message: '页面不存在' });
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ============================================================ 业务路由 */

const PROJECT_FILTERS = ['project_no', 'product_code', 'project_type', 'status', 'q'];
const DATA_FILTERS = ['project_no', 'product_code', 'base', 'process_code', 'work_order', 'coke_type'];

/* ---------- 元数据 ---------- */
function getMeta(res, user) {
  const types = db.prepare(`SELECT DISTINCT project_type AS v FROM projects WHERE project_type <> '' ORDER BY v`).all().map((r) => r.v);

  // 普通用户的筛选下拉只列自己数据中出现过的值，避免泄露他人数据
  const of = ownerFilter(user);
  const w = of ? ` WHERE ${of.sql}` : '';
  const args = of ? [of.arg] : [];
  const distinct = (col) =>
    db.prepare(`SELECT DISTINCT ${col} AS v FROM project_data${w}${of ? ' AND' : ' WHERE'} ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`)
      .all(...args).map((r) => r.v);

  const bases = distinct('base');
  const processes = distinct('process_code');
  const workOrders = distinct('work_order');
  const cokeTypes = distinct('coke_type');
  const productCodes = isAdmin(user)
    ? db.prepare(`SELECT DISTINCT product_code AS v FROM projects WHERE product_code <> '' ORDER BY v`).all().map((r) => r.v)
    : distinct('product_code');
  const projectNos = db.prepare(`SELECT DISTINCT project_no AS v FROM projects ORDER BY v`).all().map((r) => r.v);

  // 项目编号 → 产品代码，供录入时自动带出
  const projectMap = db.prepare('SELECT project_no, product_code FROM projects ORDER BY project_no').all();

  ok(res, {
    fields: FIELDS,
    options: { types, bases, processes, workOrders, cokeTypes, productCodes, projectNos },
    projectMap,
    roles: Object.entries(ROLES).map(([key, v]) => ({ key, label: v.label })),
    permissions: {
      canManageProjects: isAdmin(user),
      canDeleteData: isAdmin(user),
      canManageUsers: isAdmin(user),
      canManageAdmins: isSysAdmin(user),
      seeAllData: isAdmin(user),
    },
  });
}

/* ---------- 项目列表 ---------- */
function listProjects(res, params) {
  const { clause, args } = buildFilters(params, ['project_no', 'product_code', 'project_type']);
  const parts = [clause ? clause.replace(/^ WHERE /, '') : ''];
  const allArgs = [...args];

  const q = params.get('q');
  if (q && q.trim()) {
    parts.push('(project_no LIKE ? OR product_code LIKE ? OR project_type LIKE ? OR IFNULL(description,\'\') LIKE ?)');
    const like = `%${q.trim()}%`;
    allArgs.push(like, like, like, like);
  }
  const where = parts.filter(Boolean).length ? ` WHERE ${parts.filter(Boolean).join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM project_data d WHERE d.project_no = p.project_no) AS data_count,
              (SELECT MAX(d.entry_date) FROM project_data d WHERE d.project_no = p.project_no) AS last_entry
       FROM projects p${where}${buildOrder(params, ' ORDER BY p.id DESC')}`
    )
    .all(...allArgs);
  ok(res, { rows, total: rows.length });
}

function getProject(res, id) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '项目不存在');
  ok(res, { row });
}

function createProject(res, body) {
  const row = {
    project_no: (body.project_no || '').trim(),
    product_code: (body.product_code || '').trim(),
    project_type: (body.project_type || '').trim(),
    description: (body.description || '').trim() || null,
    status: body.status === 0 ? 0 : 1,
  };
  if (!row.project_no) return fail(res, 400, '项目编号不能为空');
  if (!row.product_code) return fail(res, 400, '产品代码不能为空');
  if (!row.project_type) return fail(res, 400, '项目类型不能为空');
  const existed = db.prepare('SELECT id FROM projects WHERE project_no = ?').get(row.project_no);
  if (existed) return fail(res, 409, `项目编号 ${row.project_no} 已存在`);
  const info = insert('projects', row);
  ok(res, { id: Number(info.lastInsertRowid) });
}

function updateProject(res, id, body) {
  const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!cur) return fail(res, 404, '项目不存在');
  const row = {};
  for (const k of ['project_no', 'product_code', 'project_type', 'description', 'status']) {
    if (k in body) row[k] = typeof body[k] === 'string' ? body[k].trim() || null : body[k];
  }
  if ('project_no' in row) {
    if (!row.project_no) return fail(res, 400, '项目编号不能为空');
    const dup = db.prepare('SELECT id FROM projects WHERE project_no = ? AND id <> ?').get(row.project_no, id);
    if (dup) return fail(res, 409, `项目编号 ${row.project_no} 已存在`);
    // 同步更新子表项目编号，保持关联
    if (row.project_no !== cur.project_no) {
      db.prepare('UPDATE project_data SET project_no = ?, updated_at = ? WHERE project_no = ?').run(
        row.project_no, nowStr(), cur.project_no
      );
    }
  }
  update('projects', id, row);
  ok(res);
}

function deleteProject(res, id) {
  const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!cur) return fail(res, 404, '项目不存在');
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM project_data WHERE project_no = ?').get(cur.project_no).c;
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  db.prepare('DELETE FROM project_data WHERE project_no = ?').run(cur.project_no);
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

function getData(res, id, user) {
  const row = db.prepare('SELECT * FROM project_data WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '数据记录不存在');
  if (!isAdmin(user) && row.created_by_id !== user.id) return fail(res, 403, '无权查看该数据记录');
  ok(res, { row });
}

/** 校验项目编号存在，并返回该项目以同步产品代码 */
function requireProject(projectNo) {
  const p = db.prepare('SELECT * FROM projects WHERE project_no = ?').get(projectNo);
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

/** 统计某五元组已存在的记录数 */
function countByKey(key) {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM project_data
       WHERE project_no = ? AND product_code = ? AND IFNULL(base,'') = ?
         AND IFNULL(process_code,'') = ? AND IFNULL(work_order,'') = ?`
    )
    .get(key.project_no, key.product_code, key.base || '', key.process_code || '', key.work_order || '').c;
}

/** 查找五元组已存在的记录 */
function findDuplicate(key) {
  return db
    .prepare(
      `SELECT * FROM project_data
       WHERE project_no = ? AND product_code = ? AND IFNULL(base,'') = ?
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
  if (hasFullKey(row)) {
    const dupCount = countByKey(row);
    if (dupCount > 0) {
      existing = findDuplicate(row);
      if (!action) {
        // 让前端确认：覆盖 or 追加
        return send(res, 409, {
          success: false,
          code: 'DUPLICATE_KEY',
          message: '系统已有相同数据',
          duplicate: {
            id: existing.id,
            count: dupCount,
            key: describeKey(row),
            created_by: existing.created_by,
            entry_date: existing.entry_date,
            updated_at: existing.updated_at,
            owner: existing.created_by_id === user.id,
          },
        });
      }
    }
  }

  if (existing && action === 'overwrite') {
    // 覆盖：仅更新本次提交的字段，保留 id 与录入人
    const patch = { ...row };
    delete patch.created_by;
    delete patch.created_by_id;
    patch.updated_by = user.username;
    update('project_data', existing.id, patch);
    return ok(res, { id: existing.id, mode: 'overwrite', previous: existing.id });
  }

  row.created_by = user.username;
  row.created_by_id = user.id;
  row.updated_by = user.username;
  const info = insert('project_data', row);
  ok(res, { id: Number(info.lastInsertRowid), mode: existing ? 'append' : 'create' });
}

function updateData(res, id, body, user) {
  const cur = db.prepare('SELECT * FROM project_data WHERE id = ?').get(id);
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
  ok(res);
}

function deleteData(res, id, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可删除数据记录');
  const info = db.prepare('DELETE FROM project_data WHERE id = ?').run(id);
  if (info.changes === 0) return fail(res, 404, '数据记录不存在');
  ok(res);
}

function bulkDeleteData(res, body, user) {
  if (!isAdmin(user)) return fail(res, 403, '仅管理员可删除数据记录');
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) return fail(res, 400, '请选择要删除的记录');
  const stmt = db.prepare('DELETE FROM project_data WHERE id = ?');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const id of ids) n += stmt.run(id).changes;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  ok(res, { deleted: n });
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

        // 五项齐全且已存在同键记录 → 视 duplicate_action 决定
        let existing = null;
        if (hasFullKey(row) && countByKey(row) > 0) existing = findDuplicate(row);

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
  const w = of ? ` WHERE ${of.sql}` : '';
  const args = of ? [of.arg] : [];

  const projectCount = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  const dataCount = db.prepare(`SELECT COUNT(*) AS c FROM project_data${w}`).get(...args).c;
  const typeCount = db.prepare(`SELECT COUNT(DISTINCT project_type) AS c FROM projects`).get().c;
  const baseCount = db
    .prepare(`SELECT COUNT(DISTINCT base) AS c FROM project_data${w}${of ? ' AND' : ' WHERE'} base IS NOT NULL AND base <> ''`)
    .get(...args).c;
  const qtySum = db.prepare(`SELECT IFNULL(SUM(quantity),0) AS s FROM project_data${w}`).get(...args).s;
  const byType = db.prepare(`SELECT project_type AS name, COUNT(*) AS value FROM projects GROUP BY project_type ORDER BY value DESC`).all();
  const byBase = db
    .prepare(`SELECT IFNULL(base,'未填') AS name, COUNT(*) AS value FROM project_data${w} GROUP BY base ORDER BY value DESC`)
    .all(...args);
  const recent = db
    .prepare(`SELECT id, project_no, product_code, work_order, entry_date, quantity FROM project_data${w} ORDER BY id DESC LIMIT 8`)
    .all(...args);
  ok(res, { stats: { projectCount, dataCount, typeCount, baseCount, qtySum, byType, byBase, recent } });
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
  update('users', id, row, { touch: false });
  // 停用或改密后，强制该用户重新登录
  for (const [token, s] of sessions) if (s.userId === id) sessions.delete(token);
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
  for (const [token, s] of sessions) if (s.userId === id) sessions.delete(token);
  ok(res, { removedUser: true, dataCount });
}

/* ============================================================ 路由分发 */

/* ---------- 登录相关（无需鉴权） ---------- */
/** 登录失败计数，防止暴力猜解：同一账号连续失败 5 次锁定 5 分钟 */
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const loginFails = new Map(); // username -> { count, firstAt, lockedUntil }

function login(res, body) {
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
    const left = MAX_FAILS - next.count;
    return fail(res, 401, left > 0 ? `账号或密码错误，还可尝试 ${left} 次` : '密码错误次数过多，请 5 分钟后再试');
  }
  loginFails.delete(username);
  if (u.status !== 1) return fail(res, 403, '该账号已停用，请联系管理员');

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowStr(), u.id);
  const token = createSession(u.id);
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
function changePassword(res, body, user) {
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
  ok(res);
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const q = url.searchParams;
  const seg = p.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  /* ---- 免登录接口 ---- */
  if (p === '/api/auth/login' && m === 'POST') return login(res, await readBody(req));
  if (p === '/api/auth/logout' && m === 'POST') return logout(req, res);

  /* ---- 以下接口均需登录 ---- */
  const user = currentUser(req);
  if (!user) return fail(res, 401, '未登录或登录已失效，请重新登录');

  if (p === '/api/auth/me' && m === 'GET') return me(res, user);
  if (p === '/api/auth/password' && m === 'POST') return changePassword(res, await readBody(req), user);

  if (m === 'GET' && p === '/api/meta') return getMeta(res, user);
  if (m === 'GET' && p === '/api/stats') return getStats(res, user);

  // projects：全员可查看；增删改仅管理员
  if (p === '/api/projects') {
    if (m === 'GET') return listProjects(res, q);
    if (m === 'POST') {
      if (!isAdmin(user)) return fail(res, 403, '仅管理员可新增项目');
      return createProject(res, await readBody(req));
    }
  }
  if (p === '/api/projects/export' && m === 'GET') return exportProjectsXlsx(res, q);
  if (seg[0] === 'projects' && seg[1]) {
    const id = Number(seg[1]);
    if (m === 'GET') return getProject(res, id);
    if (m === 'PUT' || m === 'PATCH') {
      if (!isAdmin(user)) return fail(res, 403, '仅管理员可修改项目');
      return updateProject(res, id, await readBody(req));
    }
    if (m === 'DELETE') {
      if (!isAdmin(user)) return fail(res, 403, '仅管理员可删除项目');
      return deleteProject(res, id);
    }
  }

  // project data：查看受归属限制；新增/修改需登录；删除仅管理员
  if (p === '/api/data') {
    if (m === 'GET') return listData(res, q, user);
    if (m === 'POST') return createData(res, await readBody(req), user);
  }
  // Excel 导出 / 上传解析（需登录，导出受归属过滤限制）
  if (p === '/api/data/export' && m === 'GET') return exportDataXlsx(res, q, user);
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
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error('[ERROR]', req.method, url.pathname, e);
    if (!res.headersSent) fail(res, 500, e.message || '服务器内部错误');
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
