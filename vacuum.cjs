'use strict';
/**
 * 在独立进程中执行 SQLite 的一致性快照（VACUUM INTO）。
 * 用法：node vacuum.cjs <源数据库> <目标文件>
 * 大库备份 / 导出不再阻塞主服务的请求处理。
 */
const { DatabaseSync } = require('node:sqlite');

const [, , src, dest] = process.argv;
if (!src || !dest) {
  console.error('用法：node vacuum.cjs <源数据库> <目标文件>');
  process.exit(2);
}

const db = new DatabaseSync(src);
try {
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`);
} finally {
  try { db.close(); } catch { /* ignore */ }
}
