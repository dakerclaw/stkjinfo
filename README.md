# 项目管理应用

基于 Node.js 的项目管理系统，用于管理项目库与项目检测/生产数据。
**零第三方依赖**，后端仅使用 Node.js 内置模块（`node:http`、`node:crypto`、`node:zlib`、`node:sqlite`）。

> **版权与授权**：本软件为个人私有作品，版权归作者个人所有，**保留一切权利**。未经作者书面许可，不得用于任何商业用途。详见下方「版权与许可」及 [LICENSE](LICENSE)。

> **联系方式**：stkjinfo@hehudieyiqi.com

## 快速开始

仓库根目录即代码目录，克隆后直接执行：

```bash
npm start          # 启动服务，访问 http://127.0.0.1:5173
```

要求 Node.js >= 22.5（内置 SQLite 模块）。

> 要部署到 Debian 服务器？只需一条命令，见下方「[Debian 服务器部署（安装 / 升级 / 卸载）](#debian-服务器部署安装--升级--卸载)」。

```bash
node seed.js           # 首次初始化账号与示例数据
node seed.js --reset   # 清空项目与数据后重新灌入示例（保留用户）
```

默认账号：

| 账号 | 密码 | 角色 |
|---|---|---|
| `admin` | `admin123` | 系统管理员 |
| `manager` | `manager` | 管理员 |
| `zhangsan` | `zhangsan` | 普通用户 |
| `lisi` | `lisi` | 普通用户（已停用） |

密码以 scrypt + 随机盐散列存储，不保存明文。

## 角色与权限

三种角色，登录后由后端逐条校验，前端同步隐藏无权限入口。

| 能力 | 系统管理员 `sys_admin` | 管理员 `admin` | 普通用户 `user` |
|---|:---:|:---:|:---:|
| 查看项目列表 | ✅ | ✅ | ✅ |
| 项目增 / 删 / 改 | ✅ | ✅ | ❌ |
| 查看项目数据 | 全部 | 全部 | 仅自己录入 |
| 新增 / 修改项目数据 | ✅ | ✅（可改全部） | ✅（仅自己的） |
| 删除项目数据 | ✅ | ✅ | ❌ |
| 管理普通用户 | ✅ | ✅ | ❌ |
| 管理管理员账号 | ✅ | ❌ | ❌ |
| 修改自己的密码 | ✅ | ✅ | ✅ |

- **系统管理员**固定为用户名 `admin`，账号不可删除、不可改角色、不可修改资料
- 管理员可创建/编辑/停用/重置密码/删除**普通用户**；创建**管理员**仅系统管理员可操作
- 普通用户的筛选下拉只列出自己数据中出现过的选项，避免泄露他人数据
- 修改角色、停用账号或重置密码后，该用户已有的登录会话立即失效

### 登录与密码

- 账号 + 密码登录，会话持久化到数据库（`sessions` 表），**重启服务不掉线**；7 天未活跃自动失效（`HttpOnly` Cookie）
- 账号不存在与密码错误返回同一提示，避免账号枚举
- **新增用户时密码默认为账号**；不填密码即使用该默认值，用户列表以「初始密码」标记
- 管理员可「重置密码」为账号本身；用户可在右上角菜单自行修改密码
- 改密后该账号的**其他登录会话立即失效**，当前会话自动续发新 Cookie，无需重新登录
- 仍在使用初始密码时，登录后会弹窗提醒改密（不强制，可稍后处理）
- 防暴力猜解：同一账号连续 5 次密码错误即锁定 5 分钟，期间提示剩余等待时间

## 安全说明

面向内网部署的单进程应用，已做的基础加固如下：

| 风险点 | 处理方式 |
|---|---|
| 路径穿越 | 静态文件仅提供 `public/` 目录，拼出的路径必须等于 `public/` 或以 `public/<分隔符>` 开头（避免 `public-x/` 误判），否则 403；`decodeURIComponent` 失败返回 400；非 GET/HEAD 返回 405；未知路径回落 SPA 首页 |
| SQL 注入 | 所有查询参数化；`sort` / `dir` 走白名单映射，非白名单值直接忽略 |
| 越权读写 | 逐条校验归属：普通用户只能看 / 改 / 删自己录入的数据；**覆盖导入与单条修改同权限**，不能覆盖他人记录。项目列表与导出的「数据条数 / 最近录入」也按同一口径统计，不会泄露他人数据规模 |
| 账号枚举 | 账号不存在与密码错误返回同一提示；用户列表不返回 `password_hash` / `salt` |
| 会话固定与劫持 | 登录后重新签发 `sid`；改密 / 重置密码 / 停用账号 / 变更角色即销毁该用户全部会话（仅改姓名等资料不会踢人）；Cookie 为 `HttpOnly; SameSite=Lax`；过期会话每小时随清理任务删除 |
| 弱口令爆破 | 连续 5 次密码错误锁定 5 分钟；失败计数表超过 1000 条约自动清理过期项 |
| 错误信息泄露 | 500 仅返回「服务器内部错误」，SQL / 表结构 / 文件路径只写服务端日志；Excel 解析错误统一为友好文案 |
| 畸形请求 | 非法 JSON 返回 400；请求体超过 4 MB 返回 413；文件超过 20 MB 返回 413（先排空请求流再回包，客户端能收到可读提示，而不是连接被重置） |
| 上传型攻击 | 单次上传上限 20 MB；ZIP 单条目解压上限 32 MB、合计 64 MB、条目数上限 256，并启用 `maxOutputLength` 硬限制，防解压炸弹；单次导入最多 5 万行 |
| 存储型 XSS | 所有动态文本经 `esc()` 转义；列表中的点击动作改用 `data-*` 属性 + 文档级事件委托传递参数，不再把用户输入拼进内联 JS 字符串。CSP 的 `script-src` 保留 `'unsafe-inline'`（界面大量使用内联 `onclick`，CSP 无法对事件属性做白名单），因此转义与参数隔离是 XSS 的主要防线 |
| 脏数据 / 超长内容 | 文本字段统一清洗（去控制字符、压缩空白）并按字段截断（编号 100、简介 1000、备注 2000 字符），避免污染列表、导出与日志 |
| 点击劫持 | 响应头含 `X-Frame-Options: SAMEORIGIN`、`frame-ancestors 'self'` |
| 审计追溯 | 项目 / 数据 / 账号的新增、修改、软删除、恢复、彻底删除、导入与批量状态变更写入 `audit_logs`，保留 180 天，**系统管理员**可在「审计日志」页按对象、动作、日期、关键词检索并查看字段级变更 |

部署注意事项：

- 服务监听 `0.0.0.0:5173` 且**不带 HTTPS**，Cookie 未加 `Secure`。仅适合**内网**使用；如需从公网访问，请在前面加 Nginx / Caddy 做 TLS 终止，并给 Cookie 补 `Secure`
- 单进程 Node 服务，CPU 密集操作（大文件导入、导出）会阻塞其他请求。大表导入建议避开使用高峰，单次不超过 5 万行
- 数据库文件与 `backups/` 目录权限应为 `600` / `700`，不要放在 Web 可访问目录下

### 静态资源与接口性能

- `public/` 下的文本资源（html / css / js）首次读取后缓存在内存，并按 `Accept-Encoding` 协商 **br / gzip** 压缩（`app.js` 压缩后约为原来的 1/4）
- 静态资源带 `ETag` / `Last-Modified` + `Cache-Control: no-cache`，内容未变时返回 **304** 且无正文；代码更新后首次访问即生效，不会读到旧文件
- 项目列表与导出共用同一条查询：`LEFT JOIN + GROUP BY` 一次算出「数据条数 / 最近录入」，避免每行两次相关子查询
- `/api/meta`（字段定义与筛选下拉）按用户缓存，任何写操作后自动失效，切页时不再重复跑 7 条 `DISTINCT`

## 数据库

文件：`data/app.db`（WAL 模式；可用环境变量 `DATA_DIR` 指定所在目录）。核心三张表（另有 `sessions` 登录会话表与 `audit_logs` 审计日志表，由服务自动维护）：

### 1. `users` 用户账号信息表
| 字段 | 说明 |
|---|---|
| id | 主键 |
| username | 登录账号（唯一） |
| password_hash / salt | 密码散列与盐 |
| real_name | 姓名 |
| role | 角色 `sys_admin` 系统管理员 / `admin` 管理员 / `user` 普通用户 |
| status | 1 启用 / 0 停用 |
| remark | 备注 |
| pwd_changed | 0 = 仍为初始密码（=账号），1 = 已修改 |
| created_at / last_login | 创建时间 / 最近登录 |

### 2. `projects` 项目列表信息表
| 字段 | 说明 |
|---|---|
| id | 主键 |
| project_no | 项目编号（唯一） |
| product_code | 产品代码 |
| project_type | 项目类型 |
| description | 项目简介 |
| status | 1 进行中 / 0 已归档 |
| created_at / updated_at | 时间戳 |

筛选维度：**项目编号、产品代码、项目类型**，另有关键词模糊搜索。

### 3. `project_data` 项目数据信息表
关联字段：`project_no`、`product_code`、`base`（所属公司）、`process_code`（工序）、`work_order`（工单号）、`coke_type`（焦种）

指标字段（共 46 个字段，其中数值型可为空表示未检测）：

> **精度约定**：粒度、物性、电化学、粉压、工业分析及效率/收率等全部指标字段统一为**浮点数保留 2 位小数**。手工录入、编辑、Excel 导入时服务端自动四舍五入（如 `12.3456 → 12.35`、`-0.005 → 0`），列表页固定显示 2 位小数。仅**生产数量**（`quantity`）保留原始精度。

- **粒度**：dx0、dx1、dx10、dx50、dx90、dx99、dx100、k_value
- **物性**：tap_density 振实密度、true_density 真密度、ssa_domestic 比表-国产、ssa_mic 比表-麦克、graphitization 石墨化度、magnetic 磁性物质、ph_value、oversize 筛上物、oil_absorption 吸油值、hgi 哈氏可磨指数
- **电化学**：capacity 容量、lithium_inter 嵌锂容量、lithium_deint 脱锂容量、first_eff 首次效率
- **粉压 5 点法**：press_0_5t、press_1t、press_1_5t、press_2t、press_5t
- **工业分析**：moisture_fp 成品水分、ash 灰分、volatile 挥发分、moisture 水分、sulfur 硫分、caking_index 黏结指数、coking_value 结焦值
- **生产**：efficiency 效率、yield_rate 收率、energy 能耗、quantity 生产数量、entry_date 录入日期、remark 备注

筛选维度：**项目编号、产品代码、所属公司、工序、工单号、焦种**，另支持关键词与录入日期区间。

归属字段：`created_by`（录入人账号）、`created_by_id`（录入人 id）、`updated_by`（最后修改人）。
普通用户的可见范围即 `created_by_id = 当前用户`；管理员不受限。

> 录入时只需选择**项目编号**，产品代码自动按项目档案带出并锁定，避免两者不一致；项目编号必须已存在。

## 功能

- **总览**：项目/数据统计、项目类型 / 产品代码 / 统计日期 / 项目状态分布、最近录入
- **项目列表**：多条件筛选（编号 / 产品代码 / 类型 / 状态）、列排序、增删改、跳转查看关联数据、Excel 导入 / 导出（导入仅管理员）
- **项目数据**：46 字段宽表、列排序、分页、六项筛选联动、勾选批量删除、勾选一行「复制为新行」、Excel 导入（支持中文表头）、Excel 导出
- **用户管理**：账号增删改、重置密码、角色分级授权、Excel 批量导入
- **审计日志**：新增 / 修改（含字段级 from→to）/ 删除 / 恢复 / 导入等关键操作自动落库，保留 180 天；**仅系统管理员**可查看
- **回收站**：项目与数据删除改为软删除，30 天内可在「回收站」页恢复，超期自动物理清理；彻底删除不可恢复
- **键盘操作**：录入弹窗内 Enter 跳下一字段，最后一个字段 Enter 或 Ctrl+S / Ctrl+Enter 直接保存
- 修改项目编号时自动同步更新其数据记录的项目编号，保持关联一致

### Excel 导入：支持部分指标

导入时**只需包含「项目编号」和「产品代码」**，其余指标字段可任意缺省，未提供的字段自动留空（数据库存 NULL，界面显示“—”）。

- 表头支持中文列名、字段名及常见别名：`Dx（50）`、`振实密度(g/cm³)`、`首效`、`磁性异物`、`工单号`、`首效`、`粘结指数` 等均可识别
- 空值写法一律视为未提供：空串、空格、`-`、`/`、`N/A`、`未检测`、`未测`
- 数值列若为 `16.5 mg`、`约1.08`、`<50`、`95.2%` 会自动提取数字；纯文本（如 `abc`）留空
- 导入前预览显示：识别到几个字段、哪些字段将留空、无法识别的列；缺少必填表头时会拦截
- 「选择字段生成模板」可按需勾选指标，下载只含所需列的 Excel 模板
- 上传的 Excel 由**服务端解析**：先预览（识别字段数 / 将留空的字段 / 无法识别的列），确认后再整批写入

### 重复数据：覆盖导入 / 追加导入

录入与导入都以 **项目编号 + 产品代码 + 所属公司 + 工序 + 工单号** 五项作为记录唯一键（焦种不参与判重）：

- **五项全部有值且完全相同时**，系统弹出确认框，可选择：
  - **覆盖导入**：用本次填写的数据更新已有记录，保留原记录编号与录入人（`updated_at` 刷新，`updated_by` 记录本次修改人）
  - **追加导入**：作为一条新记录保存，已有记录保持不变
- **五项中有任意一项为空或不相同**，不做重复判定，正常导入
- 覆盖时只更新本次提交的字段，未提交的指标保持原值
- Excel 批量导入同样生效：命中重复会先拦截并列出重复所在行号（最多展示 50 行），确认后整批按所选方式处理，并回报「覆盖 N 条 / 新增 M 条」

接口层面：未指定处理方式且命中重复时返回 `HTTP 409` + `code:"DUPLICATE_KEY"`，`duplicate` 字段携带冲突详情；客户端带 `duplicate_action:"overwrite"|"append"` 重新提交即可。

### 项目列表导入（仅管理员）

项目列表页同样支持 Excel 批量导入，与项目档案的新增/修改权限一致，**仅管理员可操作**。

- 必填列：**项目编号、产品代码、项目类型**；可选列：项目简介、状态（填「启用 / 停用」，留空视为启用）
- 表头支持别名：`项目号` / `项目编码`、`产品编码` / `物料代码`、`类型` / `项目类别`、`描述` / `简介`、`项目状态`
- 项目编号在系统中唯一：上传后预览即显示「将新增 N 个 / 编号已存在 M 个」；确认时若命中重复，可选择
  - **覆盖已有**：仅用文件中实际提供的字段更新已有项目（项目编号不变，`updated_at` 刷新）
  - **跳过已存在**：只导入新编号，已有的保持原样
- 文件内项目编号重复、缺少产品代码 / 项目类型的行会被跳过并在结果中列出行号
- 整批导入在一个事务内完成：命中重复且未选择处理方式时整体回滚，不会出现半批写入

### 项目列表筛选与排序

- **筛选**：项目编号、产品代码、项目类型、状态（进行中 / 已归档），可与关键词搜索叠加，条件之间为「与」关系
- **排序**：点击表头在升序 / 降序间切换，支持 **项目编号、产品代码、数据条数、最近录入、状态** 五列
- 首次点击的方向按列类型决定：编号、产品代码按**升序**（A→Z、编号从小到大），数据条数、最近录入、状态按**降序**（多的 / 近的 / 进行中在前）
- 排序细节：
  - 空值（如「最近录入」无数据记录）**始终排在最后**，不随升序 / 降序翻转
  - 同值时按记录 id 兜底，保证顺序稳定；翻页、反复刷新不会出现重复或漏行
  - 数值列按数值大小排序而非字符串字典序（`10` 排在 `9` 之后）
- 「导出 Excel」与当前列表**同口径**：带上同样的筛选条件与排序方式
- 排序参数只接受白名单内的列名，非法值自动回退默认排序（按录入顺序倒序），不影响数据安全

### 项目列表批量修改状态（仅管理员）

- 管理员在项目列表勾选若干项目（表头可全选 / 取消全选），操作栏会出现「设为进行中 / 设为已归档」两个批量按钮
- 工具栏同样提供「仅显示已选」与「删除选中」：删除为批量级联（连同项目下的数据记录），项目与数据行的**单行删除按钮已移除**，删除统一走批量勾选
- 点击后在弹窗中确认，一次性把所选项目状态改为目标值；提交后清空勾选并刷新列表
- 「导出 Excel」在有勾选时只导出**勾选的项目**（`?ids=1,2,3`），否则按当前筛选与排序导出
- 接口：`POST /api/projects/batch-status`，请求体 `{ids: number[], status: 0 | 1}`，返回 `{updated}`（实际改动的行数）
- 校验：ids 自动去重、忽略非法值；单次最多 500 个；普通用户请求返回 403

### 项目数据：筛选联动与「复制为新行」

- **六项筛选联动**：项目编号、产品代码、所属公司、工序、工单号、焦种，选中任意一项后，其余下拉只保留**在当前条件下仍有数据**的值；每列不限制自身，所以选完还能直接切换。任意选择顺序结果一致（接口 `GET /api/data/facets`）
- **复制为新行**：勾选**一行**后，工具栏出现「复制为新行」，点击会打开新增表单并预填该行全部字段；修改工单号、录入日期等可区分字段后保存，即生成一条独立的新记录（原记录不受影响）
- 若保存时五项关键字段与原记录完全相同，会提示先修改可区分字段，**不提供「覆盖」**，避免误改被复制的原记录
- 行勾选框对所有角色可见（普通用户可复制自己的数据）；「删除选中」仍仅管理员可见

### 用户批量导入（仅管理员）

用户管理页支持 Excel 批量创建账号，用于人员集中入职时一次性建号，**仅管理员可操作**。

- 必填列：**账号**（2–32 位字母、数字或 `_ . @ -`）；可选列：姓名、角色、状态、备注
- 表头支持别名：`用户名` / `登录名` / `登录账号`、`真实姓名` / `名字`、`用户角色` / `权限`、`用户状态`
- 角色填「普通用户 / 管理员」（留空视为普通用户），状态填「启用 / 停用」（留空视为启用）
- **初始密码即账号本身**，导入后账号标记为「初始密码」，首次登录后应提醒本人修改
- 账号已存在时预览即显示「将新增 N 个 / 账号已存在 M 个」，确认时可选择：
  - **覆盖已有**：用文件中的姓名、角色、状态、备注更新已有账号，**不改密码**
  - **跳过已存在**：只导入新账号，已有的保持原样
- 权限边界：
  - **系统管理员账号一律不可通过导入修改**（覆盖时也会跳过并提示）
  - 管理员可覆盖自己的账号，但不能改写其他管理员账号（仅系统管理员可以）
  - 角色变更（含把管理员降级）仅系统管理员可执行；文件未提供「角色」列时，覆盖保持原角色不变
  - 「管理员」角色的新建仅系统管理员可导入，与手工新增的规则一致
  - 覆盖时若把账号改为「停用」，该账号已登录的会话立即失效
- 账号格式错误、文件内账号重复、角色无法识别、试图导入系统管理员等行会被逐行跳过，并按 **Excel 真实行号** 报告原因

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/login | 登录 `{username,password}`，成功后下发 HttpOnly Cookie |
| POST | /api/auth/logout | 注销，清除会话 |
| GET | /api/auth/me | 当前登录用户 |
| POST | /api/auth/password | 自助修改密码 `{old_password,new_password}` |
| GET | /api/meta | 字段定义、筛选下拉、角色列表、当前用户权限位 |
| GET | /api/stats | 总览统计（普通用户仅统计自己的数据）：`byType` / `byProduct` / `byDate` / `byStatus` 分布 |
| GET | /api/audit-logs | 审计日志分页查询（**仅系统管理员**，其他角色 403）：`page` / `pageSize`（≤200）/ `entity` / `action` / `q` / `date_from` / `date_to`，保留 180 天 |
| GET/POST | /api/projects | 项目列表（全员，支持 `project_no` / `product_code` / `project_type` / `status` 筛选、`sort` / `dir` 排序）/ 新建（管理员） |
| GET/PUT/DELETE | /api/projects/:id | 项目详情 / 更新（管理员）/ 删除（管理员，级联删数据） |
| POST | /api/projects/batch-status | 批量修改项目状态 `{ids, status}`，返回 `{updated}`（仅管理员） |
| POST | /api/projects/bulk-delete | 批量删除项目 `{ids}`（软删除，级联其下数据，可在回收站恢复；仅管理员） |
| GET/POST | /api/data | 数据列表（分页，普通用户仅自己的）/ 新建（五项重复时 409） |
| GET/PUT/DELETE | /api/data/:id | 详情 / 更新（本人或管理员）/ 删除（管理员） |
| POST | /api/data/bulk-delete | 批量删除 `{ids:[]}`（管理员） |
| POST | /api/data/import | JSON 导入 `{rows:[], duplicate_action?}`，允许部分字段；返回留空字段清单 |
| GET | /api/data/export | 导出检测数据为 Excel，按筛选条件；传 `ids` 时只导出勾选的记录 |
| GET | /api/data/facets | 筛选联动：按当前筛选条件返回「所属公司 / 工序 / 工单号 / 焦种」的可选值（每列排除自身条件） |
| GET | /api/data/template | 下载导入模板 Excel，`?fields=a,b,c` 可只含指定字段 |
| POST | /api/data/import-file | 上传 .xlsx 二进制，服务端解析并返回预览与批次 `token` |
| POST | /api/data/import-confirm | 按 `token` 确认导入 `{token, duplicate_action?}` |
| GET | /api/projects/export | 导出项目档案为 Excel，按筛选与排序；传 `ids` 时只导出勾选的项目 |
| GET | /api/projects/template | 下载项目列表导入模板（仅管理员） |
| POST | /api/projects/import-file | 上传项目清单 .xlsx，返回预览、`willInsert` / `willDup` 与批次 `token`（仅管理员） |
| POST | /api/projects/import-confirm | 按 `token` 确认导入 `{token, duplicate_action?}`，重复时 409 待选 `overwrite` / `skip`（仅管理员） |
| GET | /api/recycle | 回收站列表：已软删除的项目与数据（仅管理员） |
| POST | /api/recycle/restore | 从回收站恢复 `{entity: project|data, ids}`（仅管理员） |
| POST | /api/recycle/purge | 彻底删除（物理清除，不可恢复，仅管理员） |
| GET/POST | /api/users | 用户列表 / 新建（管理员；创建管理员仅系统管理员） |
| PUT/DELETE | /api/users/:id | 更新 / 删除（管理员；管理员账号仅系统管理员可操作） |
| GET | /api/users/template | 下载用户导入模板（仅管理员，角色示例列按操作人权限裁剪） |
| POST | /api/users/import-file | 上传用户清单 .xlsx，返回预览、`willInsert` / `willDup`、逐行错误与批次 `token`（仅管理员） |
| POST | /api/users/import-confirm | 按 `token` 确认导入 `{token, duplicate_action?}`，重复时 409 待选 `overwrite` / `skip`（仅管理员） |

除 `/api/auth/login`、`/api/auth/logout` 外，所有接口均需登录，未登录返回 401。
权限不足返回 403，响应体 `{success:false, message}`；数据重复返回 409，`code` 为 `DUPLICATE_KEY`。

## 目录结构

仓库根目录即代码目录（部署脚本兼容根目录与 `stkjinfo/` 子目录两种布局）：

```
server.js            后端服务与 API
db.js                建表语句与字段定义（前后端共用字段元数据）
xlsx.js              极简 XLSX 读写（零第三方依赖：手写 ZIP + XML）
import-map.js        导入表头识别（中文列名 / 字段名 / 别名 → 字段 key）
seed.js              初始化账号与示例数据
public/index.html    页面骨架
public/styles.css    样式
public/app.js        前端逻辑（视图渲染、筛选、表单、Excel 导入导出）
deploy/              部署脚本与 systemd 单元（详见 deploy/README-部署说明.md）
data/app.db          SQLite 数据库（本机默认 ./data；部署时用 DATA_DIR 固定到 APP_DIR/data）
```

`deploy/` 目录内容：

| 文件 | 用途 |
|---|---|
| `stkj.sh` | **一键脚本（推荐）**：`install` 安装 / `upgrade` 升级 / `uninstall` 卸载 / `status` 查看状态 |
| `install.sh` | 兼容旧入口，等价于 `stkj.sh install` |
| `uninstall.sh` | 兼容旧入口，等价于 `stkj.sh uninstall` |
| `apply-update.sh` | 旧版 tar 覆盖更新脚本（已被 `stkj.sh upgrade` 取代，保留备查） |
| `backup.cjs` | 数据库在线备份（`VACUUM INTO`，`--keep N` 控制保留份数） |
| `harden-db.sh` | 对现有库做 CHECKPOINT 加固与健康检查 |
| `clear-data.cjs` | 清空业务数据（保留账号与项目档案） |
| `stkj.service` | systemd 用户服务单元（开机自启 + 崩溃自动重启） |
| `stkj-backup.service` / `.timer` | 每日 03:00 自动备份 |

## Debian 服务器部署（安装 / 升级 / 卸载）

所有操作由一个脚本完成：`deploy/stkj.sh`，四个子命令 `install`、`upgrade`、`uninstall`、`status`。
全程**无需 root**：Node.js 装在用户目录，服务以 systemd **用户服务**运行，代码、数据库、备份都在 `~/apps/stkj` 下。

> **更新只走 GitHub**：服务器上的代码不要用 scp / tar 直接覆盖，否则 git 工作区会变脏，`upgrade` 会拉取失败。
> 所有改动先推送到 GitHub，再到服务器执行 `bash ~/apps/stkj/deploy/stkj.sh upgrade`。

以下命令都用**普通用户**（示例 `mac`）SSH 登录服务器后执行，`~` 指该用户家目录。

### 一、安装（一条命令）

```bash
mkdir -p ~/apps && git clone git@github.com:dakerclaw/stkjinfo.git ~/apps/stkj \
  && bash ~/apps/stkj/deploy/stkj.sh install
```

看到最后打印的「安装完成」和「首页访问：HTTP 200」就装好了。浏览器打开 `http://<服务器IP>:5173`，用 `admin / admin123` 登录，**登录后立即在右上角修改密码**。

安装脚本自动做完这些，不需要手动操作：

| 步骤 | 说明 |
|---|---|
| Node.js | 优先用已有的 `~/apps/node-*`；没有就下载到 `~/apps`（先国内镜像，失败自动换官方源），要求 ≥ v22.13 |
| 代码 | 克隆到 `~/apps/stkj`；目录里已有代码则执行 `git pull` |
| 数据目录 | 建 `data/`、`backups/`、`logs/`，数据目录权限收紧为 700 |
| 数据库 | 没有 `data/app.db` 时初始化（含默认管理员与示例数据）；已有则**原样保留** |
| 服务 | 生成并启用 `stkj.service`（开机自启、崩溃自动重启） |
| 备份 | 装每日 03:00 自动备份定时器，默认保留 14 份 |
| 自检 | 重启服务 → 确认 active → 请求首页确认 HTTP 200 |

可选参数（写在 `install` 后面，可组合）：

| 参数 | 说明 |
|---|---|
| `--port=5173` | 监听端口 |
| `--host=127.0.0.1` | 仅本机可访问（配合 SSH 隧道更安全） |
| `--dir=~/apps/stkj` | 安装目录 |
| `--node-version=v22.23.3` | 指定 Node 版本（换版本也用它，见文末） |
| `--no-backup` | 不装每日备份定时器 |
| `--with-linger` | 自动执行 `sudo loginctl enable-linger`（开机免登录自启） |

第一次安装前只需确认两件事：

1. 系统装了 git / curl / xz（Debian 最小化安装默认没有）：

```bash
sudo apt update && sudo apt install -y git curl xz-utils ca-certificates
```

2. 服务器能读 GitHub 仓库。用 Deploy Key（只读即可）：

```bash
cat ~/.ssh/id_ed25519.pub      # 没有这个文件就先 ssh-keygen -t ed25519 -C "stkj-server"
```

把输出的公钥贴到 GitHub 仓库 → Settings → Deploy keys → Add deploy key。

> **开机自启**：systemd 用户服务默认要等该用户登录才启动。执行一次
> `sudo loginctl enable-linger $(whoami)` 即可（或安装时加 `--with-linger`）。

### 二、升级（一条命令）

```bash
bash ~/apps/stkj/deploy/stkj.sh upgrade
```

脚本自动完成：备份数据库 → 收起服务器上的本地改动（`git stash`）→ `git pull` 最新代码 → 语法检查 → **只有后端代码变了才重启**（纯前端改动会提示刷新即可）→ 自检。

看到「升级完成」和「HTTP 200」即成功。数据库结构变更由 `db.js` 启动时自动迁移，不需要手动执行 SQL，也不会改动已有数据。

### 三、卸载

```bash
bash ~/apps/stkj/deploy/stkj.sh uninstall                    # 只摘服务，代码和数据都保留（可随时重装）
bash ~/apps/stkj/deploy/stkj.sh uninstall --purge            # 连代码和数据一起删；删前自动备份数据库
bash ~/apps/stkj/deploy/stkj.sh uninstall --purge-all        # 删除整个安装目录
bash ~/apps/stkj/deploy/stkj.sh uninstall --purge --dry-run  # 先看看会做什么，不真删
```

- 加 `--yes` 跳过确认提示
- `--purge` / `--purge-all` 会先把 `data/` 和 `backups/` 备份到 `~/apps/stkj-uninstall-backup-<时间戳>/`
- Node.js 运行时（`~/apps/node-*`）不会被删，确认不用了可手动 `rm -rf ~/apps/node-*`

### 四、查看状态

```bash
bash ~/apps/stkj/deploy/stkj.sh status
```

输出：代码版本、服务状态与开机自启、监听端口、首页 HTTP 码、项目/数据/账号数量、最近备份、备份份数、磁盘占用。

### 常见问题

**1）`git clone` 报 `Permission denied (publickey)`**

服务器公钥没加到 GitHub，按上面「第一次安装前」第 2 步加 Deploy Key。

**2）升级报 `Not possible to fast-forward` 或 `diverged`**

服务器上的代码被手工改过。确认不需要这些改动后（**只影响代码，不动 `data/`**）：

```bash
cd ~/apps/stkj
git fetch origin
git reset --hard origin/main
systemctl --user restart stkj.service
```

**3）服务起不来**

```bash
systemctl --user status stkj.service --no-pager
journalctl --user -u stkj.service -n 100 --no-pager
tail -n 50 ~/apps/stkj/logs/app.log
```

**4）想回退到上一个版本**

```bash
cd ~/apps/stkj
git log --oneline -10                 # 找到升级前的 commit
git reset --hard <升级前的 commit>
systemctl --user restart stkj.service
```

如果新版本已经改过数据库结构、回退后启动异常，再把数据库也退回去（`data/` 里三个文件要一起换）：

```bash
systemctl --user stop stkj.service
rm -f ~/apps/stkj/data/app.db ~/apps/stkj/data/app.db-shm ~/apps/stkj/data/app.db-wal
cp ~/apps/stkj/backups/app-<时间戳>.db ~/apps/stkj/data/app.db
systemctl --user start stkj.service
```

### 附：升级 Node.js 版本

```bash
bash ~/apps/stkj/deploy/stkj.sh install --node-version=v22.23.3
```

会自动下载新版本、改写服务单元并重启；数据库不受影响。

### 附：手动查看服务与日志

```bash
systemctl --user status stkj.service --no-pager    # 服务状态
ss -tlnp | grep 5173                               # 端口监听
systemctl --user list-timers stkj-backup.timer     # 下次备份时间
ls -lh ~/apps/stkj/backups | tail -5               # 最近的备份文件
```

## 已知限制

- 会话持久化在数据库 `sessions` 表中，重启服务**不会**导致用户掉线；连续 7 天不活跃才失效
- Excel **仅支持 .xlsx**（Excel 2007 及以上）。旧版 `.xls` 或 `.csv` 请先用 Excel / WPS 另存为 `.xlsx` 再导入
- 导入只读取工作簿中的**第一个工作表**
- 单次上传上限 20 MB、单个工作表解压后上限 32 MB，超出会提示拆分
- 用户导入创建的账号**初始密码即账号本身**，无法在 Excel 中指定密码；如需自定义密码请导入后「重置密码」或让用户自助修改
- 单进程部署，适用于中小规模使用
- **每日自动备份**：服务器上通过 systemd user 定时器（`deploy/stkj-backup.timer`）每天 03:00 用 `VACUUM INTO` 生成在线一致性快照到 `~/apps/stkj/backups/`，默认保留最近 14 份（`backup.cjs --keep N` 可调），不影响运行中的服务

---

## 版权与许可

**Copyright © 2026 作者个人. All Rights Reserved.**

本软件（含源代码、文档、界面设计及相关素材，以下统称「本作品」）为**个人私有作品**，著作权归作者个人所有。本作品受《中华人民共和国著作权法》及适用国际著作权公约保护。

### 授权范围

| 使用情形 | 是否允许 | 说明 |
|---|:---:|---|
| 个人学习、研究、自行部署使用 | ✅ 无需申请 | 可自行部署于自有环境 |
| 公司/单位内部自用（非营利性质） | ⚠️ 需告知作者 | 建议书面告知使用范围与人数 |
| 二次开发、修改、衍生作品 | ⚠️ 需取得许可 | 不得删除或隐藏版权声明 |
| **任何商业用途** | ❌ **须事先取得作者书面许可** | 详见下方定义 |
| 转售、租赁、按次收费、SaaS 对外提供服务 | ❌ **须事先取得作者书面许可** | 包括但不限于云托管、代运维收费 |
| 去除、篡改、隐藏版权标识后分发 | ❌ 禁止 | 违反即构成侵权 |

**「商业用途」包括但不限于**：将本作品或其衍生作品用于生产经营、对外提供收费服务、作为产品的一部分销售、嵌入商业软件交付客户、以本作品为基础承接付费项目、用于引流变现等直接或间接获取经济利益的行为。

### 商业授权申请

需商业授权时，请通过项目仓库（`git@github.com:dakerclaw/stkjinfo.git`）提交 Issue 或直接联系作者(stkjinfo@hehudieyiqi.com)，说明：

1. 使用主体（个人 / 公司名称）
2. 使用场景与部署规模
3. 是否涉及二次开发与对外分发

获得书面许可后，按许可协议约定的范围使用；未获许可前，请勿将本作品用于任何商业目的。

### 免责声明

本作品按「现状」提供，不附带任何明示或暗示的担保，包括但不限于对适销性、特定用途适用性及不侵权的担保。在任何情况下，作者均不对因使用本作品而产生的任何直接、间接、偶然、特殊或后果性损害承担责任。**使用者应自行评估并承担数据安全、备份及合规责任**，生产环境使用前请务必做好数据备份。

### 第三方组件

本作品**不依赖任何第三方运行时库**（零 npm 依赖），后端仅使用 Node.js 标准库。Node.js 本身遵循其 MIT 许可证，与本作品的授权相互独立。

