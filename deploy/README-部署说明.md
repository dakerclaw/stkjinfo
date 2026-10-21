# mac mini 部署说明

服务器：`192.168.1.139`（Debian 13 trixie / x86_64 / 15G 内存 / 220G 磁盘）
主机名：`macmini`　账号：`mac`

---

## 当前部署状态

| 项目 | 状态 |
|---|---|
| Node.js | v22.22.2，位于 `~/apps/node-v22.22.2-linux-x64`（免 sudo） |
| 代码目录 | `~/apps/stkj` |
| 数据库 | `~/apps/stkj/data/app.db` |
| 服务 | systemd 用户服务 `stkj.service`，`enabled` + `active` |
| 监听 | `0.0.0.0:5173` |
| 开机自启 | 已开启 `loginctl enable-linger mac`，实测重启后 14 秒自动拉起 |
| 日志 | `~/apps/stkj/logs/app.log` |
| 访问地址 | http://192.168.1.139:5173 |

> 已实测：整机重启后服务自动恢复，无需人工登录。

---

## 一、数据安全加固（建议尽快执行）

### 问题是什么

原代码有两个数据持久化缺陷，在**异常退出/重启**时可能丢数据：

1. `seed.js` 末尾直接 `process.exit(0)`，没有关闭数据库。写入内容停留在 `app.db-wal`（曾出现 `app.db` 仅 4096 字节、WAL 却 1.7MB 的情况），重启后 WAL 失效，数据回退。
2. WAL 模式下未设置 `synchronous`，默认较弱的同步策略在断电/强杀时可能丢失最后若干次提交。

### 修复内容（已在本地仓库完成）

`db.js`：
```js
db.exec('PRAGMA synchronous = FULL;');          // 事务提交即 fsync
db.exec('PRAGMA wal_autocheckpoint = 100;');    // 每 100 页自动合并
db.exec('PRAGMA journal_size_limit = 67108864;');
db.exec('PRAGMA busy_timeout = 5000;');
```

`server.js`：新增 `SIGTERM`/`SIGINT` 处理，先关闭 HTTP 服务，再 `wal_checkpoint(TRUNCATE)` + `db.close()`。

`seed.js`：退出前 checkpoint 并 `db.close()`，并解除对 `./server` 的依赖（原写法会连带启动 HTTP 服务、占用 5173 端口）。

### 怎么应用到服务器

在 mac mini 上执行：

```bash
cd ~
# 1. 上传 stkj-deploy.tar.gz 到 ~ （见下方传输方式）
tar -xzf stkj-deploy.tar.gz -C ~/apps/stkj
# 2. 一键更新（自动备份 → 停服 → 覆盖 → 语法检查 → 启服）
bash ~/apps/stkj/deploy/apply-update.sh ~/stkj-deploy.tar.gz
# 3. 对现有库做一次 CHECKPOINT 加固
bash ~/apps/stkj/deploy/harden-db.sh
```

`apply-update.sh` 会自动把旧代码备份到 `~/apps/backups/code-<时间戳>.tar.gz`，**不会动 `data/` 数据库**。

---

## 二、把部署包传到 mac mini

三种方式任选：

**方式 A：从 Mac/PC 用 scp**
```bash
scp stkj-deploy.tar.gz mac@192.168.1.139:~/
```

**方式 B：在 mac mini 上直接 git clone**（推荐，以后更新只需 `git pull`）
```bash
cd ~/apps
git clone git@github.com:dakerclaw/stkjinfo.git stkj-src
# 首次需要把 mac mini 的 SSH 公钥加到 GitHub
```

**方式 C：U 盘/共享目录** 拷贝过去。

---

## 三、日常运维命令

```bash
# 查看状态
systemctl --user status stkj.service

# 重启 / 停止 / 启动
systemctl --user restart stkj.service
systemctl --user stop stkj.service
systemctl --user start stkj.service

# 实时看日志
tail -f ~/apps/stkj/logs/app.log

# 数据库健康检查
~/apps/node-v22.22.2-linux-x64/bin/node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('$HOME/apps/stkj/data/app.db');
console.log('projects:',db.prepare('SELECT COUNT(*) c FROM projects').get().c);
console.log('data:',db.prepare('SELECT COUNT(*) c FROM project_data').get().c);
db.close();"

# 备份数据库（建议加进 crontab 每天跑）
mkdir -p ~/backups
sqlite3 ~/apps/stkj/data/app.db ".backup '$HOME/backups/app-$(date +%F).db'" \
  || cp ~/apps/stkj/data/app.db ~/backups/app-$(date +%F).db
```

---

## 四、安全建议

1. **立即修改 admin 密码**：首次登录后改掉默认的 `admin123`。
2. 当前监听 `0.0.0.0:5173`，同网段任何人可访问。如只需自己用，把 `deploy/stkj.service` 里的
   `Environment=HOST=0.0.0.0` 改为 `127.0.0.1`，然后通过 SSH 隧道访问：
   ```bash
   ssh -L 5173:127.0.0.1:5173 mac@192.168.1.139
   ```
3. 会话存在内存中，服务重启后所有人需重新登录（这是设计上的已知限制）。

---

## 五、这些文件是什么

| 文件 | 用途 |
|---|---|
| `deploy/stkj.service` | systemd 用户服务单元（开机自启 + 崩溃自动重启） |
| `deploy/apply-update.sh` | 一键更新：备份 → 停服 → 覆盖代码 → 语法检查 → 启服 |
| `deploy/harden-db.sh` | 对现有数据库做 CHECKPOINT 加固 + 健康检查 |
| `deploy/stkj-deploy.tar.gz` | 上述内容的完整打包，便于整体传输 |
