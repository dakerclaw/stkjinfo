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

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,                       -- 随机会话令牌（Cookie sid 的值）
  user_id     INTEGER NOT NULL,                       -- 关联 users.id
  created_at  INTEGER NOT NULL,                       -- 创建时间（毫秒时间戳）
  last_seen   INTEGER NOT NULL,                       -- 最后活跃时间（毫秒时间戳），用于闲置超时
  user_agent  TEXT,                                   -- 登录时的浏览器标识（便于排查）
  ip          TEXT                                    -- 登录时的来源地址
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,                                -- 操作人 id（系统操作时为空）
  username   TEXT,                                   -- 操作人账号（冗余存储，防用户被删后无法追溯）
  action     TEXT    NOT NULL,                       -- create / update / soft_delete / restore / purge / import / status
  entity     TEXT    NOT NULL,                       -- project / data / user
  entity_id  INTEGER,                                -- 目标行 id（批量操作为空）
  summary    TEXT    NOT NULL,                       -- 人类可读的操作摘要
  changes    TEXT,                                   -- JSON：{字段: {from, to}}，仅编辑类操作记录
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);

CREATE TABLE IF NOT EXISTS project_data (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,  -- 权威关联（项目档案 id）
  project_no   TEXT NOT NULL,                         -- 项目编号（由 project_id 自动同步的展示快照）
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
  energy        REAL,                                 -- 能耗
  quantity      REAL,                                 -- 生产数量
  remark        TEXT,                                 -- 备注
  entry_date    TEXT,                                 -- 录入日期
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
ensureColumn('project_data', 'energy', 'REAL'); // 能耗：加在收率与生产数量之间（显示顺序由 FIELDS 决定）
// 软删除：删除仅打标记，30 天内可在回收站恢复，超期由服务端定时物理清理
ensureColumn('projects', 'deleted_at', 'TEXT');
ensureColumn('project_data', 'deleted_at', 'TEXT');
// 删除批次：删除项目时给随项目一起删除的数据打同一批次，恢复时只恢复本批次，
// 不会把「更早单独删除」的数据一并复活。
ensureColumn('projects', 'deleted_batch', 'TEXT');
ensureColumn('project_data', 'deleted_batch', 'TEXT');
// 权威关联：project_data.project_id → projects.id（ON DELETE RESTRICT 防止误删仍带数据的项目）。
// project_no / product_code 保留为「展示快照」，由下方触发器随项目档案自动同步，杜绝手工维护导致的不一致。
ensureColumn('project_data', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_data_project_id ON project_data(project_id)');
// 只覆盖「尚未回填」的少量行，让启动兜底回填与完整性检查都走极小的部分索引
db.exec('CREATE INDEX IF NOT EXISTS idx_data_pid_null ON project_data(project_no) WHERE project_id IS NULL');
// 项目档案的编号 / 产品代码变更后，自动同步其全部数据的展示快照（含回收站里的数据）。
// 只在这两列出现在 UPDATE 的 SET 中时触发，状态变更 / 软删除不会误触发。
db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_project_sync
AFTER UPDATE OF project_no, product_code ON projects
BEGIN
  UPDATE project_data
     SET project_id = NEW.id,
         project_no = NEW.project_no,
         product_code = NEW.product_code
   WHERE project_id = NEW.id
      OR (project_id IS NULL AND project_no = OLD.project_no);
END;
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_data_owner ON project_data(created_by_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_data_coke ON project_data(coke_type)');
// 会话按用户检索（踢下线、清理过期）与按最后活跃时间清理
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions(last_seen)');
// 回收站清理按删除时间检索
db.exec('CREATE INDEX IF NOT EXISTS idx_projects_deleted ON projects(deleted_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_data_deleted ON project_data(deleted_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_data_delete_batch ON project_data(deleted_batch)');
// 日期筛选 / 归属 + 日期组合（去掉 IFNULL 包裹后可以真正命中索引）
db.exec('CREATE INDEX IF NOT EXISTS idx_data_entry_date ON project_data(entry_date) WHERE deleted_at IS NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_data_owner_date ON project_data(created_by_id, entry_date) WHERE deleted_at IS NULL');
// 导入查重五元组：普通复合索引会被 IFNULL(base,'') 阻断，必须用同样的表达式建索引
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_data_key5
   ON project_data(project_no, product_code, IFNULL(base,''), IFNULL(process_code,''), IFNULL(work_order,''))
   WHERE deleted_at IS NULL`
);

// 角色规范化：用户名 admin 固定为系统管理员（用户名统一不区分大小写）
db.exec(`UPDATE users SET role = 'sys_admin' WHERE username = 'admin' COLLATE NOCASE AND role = 'admin'`);
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
  { key: 'energy',         label: '能耗',       type: 'number' },
  { key: 'quantity',       label: '生产数量',   type: 'number' },
  { key: 'remark',         label: '备注',       type: 'text' },
  { key: 'entry_date',     label: '录入日期',   type: 'date' },
];

// 指标字段统一保留 2 位小数（写入/导入时四舍五入）；生产数量同样保留 2 位
const ROUND2_KEYS = new Set(FIELDS.filter((f) => f.type === 'number').map((f) => f.key));
for (const f of FIELDS) if (ROUND2_KEYS.has(f.key)) f.round2 = true;

/* --------------------------------------------------------------- 迁移 */
/**
 * 版本号只用于「结构性 / 历史数据一次性整理」，不参与每次启动。
 *   1：所有数值字段归一到 2 位小数；回收站补删除批次；用户名大小写唯一。
 *   2：project_data 增加 project_id + 外键 + 同步触发器，按项目编号回填。
 * 之后新增/导入时的精度处理在 server.js 的写入路径完成，不再全表改写。
 */
const SCHEMA_VERSION = 2;

/** 把指定数值列一次性四舍五入到 2 位；Where 排除已合规行，避免无意义写入撑大 WAL */
function normalizeNumbers(handle = db) {
  const keys = [...ROUND2_KEYS];
  if (keys.length === 0) return 0;
  const setSql = keys.map((k) => `${k} = round(${k}, 2)`).join(', ');
  const whereSql = keys.map((k) => `(${k} IS NOT NULL AND ${k} != round(${k}, 2))`).join(' OR ');
  return handle.prepare(`UPDATE project_data SET ${setSql} WHERE ${whereSql}`).run().changes;
}

/** 给旧版本已软删除的项目 / 数据补删除批次，使恢复逻辑与新数据一致 */
function backfillDeleteBatches(handle = db) {
  const pros = handle
    .prepare(`SELECT id, project_no FROM projects WHERE deleted_at IS NOT NULL AND (deleted_batch IS NULL OR deleted_batch = '')`)
    .all();
  for (const p of pros) {
    const batch = `legacy-${p.id}`;
    handle.prepare('UPDATE projects SET deleted_batch = ? WHERE id = ?').run(batch, p.id);
    handle
      .prepare(
        `UPDATE project_data SET deleted_batch = ?
         WHERE project_no = ? AND deleted_at IS NOT NULL AND (deleted_batch IS NULL OR deleted_batch = '')`
      )
      .run(batch, p.project_no);
  }
  // 单独删除的数据：每行一个批次，避免恢复时互相牵连
  handle
    .prepare(
      `UPDATE project_data SET deleted_batch = 'legacy-data-' || id
       WHERE deleted_at IS NOT NULL AND (deleted_batch IS NULL OR deleted_batch = '')`
    )
    .run();
}

/**
 * 用户名统一不区分大小写：
 *   1. 历史库中仅大小写不同的重复账号，保留权限最高 / id 最小者，其余重命名并同步归属字段；
 *   2. 建立 NOCASE 唯一索引，之后应用层与数据库双重保证不会出现 Admin / admin 并存。
 */
function migrateUsernames(handle = db) {
  const groups = handle
    .prepare('SELECT username AS name FROM users GROUP BY username COLLATE NOCASE HAVING COUNT(*) > 1')
    .all();
  for (const g of groups) {
    const list = handle
      .prepare(
        `SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE
         ORDER BY CASE WHEN username = 'admin' THEN 0 ELSE 1 END,
                  CASE role WHEN 'sys_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id`
      )
      .all(g.name);
    const keep = list[0];
    for (const u of list.slice(1)) {
      const base = String(u.username).slice(0, 26);
      let candidate = `${base}_${u.id}`;
      let n = 1;
      while (handle.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(candidate)) {
        candidate = `${base}_${u.id}_${n++}`;
      }
      handle.prepare('UPDATE users SET username = ? WHERE id = ?').run(candidate, u.id);
      // 归属字段是冗余账号名，重命名后同步，避免界面显示已不存在的账号
      handle.prepare('UPDATE project_data SET created_by = ? WHERE created_by = ?').run(candidate, u.username);
      handle.prepare('UPDATE project_data SET updated_by = ? WHERE updated_by = ?').run(candidate, u.username);
      handle.prepare('UPDATE audit_logs SET username = ? WHERE username = ?').run(candidate, u.username);
      console.warn(`[migrate] 账号「${u.username}」与「${keep.username}」仅大小写不同，已重命名为「${candidate}」`);
    }
  }
  handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');
}

/**
 * 回填 project_data.project_id（版本 2 迁移 / 数据库导入后都要跑）：
 *   - 按 project_no 关联到 projects.id（含软删除在回收站里的项目）；
 *   - 只处理 project_id IS NULL 的行，幂等、可重复执行；
 *   - 找不到对应项目的孤儿行保持 NULL（SQLite 外键不约束 NULL，不会破坏旧数据）。
 */
function backfillProjectIds(handle = db) {
  // 快速短路：用部分索引 idx_data_pid_null 判断有没有孤儿行。
  // 正常启动（所有行都已回填）这一步只走索引取 1 行，几乎零成本，
  // 不会像全表 UPDATE 那样扫描 5 万行、撑大 WAL。
  const hasOrphan = handle
    .prepare('SELECT 1 FROM project_data WHERE project_id IS NULL LIMIT 1')
    .get();
  if (!hasOrphan) return 0;
  return handle
    .prepare(
      `UPDATE project_data
          SET project_id = (SELECT p.id FROM projects p WHERE p.project_no = project_data.project_no LIMIT 1)
        WHERE project_id IS NULL
          AND EXISTS (SELECT 1 FROM projects p WHERE p.project_no = project_data.project_no)`
    )
    .run().changes;
}

const currentVersion = Number((db.prepare('PRAGMA user_version').get() || {}).user_version || 0);
if (currentVersion < SCHEMA_VERSION) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 这些步骤都幂等，从 0 / 1 升到 2 都安全；版本 1 已有结构不会被重复改动
    normalizeNumbers(db);
    backfillDeleteBatches(db);
    migrateUsernames(db);
    backfillProjectIds(db); // 版本 2：按项目编号回填权威外键
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
    console.log(`[db] 已完成数据结构升级（user_version ${currentVersion} → ${SCHEMA_VERSION}）`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// 每次启动都兜底回填 project_id：兼容「外部写入 / 数据库导入 / 老版本残留」的孤儿行。
// 该 UPDATE 只命中 project_id IS NULL 且能匹配到项目的行，靠 idx_data_pno 走索引，成本极低；
// 已回填的行不会被改写，不会撑大 WAL。
try { backfillProjectIds(db); } catch (e) {
  console.warn('[db] project_id 回填跳过（不影响启动）：', e.message);
}

// 让查询计划拿到统计信息；PRAGMA optimize 本身很轻，不做全库 ANALYZE
try { db.exec('PRAGMA optimize'); } catch { /* 不影响启动 */ }

module.exports = {
  db, DB_FILE, DATA_DIR, FIELDS,
  SCHEMA_VERSION,
  ROUND2_KEYS,
  normalizeNumbers,
  backfillDeleteBatches,
  migrateUsernames,
  backfillProjectIds,
};
