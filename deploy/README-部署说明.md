# 部署说明

本文档说明本系统在 **Debian / Ubuntu 服务器**上的通用部署方式。所有示例用占位符，请按实际环境替换：

| 占位符 | 含义 | 示例 |
|---|---|---|
| `<用户名>` | 运行服务的普通用户（**不要用 root**） | `appuser` |
| `<服务器IP>` | 服务器地址 | `10.0.0.10` |
| `<端口>` | 服务监听端口（默认 5173） | `5173` |
| `~/apps/stkj` | 代码目录（可通过 `--dir` 改） | `$HOME/apps/stkj` |
| `~/apps/node-*` | Node.js 运行时目录 | `$HOME/apps/node-v22.23.3-linux-x64` |

> 逐步的安装 / 升级 / 卸载命令见根目录 `README.md` 的「Debian 服务器部署（安装 / 升级 / 卸载）」。
> 日常操作只需要一条命令：`bash ~/apps/stkj/deploy/stkj.sh install|upgrade|uninstall|status`。
> 本文档侧重**部署形态、目录约定、运维与故障排查**，补充 README 未展开的部分。

---

## 一、部署形态

采用 **systemd 用户服务**而非系统服务，理由：

- 不需要 root 权限，日常更新、重启都不用 sudo
- Node.js 装在用户目录（`~/apps/node-*`），不污染系统 PATH，不影响机器上其他项目
- 通过 `loginctl enable-linger` 实现开机自启，行为与系统服务等价

典型布局：

```
~/
├── apps/
│   ├── node-v22.23.3-linux-x64/      Node.js 运行时（免 sudo）
│   ├── stkj/                         代码目录（APP_DIR = CODE_DIR，仓库根即代码）
│   │   ├── server.js  db.js  ...
│   │   ├── deploy/                   部署脚本与 systemd 单元模板
│   │   ├── data/app.db               SQLite 数据库（含 -wal / -shm）
│   │   ├── backups/                  每日自动备份 + code-prev-*.tar.gz（升级前代码）
│   │   └── logs/app.log              运行日志
└── .config/systemd/user/
    ├── stkj.service
    ├── stkj-backup.service
    └── stkj-backup.timer
```

> **两种代码布局都支持**：`stkj.sh` 会自动检测 `APP_DIR/server.js` 或
> `APP_DIR/stkjinfo/server.js`，并把 systemd 单元的 `WorkingDirectory` 指到实际代码目录。
> 数据目录始终是 `APP_DIR/data`，由服务单元的 `DATA_DIR` 环境变量固定，与代码目录解耦。

---

## 二、前置条件

| 项目 | 要求 | 检查命令 |
|---|---|---|
| 系统 | Debian 11+ / Ubuntu 20.04+，x86_64 或 arm64 | `cat /etc/os-release`、`uname -m` |
| Node.js | **≥ 22.13**（使用内置 `node:sqlite`） | `node -v` |
| 基础工具 | `curl`、`tar`、`xz-utils`、`ca-certificates`（**不需要 git**） | `curl --version` |
| 端口 | `<端口>` 未被占用 | `ss -tlnp \| grep <端口>` |
| 磁盘 | 数据库大小 × 15 以上（自动备份保留 14 份） | `df -h ~` |

补装基础工具：

```bash
sudo apt update && sudo apt install -y curl tar xz-utils ca-certificates
```

> Node.js **不要用 `apt install nodejs`**：Debian 仓库版本普遍低于 22，缺少 `node:sqlite`。
> 用官方二进制包或 NodeSource 仓库，或直接跑 `bash deploy/stkj.sh install`（会自动下载）。
> 安装与升级都用 `curl` 下载代码包，服务器上**不需要安装 git**；只有早期 `git clone` 部署的机器才会走 `git pull`。

---

## 三、数据安全设计（重要）

SQLite 在 WAL 模式下有几个容易丢数据的坑，本项目已针对性处理，**部署时无需额外操作**，但了解原因有助于排查问题。

### 已做的处理

| 环节 | 处理 | 位置 |
|---|---|---|
| 同步策略 | `PRAGMA synchronous = FULL`，事务提交即 fsync | `db.js` |
| 自动合并 | `wal_autocheckpoint = 100`，每 100 页合并一次 | `db.js` |
| WAL 体积 | `journal_size_limit = 67108864`（64 MB 上限） | `db.js` |
| 锁等待 | `busy_timeout = 5000`，避免瞬时锁冲突直接报错 | `db.js` |
| 优雅退出 | 收到 `SIGTERM`/`SIGINT` 先关 HTTP，再 `wal_checkpoint(TRUNCATE)` + `db.close()` | `server.js` |
| 脚本退出 | `seed.js` / `backup.cjs` 结束前 checkpoint 并关库 | 对应文件 |

### 曾经踩过的坑

早期版本 `seed.js` 末尾直接 `process.exit(0)`，没有关闭数据库。写入停留在 `app.db-wal` 中（当时出现过 `app.db` 只有 4 KB、WAL 却有 1.7 MB 的情况），一旦进程被强杀或机器断电，WAL 未合并，重启后数据回退。**这类问题不会报错，只在重启后才发现数据少了**，所以务必保留优雅退出逻辑。

### 备份策略

- **每日自动**：`stkj-backup.timer` 每天 03:00 用 `VACUUM INTO` 生成在线一致性快照，不影响运行中的服务，默认保留 14 份
- **手动触发**：`bash deploy/backup.cjs`（`--keep N` 调整保留份数）
- **更新前**：`bash deploy/stkj.sh upgrade` 会先自动备份数据库，再下载代码；上一版代码同时留在 `backups/code-prev-<时间戳>.tar.gz`（最近 3 份），重启失败会自动回滚

> `VACUUM INTO` 生成的是完整独立的 .db 文件，可直接拿来恢复，不像 `cp` 主库文件那样会漏掉 WAL 里的数据。

---

## 四、日常运维

```bash
# 服务状态
systemctl --user status stkj.service --no-pager

# 重启 / 停止 / 启动
systemctl --user restart stkj.service
systemctl --user stop stkj.service
systemctl --user start stkj.service

# 实时日志
tail -f ~/apps/stkj/logs/app.log

# 备份定时器
systemctl --user list-timers stkj-backup.timer
tail -f ~/apps/stkj/logs/backup.log

# 端口监听
ss -tlnp | grep <端口>
```

### 数据库健康检查

```bash
~/apps/node-v22.23.3-linux-x64/bin/node --no-warnings -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.HOME + '/apps/stkj/data/app.db', {readOnly:true});
console.log('完整性:', db.prepare('PRAGMA integrity_check').get());
console.log('项目  :', db.prepare('SELECT COUNT(*) c FROM projects').get().c);
console.log('数据  :', db.prepare('SELECT COUNT(*) c FROM project_data').get().c);
console.log('用户  :', db.prepare('SELECT COUNT(*) c FROM users').get().c);
console.log('会话  :', db.prepare('SELECT COUNT(*) c FROM sessions').get().c);
db.close();"
```

> 只读方式打开，检查过程中不会与线上服务争抢写锁。

---

## 五、安全配置建议

1. **立即修改默认密码**：首次登录后右键菜单改掉 `admin` 的初始密码
2. **限制监听范围**：默认 `0.0.0.0`，同网段均可访问。仅需本机或经跳板机访问时改为 `127.0.0.1`：
   ```bash
   # 改服务单元后重载
   sed -i 's/Environment=HOST=0.0.0.0/Environment=HOST=127.0.0.1/' \
     ~/.config/systemd/user/stkj.service
   systemctl --user daemon-reload && systemctl --user restart stkj.service

   # 本地通过 SSH 隧道访问
   ssh -L <端口>:127.0.0.1:<端口> <用户名>@<服务器IP>
   ```
3. **不要直接暴露到公网**：应用本身不带 HTTPS，Cookie 未加 `Secure`。需要公网访问时，在前面加 Nginx / Caddy 做 TLS 终止
4. **收紧文件权限**：
   ```bash
   chmod 700 ~/apps/stkj/data ~/apps/stkj/backups
   chmod 600 ~/apps/stkj/data/app.db*
   ```
5. **会话机制**：会话持久化在数据库 `sessions` 表，重启服务不掉线，7 天不活跃失效；改密会注销该账号全部会话

---

## 六、系统服务方式（可选）

如果机器由多人共用、需要严格的系统级管理，可以改用**系统服务**。把单元文件放到 `/etc/systemd/system/`，并在 `[Service]` 中显式指定用户：

```ini
[Unit]
Description=stkj 项目管理系统
After=network-online.target

[Service]
Type=simple
User=<用户名>
Group=<用户名>
WorkingDirectory=/home/<用户名>/apps/stkj
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=<端口>
Environment=DATA_DIR=/home/<用户名>/apps/stkj/data
ExecStart=/home/<用户名>/apps/node-v22.23.3-linux-x64/bin/node --no-warnings server.js
Restart=always
RestartSec=3
StandardOutput=append:/home/<用户名>/apps/stkj/logs/app.log
StandardError=append:/home/<用户名>/apps/stkj/logs/app.log

[Install]
WantedBy=multi-user.target
```

> 若历史部署把代码放在 `~/apps/stkj/stkjinfo`（子目录布局），把 `WorkingDirectory` 改回
> 该子目录即可；`DATA_DIR` 始终指向 `apps/stkj/data`，与代码目录无关。

```bash
sudo cp stkj-system.service /etc/systemd/system/stkj.service
sudo systemctl daemon-reload
sudo systemctl enable --now stkj.service
```

两种方式的区别：

| | 用户服务（默认） | 系统服务 |
|---|---|---|
| 权限 | 普通用户即可管理 | 每次操作需 sudo |
| 开机自启 | 需 `enable-linger` | 自动 |
| 隔离性 | 仅影响该用户 | 影响整机 |
| 适用 | 单人维护、专用机器 | 多人共用、需要审计 |

---

## 七、常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 服务起不来，日志无内容 | `ExecStart` 里 Node 路径写错 | `systemctl --user cat stkj` 核对路径；`ls -l` 确认文件存在 |
| `Cannot find module 'node:sqlite'` | Node 版本 < 22.13 | 升级 Node，并同步改单元文件里的路径 |
| `Error: listen EADDRINUSE` | 端口被占用 | `ss -tlnp \| grep <端口>` 找到进程，改端口或停掉冲突服务 |
| 重启后服务没起来 | 未开 linger，且用户未登录 | `sudo loginctl enable-linger <用户名>` |
| 浏览器能开但接口全 401 | Cookie 被拦截 | 确认访问地址与 Cookie 域一致；跨域部署需额外配置 |
| 导入 Excel 报「文件过大」 | 超过 20 MB 或解压后超 32 MB | 拆分文件分批导入 |
| 数据库文件异常小（几 KB） | WAL 未合并 | 正常退出服务后查看 `app.db` 大小；必要时手动跑 `backup.cjs` |
| 定时备份没执行 | timer 未启用，或机器当时关机 | `systemctl --user list-timers`；`Persistent=true` 会在开机后补跑 |

### 查看完整堆栈

```bash
systemctl --user status stkj.service --no-pager -l
journalctl --user -u stkj.service -n 100 --no-pager
```

---

## 八、deploy/ 目录说明

| 文件 | 用途 |
|---|---|
| `stkj.sh` | **一键脚本**：`install` / `upgrade` / `uninstall` / `status`，参数见 `bash stkj.sh help` |
| `backup.cjs` | 数据库在线备份（`VACUUM INTO`，`--keep N` 控制保留份数） |
| `stkj.service` | systemd **用户**服务单元模板（`%h` 会自动替换为家目录） |
| `stkj-backup.service` / `.timer` | 每日 03:00 自动备份 |
| `harden-db.sh` | 对已有数据库做 CHECKPOINT 加固与健康检查 |
| `clear-data.cjs` | 清空业务数据（保留账号与项目档案） |
| `README-部署说明.md` | 本文件 |

单元模板中的 `%h` 由 systemd 自动展开为当前用户家目录；`stkj.sh install` 在安装时会把它替换成实际路径并写入 `~/.config/systemd/user/`。
