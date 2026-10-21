#!/usr/bin/env node
/**
 * 清空业务数据（项目档案 + 检测数据），保留账号与权限体系。
 * 用法：
 *   DB_FILE=/path/to/app.db node clear-data.cjs          # 直接执行
 *   DB_FILE=/path/to/app.db node clear-data.cjs --yes    # 跳过二次确认
 *
 * 注意：脚本只做 DELETE，不删表；执行前请自行备份数据库文件。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, '..', 'data', 'app.db');

const skipConfirm = process.argv.includes('--yes');

if (!fs.existsSync(DB_FILE)) {
  console.error('[错误] 找不到数据库文件：' + DB_FILE);
  process.exit(1);
}

function counts(d) {
  const q = (t) => {
    try {
      return d.prepare('select count(*) c from "' + t + '"').get().c;
    } catch (e) {
      return '?';
    }
  };
  return { projects: q('projects'), data: q('project_data'), users: q('users') };
}

const d = new DatabaseSync(DB_FILE);
const before = counts(d);

console.log('数据库：' + DB_FILE);
console.log('清除前：项目档案 ' + before.projects + ' 条、检测数据 ' + before.data + ' 条、账号 ' + before.users + ' 个');
console.log('将清空：projects、project_data 两张表（账号与权限保留）');

if (!skipConfirm) {
  console.log('这是一次不可逆操作，请在执行前确认已备份。');
  console.log('如需跳过提示，追加 --yes 参数。');
  d.close();
  process.exit(2);
}

d.exec('BEGIN');
d.exec('DELETE FROM project_data;');
d.exec('DELETE FROM projects;');
try {
  d.exec("DELETE FROM sqlite_sequence WHERE name IN ('projects','project_data');");
} catch (e) {
  /* 表中无 AUTOINCREMENT 时 sqlite_sequence 可能不存在，忽略 */
}
d.exec('COMMIT');

d.exec('VACUUM;');
d.exec('PRAGMA wal_checkpoint(TRUNCATE);');

const after = counts(d);
d.close();

console.log('清除后：项目档案 ' + after.projects + ' 条、检测数据 ' + after.data + ' 条、账号 ' + after.users + ' 个');
if (after.projects === 0 && after.data === 0) {
  console.log('DONE');
} else {
  console.error('[警告] 仍有残留数据，请检查');
  process.exit(3);
}
