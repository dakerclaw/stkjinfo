#!/usr/bin/env node
/**
 * 数据库在线备份：用 SQLite 的 VACUUM INTO 生成一致性副本，不中断服务。
 *
 *   node backup.cjs                  # 备份到 <DATA_DIR 同级>/backups/
 *   node backup.cjs --keep 30        # 保留最近 30 份（默认 14）
 *
 * 输出文件名：app-YYYYMMDD-HHMMSS.db
 * 建议配合 systemd user timer 每天凌晨执行（见 deploy/stkj-backup.timer）。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(HOME, 'apps', 'stkj', 'data', 'app.db');
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(HOME, 'apps', 'stkj', 'backups');

const keepArg = process.argv.indexOf('--keep');
const KEEP = Math.max(1, Number((keepArg >= 0 && process.argv[keepArg + 1]) || 14));

if (!fs.existsSync(DB_FILE)) {
  console.error('[backup] 找不到数据库：' + DB_FILE);
  process.exit(1);
}
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
const target = path.join(BACKUP_DIR, `app-${stamp}.db`);

const t0 = Date.now();
const src = new DatabaseSync(DB_FILE, { readOnly: true });
src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
src.close();

const size = fs.statSync(target).size;
if (size < 4096) {
  console.error(`[backup] 备份文件异常偏小（${size} 字节），请检查：${target}`);
  process.exit(3);
}

/* 只保留最近 KEEP 份 */
const files = fs
  .readdirSync(BACKUP_DIR)
  .filter((f) => /^app-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/.test(f))
  .sort()
  .reverse();
const removed = [];
for (const f of files.slice(KEEP)) {
  fs.unlinkSync(path.join(BACKUP_DIR, f));
  removed.push(f);
}

console.log(
  `[backup] 完成：${target}（${(size / 1024).toFixed(1)} KB，耗时 ${Date.now() - t0} ms）` +
    (removed.length ? `，清理旧备份 ${removed.length} 份` : '') +
    `，当前保留 ${Math.min(files.length, KEEP)} 份`
);
