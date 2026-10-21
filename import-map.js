'use strict';
/**
 * 导入表头识别：把 Excel 表头（中文列名 / 字段名 / 常见写法）映射到字段 key。
 * 之前这套逻辑放在前端，改为服务端解析 Excel 后统一在此处理。
 */
const { FIELDS } = require('./db');

/** 用户导入使用的字段集合（不含 password，密码单独按需处理） */
const USER_IMPORT_FIELDS = [
  { key: 'username', label: '账号', type: 'text' },
  { key: 'real_name', label: '姓名', type: 'text' },
  { key: 'role', label: '角色', type: 'text' },
  { key: 'status', label: '状态', type: 'text' },
  { key: 'remark', label: '备注', type: 'text' },
];

/** 空值判定：与后端 normalizeImportValue 的 BLANK_RE 保持一致 */
const BLANK_RE = /^(|\s*|-{1,2}|\/|—|n\/?a|null|nan|无|未检|未检测|未测|待检)$/i;
const isBlank = (v) => BLANK_RE.test(String(v === null || v === undefined ? '' : v).trim());

/** 列名归一化：去空白、去括号及单位、统一小写，容错「振实密度(g/cm3)」「Dx（50）」等写法 */
function normHeader(h) {
  let s = String(h || '')
    // 只转换全角标点，避免 ³、² 等字符被改写
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    // 去括号及括号内内容，仅当内容含「单位/字母/符号」时；纯数字括号（Dx(50)）保留
    .replace(/[(\[{【](?=[^)\]}】]*[a-zA-Zµμ%\/])[^)\]}】]*[)\]}】]/g, '')
    .replace(/\s+/g, '')
    .replace(/[·•\-_]/g, '')
    .replace(/[()（）\uFF08\uFF09]/g, '')
    .toLowerCase();
  // 去掉末尾游离的单位片段，如 振实密度g/cm3、容量mah/g、效率%、收率%
  s = s.replace(/(g\/cm3|g\/cm2|mah\/g|m2\/g|g\/ml|cm3\/g|μm|um|nm|%)+$/g, '');
  // 注意：不可去掉末尾数字，Dx(50) 的 50 是粒径标识
  return s;
}

/** 建立「列名 → 字段 key」映射表 */
function buildHeaderMap(fields = FIELDS) {
  const map = new Map();
  for (const f of fields) {
    map.set(normHeader(f.label), f.key);
    map.set(normHeader(f.key), f.key);
    // Dx(n) 精确形式额外登记：dx50 / DX(50) / dx_50
    const m = /^dx(\d+)$/.exec(f.key);
    if (m) {
      const n = m[1];
      map.set('dx' + n, f.key);
      map.set('dx(' + n + ')', f.key);
      map.set('dx（' + n + '）', f.key);
      map.set('d' + n, f.key); // D50 简写
    }
  }
  // 常见写法别名
  const alias = {
    项目编号: ['项目号', '编号', '项目编码'],
    产品代码: ['产品编码', '产品编号', '物料代码', '产品'],
    项目类型: ['类型', '项目类别', '类别'],
    项目简介: ['简介', '描述', '项目说明', '说明'],
    状态: ['项目状态'],
    所属公司: ['所属公司', '公司'],
    工序: ['工序'],
    工单号: ['工单号'],
    焦种: ['焦种', '焦炭种类', '焦类型'],
    振实密度: ['振实'],
    比表国产: ['比表面积国产', '国产比表', 'bet国产'],
    比表麦克: ['比表面积麦克', '麦克比表', 'bet麦克'],
    石墨化度: ['石墨化'],
    首次效率: ['首效', '首效率'],
    磁性物质: ['磁性物', '磁性异物'],
    ph值: ['ph'],
    真密度: ['真比重'],
    筛上物: ['筛余'],
    成品水分: ['成品水份'],
    水分: ['水份'],
    硫分: ['硫份', '全硫'],
    黏结指数: ['粘结指数', 'g值'],
    吸油值: ['吸油量', '吸油率'],
    结焦值: ['结焦'],
    哈氏可磨指数: ['可磨指数', 'hgi'],
    生产数量: ['数量', '产量'],
    录入日期: ['日期', '检测日期'],
    备注: ['说明', '备注信息'],
    // 用户导入
    账号: ['用户名', '登录名', '登录账号', '用户名账号'],
    姓名: ['真实姓名', '名字', '员工姓名'],
    角色: ['用户角色', '权限', '身份'],
    状态: ['用户状态'],
    初始密码: ['密码', '登录密码'],
  };
  for (const [label, list] of Object.entries(alias)) {
    const key = map.get(normHeader(label));
    if (!key) continue;
    for (const a of list) if (!map.has(normHeader(a))) map.set(normHeader(a), key);
  }
  return map;
}

/**
 * 把一行「表头 → 单元格值」对象按映射表转成「字段 key → 值」，空值跳过。
 * 返回 { out, skipped }，skipped 为该行被忽略的列名。
 */
function mapImportRow(raw, headerMap) {
  const out = {};
  const skipped = [];
  for (const [col, val] of Object.entries(raw)) {
    const key = headerMap.get(normHeader(col));
    if (!key) continue;
    if (isBlank(val)) continue;
    out[key] = val;
  }
  return { out, skipped };
}

module.exports = { normHeader, buildHeaderMap, isBlank, BLANK_RE, USER_IMPORT_FIELDS };
