'use strict';
/**
 * 数据库层：使用 Node.js 内置 node:sqlite（无需第三方依赖）
 * 三张表：
 *   users        用户账号密码等信息表
 *   projects     项目列表信息表
 *   project_data 项目数据信息表
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// 数据目录：可用 DATA_DIR 覆盖（部署到只读目录或独立数据盘时使用）
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
// FULL：每次事务提交都 fsync，宕机/断电不丢已提交数据（NORMAL 在 WAL 下可能丢最后一笔）
db.exec('PRAGMA synchronous = FULL;');
// 每积累 100 页自动 checkpoint，避免 WAL 无限增长、降低异常退出时的数据回退风险
db.exec('PRAGMA wal_autocheckpoint = 100;');
// 不允许 WAL 文件超过 64MB，超出立即 checkpoint
db.exec('PRAGMA journal_size_limit = 67108864;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

/* ---------------------------------------------------------------- 建表 */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,              -- 登录账号
  password_hash TEXT    NOT NULL,                     -- 密码散列（scrypt）
  salt          TEXT    NOT NULL,                     -- 盐
  real_name     TEXT,                                 -- 姓名
  role          TEXT    NOT NULL DEFAULT 'user',      -- 角色 sys_admin / admin / user
  status        INTEGER NOT NULL DEFAULT 1,           -- 1启用 0停用
  remark        TEXT,                                 -- 备注
  pwd_changed   INTEGER NOT NULL DEFAULT 1,           -- 0=仍为初始密码（=账号）
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_no  TEXT NOT NULL UNIQUE,                   -- 项目编号
  product_code TEXT NOT NULL,                         -- 产品代码
  project_type TEXT NOT NULL,                         -- 项目类型
  description TEXT,                                   -- 项目简介
  status      INTEGER NOT NULL DEFAULT 1,             -- 1进行中 0已归档
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_projects_code ON projects(product_code);
CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(project_type);

CREATE TABLE IF NOT EXISTS project_data (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_no   TEXT NOT NULL,                         -- 项目编号
  product_code TEXT NOT NULL,                         -- 产品代码
  base         TEXT,                                  -- 所属公司
  process_code TEXT,                                  -- 工序
  work_order   TEXT,                                  -- 工单号
  coke_type    TEXT,                                  -- 焦种
  -- 粒度分布
  dx0   REAL, dx1   REAL, dx10  REAL, dx50  REAL,
  dx90  REAL, dx99  REAL, dx100 REAL,
  k_value       REAL,                                 -- k值
  tap_density   REAL,                                 -- 振实密度
  ssa_domestic  REAL,                                 -- 比表-国产
  ssa_mic       REAL,                                 -- 比表-麦克
  graphitization REAL,                                -- 石墨化度
  capacity      REAL,                                 -- 容量
  lithium_inter REAL,                                 -- 嵌锂容量
  lithium_deint REAL,                                 -- 脱锂容量
  first_eff     REAL,                                 -- 首次效率
  magnetic      REAL,                                 -- 磁性物质
  ph_value      REAL,                                 -- PH值
  -- 粉压 5 点法
  press_0_5t REAL, press_1t REAL, press_1_5t REAL, press_2t REAL, press_5t REAL,
  true_density  REAL,                                 -- 真密度
  oversize      REAL,                                 -- 筛上物
  moisture_fp   REAL,                                 -- 成品水分
  ash           REAL,                                 -- 灰分
  volatile      REAL,                                 -- 挥发分
  moisture      REAL,                                 -- 水分
  sulfur        REAL,                                 -- 硫分
  caking_index  REAL,                                 -- 黏结指数
  oil_absorption REAL,                                -- 吸油值
  coking_value  REAL,                                 -- 结焦值
  hgi           REAL,                                 -- 哈氏可磨指数
  efficiency    REAL,                                 -- 效率
  yield_rate    REAL,                                 -- 收率
  quantity      REAL,                                 -- 生产数量
  entry_date    TEXT,                                 -- 录入日期
  remark        TEXT,
  created_by    TEXT,                                 -- 录入人账号（数据归属）
  created_by_id INTEGER,                              -- 录入人用户 id
  updated_by    TEXT,                                 -- 最后修改人账号
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_data_pno  ON project_data(project_no);
CREATE INDEX IF NOT EXISTS idx_data_pc   ON project_data(product_code);
CREATE INDEX IF NOT EXISTS idx_data_base ON project_data(base);
CREATE INDEX IF NOT EXISTS idx_data_proc ON project_data(process_code);
CREATE INDEX IF NOT EXISTS idx_data_wo   ON project_data(work_order);
`);

/* ------------------------------------------------------ 旧库平滑升级 */
/** 若表已存在但缺少新列，则 ALTER TABLE 补齐（SQLite ADD COLUMN 为轻量操作） */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

ensureColumn('users', 'pwd_changed', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('project_data', 'created_by', 'TEXT');
ensureColumn('project_data', 'created_by_id', 'INTEGER');
ensureColumn('project_data', 'updated_by', 'TEXT');
ensureColumn('project_data', 'coke_type', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_data_owner ON project_data(created_by_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_data_coke ON project_data(coke_type)');

// 角色规范化：用户名 admin 固定为系统管理员
db.exec(`UPDATE users SET role = 'sys_admin' WHERE username = 'admin' AND role = 'admin'`);
db.exec(`UPDATE users SET role = 'user' WHERE role NOT IN ('sys_admin','admin','user')`);

// 存量数据无归属人时，统一挂到最早的管理员账号下，避免普通用户看不到历史数据
const orphanCount = db.prepare('SELECT COUNT(*) AS c FROM project_data WHERE created_by_id IS NULL').get().c;
if (orphanCount > 0) {
  const owner = db
    .prepare(`SELECT id, username FROM users WHERE role IN ('sys_admin','admin') ORDER BY id LIMIT 1`)
    .get();
  if (owner) {
    db.prepare(
      'UPDATE project_data SET created_by_id = ?, created_by = ? WHERE created_by_id IS NULL'
    ).run(owner.id, owner.username);
  }
}

/* ------------------------------------------------- 字段定义（前端复用） */

const FIELDS = [
  { key: 'project_no',   label: '项目编号',   type: 'text' },
  { key: 'product_code', label: '产品代码',   type: 'text' },
  { key: 'base',         label: '所属公司',   type: 'text' },
  { key: 'process_code', label: '工序',       type: 'text' },
  { key: 'work_order',   label: '工单号',     type: 'text' },
  { key: 'coke_type',    label: '焦种',       type: 'text' },
  { key: 'dx0',   label: 'Dx(0)',   type: 'number' },
  { key: 'dx1',   label: 'Dx(1)',   type: 'number' },
  { key: 'dx10',  label: 'Dx(10)',  type: 'number' },
  { key: 'dx50',  label: 'Dx(50)',  type: 'number' },
  { key: 'dx90',  label: 'Dx(90)',  type: 'number' },
  { key: 'dx99',  label: 'Dx(99)',  type: 'number' },
  { key: 'dx100', label: 'Dx(100)', type: 'number' },
  { key: 'k_value',       label: 'k值',        type: 'number' },
  { key: 'tap_density',   label: '振实密度',   type: 'number' },
  { key: 'ssa_domestic',  label: '比表-国产',  type: 'number' },
  { key: 'ssa_mic',       label: '比表-麦克',  type: 'number' },
  { key: 'graphitization',label: '石墨化度',   type: 'number' },
  { key: 'capacity',      label: '容量',       type: 'number' },
  { key: 'lithium_inter', label: '嵌锂容量',   type: 'number' },
  { key: 'lithium_deint', label: '脱锂容量',   type: 'number' },
  { key: 'first_eff',     label: '首次效率',   type: 'number' },
  { key: 'magnetic',      label: '磁性物质',   type: 'number' },
  { key: 'ph_value',      label: 'PH值',       type: 'number' },
  { key: 'press_0_5t', label: '0.5T粉压-5点法', type: 'number' },
  { key: 'press_1t',   label: '1T粉压-5点法',   type: 'number' },
  { key: 'press_1_5t', label: '1.5T粉压-5点法', type: 'number' },
  { key: 'press_2t',   label: '2T粉压-5点法',   type: 'number' },
  { key: 'press_5t',   label: '5T粉压-5点法',   type: 'number' },
  { key: 'true_density',   label: '真密度',     type: 'number' },
  { key: 'oversize',       label: '筛上物',     type: 'number' },
  { key: 'moisture_fp',    label: '成品水分',   type: 'number' },
  { key: 'ash',            label: '灰分',       type: 'number' },
  { key: 'volatile',       label: '挥发分',     type: 'number' },
  { key: 'moisture',       label: '水分',       type: 'number' },
  { key: 'sulfur',         label: '硫分',       type: 'number' },
  { key: 'caking_index',   label: '黏结指数',   type: 'number' },
  { key: 'oil_absorption', label: '吸油值',     type: 'number' },
  { key: 'coking_value',   label: '结焦值',     type: 'number' },
  { key: 'hgi',            label: '哈氏可磨指数', type: 'number' },
  { key: 'efficiency',     label: '效率',       type: 'number' },
  { key: 'yield_rate',     label: '收率',       type: 'number' },
  { key: 'quantity',       label: '生产数量',   type: 'number' },
  { key: 'entry_date',     label: '录入日期',   type: 'date' },
  { key: 'remark',         label: '备注',       type: 'text' },
];

module.exports = { db, DB_FILE, DATA_DIR, FIELDS };
