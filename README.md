# 项目管理应用

基于 Node.js + SQLite 的本地 Web 应用，用于管理项目库与项目检测/生产数据。
**零第三方依赖**，使用 Node.js 内置的 `node:sqlite` 与 `node:http`。

## 快速开始

双击 `start.bat`（首次自动初始化数据库并打开浏览器），或在终端执行：

```bash
npm start          # 启动服务，访问 http://127.0.0.1:5173
```

要求 Node.js >= 22.5（内置 SQLite 模块）。

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

- 账号 + 密码登录，会话存于服务端内存（12 小时，`HttpOnly` Cookie），关闭服务需重新登录
- 账号不存在与密码错误返回同一提示，避免账号枚举
- **新增用户时密码默认为账号**；不填密码即使用该默认值，用户列表以「初始密码」标记
- 管理员可「重置密码」为账号本身；用户可在右上角菜单自行修改密码
- 防暴力猜解：同一账号连续 5 次密码错误即锁定 5 分钟，期间提示剩余等待时间

## 数据库

文件：`data/app.db`（WAL 模式）。三张表：

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

指标字段（共 45 个字段，其中数值型可为空表示未检测）：

- **粒度**：dx0、dx1、dx10、dx50、dx90、dx99、dx100、k_value
- **物性**：tap_density 振实密度、true_density 真密度、ssa_domestic 比表-国产、ssa_mic 比表-麦克、graphitization 石墨化度、magnetic 磁性物质、ph_value、oversize 筛上物、oil_absorption 吸油值、hgi 哈氏可磨指数
- **电化学**：capacity 容量、lithium_inter 嵌锂容量、lithium_deint 脱锂容量、first_eff 首次效率
- **粉压 5 点法**：press_0_5t、press_1t、press_1_5t、press_2t、press_5t
- **工业分析**：moisture_fp 成品水分、ash 灰分、volatile 挥发分、moisture 水分、sulfur 硫分、caking_index 黏结指数、coking_value 结焦值
- **生产**：efficiency 效率、yield_rate 收率、quantity 生产数量、entry_date 录入日期、remark 备注

筛选维度：**项目编号、产品代码、所属公司、工序、工单号、焦种**，另支持关键词与录入日期区间。

归属字段：`created_by`（录入人账号）、`created_by_id`（录入人 id）、`updated_by`（最后修改人）。
普通用户的可见范围即 `created_by_id = 当前用户`；管理员不受限。

> 录入时只需选择**项目编号**，产品代码自动按项目档案带出并锁定，避免两者不一致；项目编号必须已存在。

## 功能

- **总览**：项目/数据统计、项目类型与所属公司分布、最近录入
- **项目列表**：多条件筛选、列排序、增删改、跳转查看关联数据、Excel 导出
- **项目数据**：45 字段宽表、列排序、分页、勾选批量删除、Excel 导入（支持中文表头）、Excel 导出
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

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/login | 登录 `{username,password}`，成功后下发 HttpOnly Cookie |
| POST | /api/auth/logout | 注销，清除会话 |
| GET | /api/auth/me | 当前登录用户 |
| POST | /api/auth/password | 自助修改密码 `{old_password,new_password}` |
| GET | /api/meta | 字段定义、筛选下拉、角色列表、当前用户权限位 |
| GET | /api/stats | 总览统计（普通用户仅统计自己的数据） |
| GET/POST | /api/projects | 项目列表（全员）/ 新建（管理员） |
| GET/PUT/DELETE | /api/projects/:id | 项目详情 / 更新（管理员）/ 删除（管理员，级联删数据） |
| GET/POST | /api/data | 数据列表（分页，普通用户仅自己的）/ 新建（五项重复时 409） |
| GET/PUT/DELETE | /api/data/:id | 详情 / 更新（本人或管理员）/ 删除（管理员） |
| POST | /api/data/bulk-delete | 批量删除 `{ids:[]}`（管理员） |
| POST | /api/data/import | JSON 导入 `{rows:[], duplicate_action?}`，允许部分字段；返回留空字段清单 |
| GET | /api/data/export | 导出检测数据为 Excel（按当前筛选条件） |
| GET | /api/data/template | 下载导入模板 Excel，`?fields=a,b,c` 可只含指定字段 |
| POST | /api/data/import-file | 上传 .xlsx 二进制，服务端解析并返回预览与批次 `token` |
| POST | /api/data/import-confirm | 按 `token` 确认导入 `{token, duplicate_action?}` |
| GET | /api/projects/export | 导出项目档案为 Excel |
| GET/POST | /api/users | 用户列表 / 新建（管理员；创建管理员仅系统管理员） |
| PUT/DELETE | /api/users/:id | 更新 / 删除（管理员；管理员账号仅系统管理员可操作） |

除 `/api/auth/login`、`/api/auth/logout` 外，所有接口均需登录，未登录返回 401。
权限不足返回 403，响应体 `{success:false, message}`；数据重复返回 409，`code` 为 `DUPLICATE_KEY`。

## 目录结构

```
server.js          后端服务与 API
db.js              建表语句与字段定义（前后端共用字段元数据）
xlsx.js            极简 XLSX 读写（零第三方依赖：手写 ZIP + XML）
import-map.js      导入表头识别（中文列名 / 字段名 / 别名 → 字段 key）
seed.js            初始化账号与示例数据
public/index.html  页面骨架
public/styles.css  样式
public/app.js      前端逻辑（视图渲染、筛选、表单、Excel 导入导出）
data/app.db        SQLite 数据库文件
```

## 已知限制

- 会话保存在服务端内存，**重启服务后所有用户需重新登录**
- Excel **仅支持 .xlsx**（Excel 2007 及以上）。旧版 `.xls` 或 `.csv` 请先用 Excel / WPS 另存为 `.xlsx` 再导入
- 导入只读取工作簿中的**第一个工作表**
- 单进程部署，适用于本地或内网小规模使用；如需多实例可把会话改存数据库
