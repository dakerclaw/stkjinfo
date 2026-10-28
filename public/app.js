'use strict';
/* ============================================================
   项目管理应用 - 前端逻辑
   ============================================================ */

const API = {
  async req(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    // 会话失效：回到登录页
    if (res.status === 401 && !url.startsWith('/api/auth/login')) {
      showLogin('登录已失效，请重新登录');
      throw new Error(data.message || '未登录');
    }
    if (!res.ok || data.success === false) {
      const err = new Error(data.message || `请求失败 (${res.status})`);
      err.status = res.status;
      err.code = data.code;
      err.payload = data;
      throw err;
    }
    return data;
  },
  /** 上传二进制内容（Excel 文件） */
  async postRaw(url, arrayBuffer) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: arrayBuffer,
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (res.status === 401) {
      showLogin('登录已失效，请重新登录');
      throw new Error(data.message || '未登录');
    }
    if (!res.ok || data.success === false) {
      const err = new Error(data.message || `请求失败 (${res.status})`);
      err.status = res.status;
      err.code = data.code;
      err.payload = data;
      throw err;
    }
    return data;
  },
  get: (u) => API.req('GET', u),
  post: (u, b) => API.req('POST', u, b || {}),
  put: (u, b) => API.req('PUT', u, b),
  del: (u) => API.req('DELETE', u),
};

/* ------------------------------------------------------------ 全局状态 */
const state = {
  view: 'dashboard',
  user: null,
  meta: null,
  projects: { filters: {}, sort: '', dir: 'asc', selected: new Set(), onlySelected: false, rows: [] },
  data: { filters: {}, sort: '', dir: 'asc', page: 1, pageSize: 20, selected: new Set(), facets: null, facetsSeq: 0 },
  users: { rows: [] },
  audit: { filters: {}, page: 1, pageSize: 50 },
};

/** 权限判断（与后端 meta.permissions 保持一致） */
const can = () => (state.meta && state.meta.permissions) || {};
const canManageProjects = () => !!can().canManageProjects;
const canDeleteData = () => !!can().canDeleteData;
const canManageUsers = () => !!can().canManageUsers;
const canManageAdmins = () => !!can().canManageAdmins;
const canViewAudit = () => !!can().canViewAudit;
const canManageDatabase = () => !!can().canManageDatabase;
const seeAllData = () => !!can().seeAllData;

const el = (sel) => document.querySelector(sel);
const content = () => el('#content');
const actions = () => el('#topbarActions');

/* ------------------------------------------------------------ 工具 */
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(v, digits) {
  if (v === null || v === undefined || v === '') return '<span class="empty-num">—</span>';
  const n = Number(v);
  if (!Number.isFinite(n)) return esc(v);
  if (digits != null) return n.toFixed(digits);
  const s = Math.abs(n) >= 1000 ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(Number(n.toPrecision(8)));
  return s;
}
function toast(msg, type = '') {
  const root = el('#toastRoot');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, 2400);
}
function typeClass(t) {
  const s = String(t || '');
  if (/锂|负极|石墨|正极|材料/.test(s)) return '';
  if (/中试|试验|研发/.test(s)) return 'green';
  if (/量产|生产|工业/.test(s)) return 'amber';
  return 'gray';
}
function debounce(fn, ms = 260) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ------------------------------------------------------------ 导航 */
const VIEWS = {
  dashboard: { title: '总览', sub: '项目库与检测数据概览', render: renderDashboard },
  projects: { title: '项目列表', sub: '按项目编号、产品代码、项目类型、状态筛选项目', render: renderProjects },
  data: { title: '项目数据', sub: '按项目编号、产品代码、所属公司、工序、工单号、焦种筛选', render: renderData },
  users: { title: '用户管理', sub: '系统账号与权限信息', render: renderUsers },
  recycle: { title: '回收站', sub: '已删除的项目与数据，30 天内可恢复，超期自动清除', render: renderRecycle },
  audit: { title: '审计日志', sub: '记录项目、数据与账号的新增 / 修改 / 删除 / 导入操作，保留 180 天', render: renderAudit },
  database: { title: '数据库维护', sub: '导出、导入数据库与手动备份（仅系统管理员）', render: renderDatabase },
};

function navigate(view) {
  // 元数据还没就绪（例如会话失效后刷新）时不渲染，避免读空 meta 报错
  if (!state.meta) return;
  const def = VIEWS[view];
  // 浏览器 / CDN 缓存了旧版 app.js 时，新页面里的新导航会点不开：给出明确提示而不是静默失败
  if (!def) {
    state.view = view;
    el('#viewTitle').textContent = '页面需要刷新';
    el('#viewSub').textContent = '当前前端脚本是旧版本';
    actions().innerHTML = '';
    content().innerHTML = `<div class="card"><div class="card-body" style="text-align:center;padding:40px 0">
      <p style="margin:0 0 6px;color:var(--danger);font-weight:600">当前页面使用的是旧版前端脚本</p>
      <p style="margin:0 0 14px;color:var(--text-3);font-size:13px">系统刚更新过，浏览器或 CDN 还留着旧文件，刷新一次即可</p>
      <button class="btn btn-primary" onclick="location.reload()">刷新页面</button>
    </div></div>`;
    return;
  }
  state.view = view;
  // 数据页改为「只有表格内部滚动」，避免整页再出现一条滚动条
  content().classList.toggle('fit', view === 'data');
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  el('#viewTitle').textContent = def.title;
  el('#viewSub').textContent = def.sub;
  actions().innerHTML = '';
  // 各视图的 render 都是 async：统一兜住异常，避免接口失败后页面停在骨架屏
  try {
    const r = def.render();
    if (r && typeof r.catch === 'function') r.catch(showViewError);
  } catch (e) {
    showViewError(e);
  }
}

/** 视图加载失败：给出可重试的提示 */
function showViewError(e) {
  const msg = (e && e.message) || '加载失败';
  content().innerHTML = `<div class="card"><div class="card-body" style="text-align:center;padding:40px 0">
    <p style="margin:0 0 6px;color:var(--danger);font-weight:600">${esc(msg)}</p>
    <p style="margin:0 0 14px;color:var(--text-3);font-size:13px">请检查网络或稍后重试</p>
    <button class="btn" onclick="navigate('${state.view}')">重新加载</button>
  </div></div>`;
}

/* ============================================================
   总览
   ============================================================ */
async function renderDashboard() {
  content().innerHTML = `<div class="stat-grid">${'<div class="stat"><div class="skeleton" style="height:60px"></div></div>'.repeat(4)}</div>`;
  const { stats } = await API.get('/api/stats');
  // 兼容旧版接口：缺失的分布字段按空处理，避免整页渲染失败
  const byProduct = stats.byProduct || [];
  const byDate = stats.byDate || [];
  const byStatus = stats.byStatus || [];

  const maxType = Math.max(1, ...stats.byType.map((r) => r.value));
  const maxProduct = Math.max(1, ...byProduct.map((r) => r.value));
  const dates = byDate.slice(0, 10);
  const maxDate = Math.max(1, ...dates.map((r) => r.value));
  const maxStatus = Math.max(1, ...byStatus.map((r) => r.value));

  content().innerHTML = `
    <div class="stat-grid">
      ${statCard('项目总数', stats.projectCount, '个', '项目库中登记的项目')}
      ${statCard('项目数据记录', stats.dataCount, '条', '所有检测/生产数据')}
    </div>
    <div class="grid-4">
      <div class="col-stack">
        <div class="card">
          <div class="card-head"><h3>项目状态分布</h3></div>
          <div class="card-body">
            <div class="bar-list rows-3">${stats.byStatus.map((r) => barItem(r.name, r.value, maxStatus, r.status === 1 ? '' : 'muted')).join('')}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>项目类型分布</h3></div>
          <div class="card-body">
            ${stats.byType.length ? `<div class="bar-list rows-3">${stats.byType.map((r) => barItem(r.name, r.value, maxType)).join('')}</div>`
              : `<div class="empty" style="padding:24px"><p>暂无项目</p></div>`}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>产品代码数据分布</h3></div>
        <div class="card-body">
          ${stats.byProduct.length ? `<div class="bar-list rows-10">${stats.byProduct.map((r) => barItem(r.name, r.value, maxProduct)).join('')}</div>`
            : `<div class="empty" style="padding:24px"><p>暂无数据记录</p></div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>统计日期数据分布</h3>${stats.byDate.length > dates.length ? `<span class="meta">近 ${dates.length} 个日期</span>` : ''}</div>
        <div class="card-body">
          ${dates.length ? `<div class="bar-list rows-10">${dates.map((r) => barItem(r.name, r.value, maxDate)).join('')}</div>`
            : `<div class="empty" style="padding:24px"><p>暂无数据记录</p></div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>最近录入的数据</h3><button class="btn btn-sm btn-ghost" onclick="navigate('data')">查看全部 →</button></div>
        <div class="card-body">
          ${stats.recent.length
            ? `<div class="recent-list rows-10">
              ${stats.recent.map((r) => `
                <div class="recent-item">
                  <div class="recent-main">
                    <span class="code-chip">${esc(r.project_no)}</span>
                    <span class="recent-code">${esc(r.product_code)}</span>
                    ${r.work_order ? `<span class="meta recent-wo">工单 ${esc(r.work_order)}</span>` : ''}
                  </div>
                  <div class="meta recent-side">${esc(r.entry_date || '')} · ${fmtNum(r.quantity)}</div>
                </div>`).join('')}
            </div>`
            : `<div class="empty" style="padding:32px"><p>暂无数据记录</p><span>前往「项目数据」新增第一条记录</span></div>`}
        </div>
      </div>
    </div>`;
}
function statCard(label, val, unit, hint) {
  return `<div class="stat"><label>${label}</label><div class="val">${val}${unit ? `<small>${unit}</small>` : ''}</div><div class="hint">${esc(hint)}</div></div>`;
}
function barItem(name, value, max, tone = '') {
  return `<div class="bar-item">
    <div class="bar-label"><span>${esc(name)}</span><b>${value}</b></div>
    <div class="bar-track"><div class="bar-fill ${tone}" style="width:${(value / max) * 100}%"></div></div>
  </div>`;
}

/* ============================================================
   项目列表
   ============================================================ */
async function renderProjects() {
  const f = state.projects.filters;
  actions().innerHTML = '';

  content().innerHTML = `
    <div class="filters">
      <div class="filter-row">
        <div class="field w-160"><label>项目编号</label>
          <select class="select" id="fPno"><option value="">全部</option>${(state.meta.options.projectNos || []).map((v) => `<option ${f.project_no === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-160"><label>产品代码</label>
          <select class="select" id="fPc"><option value="">全部</option>${(state.meta.options.productCodes || []).map((v) => `<option ${f.product_code === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-140"><label>项目类型</label>
          <select class="select" id="fType"><option value="">全部</option>${(state.meta.options.types || []).map((v) => `<option ${f.project_type === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-120"><label>状态</label>
          <select class="select" id="fStatus">
            <option value="">全部</option>
            <option value="1" ${f.status === '1' ? 'selected' : ''}>进行中</option>
            <option value="0" ${f.status === '0' ? 'selected' : ''}>已归档</option>
          </select>
        </div>
        <div class="field w-220"><label>关键词</label>
          <input class="input" id="fKw" placeholder="搜索编号/代码/简介" value="${esc(f.q || '')}" />
        </div>
        <div class="filter-actions">
          <button class="btn btn-ghost" onclick="clearProjectFilters()">重置</button>
        </div>
      </div>
    </div>
    <div class="toolbar" id="projToolbar">
      ${canManageProjects() ? `<button class="btn btn-primary" onclick="openProjectModal()">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新增项目
      </button>
      <button class="btn" onclick="openProjectImport()">导入 Excel</button>` : ''}
      <button class="btn" onclick="exportProjects()">导出 Excel</button>
      ${canManageProjects() ? `
      <span class="toolbar-sep"></span>
      <button class="btn btn-sm" id="bulkStOn" style="display:none" onclick="bulkProjectStatus(1)">设为进行中 (<span id="selStOn">0</span>)</button>
      <button class="btn btn-sm" id="bulkStOff" style="display:none" onclick="bulkProjectStatus(0)">设为已归档 (<span id="selStOff">0</span>)</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-2);cursor:pointer">
        <input type="checkbox" id="onlySelP" style="accent-color:var(--primary)" ${state.projects.onlySelected ? 'checked' : ''}/> 仅显示已选
      </label>
      <button class="btn btn-sm btn-danger" id="bulkDelP" style="display:none" onclick="bulkDeleteProjects()">删除选中 (<span id="selDelP">0</span>)</button>` : ''}
    </div>
    <div class="card"><div id="projectTable"><div class="card-body"><div class="skeleton" style="height:200px"></div></div></div></div>`;

  const bind = () => {
    const applyFilters = () => {
      collectProjectFilters();
      // 条件变化后，旧勾选可能已不在结果里：不清空会让「删除选中」误伤当前不可见的行
      clearProjectSelection();
      loadProjects();
    };
    const run = debounce(applyFilters, 220);
    ['fPno', 'fPc', 'fType', 'fStatus'].forEach((id) => el('#' + id).addEventListener('change', applyFilters));
    el('#fKw').addEventListener('input', run);
  };
  bind();
  loadProjects();
}

function collectProjectFilters() {
  state.projects.filters = {
    project_no: el('#fPno').value,
    product_code: el('#fPc').value,
    project_type: el('#fType').value,
    status: el('#fStatus').value,
    q: el('#fKw').value.trim(),
  };
}
function clearProjectFilters() {
  state.projects.filters = {};
  state.projects.sort = '';
  renderProjects();
}

async function loadProjects() {
  const f = state.projects.filters;
  const qs = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => { if (v) qs.set(k, v); });
  if (state.projects.sort) { qs.set('sort', state.projects.sort); qs.set('dir', state.projects.dir); }
  const { rows: allRows, total } = await API.get('/api/projects?' + qs.toString());
  // 仅显示已选：客户端过滤当前勾选的项目
  const rows = state.projects.onlySelected && state.projects.selected.size
    ? allRows.filter((r) => state.projects.selected.has(r.id))
    : allRows;
  state.projects.rows = allRows;

  const box = el('#projectTable');
  if (!rows.length) {
    box.innerHTML = `<div class="empty">
      <div class="ico"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>
      <p>没有符合条件的项目</p><span>调整筛选条件，或新增一个项目</span></div>`;
    return;
  }
  const cols = [
    ['project_no', '项目编号'], ['product_code', '产品代码'], ['project_type', '项目类型'],
    ['description', '项目简介'], ['data_count', '数据条数'], ['last_entry', '最近录入'], ['status', '状态'], ['act', '操作'],
  ];
  // 可排序列：编号 / 产品代码 / 数据条数 / 最近录入 / 状态
  const SORTABLE = new Set(['project_no', 'product_code', 'data_count', 'last_entry', 'status']);
  const sorted = state.projects.sort;
  // 管理员可见勾选列，用于批量修改状态
  const showChk = canManageProjects();
  box.innerHTML = `
    <div class="table-wrap" style="max-height:calc(100vh - 385px)">
      <table class="data-table">
        <thead><tr>
          ${showChk ? '<th style="width:40px"><input type="checkbox" id="checkAllP" style="accent-color:var(--primary)" /></th>' : ''}
          ${cols.map(([k, label]) => SORTABLE.has(k)
            ? `<th class="sortable ${sorted === k ? 'sorted' : ''}" data-sort="${k}" title="点击切换升序 / 降序">${label}<span class="arrow">${sorted === k ? (state.projects.dir === 'asc' ? '▲' : '▼') : '↕'}</span></th>`
            : `<th>${label}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            ${showChk ? `<td><input type="checkbox" class="rowChkP" data-id="${r.id}" style="accent-color:var(--primary)" ${state.projects.selected.has(r.id) ? 'checked' : ''} /></td>` : ''}
            <td class="col-sticky"><span class="code-chip">${esc(r.project_no)}</span></td>
            <td>${esc(r.product_code)}</td>
            <td><span class="type-tag ${typeClass(r.project_type)}">${esc(r.project_type)}</span></td>
            <td class="wrap dim">${esc(r.description || '')}</td>
            <td class="num">${r.data_count ? `<a href="javascript:;" data-goto-pno="${esc(r.project_no)}" style="color:var(--primary);text-decoration:none;font-weight:550">${r.data_count}</a>` : '<span class="empty-num">0</span>'}</td>
            <td class="dim">${esc(r.last_entry || '—')}</td>
            <td><span class="status-tag ${r.status ? 'on' : 'off'}">${r.status ? '进行中' : '已归档'}</span></td>
            <td>
              <div class="row-actions">
                <button class="btn btn-sm btn-ghost" data-goto-pno="${esc(r.project_no)}">查看数据</button>
                ${canManageProjects()
                  ? `<button class="btn btn-sm btn-ghost" onclick="openProjectModal(${r.id})">编辑</button>`
                  : ''}
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="pagination"><span>共 <b>${total}</b> 个项目</span></div>`;

  // 勾选（批量操作用）
  box.querySelectorAll('.rowChkP').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      cb.checked ? state.projects.selected.add(id) : state.projects.selected.delete(id);
      updateProjSelCount();
    });
  });
  el('#checkAllP')?.addEventListener('change', (e) => {
    box.querySelectorAll('.rowChkP').forEach((cb) => {
      cb.checked = e.target.checked;
      const id = Number(cb.dataset.id);
      e.target.checked ? state.projects.selected.add(id) : state.projects.selected.delete(id);
    });
    updateProjSelCount();
  });
  el('#onlySelP')?.addEventListener('change', (e) => {
    state.projects.onlySelected = e.target.checked;
    loadProjects();
  });
  updateProjSelCount();

  box.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.projects.sort === k) {
        state.projects.dir = state.projects.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.projects.sort = k;
        // 文本列首次点击按升序（A→Z、编号从小到大），数值/日期列按降序（多的、近的在前）
        state.projects.dir = /^(project_no|product_code)$/.test(k) ? 'asc' : 'desc';
      }
      loadProjects();
    });
  });
}

/** 从项目列表跳到「项目数据」，并按该项目编号筛选 */
function gotoDataForProject(pno) {
  // 只保留项目编号条件，避免上一次的其它筛选把结果过滤空
  state.data.filters = { project_no: pno };
  state.data.page = 1;
  state.data.selected.clear();
  state.data.onlySelected = false;
  navigate('data');
}

/**
 * 列表里的项目编号 / 回收站「彻底删除」通过 data-* 传参，由事件委托统一处理。
 * 之前写成 onclick="fn('${esc(x)}')"：esc() 只做 HTML 转义，浏览器会先把实体还原、
 * 再交给 JS 解析，单引号可以逃逸出字符串执行任意代码（存储型 XSS）。
 */
document.addEventListener('click', (e) => {
  const gotoBtn = e.target.closest('[data-goto-pno]');
  if (gotoBtn) {
    e.preventDefault();
    gotoDataForProject(gotoBtn.dataset.gotoPno);
    return;
  }
  const purgeBtn = e.target.closest('[data-purge-entity]');
  if (purgeBtn) {
    e.preventDefault();
    confirmRecyclePurge(
      purgeBtn.dataset.purgeEntity,
      Number(purgeBtn.dataset.purgeId),
      purgeBtn.dataset.purgeLabel,
      Number(purgeBtn.dataset.purgeCount) || 0
    );
  }
});

/** 更新批量状态/删除按钮的可见性与计数 */
function updateProjSelCount() {
  const n = state.projects.selected.size;
  for (const [btn, cnt] of [['#bulkStOn', '#selStOn'], ['#bulkStOff', '#selStOff'], ['#bulkDelP', '#selDelP']]) {
    const b = el(btn); const c = el(cnt);
    if (c) c.textContent = n;
    if (b) b.style.display = n ? 'inline-flex' : 'none';
  }
}

function clearProjectSelection() {
  state.projects.selected.clear();
  updateProjSelCount();
  // 同步表格里的勾选框（若已渲染）
  document.querySelectorAll('.rowChkP').forEach((cb) => { cb.checked = false; });
  const all = el('#checkAllP');
  if (all) all.checked = false;
}

/** 批量修改所选项目状态 */
function bulkProjectStatus(status) {
  const ids = [...state.projects.selected];
  if (!ids.length || !canManageProjects()) return;
  const label = status ? '进行中' : '已归档';
  openModal({
    title: '批量修改状态', narrow: true,
    body: `<p style="margin:0;color:var(--text-2)">确定把选中的 <b>${ids.length}</b> 个项目状态批量改为「<b>${label}</b>」吗？</p>`,
    footer: `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" id="okBulkSt">确认修改</button>`,
  });
  el('#okBulkSt').addEventListener('click', async () => {
    try {
      const r = await API.post('/api/projects/batch-status', { ids, status });
      clearProjectSelection();
      closeModal();
      toast(`已将 ${r.updated} 个项目设为${label}`, 'ok');
      loadProjects();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/** 批量删除所选项目（级联删除其下数据记录） */
function bulkDeleteProjects() {
  const ids = [...state.projects.selected];
  if (!ids.length || !canManageProjects()) return;
  // 用当前列表数据估算将被级联删除的数据条数
  const dataCount = state.projects.rows
    .filter((r) => state.projects.selected.has(r.id))
    .reduce((a, r) => a + (r.data_count || 0), 0);
  openModal({
    title: '批量删除项目', narrow: true,
    body: `<p style="margin:0 0 8px;color:var(--text-2)">确定删除选中的 <b>${ids.length}</b> 个项目吗？</p>
      ${dataCount ? `<p style="margin:0;color:var(--danger);font-size:13px">这些项目下共有 <b>${dataCount}</b> 条数据记录，删除项目会同时删除这些记录，此操作不可恢复。</p>`
        : `<p style="margin:0;color:var(--text-3);font-size:13px">所选项目暂无数据记录。</p>`}`,
    footer: `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-danger" id="okBulkDelP">确认删除</button>`,
  });
  el('#okBulkDelP').addEventListener('click', async () => {
    try {
      const r = await API.post('/api/projects/bulk-delete', { ids });
      clearProjectSelection();
      closeModal();
      toast(`已删除 ${r.removed} 个项目${r.removedData ? `及其 ${r.removedData} 条数据` : ''}`, 'ok');
      loadProjects();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function exportProjects() {
  const f = state.projects.filters;
  const qs = new URLSearchParams();
  // 已勾选时优先只导出勾选的项目；否则按当前筛选 + 排序导出
  if (state.projects.selected.size) {
    qs.set('ids', [...state.projects.selected].join(','));
    downloadFile('/api/projects/export?' + qs.toString());
    toast(`已导出选中的 ${state.projects.selected.size} 个项目`, 'ok');
    return;
  }
  Object.entries(f).forEach(([k, v]) => { if (v) qs.set(k, v); });
  // 导出口径与当前列表一致：带上筛选 + 排序
  if (state.projects.sort) { qs.set('sort', state.projects.sort); qs.set('dir', state.projects.dir); }
  downloadFile('/api/projects/export?' + qs.toString());
  toast('项目列表已导出', 'ok');
}

/** 触发服务端文件下载 */
function downloadFile(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 通过 fetch 下载：能拿到 4xx/5xx 的可读错误，再用 Blob 触发保存 */
async function downloadViaFetch(url, fallbackName) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let j = {};
    try { j = await res.json(); } catch { /* ignore */ }
    if (res.status === 401) showLogin('登录已失效，请重新登录');
    throw new Error(j.message || `下载失败（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  let name = fallbackName || 'download.db';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('content-disposition') || '');
  if (m) { try { name = decodeURIComponent(m[1]); } catch { /* ignore */ } }
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 3000);
  return { name, size: blob.size };
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

/* ---------- 项目弹窗 ---------- */
function openProjectModal(id) {
  const editing = !!id;
  const load = editing ? API.get('/api/projects/' + id).then((r) => r.row) : Promise.resolve({ status: 1 });
  load.then((row) => {
    openModal({
      title: editing ? '编辑项目' : '新增项目',
      sub: editing ? `项目编号 ${row.project_no}` : '登记一个新的项目到项目库',
      narrow: true,
      body: `
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="field"><label class="req">项目编号</label><input class="input" id="pNo" value="${esc(row.project_no || '')}" placeholder="如 PJ-2026-001" /></div>
          <div class="field"><label class="req">产品代码</label><input class="input" id="pCode" value="${esc(row.product_code || '')}" placeholder="如 PROD-A1" /></div>
          <div class="field"><label class="req">项目类型</label><input class="input" id="pType" list="typeList" value="${esc(row.project_type || '')}" placeholder="如 研发/中试/量产" />
            <datalist id="typeList">${(state.meta.options.types || []).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          </div>
          <div class="field"><label>状态</label><select class="select" id="pStatus">
            <option value="1" ${row.status ? 'selected' : ''}>进行中</option>
            <option value="0" ${!row.status ? 'selected' : ''}>已归档</option>
          </select></div>
          <div class="field full" style="grid-column:1/-1"><label>项目简介</label>
            <textarea class="input" id="pDesc" placeholder="简要描述项目背景、目标与范围">${esc(row.description || '')}</textarea>
          </div>
        </div>`,
      footer: `<button class="btn" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" id="pSave">${editing ? '保存修改' : '创建项目'}</button>`,
    });
    el('#pSave').addEventListener('click', async () => {
      const body = {
        project_no: el('#pNo').value.trim(),
        product_code: el('#pCode').value.trim(),
        project_type: el('#pType').value.trim(),
        description: el('#pDesc').value.trim(),
        status: Number(el('#pStatus').value),
      };
      if (!body.project_no || !body.product_code || !body.project_type) return toast('请填写项目编号、产品代码、项目类型', 'err');
      try {
        if (editing) await API.put('/api/projects/' + id, body);
        else await API.post('/api/projects', body);
        closeModal();
        toast(editing ? '项目已更新' : '项目已创建', 'ok');
        await refreshMeta();
        loadProjects();
      } catch (e) { toast(e.message, 'err'); }
    });
  }).catch((e) => toast(e.message, 'err'));
}

/* ============================================================
   项目数据
   ============================================================ */
const F = () => state.meta.fields;
const NUM_FIELDS = () => F().filter((f) => f.type === 'number');
const TEXT_FIELDS = () => F().filter((f) => f.type !== 'number');

async function renderData() {
  const f = state.data.filters;
  const o = (state.meta && state.meta.options) || {};
  // 六个下拉都用「筛选联动」结果（随其他筛选收窄）；没有时退回 meta 的全量选项
  const fo = state.data.facets || {};
  const facetOpts = {
    projectNos: fo.projectNos || o.projectNos,
    productCodes: fo.productCodes || o.productCodes,
    bases: fo.bases || o.bases,
    processes: fo.processes || o.processes,
    workOrders: fo.workOrders || o.workOrders,
    cokeTypes: fo.cokeTypes || o.cokeTypes,
  };
  // 从项目列表跳转过来时，目标编号可能不在当前用户可见的下拉选项里，需临时补入
  const pnoOpts = [...facetOpts.projectNos];
  if (f.project_no && !pnoOpts.includes(f.project_no)) pnoOpts.unshift(f.project_no);
  actions().innerHTML = '';

  content().innerHTML = `
    ${f.project_no ? `<div class="perm-note" style="background:var(--primary-weak);border-color:#c7d8ff">
      <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      <span>正在查看项目 <b>${esc(f.project_no)}</b> 的数据，
        <a href="javascript:;" onclick="clearDataFilters()" style="color:var(--primary);font-weight:550">清除筛选</a> 查看全部</span>
    </div>` : ''}
    ${seeAllData() ? '' : `<div class="perm-note">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>
      <span>你当前的角色为<b>普通用户</b>，仅显示<b>你自己录入</b>的数据。可新增与修改，删除需联系管理员。</span>
    </div>`}
    <div class="filters">
      <div class="filter-row">
        <div class="field w-160"><label>项目编号</label>
          <select class="select" id="dPno"><option value="">全部</option>${pnoOpts.map((v) => `<option ${f.project_no === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-160"><label>产品代码</label>
          <select class="select" id="dPc"><option value="">全部</option>${facetOpts.productCodes.map((v) => `<option ${f.product_code === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-160"><label>所属公司</label>
          <select class="select" id="dBase"><option value="">全部</option>${facetOpts.bases.map((v) => `<option ${f.base === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-140"><label>工序</label>
          <select class="select" id="dProc"><option value="">全部</option>${facetOpts.processes.map((v) => `<option ${f.process_code === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-140"><label>工单号</label>
          <select class="select" id="dWo"><option value="">全部</option>${facetOpts.workOrders.map((v) => `<option ${f.work_order === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-140"><label>焦种</label>
          <select class="select" id="dCoke"><option value="">全部</option>${facetOpts.cokeTypes.map((v) => `<option ${f.coke_type === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <div class="field w-160"><label>关键词</label>
          <input class="input" id="dKw" placeholder="模糊搜索…" value="${esc(f.q || '')}" />
        </div>
        <div class="filter-actions">
          <button class="btn btn-ghost" onclick="clearDataFilters()">重置</button>
        </div>
      </div>
      <div class="filter-row" style="margin-top:10px">
        <div class="field w-160"><label>录入日期 起</label><input class="input" type="date" id="dFrom" value="${esc(f.date_from || '')}" /></div>
        <div class="field w-160"><label>录入日期 止</label><input class="input" type="date" id="dTo" value="${esc(f.date_to || '')}" /></div>
      </div>
    </div>
    <div class="toolbar" id="dataToolbar">
      <button class="btn btn-primary" onclick="openDataModal()">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新增数据
      </button>
      <button class="btn" onclick="openImport()">导入 Excel</button>
      <button class="btn" onclick="exportData()">导出 Excel</button>
      <span class="toolbar-sep"></span>
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-2);cursor:pointer">
        <input type="checkbox" id="onlySel" style="accent-color:var(--primary)" ${state.data.onlySelected ? 'checked' : ''}/> 仅显示已选
      </label>
      <button class="btn btn-sm" id="copyRow" style="display:none" onclick="copySelectedData()" title="勾选一行后，可基于它复制出一条新记录">复制为新行</button>
      <button class="btn btn-sm btn-danger" id="bulkDel" style="display:none" onclick="bulkDelete()">删除选中 (<span id="selCount">0</span>)</button>
    </div>
    <div class="card"><div id="dataTable"><div class="card-body"><div class="skeleton" style="height:240px"></div></div></div></div>`;

  const collect = () => {
    state.data.filters = {
      project_no: el('#dPno').value,
      product_code: el('#dPc').value,
      base: el('#dBase').value,
      process_code: el('#dProc').value,
      work_order: el('#dWo').value,
      coke_type: el('#dCoke').value,
      q: el('#dKw').value.trim(),
      date_from: el('#dFrom').value,
      date_to: el('#dTo').value,
    };
    state.data.page = 1;
  };
  const reload = () => {
    collect();
    // 同项目页：筛选变化先清空勾选，避免批量删除作用到当前不可见的记录
    state.data.selected.clear();
    updateSelCount();
    loadData();
    refreshDataOptions();
  };
  ['dPno', 'dPc', 'dBase', 'dProc', 'dWo', 'dCoke', 'dFrom', 'dTo'].forEach((id) => el('#' + id).addEventListener('change', reload));
  el('#dKw').addEventListener('input', debounce(reload, 240));
  el('#onlySel').addEventListener('change', (e) => { state.data.onlySelected = e.target.checked; loadData(); });

  loadData();
  refreshDataOptions();
}

function clearDataFilters() {
  state.data.filters = {};
  state.data.page = 1;
  state.data.selected.clear();
  state.data.facets = null;
  renderData();
}

/**
 * 筛选联动：按当前全部筛选条件重新取四个下拉的可选值。
 * 服务端每列都会排除自身条件，所以选中某列后仍能切换到同列其他值。
 */
async function refreshDataOptions() {
  const qs = new URLSearchParams();
  Object.entries(state.data.filters).forEach(([k, v]) => { if (v) qs.set(k, v); });
  const seq = (state.data.facetsSeq = (state.data.facetsSeq || 0) + 1);
  let r;
  try {
    r = await API.get('/api/data/facets?' + qs.toString());
  } catch {
    return;
  }
  if (seq !== state.data.facetsSeq) return; // 已有更新的请求，丢弃过期响应
  state.data.facets = r.options || null;
  applyDataOptions();
}

/** 把联动结果写回六个下拉，保留当前选中值（即使它已不在结果里） */
function applyDataOptions() {
  const fo = state.data.facets;
  if (!fo) return;
  const f = state.data.filters;
  const fill = (id, list, cur) => {
    const box = el('#' + id);
    if (!box) return;
    const vals = [...(list || [])];
    if (cur && !vals.includes(cur)) vals.unshift(cur);
    box.innerHTML = `<option value="">全部</option>`
      + vals.map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
    box.value = cur || '';
  };
  fill('dPno', fo.projectNos, f.project_no);
  fill('dPc', fo.productCodes, f.product_code);
  fill('dBase', fo.bases, f.base);
  fill('dProc', fo.processes, f.process_code);
  fill('dWo', fo.workOrders, f.work_order);
  fill('dCoke', fo.cokeTypes, f.coke_type);
}

async function loadData() {
  const qs = new URLSearchParams();
  Object.entries(state.data.filters).forEach(([k, v]) => { if (v) qs.set(k, v); });
  qs.set('page', state.data.page);
  qs.set('pageSize', state.data.pageSize);
  if (state.data.sort) { qs.set('sort', state.data.sort); qs.set('dir', state.data.dir); }

  const { rows: allRows, total, page, pageSize } = await API.get('/api/data?' + qs.toString());
  state.data.rows = allRows; // 供「复制为新行」等操作按 id 取原始记录
  const rows = state.data.onlySelected && state.data.selected.size
    ? allRows.filter((r) => state.data.selected.has(r.id))
    : allRows;

  const box = el('#dataTable');
  if (!box) return; // 视图尚未挂载（例如切换页面过程中）
  if (!allRows.length) {
    box.innerHTML = `<div class="empty">
      <div class="ico"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg></div>
      <p>没有符合条件的数据</p><span>调整筛选条件，或新增/导入数据</span></div>`;
    return;
  }

  const cols = NUM_FIELDS().map((f) => f.key);
  const sorted = state.data.sort;
  const arrow = (k) => sorted === k ? (state.data.dir === 'asc' ? '▲' : '▼') : '↕';

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="col-sticky" style="width:40px"><input type="checkbox" id="checkAll" style="accent-color:var(--primary)" /></th>
            ${F().map((f) => `<th class="sortable ${sorted === f.key ? 'sorted' : ''}" data-sort="${f.key}">${esc(f.label)}<span class="arrow">${arrow(f.key)}</span></th>${
              f.key === 'entry_date' ? `<th class="sortable ${sorted === 'created_by' ? 'sorted' : ''}" data-sort="created_by">录入人<span class="arrow">${arrow('created_by')}</span></th>` : ''
            }`).join('')}
            <th style="position:sticky;right:0;background:var(--surface-2);z-index:3">操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const mine = r.created_by_id === state.user.id;
            return `<tr>
            <td class="col-sticky"><input type="checkbox" class="rowChk" data-id="${r.id}" style="accent-color:var(--primary)" ${state.data.selected.has(r.id) ? 'checked' : ''} /></td>
            ${F().map((f) => {
              const v = r[f.key];
              const sticky = '';
              const ownerCell = f.key === 'entry_date'
                ? `<td><span class="owner-chip ${mine ? 'me' : ''}">${esc(r.created_by || '—')}${mine ? '（我）' : ''}</span></td>`
                : '';
              if (f.key === 'project_no') return `<td class="${sticky}"><span class="code-chip">${esc(v)}</span></td>${ownerCell}`;
              if (f.key === 'remark') return `<td class="wrap dim">${esc(v || '')}</td>${ownerCell}`;
              if (f.key === 'entry_date') return `<td class="dim">${esc(v || '—')}</td>${ownerCell}`;
              if (f.type === 'number') return `<td class="num">${fmtNum(v, f.round2 ? 2 : undefined)}</td>${ownerCell}`;
              return `<td>${esc(v || '—')}</td>${ownerCell}`;
            }).join('')}
            <td style="position:sticky;right:0;background:var(--surface);border-left:1px solid var(--border)">
              <div class="row-actions">
                <button class="btn btn-sm btn-ghost" onclick="openDataModal(${r.id})">编辑</button>
              </div>
            </td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${renderPagination(total, page, pageSize)}
    <div style="padding:0 16px 12px"><span class="scroll-hint">↔ 表格可横向滚动查看全部 ${F().length} 个指标字段</span></div>`;

  // 排序
  box.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.data.sort === k) state.data.dir = state.data.dir === 'asc' ? 'desc' : 'asc';
      else { state.data.sort = k; state.data.dir = 'asc'; }
      loadData();
    });
  });

  // 选择
  box.querySelectorAll('.rowChk').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      cb.checked ? state.data.selected.add(id) : state.data.selected.delete(id);
      updateSelCount();
    });
  });
  el('#checkAll')?.addEventListener('change', (e) => {
    box.querySelectorAll('.rowChk').forEach((cb) => {
      cb.checked = e.target.checked;
      const id = Number(cb.dataset.id);
      e.target.checked ? state.data.selected.add(id) : state.data.selected.delete(id);
    });
    updateSelCount();
  });
  updateSelCount();

  // 分页
  box.querySelectorAll('.page-btn[data-page]').forEach((b) => {
    b.addEventListener('click', () => { state.data.page = Number(b.dataset.page); loadData(); });
  });
}

function updateSelCount() {
  const n = state.data.selected.size;
  const c = el('#selCount');
  if (c) c.textContent = n;
  const b = el('#bulkDel');
  if (b) b.style.display = n && canDeleteData() ? 'inline-flex' : 'none';
  const cp = el('#copyRow');
  if (cp) cp.style.display = n === 1 ? 'inline-flex' : 'none';
}

/** 以勾选的那一行为模板，打开新增表单（保存后生成独立的新记录） */
function copySelectedData() {
  const id = [...state.data.selected][0];
  if (!id) return toast('请先勾选一行数据', 'err');
  const row = (state.data.rows || []).find((r) => r.id === id);
  if (!row) return toast('未找到选中的记录，请刷新后重试', 'err');
  openDataModal(null, { copyFrom: row });
}

function renderPagination(total, page, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const nums = [];
  const push = (n) => { if (!nums.includes(n) && n >= 1 && n <= pages) nums.push(n); };
  push(1); push(page - 1); push(page); push(page + 1); push(pages);
  const list = [...new Set(nums)].sort((a, b) => a - b);
  let html = '';
  let prev = 0;
  for (const n of list) {
    if (prev && n - prev > 1) html += `<span style="color:var(--text-3);padding:0 2px">…</span>`;
    html += `<button class="page-btn ${n === page ? 'active' : ''}" data-page="${n}">${n}</button>`;
    prev = n;
  }
  return `<div class="pagination">
    <span>共 <b>${total}</b> 条 · 第 ${page}/${pages} 页</span>
    <div class="page-btns">
      <button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      ${html}
      <button class="page-btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`;
}

/* ---------- 数据录入弹窗 ---------- */
function openDataModal(id, opts = {}) {
  const editing = !!id;
  const copyFrom = opts.copyFrom || null;
  const load = editing
    ? API.get('/api/data/' + id).then((r) => r.row)
    : Promise.resolve(copyFrom ? { ...copyFrom } : { entry_date: new Date().toISOString().slice(0, 10) });
  load.then((row) => {
    const groups = [
      { title: '基础信息', keys: ['project_no', 'product_code', 'base', 'process_code', 'work_order'] },
      { title: '粒度分布 (μm)', keys: ['dx0', 'dx1', 'dx10', 'dx50', 'dx90', 'dx99', 'dx100', 'k_value'] },
      { title: '物性指标', keys: ['tap_density', 'true_density', 'ssa_domestic', 'ssa_mic', 'graphitization', 'magnetic', 'ph_value', 'oversize', 'oil_absorption', 'hgi'] },
      { title: '电化学性能', keys: ['capacity', 'lithium_inter', 'lithium_deint', 'first_eff'] },
      { title: '粉压 (5点法)', keys: ['press_0_5t', 'press_1t', 'press_1_5t', 'press_2t', 'press_5t'] },
      { title: '工业分析', keys: ['moisture_fp', 'ash', 'volatile', 'moisture', 'sulfur', 'caking_index', 'coking_value'] },
      { title: '生产信息', keys: ['efficiency', 'yield_rate', 'energy', 'quantity', 'entry_date', 'remark'] },
    ];
    const fieldMap = new Map(F().map((f) => [f.key, f]));
    const used = new Set(groups.flatMap((g) => g.keys));
    const others = F().filter((f) => !used.has(f.key));
    if (others.length) groups.push({ title: '其他', keys: others.map((f) => f.key) });

    const inputFor = (key) => {
      const f = fieldMap.get(key);
      if (!f) return '';
      const v = row[key];
      const val = v === null || v === undefined ? '' : v;
      const required = key === 'project_no' ? ' req' : '';
      if (key === 'remark') {
        return `<div class="field" style="grid-column:1/-1"><label>${f.label}</label><textarea class="input" id="d_${key}" rows="2">${esc(val)}</textarea></div>`;
      }
      if (key === 'project_no') {
        const opts = state.meta.options.projectNos.map((p) => `<option ${p === val ? 'selected' : ''}>${esc(p)}</option>`).join('');
        return `<div class="field"><label class="req">${f.label}</label>
          <input class="input" id="d_${key}" list="pnoList" value="${esc(val)}" placeholder="选择或输入项目编号" autocomplete="off" />
          <datalist id="pnoList">${opts}</datalist>
          <span id="pnoHint" style="font-size:11px;color:var(--text-3)"></span></div>`;
      }
      // 产品代码：由项目编号自动带出，只读
      if (key === 'product_code') {
        return `<div class="field"><label>${f.label}</label>
          <input class="input" id="d_${key}" value="${esc(val)}" readonly
            style="background:var(--surface-2);color:var(--text-2);cursor:not-allowed" placeholder="随项目编号自动带出" />
          <span style="font-size:11px;color:var(--text-3)">自动同步</span></div>`;
      }
      const listId = { base: 'baseList', process_code: 'procList', work_order: 'woList', coke_type: 'cokeList' }[key];
      const listOpts = listId
        ? `<datalist id="${listId}">${(state.meta.options[{ base: 'bases', process_code: 'processes', work_order: 'workOrders', coke_type: 'cokeTypes' }[key]] || []).map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`
        : '';
      const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
      const step = f.type === 'number' ? ' step="any"' : '';
      return `<div class="field"><label class="${required.trim()}">${f.label}</label>
        <input class="input" type="${type}"${step} id="d_${key}" value="${esc(val)}" placeholder="${f.type === 'number' ? '数值' : ''}" />${listOpts}</div>`;
    };

    openModal({
      title: editing ? '编辑数据记录' : copyFrom ? '复制为新数据记录' : '新增数据记录',
      sub: editing
        ? `工单 ${row.work_order || '—'} · 录入 ${row.entry_date || ''}`
        : copyFrom
          ? `已复制「${row.project_no} / 工单 ${row.work_order || '—'}」的全部字段，修改工单号或录入日期后保存为新记录`
          : '填写检测与生产数据，数值项留空表示未检测',
      wide: true,
      body: `<div class="form-grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
        ${groups.map((g) => `<div class="form-section-title">${g.title}</div>${g.keys.map(inputFor).join('')}`).join('')}
      </div>`,
      footer: `<div class="left">共 ${F().length} 个字段</div>
        <button class="btn" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" id="dSave">${editing ? '保存修改' : '保存记录'}</button>`,
    });

    // 项目编号 → 产品代码 自动带出（以项目档案为准）
    const pnoInput = el('#d_project_no');
    const pcInput = el('#d_product_code');
    const hint = el('#pnoHint');
    const syncProduct = () => {
      const pno = pnoInput.value.trim();
      const map = state.meta.projectMap || [];
      const hit = map.find((p) => p.project_no === pno);
      if (hit) {
        pcInput.value = hit.product_code;
        pcInput.style.color = 'var(--text-2)';
        if (hint) { hint.textContent = `已关联项目 ${pno}`; hint.style.color = 'var(--success)'; }
      } else {
        pcInput.value = '';
        if (pno) {
          if (hint) { hint.textContent = '项目不存在，请先在项目列表创建'; hint.style.color = 'var(--danger)'; }
        } else if (hint) { hint.textContent = ''; }
      }
    };
    pnoInput?.addEventListener('change', syncProduct);
    pnoInput?.addEventListener('input', syncProduct);

    el('#dSave').addEventListener('click', async () => {
      const body = {};
      for (const f of F()) {
        const inp = el('#d_' + f.key);
        if (!inp) continue;
        body[f.key] = inp.value.trim();
      }
      if (!body.project_no) return toast('请填写项目编号', 'err');
      if (!body.product_code) return toast('项目编号不存在，请选择项目列表中已有的项目', 'err');

      const save = async (dupAction) => {
        const payload = dupAction ? { ...body, duplicate_action: dupAction } : body;
        return editing ? API.put('/api/data/' + id, payload) : API.post('/api/data', payload);
      };

      try {
        await save();
        closeModal();
        toast(editing ? '记录已更新' : copyFrom ? '已复制为新记录' : '记录已保存', 'ok');
        if (copyFrom) { state.data.selected.clear(); updateSelCount(); }
        await refreshMeta();
        loadData();
      } catch (e) {
        if (e.status === 409 && e.code === 'DUPLICATE_KEY') {
          // 复制场景：五项与被复制的那条完全相同，不提供「覆盖」，避免误改原记录
          if (copyFrom) return toast('与原有记录五项完全相同，请先修改工单号或录入日期再保存', 'err');
          // 五项全部相同 → 询问覆盖还是追加
          const info = e.payload.duplicate || {};
          askDuplicateAction({
            title: '系统已有相同数据',
            key: info.key || '',
            count: info.count || 1,
            extra: info.created_by ? `已有记录由「${info.created_by}」于 ${info.entry_date || '—'} 录入` : '',
            onChoice: async (choice) => {
              try {
                const r = await save(choice);
                toast(choice === 'overwrite' ? '已覆盖原有记录' : '已追加为新记录', 'ok');
                await refreshMeta();
                loadData();
                return r;
              } catch (err) { toast(err.message, 'err'); throw err; }
            },
          });
          return;
        }
        toast(e.message, 'err');
      }
    });
  }).catch((e) => toast(e.message, 'err'));
}

/**
 * 重复数据确认弹窗：覆盖导入 / 追加导入
 * choice 回调收到 'overwrite' | 'append'
 */
function askDuplicateAction({ title, key, count, extra, rowsHtml, onChoice }) {
  openModal({
    title: title || '数据重复',
    narrow: true,
    body: `
      <div class="dup-box">
        <div class="dup-icon">!</div>
        <div class="dup-text">
          <p class="dup-lead">项目编号 + 产品代码 + 所属公司 + 工序 + 工单号 五项完全相同，系统中已存在 ${count || 1} 条此类数据。</p>
          ${key ? `<p class="dup-key">${esc(key)}</p>` : ''}
          ${extra ? `<p class="dup-extra">${esc(extra)}</p>` : ''}
          ${rowsHtml || ''}
        </div>
      </div>
      <p class="dup-hint">
        <b>覆盖导入</b>：用本次填写的数据更新已有记录（保留原录入人与记录编号）<br />
        <b>追加导入</b>：作为一条新记录保存，已有记录不变
      </p>`,
    footer: `<button class="btn" onclick="closeModal()">取消</button>
      <button class="btn" id="dupAppend">追加导入</button>
      <button class="btn btn-primary" id="dupOverwrite">覆盖导入</button>`,
  });

  const pick = (choice) => {
    closeModal();
    onChoice(choice);
  };
  el('#dupOverwrite').addEventListener('click', () => pick('overwrite'));
  el('#dupAppend').addEventListener('click', () => pick('append'));
}

function bulkDelete() {
  const ids = [...state.data.selected];
  if (!ids.length) return;
  openModal({
    title: '批量删除', narrow: true,
    body: `<p style="margin:0;color:var(--text-2)">确定删除选中的 <b>${ids.length}</b> 条数据记录吗？此操作不可恢复。</p>`,
    footer: `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-danger" id="okDel">确认删除</button>`,
  });
  el('#okDel').addEventListener('click', async () => {
    try {
      const r = await API.post('/api/data/bulk-delete', { ids });
      state.data.selected.clear();
      closeModal(); toast(`已删除 ${r.deleted} 条记录`, 'ok'); loadData(); refreshDataOptions();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------- Excel 导入：三种导入共用一套交互 ---------- */

/** 预览用的小统计卡 */
function importStatCards(items) {
  return `<div style="display:grid;grid-template-columns:repeat(${items.length},1fr);gap:8px;margin-bottom:12px">
    ${items.map((it) => `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:9px 11px">
      <div style="font-size:11.5px;color:var(--text-3)">${esc(it.label)}</div>
      <div style="font-size:19px;font-weight:650;${it.color ? `color:${it.color}` : ''}">${esc(String(it.value))}${it.suffix || ''}</div>
    </div>`).join('')}
  </div>`;
}

/** 预览的通用提示：识别列 / 留空列 / 无法识别的列 / 缺少必填表头 / 逐行校验错误 */
function importWarnings(info, extra = '') {
  const { matched = [], unknown = [], missingRequired = [], blankLabels = [], errors = [] } = info;
  return `<div style="font-size:12.5px;line-height:1.9;color:var(--text-2)">
    ${matched.length ? `<div><b style="color:var(--text)">识别到的列：</b><span style="color:var(--text-3)">${matched.map((m) => esc(m.col)).join('、')}</span></div>` : ''}
    ${blankLabels.length ? `<div><b style="color:var(--text)">未提供的列（将留空）：</b><span style="color:var(--text-3)">${blankLabels.map(esc).join('、')}</span></div>` : ''}
    ${unknown.length ? `<div style="margin-top:6px"><b style="color:var(--warn)">无法识别的列（将被忽略）：</b> ${unknown.map(esc).join('、')}</div>` : ''}
    ${missingRequired.length ? `<div style="margin-top:8px;color:var(--danger);font-weight:600">缺少必填表头：${missingRequired.map(esc).join('、')}，请补充后重新选择文件。</div>` : ''}
    ${extra}
    ${errors.length ? `<div style="margin-top:8px;color:var(--danger)">
        <b>${errors.length} 行校验未通过（导入时将被跳过）：</b>
        <div style="margin-top:3px;color:var(--text-2)">${errors.map(esc).join('<br>')}</div>
      </div>` : ''}
  </div>`;
}

/** 重复行表格：最多展示 8 行，其余折叠成一行提示 */
function importDupRows(rows, cols, total) {
  if (!rows || !rows.length) return '';
  return `<div class="dup-rows"><table>
      <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, 8).map((d) => `<tr>${cols.map((c) => `<td>${esc(d[c.key] == null ? '—' : d[c.key])}</td>`).join('')}</tr>`).join('')}
      </tbody></table>
      ${total > 8 ? `<div class="dup-more">另有 ${total - 8} 行未列出</div>` : ''}</div>`;
}

/**
 * 通用 Excel 导入弹窗：选文件 → 校验后缀 → 上传解析 → 预览 → 确认 → 409 重复询问 → 刷新。
 * 项目 / 数据 / 用户三种导入共用这一套骨架，差异全部由 cfg 注入。
 *
 * cfg: {
 *   title, sub, tip, templateLabel, onTemplate,
 *   uploadUrl, confirmUrl,
 *   preview(info) -> html, canSubmit?(info) -> bool,
 *   dupTitle(info), dupLead(info), dupRows(info), dupHint,
 *   dupChoices: [{ value, label, primary? }],
 *   summarize(r) -> string, after?(r) -> Promise
 * }
 */
function openExcelImport(cfg) {
  openModal({
    title: cfg.title,
    sub: cfg.sub,
    body: `
      <div style="background:var(--primary-weak);border-radius:9px;padding:11px 13px;font-size:12.5px;color:#1e4fbf;line-height:1.75;margin-bottom:14px">${cfg.tip}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <input type="file" id="excelFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="input" style="height:auto;padding:8px;flex:1;min-width:220px" />
        <button class="btn btn-sm" id="importTpl">${esc(cfg.templateLabel)}</button>
      </div>
      <div id="importPreview"></div>`,
    footer: `<button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="okImport" disabled>开始导入</button>`,
  });

  el('#importTpl').addEventListener('click', () => cfg.onTemplate());

  el('#excelFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const prev = el('#importPreview');
    const okBtn = el('#okImport');
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      prev.innerHTML = `<div style="color:var(--danger);font-size:12.5px">
        仅支持 .xlsx 格式。请先用 Excel / WPS 打开后「另存为」Excel 工作簿（.xlsx）再上传。
      </div>`;
      okBtn.disabled = true;
      return;
    }

    prev.innerHTML = `<div style="color:var(--text-3);font-size:12.5px">正在解析 ${esc(file.name)} …</div>`;
    okBtn.disabled = true;

    let info;
    try {
      info = await API.postRaw(cfg.uploadUrl, await file.arrayBuffer());
    } catch (err) {
      prev.innerHTML = `<div style="color:var(--danger);font-size:12.5px">${esc(err.message)}</div>`;
      return;
    }

    prev.innerHTML = cfg.preview(info);
    const { missingRequired = [], rowCount = 0 } = info;
    okBtn.disabled = missingRequired.length > 0 || rowCount === 0 || (cfg.canSubmit ? !cfg.canSubmit(info) : false);
    okBtn._token = info.token;
  });

  const finish = async (r) => {
    closeModal();
    toast(cfg.summarize(r), r.failed ? 'err' : 'ok');
    if (r.errors && r.errors.length) setTimeout(() => alert('部分行导入失败：\n' + r.errors.join('\n')), 300);
    if (cfg.after) await cfg.after(r);
  };

  el('#okImport').addEventListener('click', async () => {
    const token = el('#okImport')._token;
    if (!token) return toast('请先选择 Excel 文件', 'err');
    const run = (choice) => API.post(cfg.confirmUrl, choice ? { token, duplicate_action: choice } : { token });

    try {
      await finish(await run());
    } catch (e) {
      if (e.status === 409 && e.code === 'DUPLICATE_KEY') {
        const info = e.payload.duplicate || {};
        openImportDuplicate(cfg, info, async (choice) => {
          try { await finish(await run(choice)); }
          catch (err) { toast(err.message, 'err'); }
        });
        return;
      }
      toast(e.message, 'err');
    }
  });
}

/** 导入命中重复时的选择弹窗（覆盖 / 跳过，数据导入为覆盖 / 追加） */
function openImportDuplicate(cfg, info, onChoice) {
  openModal({
    title: cfg.dupTitle(info),
    narrow: true,
    body: `
      <div class="dup-box">
        <div class="dup-icon">!</div>
        <div class="dup-text">
          <p class="dup-lead">${esc(cfg.dupLead(info))}</p>
          ${cfg.dupRows(info)}
        </div>
      </div>
      <p class="dup-hint">${cfg.dupHint}</p>`,
    footer: `<button class="btn" onclick="closeModal()">取消</button>
      ${cfg.dupChoices.map((c, i) => `<button class="btn ${c.primary ? 'btn-primary' : ''}" id="dupChoice${i}">${esc(c.label)}</button>`).join('')}`,
  });
  cfg.dupChoices.forEach((c, i) => {
    el(`#dupChoice${i}`).addEventListener('click', () => { closeModal(); onChoice(c.value); });
  });
}

/** 项目列表导入：Excel 上传 → 服务端解析 → 预览 → 确认 */
function openProjectImport() {
  if (!canManageProjects()) return toast('仅管理员可导入项目', 'err');
  openExcelImport({
    title: '导入项目列表',
    sub: '支持 .xlsx 文件；项目编号、产品代码、项目类型为必填，项目简介与状态可选',
    tip: `<b>三项必填</b>：项目编号、产品代码、项目类型。项目简介可留空，状态填「进行中 / 已归档」（留空视为进行中）。<br>
      项目编号在系统中唯一，重复时由你选择<b>覆盖已有项目</b>或<b>跳过</b>。<br>
      <b>仅支持 .xlsx</b>（Excel 2007 及以上）。若是 .xls 或 .csv，请先用 Excel 另存为 .xlsx。`,
    templateLabel: '下载导入模板',
    onTemplate: () => downloadFile('/api/projects/template'),
    uploadUrl: '/api/projects/import-file',
    confirmUrl: '/api/projects/import-confirm',
    preview: (info) => importStatCards([
      { label: '数据行', value: info.rowCount },
      { label: '新增', value: info.willInsert, color: 'var(--ok,#16a34a)' },
      { label: '编号已存在', value: info.willDup, color: info.willDup ? 'var(--warn)' : '' },
    ]) + importWarnings(info),
    dupTitle: (info) => `有 ${info.count || 0} 个项目编号已存在`,
    dupLead: (info) => `以下项目编号在系统中已经存在（共 ${info.count || 1} 个，本次共 ${info.total || info.count || 0} 行待导入）。`,
    dupRows: (info) => importDupRows(info.rows, [
      { key: 'line', label: 'Excel 行号' }, { key: 'project_no', label: '项目编号' },
    ], info.count),
    dupHint: `<b>覆盖已有</b>：用本次文件中的内容更新已有项目（项目编号不变）<br />
      <b>跳过已存在</b>：只导入新编号，已有的保持不变`,
    dupChoices: [
      { value: 'skip', label: '跳过已存在' },
      { value: 'overwrite', label: '覆盖已有', primary: true },
    ],
    summarize: (r) => {
      const parts = [`新增 ${r.inserted} 个`];
      if (r.overwritten) parts.push(`覆盖 ${r.overwritten} 个`);
      if (r.skipped) parts.push(`跳过 ${r.skipped} 个`);
      if (r.failed) parts.push(`失败 ${r.failed} 个`);
      return `导入完成：${parts.join('、')}`;
    },
    after: async () => { await refreshMeta(); loadProjects(); },
  });
}

/* ---------- Excel 导出 ---------- */

async function exportData() {
  const qs = new URLSearchParams();

  // 已勾选时优先只导出勾选的记录
  if (state.data.selected.size) {
    qs.set('ids', [...state.data.selected].join(','));
    downloadFile('/api/data/export?' + qs.toString());
    toast(`已导出选中的 ${state.data.selected.size} 条记录`, 'ok');
    return;
  }

  Object.entries(state.data.filters).forEach(([k, v]) => { if (v) qs.set(k, v); });

  // 先取总数用于提示，实际文件由服务端按同样条件生成
  qs.set('pageSize', 10);
  qs.set('page', 1);
  const { total } = await API.get('/api/data?' + qs.toString());
  if (!total) return toast('当前筛选条件下没有可导出的数据', 'err');
  qs.delete('page');
  qs.delete('pageSize');
  downloadFile('/api/data/export?' + qs.toString());
  toast(`已导出 ${total} 条记录`, 'ok');
}

/* ---------- 导入：Excel 上传后由服务端解析与识别表头 ---------- */

function openImport() {
  openExcelImport({
    title: '导入 Excel 数据',
    sub: '支持 .xlsx 文件，指标字段可只填一部分，未提供的指标将自动留空',
    tip: `<b>部分字段即可导入</b>：无需凑齐 ${F().length} 个字段，只要包含<b>项目编号</b>和<b>产品代码</b>，其余指标可任意缺省。<br>
      表头可用中文列名或字段名，兼容 <code>Dx（50）</code>、<code>振实密度(g/cm³)</code>、<code>首效</code> 等写法；空格、<code>-</code>、<code>N/A</code> 视为未提供。<br>
      <b>仅支持 .xlsx</b>（Excel 2007 及以上）。若是 .xls 或 .csv，请先用 Excel 另存为 .xlsx。`,
    templateLabel: '选择字段生成模板',
    onTemplate: () => openTemplatePicker(),
    uploadUrl: '/api/data/import-file',
    confirmUrl: '/api/data/import-confirm',
    preview: (info) => importStatCards([
      { label: '数据行', value: info.rowCount },
      {
        label: '识别到的指标字段',
        value: info.matched.length,
        suffix: ` <span style="font-size:12px;color:var(--text-3);font-weight:400">/ ${F().length}</span>`,
      },
    ]) + importWarnings(info, `<div><b style="color:var(--text)">将留空的指标（${info.blankLabels.length} 项）：</b>
        <span style="color:var(--text-3)">${info.blankLabels.map(esc).join('、') || '无'}</span></div>`),
    dupTitle: (info) => `有 ${info.count || 0} 行数据重复`,
    dupLead: (info) => `${info.count || 0} 行的「项目编号 + 产品代码 + 所属公司 + 工序 + 工单号」与系统已有记录完全相同（本次共 ${info.total || info.count || 0} 行待导入）。`,
    dupRows: (info) => importDupRows(info.rows, [
      { key: 'line', label: 'Excel 行号' }, { key: 'project_no', label: '项目编号' },
      { key: 'base', label: '所属公司' }, { key: 'process_code', label: '工序' },
      { key: 'work_order', label: '工单号' },
    ], info.count),
    dupHint: `<b>覆盖导入</b>：用本次文件的数据更新已有记录（保留原录入人与记录编号）<br />
      <b>追加导入</b>：作为新记录保存，已有记录不变`,
    dupChoices: [
      { value: 'append', label: '追加导入' },
      { value: 'overwrite', label: '覆盖导入', primary: true },
    ],
    summarize: (r) => {
      const parts = [`新增 ${r.inserted} 条`];
      if (r.overwritten) parts.push(`覆盖 ${r.overwritten} 条`);
      if (r.failed) parts.push(`失败 ${r.failed} 条`);
      return `导入完成：${parts.join('、')}`;
    },
    after: async (r) => {
      if (r.blankFields && r.blankFields.length) {
        setTimeout(() => alert(
          `导入完成：成功 ${r.inserted} 条${r.overwritten ? `，覆盖 ${r.overwritten} 条` : ''}${r.failed ? `，失败 ${r.failed} 条` : ''}\n\n` +
          `以下 ${r.blankFields.length} 个字段在所有记录中均未提供，已自动留空：\n` +
          r.blankFields.join('、')
        ), 300);
      }
      await refreshMeta();
      loadData();
    },
  });
}

/** 按勾选字段生成 Excel 导入模板（含一行示例），用于部分指标导入 */
function openTemplatePicker() {
  const groups = [
    { title: '基础（必选）', keys: ['project_no', 'product_code', 'base', 'process_code', 'work_order'] },
    { title: '粒度', keys: ['dx0', 'dx1', 'dx10', 'dx50', 'dx90', 'dx99', 'dx100', 'k_value'] },
    { title: '物性', keys: ['tap_density', 'true_density', 'ssa_domestic', 'ssa_mic', 'graphitization', 'magnetic', 'ph_value', 'oversize', 'oil_absorption', 'hgi'] },
    { title: '电化学', keys: ['capacity', 'lithium_inter', 'lithium_deint', 'first_eff'] },
    { title: '粉压', keys: ['press_0_5t', 'press_1t', 'press_1_5t', 'press_2t', 'press_5t'] },
    { title: '工业分析', keys: ['moisture_fp', 'ash', 'volatile', 'moisture', 'sulfur', 'caking_index', 'coking_value'] },
    { title: '生产', keys: ['efficiency', 'yield_rate', 'energy', 'quantity', 'entry_date', 'remark'] },
  ];
  const fm = new Map(F().map((f) => [f.key, f]));
  const required = new Set(['project_no', 'product_code']);
  const checked = new Set([...required, 'base', 'process_code', 'work_order', 'dx50', 'tap_density', 'capacity', 'first_eff', 'quantity', 'entry_date']);

  openModal({
    title: '生成导入模板', narrow: true,
    sub: '勾选本次要填写的指标，未勾选的字段会在导入时自动留空',
    body: `<div style="max-height:52vh;overflow:auto">
      ${groups.map((g) => `
        <div style="margin-bottom:14px">
          <div style="font-size:11.5px;font-weight:650;color:var(--text-3);letter-spacing:.4px;margin-bottom:7px;display:flex;justify-content:space-between">
            <span>${g.title}</span>
            ${g.title.startsWith('基础') ? '<span style="font-weight:400;color:var(--text-3)">项目编号、产品代码必选</span>'
              : `<a href="javascript:;" data-toggle-group="${g.title}" style="color:var(--primary);text-decoration:none;font-weight:500">全选/取消</a>`}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px 10px">
            ${g.keys.filter((k) => fm.has(k)).map((k) => {
              const f = fm.get(k);
              const isReq = required.has(k);
              return `<label style="display:flex;align-items:center;gap:5px;font-size:12.5px;color:var(--text-2);cursor:pointer;width:calc(50% - 5px)">
                <input type="checkbox" class="tplChk" value="${k}" ${checked.has(k) ? 'checked' : ''} ${isReq ? 'disabled' : ''} style="accent-color:var(--primary)" />
                ${esc(f.label)}
              </label>`;
            }).join('')}
          </div>
        </div>`).join('')}
    </div>`,
    footer: `<div class="left">已选 <b id="tplCount">${checked.size}</b> 个字段</div>
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="tplGo">下载模板</button>`,
  });

  const refreshCount = () => {
    const n = [...document.querySelectorAll('.tplChk')].filter((c) => c.checked).length;
    el('#tplCount').textContent = n;
  };
  document.querySelectorAll('.tplChk').forEach((c) => c.addEventListener('change', refreshCount));
  document.querySelectorAll('[data-toggle-group]').forEach((a) => {
    a.addEventListener('click', () => {
      const g = groups.find((x) => x.title === a.dataset.toggleGroup);
      const items = g.keys.map((k) => document.querySelector(`.tplChk[value="${k}"]`)).filter((c) => c && !c.disabled);
      const allOn = items.every((c) => c.checked);
      items.forEach((c) => { c.checked = !allOn; });
      refreshCount();
    });
  });

  el('#tplGo').addEventListener('click', () => {
    const keys = [...document.querySelectorAll('.tplChk')].filter((c) => c.checked).map((c) => c.value);
    const order = F().map((f) => f.key).filter((k) => keys.includes(k));
    if (!order.length) return toast('请至少选择一个字段', 'err');
    downloadFile('/api/data/template?fields=' + encodeURIComponent(order.join(',')));
    toast(`模板已生成，含 ${order.length} 个字段`, 'ok');
  });
}

/* ============================================================
   用户管理（仅管理员可进入）
   ============================================================ */
const ROLE_TAG = (role) => {
  const map = { sys_admin: '系统管理员', admin: '管理员', user: '普通用户' };
  return `<span class="role-tag ${role}">${map[role] || role}</span>`;
};

async function renderUsers() {
  if (!canManageUsers()) {
    content().innerHTML = `<div class="card"><div class="card-body"><div class="empty">
      <p>无权访问用户管理</p><span>请联系管理员</span></div></div></div>`;
    return;
  }
  actions().innerHTML = `<button class="btn btn-primary" onclick="openUserModal()">
    <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新增用户</button>
    <button class="btn" onclick="openUserImport()">
      <svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>导入 Excel</button>`;
  const { rows } = await API.get('/api/users');
  state.users.rows = rows;

  const counts = rows.reduce((a, r) => { a[r.role] = (a[r.role] || 0) + 1; return a; }, {});

  content().innerHTML = `
    <div class="perm-note">
      <svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      <span>${canManageAdmins()
        ? '你是系统管理员，可管理系统内所有账号，包括管理员。'
        : '你是管理员，可管理普通用户；管理员账号仅系统管理员可操作。'}</span>
    </div>
    <div class="card">
      <div class="card-head"><h3>用户账号<span class="sub">
        共 ${rows.length} 个 · 管理员 ${(counts.admin || 0) + (counts.sys_admin || 0)} · 普通用户 ${counts.user || 0}
      </span></h3></div>
      <div class="table-wrap" style="max-height:calc(100vh - 320px)">
        <table class="data-table">
          <thead><tr>
            <th class="col-sticky">账号</th><th>姓名</th><th>角色</th><th>状态</th><th>密码</th>
            <th>数据条数</th><th>备注</th><th>最近登录</th><th>操作</th>
          </tr></thead>
          <tbody>
            ${rows.map((r) => {
              const locked = r.role === 'sys_admin' || (r.role === 'admin' && !canManageAdmins());
              return `<tr>
              <td class="col-sticky"><b>${esc(r.username)}</b>${r.id === state.user.id ? ' <span style="color:var(--primary);font-size:11px">(我)</span>' : ''}</td>
              <td>${esc(r.real_name || '—')}</td>
              <td>${ROLE_TAG(r.role)}</td>
              <td><span class="status-tag ${r.status ? 'on' : 'off'}">${r.status ? '启用' : '停用'}</span></td>
              <td>${r.pwd_changed ? '<span class="dim" style="font-size:12px">已修改</span>'
                : '<span style="color:var(--warn);font-size:12px;font-weight:550">初始密码</span>'}</td>
              <td class="num dim">${esc(String(r.data_count ?? 0))}</td>
              <td class="dim wrap">${esc(r.remark || '—')}</td>
              <td class="dim">${esc(r.last_login || '—')}</td>
              <td><div class="row-actions">
                ${locked
                  ? '<span class="dim" style="font-size:12px">—</span>'
                  : `<button class="btn btn-sm btn-ghost" onclick="openUserModal(${r.id})">编辑</button>
                     <button class="btn btn-sm btn-ghost" onclick="resetUserPwd(${r.id}, '${esc(r.username)}')">重置密码</button>
                     ${r.id === state.user.id ? '' : `<button class="btn btn-sm btn-ghost" style="color:var(--danger)" onclick="confirmDeleteUser(${r.id}, '${esc(r.username)}', ${r.data_count ?? 0})">删除</button>`}`}
              </div></td>
            </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="pagination"><span>密码以 scrypt 加盐散列存储，不保存明文；新增用户默认密码为账号</span></div>
    </div>`;
}

/** 用户批量导入：Excel 上传 → 服务端校验 → 预览 → 确认 */
function openUserImport() {
  if (!canManageUsers()) return toast('仅管理员可导入用户', 'err');
  openExcelImport({
    title: '批量导入用户',
    sub: '支持 .xlsx 文件；仅「账号」为必填，姓名、角色、状态、备注可选',
    tip: `<b>必填一项</b>：账号（2-32 位字母、数字或 _ . @ -）。<br>
      角色填「普通用户 / 管理员」（留空视为普通用户），状态填「启用 / 停用」（留空视为启用）。<br>
      导入用户的<b>初始密码即账号本身</b>，首次登录后请及时修改；账号已存在时由你选择<b>覆盖</b>或<b>跳过</b>。<br>
      <b>仅支持 .xlsx</b>（Excel 2007 及以上）。若是 .xls 或 .csv，请先用 Excel 另存为 .xlsx。`,
    templateLabel: '下载导入模板',
    onTemplate: () => downloadFile('/api/users/template'),
    uploadUrl: '/api/users/import-file',
    confirmUrl: '/api/users/import-confirm',
    preview: (info) => importStatCards([
      { label: '数据行', value: info.rowCount },
      { label: '新增', value: info.willInsert, color: 'var(--ok,#16a34a)' },
      { label: '账号已存在', value: info.willDup, color: info.willDup ? 'var(--warn)' : '' },
    ]) + importWarnings(info),
    // 全部行都校验失败时不允许提交，避免空跑
    canSubmit: (info) => info.rowCount - (info.errorCount || 0) > 0,
    dupTitle: (info) => `有 ${info.count || 0} 个账号已存在`,
    dupLead: (info) => `以下账号在系统中已经存在（共 ${info.count || 1} 个）。`,
    dupRows: (info) => importDupRows(info.rows, [
      { key: 'line', label: 'Excel 行号' }, { key: 'username', label: '账号' },
    ], info.count),
    dupHint: `<b>覆盖已有</b>：用本次文件中的姓名、角色、状态、备注更新已有账号（<b>不改密码</b>；系统管理员账号一律跳过）<br />
      <b>跳过已存在</b>：只导入新账号，已有的保持不变`,
    dupChoices: [
      { value: 'skip', label: '跳过已存在' },
      { value: 'overwrite', label: '覆盖已有', primary: true },
    ],
    summarize: (r) => {
      const parts = [`新增 ${r.inserted} 个`];
      if (r.overwritten) parts.push(`覆盖 ${r.overwritten} 个`);
      if (r.skipped) parts.push(`跳过 ${r.skipped} 个`);
      if (r.failed) parts.push(`失败 ${r.failed} 个`);
      return `导入完成：${parts.join('、')}`;
    },
    after: async () => { renderUsers(); },
  });
}

function openUserModal(id) {
  const editing = !!id;
  const row = editing ? state.users.rows.find((r) => r.id === id) || {} : { role: 'user', status: 1 };
  const roleOptions = [
    { v: 'user', t: '普通用户', d: '仅查看/维护自己录入的数据' },
    { v: 'admin', t: '管理员', d: '查看全部数据，可增删改，可管理普通用户' },
  ];
  if (canManageAdmins()) roleOptions.push({ v: 'sys_admin', t: '系统管理员', d: '全部权限，含管理员管理（仅 admin 账号）' });

  openModal({
    title: editing ? '编辑用户' : '新增用户',
    sub: editing ? `账号 ${row.username}` : '不填写密码时，默认密码即为账号',
    narrow: true,
    body: `<div class="form-grid" style="grid-template-columns:1fr 1fr">
      ${editing ? '' : `<div class="field"><label class="req">账号</label><input class="input" id="uName" placeholder="2-32 位字母数字" autocomplete="off" /></div>`}
      ${editing ? '' : `<div class="field"><label>初始密码</label><input class="input" id="uPwd" placeholder="留空 = 账号" autocomplete="new-password" /></div>`}
      <div class="field"><label>姓名</label><input class="input" id="uReal" value="${esc(row.real_name || '')}" /></div>
      <div class="field"><label>角色</label><select class="select" id="uRole" ${editing && row.role === 'sys_admin' ? 'disabled' : ''}>
        ${roleOptions.map((o) => `<option value="${o.v}" ${row.role === o.v ? 'selected' : ''}>${o.t}</option>`).join('')}
      </select><span id="roleHint" style="font-size:11px;color:var(--text-3)"></span></div>
      <div class="field"><label>状态</label><select class="select" id="uStatus">
        <option value="1" ${row.status ? 'selected' : ''}>启用</option>
        <option value="0" ${!row.status ? 'selected' : ''}>停用</option>
      </select></div>
      <div class="field full" style="grid-column:1/-1"><label>备注</label><input class="input" id="uRemark" value="${esc(row.remark || '')}" /></div>
    </div>`,
    footer: `<button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="uSave">${editing ? '保存' : '创建'}</button>`,
  });

  const hint = el('#roleHint');
  const syncHint = () => {
    const v = el('#uRole').value;
    const o = roleOptions.find((x) => x.v === v);
    if (hint) hint.textContent = o ? o.d : '';
  };
  el('#uRole').addEventListener('change', syncHint);
  syncHint();

  el('#uSave').addEventListener('click', async () => {
    try {
      if (editing) {
        const body = {
          real_name: el('#uReal').value.trim(),
          status: Number(el('#uStatus').value),
          remark: el('#uRemark').value.trim(),
        };
        const roleSel = el('#uRole');
        if (roleSel && !roleSel.disabled && roleSel.value !== row.role) body.role = roleSel.value;
        await API.put('/api/users/' + id, body);
        closeModal(); toast('用户已更新', 'ok'); renderUsers();
      } else {
        const username = el('#uName').value.trim();
        if (!username) return toast('请填写账号', 'err');
        const pwd = el('#uPwd').value.trim();
        const r = await API.post('/api/users', {
          username,
          password: pwd || undefined,
          real_name: el('#uReal').value.trim(),
          role: el('#uRole').value,
          status: Number(el('#uStatus').value),
          remark: el('#uRemark').value.trim(),
        });
        closeModal();
        toast(r.defaultPassword ? `已创建，初始密码与账号相同（${username}）` : '用户已创建', 'ok');
        renderUsers();
      }
    } catch (e) { toast(e.message, 'err'); }
  });
}

function resetUserPwd(id, name) {
  openModal({
    title: '重置密码', narrow: true,
    body: `<p style="margin:0 0 8px;color:var(--text-2)">将账号 <b>${esc(name)}</b> 的密码重置为初始密码（即账号本身）？</p>
      <p style="margin:0;font-size:12.5px;color:var(--text-3)">重置后该用户所有登录会话将失效，需用新密码重新登录。</p>`,
    footer: `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" id="okReset">确认重置</button>`,
  });
  el('#okReset').addEventListener('click', async () => {
    try {
      await API.put('/api/users/' + id, { reset_password: true });
      closeModal(); toast(`已将密码重置为 ${name}`, 'ok'); renderUsers();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function confirmDeleteUser(id, name, dataCount) {
  openModal({
    title: '删除用户', narrow: true,
    body: `<p style="margin:0 0 8px;color:var(--text-2)">确定删除账号 <b>${esc(name)}</b> 吗？</p>
      ${dataCount ? `<p style="margin:0;font-size:12.5px;color:var(--warn)">该用户名下有 <b>${dataCount}</b> 条数据记录，删除后将失去归属人，仅管理员仍可见。</p>`
        : `<p style="margin:0;font-size:12.5px;color:var(--text-3)">该用户暂无数据记录。</p>`}`,
    footer: `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-danger" id="okDel">确认删除</button>`,
  });
  el('#okDel').addEventListener('click', async () => {
    try { await API.del('/api/users/' + id); closeModal(); toast('已删除', 'ok'); renderUsers(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

/* ============================================================
   登录 / 账号
   ============================================================ */
function showLogin(message) {
  el('#appShell').style.display = 'none';
  const scr = el('#loginScreen');
  scr.style.display = 'grid';
  el('#loginErr').textContent = message || '';
  el('#loginPwd').value = '';
  setTimeout(() => el('#loginUser').focus(), 80);
}

function hideLogin() {
  el('#loginScreen').style.display = 'none';
  el('#appShell').style.display = 'flex';
}

function paintUser() {
  const u = state.user;
  el('#userName').textContent = u.real_name || u.username;
  el('#userRole').textContent = u.roleLabel || u.role;
  el('#userAvatar').textContent = (u.real_name || u.username).slice(0, 1);
  // 用户管理 / 回收站入口仅管理员可见；审计日志仅系统管理员可见
  document.querySelectorAll('[data-admin-only]').forEach((n) => {
    n.style.display = canManageUsers() ? '' : 'none';
  });
  document.querySelectorAll('[data-sysadmin-only]').forEach((n) => {
    n.style.display = canViewAudit() ? '' : 'none';
  });
}

async function doLogin(e) {
  if (e) e.preventDefault();
  const username = el('#loginUser').value.trim();
  const password = el('#loginPwd').value;
  if (!username || !password) {
    el('#loginErr').textContent = '请输入账号和密码';
    return;
  }
  const btn = el('#loginBtn');
  btn.disabled = true;
  el('#loginErr').textContent = '';
  try {
    const r = await API.post('/api/auth/login', { username, password });
    state.user = r.user;
    await bootApp();
  } catch (err) {
    el('#loginErr').textContent = err.message;
    el('#loginPwd').select();
  } finally {
    btn.disabled = false;
  }
}

async function doLogout() {
  try { await API.post('/api/auth/logout'); } catch { /* 忽略 */ }
  state.user = null;
  state.meta = null;
  el('#userMenu').classList.remove('open');
  showLogin('');
  el('#loginUser').value = '';
  el('#loginPwd').value = '';
}

function openPasswordModal() {
  el('#userMenu').classList.remove('open');
  openModal({
    title: '修改密码', narrow: true,
    sub: `当前账号 ${state.user.username}`,
    body: `<div class="form-grid" style="grid-template-columns:1fr">
      <div class="field"><label class="req">原密码</label><input class="input" type="password" id="pOld" autocomplete="current-password" /></div>
      <div class="field"><label class="req">新密码</label><input class="input" type="password" id="pNew" placeholder="至少 4 位" autocomplete="new-password" /></div>
      <div class="field"><label class="req">确认新密码</label><input class="input" type="password" id="pNew2" autocomplete="new-password" /></div>
    </div>`,
    footer: `<button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="pSave">保存新密码</button>`,
  });
  el('#pSave').addEventListener('click', async () => {
    const oldPwd = el('#pOld').value;
    const p1 = el('#pNew').value;
    const p2 = el('#pNew2').value;
    if (!oldPwd || !p1) return toast('请填写原密码与新密码', 'err');
    if (p1 !== p2) return toast('两次输入的新密码不一致', 'err');
    if (p1.length < 4) return toast('新密码至少 4 位', 'err');
    try {
      await API.post('/api/auth/password', { old_password: oldPwd, new_password: p1 });
      state.user.pwd_changed = 1;
      closeModal();
      toast('密码已修改', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ============================================================
   回收站
   ============================================================ */
/** 「YYYY-MM-DD HH:MM:SS」→「YYYY-MM-DD HH:MM」 */
function fmtDateTime(s) {
  return s ? String(s).slice(0, 16) : '';
}
/** 软删除后还剩几天可恢复 */
function daysLeft(deletedAt, keepDays) {
  const t = new Date(String(deletedAt).replace(' ', 'T')).getTime();
  if (!Number.isFinite(t)) return keepDays;
  return Math.max(0, Math.ceil((t + keepDays * 86400000 - Date.now()) / 86400000));
}

async function renderRecycle() {
  actions().innerHTML = `<button class="btn" onclick="renderRecycle()">
    <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>刷新</button>`;
  content().innerHTML = `<div class="card"><div class="card-body"><div class="skeleton" style="height:200px"></div></div></div>`;
  let info;
  try {
    info = await API.get('/api/recycle');
  } catch (e) {
    content().innerHTML = `<div class="card"><div class="card-body"><p class="muted">${esc(e.message)}</p></div></div>`;
    return;
  }
  const kp = info.keepDays || 30;
  const projects = info.projects || [];
  const datas = info.datas || [];

  if (projects.length === 0 && datas.length === 0) {
    content().innerHTML = `
      <div class="card"><div class="card-body" style="text-align:center;padding:48px 0">
        <p style="margin:0;color:var(--text-3)">回收站是空的</p>
        <p style="margin:8px 0 0;color:var(--text-3);font-size:13px">删除的项目和数据会在这里保留 ${kp} 天，之后自动清除</p>
      </div></div>`;
    return;
  }

  const left = (dt) => {
    const n = daysLeft(dt, kp);
    return `<span style="color:${n <= 3 ? 'var(--danger)' : 'var(--text-3)'}">${n} 天</span>`;
  };

  content().innerHTML = `
    ${projects.length ? `
    <div class="card">
      <div class="card-head"><h3>已删除的项目 (${projects.length})</h3></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>项目编号</th><th>产品代码</th><th>项目类型</th><th>数据条数</th><th>删除时间</th><th>剩余可恢复</th><th>操作</th></tr></thead>
          <tbody>
            ${projects.map((r) => `<tr>
              <td class="col-sticky"><span class="code-chip">${esc(r.project_no)}</span></td>
              <td>${esc(r.product_code)}</td>
              <td>${esc(r.project_type)}</td>
              <td>${r.data_count || 0}</td>
              <td>${fmtDateTime(r.deleted_at)}</td>
              <td>${left(r.deleted_at)}</td>
              <td><div class="row-actions">
                <button class="btn btn-sm btn-ghost" onclick="recycleRestore('project', ${r.id})">恢复</button>
                <button class="btn btn-sm btn-ghost" style="color:var(--danger)" data-purge-entity="project" data-purge-id="${r.id}" data-purge-label="${esc(r.project_no)}" data-purge-count="${r.data_count || 0}">彻底删除</button>
              </div></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
    ${datas.length ? `
    <div class="card">
      <div class="card-head"><h3>已删除的数据记录 (${datas.length}${datas.length >= 1000 ? '+' : ''})</h3></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>项目编号</th><th>产品代码</th><th>工单号</th><th>录入日期</th><th>录入人</th><th>删除时间</th><th>剩余可恢复</th><th>操作</th></tr></thead>
          <tbody>
            ${datas.map((r) => `<tr>
              <td class="col-sticky"><span class="code-chip">${esc(r.project_no)}</span></td>
              <td>${esc(r.product_code)}</td>
              <td>${esc(r.work_order)}</td>
              <td>${esc(r.entry_date)}</td>
              <td>${esc(r.created_by)}</td>
              <td>${fmtDateTime(r.deleted_at)}</td>
              <td>${left(r.deleted_at)}</td>
              <td><div class="row-actions">
                <button class="btn btn-sm btn-ghost" onclick="recycleRestore('data', ${r.id})">恢复</button>
                <button class="btn btn-sm btn-ghost" style="color:var(--danger)" data-purge-entity="data" data-purge-id="${r.id}" data-purge-label="${esc(r.project_no)} 工单 ${esc(r.work_order || '-')}" data-purge-count="0">彻底删除</button>
              </div></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
    <div style="padding:0 16px 12px"><span class="scroll-hint">↔ 恢复项目时，随项目一起删除的数据会一并恢复；彻底删除不可恢复</span></div>`;
}

async function recycleRestore(entity, id) {
  try {
    const r = await API.post('/api/recycle/restore', { entity, ids: [id] });
    const d = r.restoredData || 0;
    toast(entity === 'project' ? `已恢复项目及其 ${d} 条数据` : '已恢复该数据记录', 'ok');
    renderRecycle();
  } catch (e) { toast(e.message, 'err'); }
}

function confirmRecyclePurge(entity, id, label, dataCount) {
  openModal({
    title: '彻底删除', narrow: true,
    body: `<p style="margin:0 0 8px">确定<b style="color:var(--danger)">永久删除</b> ${entity === 'project' ? '项目' : '数据记录'} <b>${esc(label)}</b> 吗？</p>
      ${entity === 'project' && dataCount ? `<p style="margin:0;color:var(--danger);font-size:13px">其下 <b>${dataCount}</b> 条数据记录将一并永久删除，此操作不可恢复。</p>`
        : `<p style="margin:0;color:var(--danger);font-size:13px">此操作不可恢复。</p>`}`,
    footer: `<button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" id="okPurge">永久删除</button>`,
  });
  el('#okPurge').addEventListener('click', async () => {
    try {
      await API.post('/api/recycle/purge', { entity, ids: [id] });
      closeModal();
      toast('已彻底删除', 'ok');
      renderRecycle();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ============================================================
   审计日志（仅管理员）
   ============================================================ */
const AUDIT_ACTIONS = [
  ['create', '新增'], ['update', '修改'], ['soft_delete', '删除'],
  ['restore', '恢复'], ['purge', '彻底删除'], ['import', '导入'], ['status', '状态变更'],
  ['export', '导出'], ['backup', '备份'],
];
const AUDIT_ENTITIES = [['project', '项目'], ['data', '数据'], ['user', '用户'], ['database', '数据库']];
const auditActionLabel = (k) => (AUDIT_ACTIONS.find(([v]) => v === k) || [null, k || '—'])[1];
const auditEntityLabel = (k) => (AUDIT_ENTITIES.find(([v]) => v === k) || [null, k || '—'])[1];

async function renderAudit() {
  if (!canViewAudit()) {
    actions().innerHTML = '';
    content().innerHTML = `<div class="card"><div class="card-body" style="text-align:center;padding:40px 0">
      <p style="margin:0 0 6px;color:var(--danger);font-weight:600">无权查看审计日志</p>
      <p style="margin:0;color:var(--text-3);font-size:13px">审计日志仅对系统管理员开放</p>
    </div></div>`;
    return;
  }
  actions().innerHTML = `<button class="btn" onclick="renderAudit()">
    <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>刷新</button>`;
  const f = state.audit.filters;
  content().innerHTML = `
    <div class="filters">
      <div class="filter-row">
        <div class="field w-140"><label>对象</label>
          <select class="select" id="aEntity"><option value="">全部</option>
            ${AUDIT_ENTITIES.map(([v, l]) => `<option value="${v}" ${f.entity === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="field w-160"><label>动作</label>
          <select class="select" id="aAction"><option value="">全部</option>
            ${AUDIT_ACTIONS.map(([v, l]) => `<option value="${v}" ${f.action === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="field w-160"><label>开始日期</label><input type="date" class="input" id="aFrom" value="${esc(f.date_from || '')}" /></div>
        <div class="field w-160"><label>结束日期</label><input type="date" class="input" id="aTo" value="${esc(f.date_to || '')}" /></div>
        <div class="field w-220"><label>关键词</label><input class="input" id="aKw" placeholder="操作人 / 摘要" value="${esc(f.q || '')}" /></div>
        <div class="filter-actions"><button class="btn btn-ghost" id="aReset">重置</button></div>
      </div>
    </div>
    <div class="card"><div id="auditTable"><div class="card-body"><div class="skeleton" style="height:240px"></div></div></div></div>`;

  const apply = () => {
    state.audit.filters = {
      entity: el('#aEntity').value,
      action: el('#aAction').value,
      date_from: el('#aFrom').value,
      date_to: el('#aTo').value,
      q: el('#aKw').value.trim(),
    };
    state.audit.page = 1;
    loadAudit();
  };
  ['aEntity', 'aAction', 'aFrom', 'aTo'].forEach((id) => el('#' + id).addEventListener('change', apply));
  el('#aKw').addEventListener('input', debounce(apply, 240));
  el('#aReset').addEventListener('click', () => {
    state.audit.filters = {};
    state.audit.page = 1;
    renderAudit();
  });
  loadAudit();
}

async function loadAudit() {
  const f = state.audit.filters;
  const qs = new URLSearchParams({ page: String(state.audit.page), pageSize: String(state.audit.pageSize) });
  Object.entries(f).forEach(([k, v]) => { if (v) qs.set(k, v); });

  let r;
  try {
    r = await API.get('/api/audit-logs?' + qs.toString());
  } catch (e) {
    const box = el('#auditTable');
    if (box) box.innerHTML = `<div class="card-body"><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  const box = el('#auditTable');
  if (!box) return;
  if (!r.rows.length) {
    box.innerHTML = `<div class="empty" style="padding:44px"><p>没有符合条件的日志</p>
      <span>审计日志保留 ${r.keepDays || 180} 天，超期自动清理</span></div>`;
    return;
  }
  box.innerHTML = `
    <div class="table-wrap" style="max-height:calc(100vh - 385px)">
      <table class="data-table">
        <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>摘要</th><th>详情</th></tr></thead>
        <tbody>
          ${r.rows.map((x) => `<tr>
            <td style="white-space:nowrap">${esc(x.created_at)}</td>
            <td>${esc(x.username || '系统')}</td>
            <td><span class="code-chip">${esc(auditActionLabel(x.action))}</span></td>
            <td>${esc(auditEntityLabel(x.entity))}</td>
            <td style="max-width:560px">${esc(x.summary)}</td>
            <td>${auditHasDetail(x)
              ? `<button class="btn btn-sm btn-ghost" data-audit-detail="${x.id}">查看</button>`
              : '<span class="empty-num">—</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${renderPagination(r.total, r.page, r.pageSize)}`;

  box.querySelectorAll('[data-audit-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = r.rows.find((x) => String(x.id) === btn.dataset.auditDetail);
      if (row) openAuditDetail(row);
    });
  });
  box.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = Number(btn.dataset.page);
      if (!p || p === state.audit.page) return;
      state.audit.page = p;
      loadAudit();
    });
  });
}

/** 审计 changes 有两种形态：{字段:{from,to}}（字段级变更）、{ids:[...]}（批量操作影响范围） */
function parseAuditChanges(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  const out = { ids: [], diffs: [], extras: [] };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  Object.entries(obj).forEach(([k, v]) => {
    if (k === 'ids' || k === 'entity_ids') {
      (Array.isArray(v) ? v : [v])
        .filter((n) => n !== null && n !== undefined && n !== '')
        .forEach((n) => out.ids.push(n));
    } else if (v && typeof v === 'object' && !Array.isArray(v) && ('from' in v || 'to' in v)) {
      out.diffs.push([k, v.from, v.to]);
    } else {
      out.extras.push([k, v]);
    }
  });
  return out;
}

/** 该条日志是否有可展示的详情（没有就显示「—」，不出查看按钮） */
function auditHasDetail(row) {
  const p = parseAuditChanges(row && row.changes);
  return p.ids.length > 0 || p.diffs.length > 0 || p.extras.length > 0;
}

/** 查看某条日志详情：摘要 + 影响范围（记录 ID）+ 字段级变更 */
function openAuditDetail(row) {
  const { ids, diffs, extras } = parseAuditChanges(row.changes);
  // 字段键优先取指标字段的中文名，其次取常见档案字段名
  const EXTRA_LABELS = {
    project_no: '项目编号', product_code: '产品代码', project_type: '项目类型', description: '项目简介',
    status: '状态', username: '账号', real_name: '姓名', role: '角色', remark: '备注',
  };
  const labelOf = (k) => (F().find((f) => f.key === k) || {}).label || EXTRA_LABELS[k] || k;
  const fmtVal = (v) => (v === '' || v === null || v === undefined ? '（空）' : String(v));
  const fmtAny = (v) => {
    if (v === null || v === undefined || v === '') return '（空）';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  const metaRows = [];
  if (ids.length) metaRows.push(['涉及记录 ID', ids.join('、')]);
  if (row.entity_id !== null && row.entity_id !== undefined && row.entity_id !== '') {
    metaRows.push(['对象 ID', String(row.entity_id)]);
  }
  extras.forEach(([k, v]) => metaRows.push([labelOf(k), fmtAny(v)]));

  const blocks = [`<p style="margin:0 0 10px;color:var(--text-2);font-size:13px">${esc(row.summary)}</p>`];
  if (metaRows.length) {
    blocks.push(`<div class="table-wrap"><table class="data-table">
      <thead><tr><th>项目</th><th>内容</th></tr></thead>
      <tbody>${metaRows.map(([k, v]) => `<tr>
        <td style="white-space:nowrap">${esc(k)}</td>
        <td>${esc(v)}</td>
      </tr>`).join('')}</tbody></table></div>`);
  }
  if (diffs.length) {
    blocks.push(`<div class="table-wrap"${metaRows.length ? ' style="margin-top:12px"' : ''}><table class="data-table">
      <thead><tr><th>字段</th><th>变更前</th><th>变更后</th></tr></thead>
      <tbody>${diffs.map(([k, from, to]) => `<tr>
        <td>${esc(labelOf(k))}</td>
        <td style="color:var(--text-3)">${esc(fmtVal(from))}</td>
        <td style="font-weight:550">${esc(fmtVal(to))}</td>
      </tr>`).join('')}</tbody></table></div>`);
  } else {
    blocks.push(`<p style="margin:${metaRows.length ? '10px' : '0'} 0 0;color:var(--text-3);font-size:13px">该操作没有字段级变更${ids.length ? '，仅记录受影响的记录 ID' : ''}。</p>`);
  }

  openModal({
    title: '操作详情',
    sub: `${auditActionLabel(row.action)} · ${row.username || '系统'} · ${row.created_at}`,
    narrow: true,
    body: blocks.join(''),
    footer: `<button class="btn" onclick="closeModal()">关闭</button>`,
  });
}

/* ============================================================
   数据库维护（仅系统管理员）
   ============================================================ */
async function renderDatabase() {
  if (!canManageDatabase()) {
    actions().innerHTML = '';
    content().innerHTML = `<div class="card"><div class="card-body" style="text-align:center;padding:40px 0">
      <p style="margin:0 0 6px;color:var(--danger);font-weight:600">无权维护数据库</p>
      <p style="margin:0;color:var(--text-3);font-size:13px">数据库导出、导入与备份仅对系统管理员开放</p>
    </div></div>`;
    return;
  }
  actions().innerHTML = `<button class="btn" onclick="renderDatabase()">
    <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>刷新</button>`;
  content().innerHTML = `<div class="card"><div class="card-body"><div class="skeleton" style="height:220px"></div></div></div>`;

  let info;
  try {
    info = await API.get('/api/admin/db/info');
  } catch (e) {
    content().innerHTML = `<div class="card"><div class="card-body"><p class="muted">${esc(e.message)}</p></div></div>`;
    return;
  }

  const c = info.counts || {};
  content().innerHTML = `
    <div class="stat-grid">
      ${statCard('用户账号', c.users ?? 0, '个', '系统管理员 / 管理员 / 普通用户')}
      ${statCard('项目', c.projects ?? 0, '个', '项目库中的全部项目')}
      ${statCard('数据记录', c.projectData ?? 0, '条', '项目数据表的全部记录')}
      ${statCard('数据库大小', fmtBytes(info.size), '', `最近写入 ${info.mtime}`)}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>导出数据库</h3><span class="sub">下载完整副本</span></div>
        <div class="card-body">
          <p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.75">
            导出包含<b>全部账号、项目、数据与审计日志</b>的 SQLite 文件（<code>.db</code>）。
            使用 <code>VACUUM INTO</code> 生成一致性快照，不会中断正在使用的用户。
          </p>
          <button class="btn btn-primary" id="dbExport">
            <svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/></svg>
            导出并下载
          </button>
          <p style="margin:12px 0 0;color:var(--text-3);font-size:12px">文件名形如 stkj-2026-10-27-18-30-00.db</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>导入数据库</h3><span class="sub">替换全部数据</span></div>
        <div class="card-body">
          <p style="margin:0 0 12px;color:var(--text-2);font-size:13px;line-height:1.75">
            选择从其他服务器导出的 <code>.db</code> 文件，导入前会先校验文件并显示来源数据摘要。
            来源服务器仍在运行时，请先停止服务或使用其「导出数据库」功能，避免漏掉 WAL 中尚未落盘的数据。
          </p>
          <div style="padding:10px 12px;margin-bottom:12px;border:1px solid #f3c9c9;background:var(--danger-weak);border-radius:8px;color:var(--text-2);font-size:12.5px;line-height:1.7">
            <b style="color:var(--danger)">导入会覆盖现有数据</b>：当前账号、项目、数据与审计日志将被来源数据库完全替换；
            导入前会自动备份一份到 <code>backups/</code>；所有登录会话立即失效，需要用来源数据库中的账号重新登录。
          </div>
          <input type="file" class="input" id="dbFile" accept=".db,application/x-sqlite3,application/octet-stream" />
          <p style="margin:8px 0 0;color:var(--text-3);font-size:12px">仅支持 SQLite 数据库文件，单个文件不超过 20 MB。</p>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <h3>备份</h3>
        <span class="sub">保留最近 ${info.keep} 份 · 每天凌晨自动备份</span>
      </div>
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <button class="btn btn-primary" id="dbBackup">
            <svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>
            立即备份
          </button>
          <span style="color:var(--text-3);font-size:12.5px">备份文件存放在服务器 <code>backups/</code> 目录，可直接下载</span>
        </div>
        <div id="dbBackupList">${renderBackupList(info.backups)}</div>
      </div>
    </div>`;

  el('#dbExport').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '正在生成…';
    try {
      const r = await downloadViaFetch('/api/admin/db/export', 'stkj-db.db');
      toast(`已导出 ${r.name}（${fmtBytes(r.size)}）`, 'ok');
      renderDatabase();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.innerHTML = html;
    }
  });

  el('#dbBackup').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '正在备份…';
    try {
      const r = await API.post('/api/admin/db/backup');
      toast(`备份完成：${r.file}（${fmtBytes(r.size)}）`, 'ok');
      renderDatabase();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.innerHTML = html;
    }
  });

  el('#dbFile').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (f) previewDbImport(f);
  });

  document.querySelectorAll('[data-db-backup]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.dbBackup;
      try {
        await downloadViaFetch('/api/admin/db/backups/' + encodeURIComponent(name), name);
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

function renderBackupList(backups) {
  if (!backups || !backups.length) {
    return `<div class="empty" style="padding:30px 20px"><p>暂无备份</p><span>点击「立即备份」创建第一份，或等待每天凌晨的自动备份</span></div>`;
  }
  return `<div class="table-wrap" style="max-height:none">
    <table class="data-table">
      <thead><tr><th>备份文件</th><th>时间</th><th>大小</th><th style="width:90px">操作</th></tr></thead>
      <tbody>
        ${backups.map((b) => `<tr>
          <td><span class="code-chip">${esc(b.name)}</span></td>
          <td>${esc(b.mtime)}</td>
          <td>${fmtBytes(b.size)}</td>
          <td><button class="btn btn-sm btn-ghost" data-db-backup="${esc(b.name)}">下载</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

/** 选择 .db 后先上传校验，拿到摘要再二次确认 */
async function previewDbImport(file) {
  if (file.size > 20 * 1024 * 1024) return toast('文件超过 20 MB，无法导入', 'err');
  const name = file.name || '';
  if (name && !/\.(db|sqlite|sqlite3)$/i.test(name)) {
    return toast('请选择 .db 格式的 SQLite 数据库文件', 'err');
  }
  toast('正在校验数据库文件…');
  let r;
  try {
    const buf = await file.arrayBuffer();
    r = await API.postRaw('/api/admin/db/import-preview', buf);
  } catch (e) {
    return toast(e.message, 'err');
  }
  openDbImportConfirm(r);
}

function openDbImportConfirm(r) {
  const s = r.summary || {};
  const c = s.counts || {};
  const admins = (s.admins || []).join('、');
  openModal({
    title: '确认导入数据库',
    sub: '导入前请核对来源数据',
    narrow: true,
    body: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin-bottom:14px;font-size:13px;color:var(--text-2)">
        <div>用户账号：<b>${c.users ?? 0}</b> 个</div>
        <div>项目：<b>${c.projects ?? 0}</b> 个</div>
        <div>数据记录：<b>${c.project_data ?? 0}</b> 条</div>
        <div>审计日志：<b>${c.audit_logs ?? 0}</b> 条</div>
        <div>文件大小：<b>${fmtBytes(s.size)}</b></div>
        <div>管理员：<b>${esc(admins || '—')}</b></div>
      </div>
      <div style="padding:10px 12px;margin-bottom:14px;border:1px solid #f3c9c9;background:var(--danger-weak);border-radius:8px;color:var(--text-2);font-size:12.5px;line-height:1.75">
        <b style="color:var(--danger)">此操作不可撤销</b>：当前全部账号、项目、数据与审计日志会被来源数据库替换。
        系统会先自动备份当前数据；导入完成后所有会话失效，需要重新登录（默认保留当前管理员密码，见下方选项）。
      </div>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:14px;font-size:12.5px;color:var(--text-2);line-height:1.6">
        <input type="checkbox" id="dbKeepAdmin" checked style="margin-top:2px" />
        <span>保留当前系统管理员账号 <b>${esc((state.user && state.user.username) || '')}</b> 的密码（推荐，避免来源库密码未知导致无法登录）</span>
      </label>
      <label style="display:block;margin-bottom:6px;font-size:12.5px;color:var(--text-2)">请输入「<b>导入</b>」两个字确认</label>
      <input class="input" id="dbConfirmText" placeholder="导入" autocomplete="off" />`,
    footer: `<button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" id="dbImportGo" disabled>确认导入</button>`,
  });

  const input = el('#dbConfirmText');
  const go = el('#dbImportGo');
  const sync = () => { go.disabled = input.value.trim() !== '导入'; };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); go.click(); }
  });
  setTimeout(() => input.focus(), 60);

  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = '正在导入…';
    let out;
    try {
      out = await API.post('/api/admin/db/import-confirm', {
        token: r.token,
        keep_admin: !!(el('#dbKeepAdmin') && el('#dbKeepAdmin').checked),
      });
    } catch (e) {
      toast(e.message, 'err');
      go.disabled = false;
      go.textContent = '确认导入';
      return;
    }
    const after = out.after || {};
    closeModal();
    openModal({
      title: '数据库导入完成',
      narrow: true,
      body: `
        <p style="margin:0 0 8px;color:var(--text-2)">已导入：用户 <b>${after.users ?? 0}</b> 个、项目 <b>${after.projects ?? 0}</b> 个、数据 <b>${after.projectData ?? 0}</b> 条。</p>
        <p style="margin:0 0 8px;color:var(--text-2)">导入前的数据已自动备份为 <code>${esc(out.backup || '')}</code>，可在「备份」列表中下载。</p>
        <p style="margin:0;color:var(--danger);font-size:13px">所有登录会话已失效。${out.keepAdmin
          ? `当前管理员账号 <b>${esc(out.keptAdmin || '')}</b> 的密码已保留，可直接用原密码重新登录。`
          : `请使用来源数据库中的账号重新登录${admins ? `（管理员：${esc(admins)}）` : ''}。`}</p>`,
      footer: `<button class="btn btn-primary" id="dbRelogin">重新登录</button>`,
    });
    el('#dbRelogin').addEventListener('click', () => {
      state.user = null;
      location.reload();
    });
  });
}

/* ============================================================
   弹窗基础
   ============================================================ */
function openModal({ title, sub, body, footer, narrow, wide }) {
  const root = el('#modalRoot');
  root.innerHTML = `
    <div class="modal-mask"></div>
    <div class="modal ${narrow ? 'narrow' : ''} ${wide ? 'wide' : ''}">
      <div class="modal-head">
        <div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
        <button class="btn btn-icon btn-ghost" onclick="closeModal()" title="关闭">
          <svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${footer || ''}</div>
    </div>`;
  root.classList.add('open');
  root.querySelector('.modal-mask').addEventListener('click', closeModal);
  const first = root.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 60);
}
function closeModal() {
  const root = el('#modalRoot');
  root.classList.remove('open');
  root.innerHTML = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  // Ctrl+Enter / Ctrl+S（Mac 为 ⌘+Enter / ⌘+S）：提交当前弹窗
  if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    const btn = document.querySelector('.modal-foot .btn-primary');
    if (btn) btn.click();
    return;
  }
  // 录入表单内 Enter 跳到下一个字段（textarea 换行、按钮触发不受影响）
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    const root = el('#modalRoot');
    if (!root.classList.contains('open')) return;
    const t = e.target;
    if (!t || !root.contains(t)) return;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'LABEL') return;
    if (t.type === 'checkbox' || t.type === 'radio' || t.type === 'file' || t.type === 'submit') return;
    // 可聚焦的字段序：文本/数字/日期输入、下拉框、多行文本（textarea 内按 Enter 不触发跳转，只作跳转目标）
    const fields = [...root.querySelectorAll('input, select, textarea')]
      .filter((n) => !n.disabled && n.type !== 'hidden' && n.type !== 'checkbox' && n.type !== 'radio' && n.type !== 'file');
    const i = fields.indexOf(t);
    if (i >= 0 && i < fields.length - 1) {
      e.preventDefault();
      const nxt = fields[i + 1];
      nxt.focus();
      if (nxt.tagName === 'INPUT' && ['text', 'number', 'date'].includes(nxt.type)) nxt.select();
    } else if (i === fields.length - 1) {
      // 最后一个字段按 Enter 直接触发主按钮（保存）
      e.preventDefault();
      const btn = root.querySelector('.modal-foot .btn-primary');
      if (btn) btn.click();
    }
  }
});

/* ============================================================
   启动
   ============================================================ */
/** 版权年份自动取当前年，避免跨年后信息过期 */
function fillCopyrightYear() {
  const y = String(new Date().getFullYear());
  document.querySelectorAll('#copyrightYear, .copyright-year').forEach((n) => {
    n.textContent = y;
  });
}

async function refreshMeta() {
  state.meta = await API.get('/api/meta');
  // 数据有变动后，筛选联动的可选值也要跟着更新（仅数据页需要）
  if (state.view === 'data') refreshDataOptions();
}

/** 登录成功后进入主应用 */
async function bootApp() {
  await refreshMeta();
  hideLogin();
  paintUser();
  state.view = 'dashboard';
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === 'dashboard');
  });
  el('#viewTitle').textContent = VIEWS.dashboard.title;
  el('#viewSub').textContent = VIEWS.dashboard.sub;
  actions().innerHTML = '';
  navigate('dashboard');
  // 仍在使用初始密码时提醒改密（不强制，可在账号菜单里随时修改）
  if (Number(state.user.pwd_changed) === 0) setTimeout(promptInitialPassword, 400);
}

/** 首次登录 / 初始密码未修改时的改密提醒 */
function promptInitialPassword() {
  openModal({
    title: '请修改初始密码',
    narrow: true,
    body: `<p style="margin:0 0 8px">你当前仍在使用<b>初始密码</b>，为账号安全建议立即修改。</p>
      <p style="margin:0;color:var(--text-3);font-size:13px">修改成功后本提醒不再出现；也可以稍后在右上角账号菜单中修改。</p>`,
    footer: `<button class="btn" onclick="closeModal()">稍后再说</button>
      <button class="btn btn-primary" id="okChangePwd">立即修改</button>`,
  });
  el('#okChangePwd').addEventListener('click', () => { closeModal(); openPasswordModal(); });
}

function bindAuthEvents() {
  el('#loginForm').addEventListener('submit', doLogin);

  // 密码可见切换
  el('#pwdEye').addEventListener('click', () => {
    const p = el('#loginPwd');
    p.type = p.type === 'password' ? 'text' : 'password';
    p.focus();
  });

  // 用户菜单
  el('#userMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    el('#userMenu').classList.toggle('open');
  });
  el('#userMenu').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-act]');
    if (!a) return;
    if (a.dataset.act === 'password') openPasswordModal();
    if (a.dataset.act === 'logout') doLogout();
  });
  document.addEventListener('click', () => el('#userMenu').classList.remove('open'));

  document.querySelectorAll('.nav-item').forEach((n) => {
    n.addEventListener('click', () => navigate(n.dataset.view));
  });
}

(async function boot() {
  fillCopyrightYear();
  bindAuthEvents();
  try {
    // 已有有效会话则直接进入
    const r = await API.get('/api/auth/me');
    state.user = r.user;
    await bootApp();
  } catch {
    showLogin('');
  }
})();
