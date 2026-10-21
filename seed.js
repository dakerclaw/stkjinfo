'use strict';
/**
 * 初始化脚本：创建默认管理员账号 + 可选示例数据
 * 用法：
 *   node seed.js          首次初始化（已有数据则跳过示例数据）
 *   node seed.js --reset  清空项目/数据后重新灌入示例数据（保留用户）
 */
const crypto = require('node:crypto');
const { db, FIELDS } = require('./db');

/* scrypt 散列（与 server.js 保持一致） */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

const RESET = process.argv.includes('--reset');

/* ---------- 默认账号 ---------- */
function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) {
    // 已有账号：仅确保 admin 是系统管理员
    db.exec(`UPDATE users SET role = 'sys_admin' WHERE username = 'admin'`);
    console.log(`  用户表已有 ${count} 个账号，跳过创建（已确保 admin 为系统管理员）`);
    return;
  }
  const stmt = db.prepare(
    'INSERT INTO users (username, password_hash, salt, real_name, role, status, remark, pwd_changed) VALUES (?,?,?,?,?,?,?,?)'
  );
  const add = (username, password, realName, role, status, remark, pwdChanged = 1) => {
    const salt = makeSalt();
    stmt.run(username, hashPassword(password, salt), salt, realName, role, status, remark, pwdChanged);
  };
  // 系统管理员（固定账号名 admin）
  add('admin', 'admin123', '系统管理员', 'sys_admin', 1, '默认系统管理员账号');
  // 管理员：默认密码 = 账号
  add('manager', 'manager', '王经理', 'admin', 1, '管理员，默认密码为账号', 0);
  // 普通用户：默认密码 = 账号
  add('zhangsan', 'zhangsan', '张三', 'user', 1, '普通用户，默认密码为账号', 0);
  add('lisi', 'lisi', '李四', 'user', 0, '普通用户，已停用', 0);
  console.log('  已创建账号：admin/admin123（系统管理员）、manager（管理员）、zhangsan、lisi（普通用户，密码=账号）');
}

/* ---------- 示例项目 ---------- */
const PROJECTS = [
  ['PJ-2026-001', 'GC-A1', '研发', '高容量石墨负极材料开发，目标容量 360mAh/g 以上，重点优化粒度分布与首次效率。', 1],
  ['PJ-2026-002', 'GC-B2', '中试', '快充型负极材料中试放大，验证 5C 倍率下的粉压与循环性能。', 1],
  ['PJ-2026-003', 'SC-C1', '量产', '储能用人造石墨量产项目，稳定收率与灰分控制。', 1],
  ['PJ-2026-004', 'GC-A3', '研发', '低比表面积高首次效率配方研究，降低磁性物质含量。', 1],
  ['PJ-2026-005', 'SC-D5', '量产', '动力电池负极二期产线认证，覆盖两个生产基地数据比对。', 1],
  ['PJ-2025-018', 'GC-Z9', '研发', '上一代高功率石墨项目，已完成结题归档。', 0],
  ['PJ-2026-006', 'AC-E1', '中试', '硬碳负极材料预研，关注吸油值与振实密度。', 1],
  ['PJ-2026-007', 'GC-B7', '量产', '海外客户定制规格量产项目，按工单全程追溯。', 1],
];

/* ---------- 示例数据 ---------- */
const BASES = ['江西基地', '广东基地', '四川基地'];
const PROCS = ['PR-10', 'PR-20', 'PR-30', 'PR-40'];
const rnd = (min, max, d = 2) => Number((min + Math.random() * (max - min)).toFixed(d));
let woSeq = 1;

function makeRow(pno, pcode, i) {
  const base = BASES[i % BASES.length];
  const proc = PROCS[i % PROCS.length];
  const wo = `WO-2026${String(100 + woSeq++).padStart(4, '0')}`;
  const dx10 = rnd(4, 9);
  const dx50 = rnd(12, 20);
  const dx90 = rnd(28, 42);
  const date = new Date(Date.now() - Math.floor(Math.random() * 120) * 86400000).toISOString().slice(0, 10);
  return {
    project_no: pno, product_code: pcode, base, process_code: proc, work_order: wo,
    dx0: rnd(1.2, 2.5), dx1: rnd(2.2, 3.6), dx10, dx50, dx90,
    dx99: rnd(55, 75), dx100: rnd(90, 120),
    k_value: rnd(0.8, 2.4),
    tap_density: rnd(0.85, 1.15, 3),
    ssa_domestic: rnd(0.8, 2.6, 3),
    ssa_mic: rnd(0.9, 2.8, 3),
    graphitization: rnd(88, 96),
    capacity: rnd(330, 365),
    lithium_inter: rnd(355, 385),
    lithium_deint: rnd(330, 362),
    first_eff: rnd(89, 94),
    magnetic: rnd(0.02, 0.15, 3),
    ph_value: rnd(6.5, 8.5),
    press_0_5t: rnd(1.55, 1.75, 3), press_1t: rnd(1.6, 1.8, 3),
    press_1_5t: rnd(1.62, 1.84, 3), press_2t: rnd(1.65, 1.88, 3),
    press_5t: rnd(1.70, 1.95, 3),
    true_density: rnd(2.18, 2.28, 3),
    oversize: rnd(0.01, 0.08, 3),
    moisture_fp: rnd(0.01, 0.06, 3),
    ash: rnd(0.01, 0.05, 3),
    volatile: rnd(0.3, 1.2, 3),
    moisture: rnd(0.05, 0.25, 3),
    sulfur: rnd(0.005, 0.03, 4),
    caking_index: rnd(60, 85, 1),
    oil_absorption: rnd(45, 75, 1),
    coking_value: rnd(6, 12),
    hgi: rnd(55, 80),
    efficiency: rnd(92, 98.5),
    yield_rate: rnd(86, 96),
    quantity: rnd(12, 180, 1),
    entry_date: date,
    remark: i % 5 === 0 ? '抽检复测，数据正常' : null,
  };
}

function seedData() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  if (existing > 0 && !RESET) {
    console.log(`  项目表已有 ${existing} 条记录，跳过示例数据（如需重灌请加 --reset）`);
    return;
  }
  if (RESET) {
    db.exec('DELETE FROM project_data; DELETE FROM projects;');
    console.log('  已清空项目与项目数据');
  }
  const insP = db.prepare(
    'INSERT INTO projects (project_no, product_code, project_type, description, status) VALUES (?,?,?,?,?)'
  );
  for (const p of PROJECTS) insP.run(...p);

  const keys = FIELDS.map((f) => f.key).concat(['created_by', 'created_by_id', 'updated_by']);
  const insD = db.prepare(
    `INSERT INTO project_data (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  );
  // 示例数据归属到 admin 账号，便于管理员直接查看
  const owner = db.prepare(`SELECT id, username FROM users WHERE username = 'admin'`).get() || { id: null, username: 'admin' };
  let n = 0;
  for (const [pno, pcode] of PROJECTS) {
    const cnt = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < cnt; i++) {
      const row = makeRow(pno, pcode, i);
      row.created_by = owner.username;
      row.created_by_id = owner.id;
      row.updated_by = owner.username;
      insD.run(...keys.map((k) => (row[k] === undefined ? null : row[k])));
      n++;
    }
  }
  console.log(`  已写入 ${PROJECTS.length} 个项目、${n} 条项目数据（归属 ${owner.username}）`);
}

seedUsers();
seedData();

// 关键：显式 checkpoint 并关闭数据库，把 WAL 中的数据合并进主库文件
// 否则直接 process.exit 会丢失尚未落盘的数据
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
} catch (e) {
  console.warn('  警告：关闭数据库时出错 -', e.message);
}

console.log('\n  初始化完成。启动服务：npm start  然后访问 http://127.0.0.1:5173\n');
