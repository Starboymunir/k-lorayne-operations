// K.Lorayne Operations — Enterprise CRM Frontend
// Full SPA with 12 page types

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentPage = 'dashboard';
let _categories = [];
let _glossary = null;

// ─── INFO TOOLTIP HELPER ────────────────────────

async function getGlossary() {
  if (_glossary) return _glossary;
  try {
    const r = await fetch('/api/glossary');
    _glossary = await r.json();
  } catch { _glossary = {}; }
  return _glossary;
}

function infoTip(text) {
  return `<span class="info-icon">?<span class="info-tooltip">${escHtml(text)}</span></span>`;
}

// ─── LOADING BAR HELPER ─────────────────────────

let _statusInterval = null;
function startStatusPolling() {
  stopStatusPolling();
  const bar = document.getElementById('loadingBar');
  if (!bar) return;
  _statusInterval = setInterval(async () => {
    try {
      const r = await fetch('/api/status');
      const s = await r.json();
      if (s.state === 'ready' || (s.products && s.orders && s.customers)) {
        bar.remove();
        stopStatusPolling();
        return;
      }
      const parts = [];
      if (s.products) parts.push(`${s.productCount} products ✓`);
      if (s.orders) parts.push(`${s.orderCount} orders ✓`);
      if (!s.customers) parts.push(`loading customers... (${s.customerCount} so far)`);
      const text = bar.querySelector('.loading-bar-text');
      if (text) text.innerHTML = parts.join(' &nbsp;·&nbsp; ');
    } catch {}
  }, 3000);
}
function stopStatusPolling() { clearInterval(_statusInterval); _statusInterval = null; }

// ─── NAVIGATION ─────────────────────────────────

$$('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const page = item.dataset.page;
    if (page) navigateTo(page);
    $('#sidebar').classList.remove('open');
  });
});

$('#menuToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

$('#refreshBtn').addEventListener('click', async () => {
  const btn = $('#refreshBtn');
  btn.classList.add('loading');
  try {
    await fetch('/api/refresh', { method: 'POST' });
    toast('Data refreshed from Shopify', 'success');
    navigateTo(currentPage);
  } catch (err) { toast('Refresh failed', 'error'); }
  finally { btn.classList.remove('loading'); }
});

function navigateTo(page, params) {
  currentPage = page;
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = $(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  const titles = {
    dashboard: 'Dashboard', inventory: 'Inventory Audit',
    replenishment: 'Replenishment', alerts: 'Low-Stock Alerts',
    orders: 'Orders', customers: 'Customers',
    tickets: 'Support Tickets', analytics: 'Analytics & Reports',
    cleanup: 'Inventory Cleanup', settings: 'Settings', 'customer-profile': 'Customer Profile',
    'ticket-detail': 'Ticket Detail', 'order-detail': 'Order Detail',
  };
  $('#pageTitle').textContent = titles[page] || page;
  showLoading();

  const load = {
    dashboard: loadDashboard, inventory: loadInventory,
    replenishment: loadReplenishment, alerts: loadAlerts,
    orders: loadOrders, customers: loadCustomers,
    tickets: loadTickets, analytics: loadAnalytics,
    cleanup: loadCleanup, settings: loadSettings, 'customer-profile': () => loadCustomerProfile(params),
    'ticket-detail': () => loadTicketDetail(params),
    'order-detail': () => loadOrderDetail(params),
  };
  (load[page] || load.dashboard)();
}

function showLoading() {
  $('#content').innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading...</p></div>';
}

// ─── HELPERS ────────────────────────────────────

function fmt(n) { return Number(n).toLocaleString(); }
function fmtMoney(n) { return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
function timeAgo(d) {
  if (!d) return '—';
  const diff = (Date.now() - new Date(d)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function priorityBadge(p) {
  const m = { CRITICAL: 'critical', URGENT: 'urgent', REORDER: 'reorder', WATCH: 'watch', OK: 'ok' };
  return `<span class="badge badge-${m[p] || 'ok'}">${p}</span>`;
}
function velocityBadge(v) {
  const m = { 'FAST MOVER': 'fast', 'REGULAR': 'regular', 'SLOW MOVER': 'slow', 'NO SALES': 'nosales' };
  return `<span class="badge badge-${m[v] || 'nosales'}">${v}</span>`;
}
function tierBadge(t) { return `<span class="badge badge-${(t||'new').toLowerCase()}">${t}</span>`; }
function riskBadge(r) {
  if (r === 'high') return '<span class="badge badge-critical">AT RISK</span>';
  if (r === 'medium') return '<span class="badge badge-urgent">MONITOR</span>';
  return '';
}
function statusBadge(s) {
  const m = { open: 'critical', in_progress: 'urgent', waiting: 'reorder', resolved: 'ok', closed: 'nosales' };
  const l = { open: 'Open', in_progress: 'In Progress', waiting: 'Waiting', resolved: 'Resolved', closed: 'Closed' };
  return `<span class="badge badge-${m[s] || 'ok'}">${l[s] || s}</span>`;
}
function ticketPriorityBadge(p) {
  const m = { urgent: 'critical', high: 'urgent', medium: 'reorder', low: 'ok' };
  return `<span class="badge badge-${m[p] || 'ok'}">${(p||'').toUpperCase()}</span>`;
}
function financialBadge(s) {
  const m = { PAID: 'ok', PARTIALLY_PAID: 'reorder', PENDING: 'urgent', REFUNDED: 'watch', PARTIALLY_REFUNDED: 'reorder', VOIDED: 'nosales', AUTHORIZED: 'fast' };
  return `<span class="badge badge-${m[s] || 'nosales'}">${(s||'').replace(/_/g,' ')}</span>`;
}
function fulfillmentBadge(s) {
  const m = { FULFILLED: 'ok', UNFULFILLED: 'urgent', PARTIALLY_FULFILLED: 'reorder' };
  return `<span class="badge badge-${m[s] || 'nosales'}">${(s||'PENDING').replace(/_/g,' ')}</span>`;
}
function categoryLabel(id) {
  const cat = _categories.find(c => c.id === id);
  return cat ? `${cat.icon} ${cat.label}` : id;
}

function exportCSV(data, filename) {
  if (!data.length) return;
  const keys = Object.keys(data[0]);
  let csv = keys.join(',') + '\n';
  data.forEach(row => {
    csv += keys.map(k => {
      const val = row[k];
      return typeof val === 'string' && (val.includes(',') || val.includes('"'))
        ? `"${val.replace(/"/g, '""')}"` : (val ?? '');
    }).join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
}

// ─── GLOBAL SEARCH ──────────────────────────────

let searchTimeout;
$('#globalSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#searchResults').classList.remove('show'); return; }
  searchTimeout = setTimeout(async () => {
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      const sr = $('#searchResults');
      if (!d.results.length) { sr.innerHTML = '<div class="sr-empty">No results</div>'; sr.classList.add('show'); return; }
      sr.innerHTML = d.results.map(r => `
        <div class="sr-item" data-type="${r.type}" data-id="${r.id}">
          <span class="sr-type">${r.type}</span>
          <div class="sr-text"><strong>${escHtml(r.title)}</strong><span>${escHtml(r.subtitle || '')}</span></div>
          <span class="sr-meta">${escHtml(r.meta || '')}</span>
        </div>
      `).join('');
      sr.classList.add('show');
      sr.querySelectorAll('.sr-item').forEach(el => el.addEventListener('click', () => {
        sr.classList.remove('show');
        $('#globalSearch').value = '';
        const t = el.dataset.type, id = el.dataset.id;
        if (t === 'customer') navigateTo('customer-profile', id);
        else if (t === 'order') navigateTo('order-detail', id);
        else if (t === 'ticket') navigateTo('ticket-detail', id);
      }));
    } catch {}
  }, 300);
});
$('#globalSearch').addEventListener('blur', () => setTimeout(() => $('#searchResults').classList.remove('show'), 200));

// ─── BOOT ───────────────────────────────────────

(async function boot() {
  // Pre-fetch glossary
  getGlossary();
  try {
    const r = await fetch('/api/crm/categories');
    const d = await r.json();
    _categories = d.categories || [];
  } catch {}
  try {
    const r = await fetch('/api/tickets?status=open&status=in_progress');
    const d = await r.json();
    const badge = $('#ticketBadge');
    if (badge && d.total > 0) { badge.textContent = d.total; badge.classList.add('show'); }
  } catch {}
  navigateTo('dashboard');
})();

// ════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════

async function loadDashboard() {
  try {
    const [dRes, gRes, statusRes] = await Promise.all([
      fetch('/api/dashboard'), getGlossary(), fetch('/api/status'),
    ]);
    const d = await dRes.json();
    const g = gRes;
    const status = await statusRes.json();
    if (d.error) throw new Error(d.error);

    $('#storeName').textContent = d.store;
    $('#lastUpdated').textContent = `Updated: ${new Date().toLocaleTimeString()}`;

    const totalAlerts = d.alerts.critical + d.alerts.urgent;
    const badge = $('#alertBadge');
    if (totalAlerts > 0) { badge.textContent = totalAlerts; badge.classList.add('show'); } else badge.classList.remove('show');

    // Revenue chart data
    const revDays = Object.entries(d.revByDay || {});
    const maxRev = Math.max(...revDays.map(([,v]) => v), 1);
    const revBars = revDays.map(([day, val]) => {
      const h = Math.max(2, (val / maxRev) * 80);
      return `<div class="rev-bar" style="height:${h}px" title="${day}: ${fmtMoney(val)}"></div>`;
    }).join('');

    // Loading bar if customers still fetching
    const loadingBar = (!status.customers && status.state === 'fetching')
      ? `<div class="loading-bar" id="loadingBar"><div class="spinner-sm"></div><span class="loading-bar-text">Loading customers... (<span class="loading-bar-count">${status.customerCount}</span> so far)</span></div>`
      : '';

    $('#content').innerHTML = `
      ${loadingBar}
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--green-soft);color:var(--green)">$</div>
          <div class="kpi-data">
            <div class="kpi-value">${fmtMoney(d.revenue)}</div>
            <div class="kpi-label">Revenue (${d.daysCovered}d)</div>
          </div>
        </div>
        <div class="kpi-card clickable" onclick="navigateTo('orders')">
          <div class="kpi-icon" style="background:var(--blue-soft);color:var(--blue)">#</div>
          <div class="kpi-data">
            <div class="kpi-value">${fmt(d.totalOrders)}</div>
            <div class="kpi-label">Orders</div>
          </div>
        </div>
        <div class="kpi-card clickable" onclick="navigateTo('customers')">
          <div class="kpi-icon" style="background:var(--accent-soft);color:var(--accent)">⚡</div>
          <div class="kpi-data">
            <div class="kpi-value">${fmt(d.totalCustomers)}</div>
            <div class="kpi-label">Customers</div>
          </div>
        </div>
        <div class="kpi-card clickable" onclick="navigateTo('tickets')">
          <div class="kpi-icon" style="background:${d.crm.active > 0 ? 'var(--orange-soft)' : 'var(--green-soft)'};color:${d.crm.active > 0 ? 'var(--orange)' : 'var(--green)'}">✉</div>
          <div class="kpi-data">
            <div class="kpi-value">${d.crm.active}</div>
            <div class="kpi-label">Open Tickets</div>
          </div>
        </div>
        <div class="kpi-card clickable" onclick="navigateTo('alerts')">
          <div class="kpi-icon" style="background:${d.alerts.critical > 0 ? 'var(--red-soft)' : 'var(--green-soft)'};color:${d.alerts.critical > 0 ? 'var(--red)' : 'var(--green)'}">!</div>
          <div class="kpi-data">
            <div class="kpi-value">${d.alerts.critical + d.alerts.urgent}</div>
            <div class="kpi-label">Stock Alerts ${infoTip('Products that are out of stock or will run out before the next delivery. Click to see details.')}</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--yellow-soft);color:var(--yellow)">📦</div>
          <div class="kpi-data">
            <div class="kpi-value">${fmtMoney(d.totalInventoryValue)}</div>
            <div class="kpi-label">Inventory Value ${infoTip('Total retail value of all products currently in stock (available units × price).')}</div>
          </div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="dash-col-main">
          <div class="section">
            <div class="section-header">
              <h2 class="section-title">Revenue Trend (30 Days)</h2>
            </div>
            <div class="rev-chart">${revBars}</div>
          </div>

          <div class="section">
            <div class="section-header">
              <h2 class="section-title">Recent Orders</h2>
              <button class="btn btn-sm" onclick="navigateTo('orders')">View All →</button>
            </div>
            <div class="table-wrap"><table><thead><tr>
              <th>Order</th><th>Customer</th><th>Date</th><th>Payment</th><th>Fulfillment</th><th style="text-align:right">Total</th>
            </tr></thead><tbody>
              ${(d.recentOrders || []).map(o => `<tr class="clickable-row" onclick="navigateTo('order-detail','${encodeURIComponent(o.id)}')">
                <td><strong>${escHtml(o.name)}</strong></td>
                <td>${escHtml(o.customer)}</td>
                <td style="font-size:12px">${fmtDate(o.createdAt)}</td>
                <td>${financialBadge(o.financial)}</td>
                <td>${fulfillmentBadge(o.fulfillment)}</td>
                <td style="text-align:right;font-weight:600">${fmtMoney(o.total)}</td>
              </tr>`).join('')}
            </tbody></table></div>
          </div>

          ${d.topIssues.length > 0 ? `
          <div class="section">
            <div class="section-header">
              <h2 class="section-title">Inventory Alerts ${infoTip('These products need attention — they are out of stock or running low on items with proven sales.')}</h2>
              <button class="btn btn-sm" onclick="navigateTo('alerts')">View All →</button>
            </div>
            <div class="table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th style="text-align:right">Stock</th><th style="text-align:right">Sales/mo</th><th>Status ${infoTip('CRITICAL = out of stock with sales. URGENT = will not last until next delivery. REORDER = below safety level.')}</th></tr></thead>
            <tbody>${d.topIssues.map(i => `<tr>
              <td>${escHtml(i.product)}</td>
              <td style="font-family:monospace;font-size:12px">${escHtml(i.sku)}</td>
              <td style="text-align:right;${i.available <= 0 ? 'color:var(--red);font-weight:600' : ''}">${i.available}</td>
              <td style="text-align:right">${i.monthlyVelocity}</td>
              <td>${priorityBadge(i.priority)}</td>
            </tr>`).join('')}</tbody></table></div>
          </div>` : ''}
        </div>

        <div class="dash-col-side">
          <div class="section">
            <div class="section-header"><h2 class="section-title">Customer Segments ${infoTip('Customers are automatically grouped based on their total spending and number of orders. VIP = $500+ or 10+ orders. Loyal = $200+ or 5+ orders. Repeat = 2+ orders. 1-Time = 1 order. New = 0 orders.')}</h2></div>
            <div style="padding:16px">
              ${Object.entries(d.tierCounts || {}).map(([tier, count]) => {
                const colors = { VIP: 'var(--accent)', LOYAL: 'var(--green)', REPEAT: 'var(--blue)', CUSTOMER: 'var(--text-dim)', NEW: 'var(--text-muted)' };
                const pct = d.totalCustomers > 0 ? Math.round((count / d.totalCustomers) * 100) : 0;
                return `<div class="seg-row">
                  <span class="seg-label" style="color:${colors[tier] || 'inherit'}">${tier}</span>
                  <div class="seg-bar-wrap"><div class="seg-bar" style="width:${pct}%;background:${colors[tier]}"></div></div>
                  <span class="seg-count">${count}</span>
                </div>`;
              }).join('')}
            </div>
          </div>

          <div class="section">
            <div class="section-header"><h2 class="section-title">Top Customers</h2></div>
            <div class="top-cust-list">
              ${(d.topCustomers || []).map(c => `
                <div class="top-cust-item clickable" onclick="navigateTo('customer-profile','${encodeURIComponent(c.id)}')">
                  <div class="top-cust-avatar">${(c.name || '?')[0].toUpperCase()}</div>
                  <div class="top-cust-info">
                    <strong>${escHtml(c.name)}</strong>
                    <span>${tierBadge(c.tier)} ${c.totalOrders} orders</span>
                  </div>
                  <div class="top-cust-val">${fmtMoney(c.totalSpent)}</div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="section">
            <div class="section-header"><h2 class="section-title">Recent Activity</h2></div>
            <div class="activity-list">
              ${(d.activity || []).map(a => `
                <div class="activity-item">
                  <div class="activity-dot"></div>
                  <div class="activity-text">
                    <span>${escHtml(a.description)}</span>
                    <span class="activity-time">${timeAgo(a.timestamp)}</span>
                  </div>
                </div>
              `).join('') || '<p style="padding:16px;color:var(--text-muted);font-size:13px">No activity yet</p>'}
            </div>
          </div>
        </div>
      </div>
    `;
    if (loadingBar) startStatusPolling();
  } catch (err) {
    $('#content').innerHTML = `<div class="empty-state"><h3>Error loading dashboard</h3><p>${escHtml(err.message)}</p></div>`;
  }
}

// ════════════════════════════════════════════════
//  ORDERS PAGE
// ════════════════════════════════════════════════

async function loadOrders() {
  try {
    const res = await fetch('/api/orders');
    const data = await res.json();

    let searchTerm = '', filterFin = '', filterFul = '';

    function getFiltered() {
      let items = data.orders;
      if (searchTerm) { const s = searchTerm.toLowerCase(); items = items.filter(o => o.name.toLowerCase().includes(s) || o.customer.toLowerCase().includes(s) || o.customerEmail.toLowerCase().includes(s)); }
      if (filterFin) items = items.filter(o => o.financial === filterFin);
      if (filterFul) items = items.filter(o => (o.fulfillment || 'PENDING') === filterFul);
      return items;
    }

    function render() {
      const items = getFiltered();
      const tbody = document.getElementById('ordBody');
      if (!tbody) return;
      tbody.innerHTML = items.slice(0, 200).map(o => `<tr class="clickable-row" onclick="navigateTo('order-detail','${encodeURIComponent(o.id)}')">
        <td><strong>${escHtml(o.name)}</strong></td>
        <td>${escHtml(o.customer)}</td>
        <td style="font-size:12px">${fmtDate(o.createdAt)}</td>
        <td>${financialBadge(o.financial)}</td>
        <td>${fulfillmentBadge(o.fulfillment)}</td>
        <td style="text-align:right">${o.itemCount} items</td>
        <td style="text-align:right;font-weight:600">${fmtMoney(o.total)}</td>
        ${parseFloat(o.refunded) > 0 ? `<td style="text-align:right;color:var(--red);font-size:12px">-${fmtMoney(o.refunded)}</td>` : '<td></td>'}
      </tr>`).join('');
      document.getElementById('ordCount').textContent = `${items.length} of ${data.total}`;
    }

    $('#content').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--green-soft);color:var(--green)">#</div><div class="kpi-data"><div class="kpi-value">${fmt(data.total)}</div><div class="kpi-label">Total Orders</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--blue-soft);color:var(--blue)">$</div><div class="kpi-data"><div class="kpi-value">${fmtMoney(data.totalRevenue)}</div><div class="kpi-label">Revenue</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--accent-soft);color:var(--accent)">⊘</div><div class="kpi-data"><div class="kpi-value">${fmtMoney(data.avgOrderValue)}</div><div class="kpi-label">Avg Order</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--red-soft);color:var(--red)">↩</div><div class="kpi-data"><div class="kpi-value">${fmtMoney(data.totalRefunds)}</div><div class="kpi-label">Refunds</div></div></div>
      </div>
      <div class="section"><div class="section-header">
        <h2 class="section-title">Orders — <span id="ordCount">${data.total}</span></h2>
        <button class="export-btn" onclick="exportCSV(${JSON.stringify(data.orders.map(o => ({Order:o.name,Customer:o.customer,Email:o.customerEmail,Date:o.createdAt.split('T')[0],Payment:o.financial,Fulfillment:o.fulfillment||'PENDING',Total:o.total,Refunded:o.refunded}))).replace(/"/g,'&quot;')},'orders.csv')">Export CSV</button>
      </div>
      <div class="toolbar">
        <input type="text" class="search-input" id="ordSearch" placeholder="Search orders, customers...">
        <select class="form-input toolbar-select" id="ordFinFilter"><option value="">All Payment</option>
          <option value="PAID">Paid</option><option value="PENDING">Pending</option><option value="REFUNDED">Refunded</option><option value="PARTIALLY_REFUNDED">Partial Refund</option><option value="AUTHORIZED">Authorized</option>
        </select>
        <select class="form-input toolbar-select" id="ordFulFilter"><option value="">All Fulfillment</option>
          <option value="FULFILLED">Fulfilled</option><option value="UNFULFILLED">Unfulfilled</option><option value="PARTIALLY_FULFILLED">Partial</option>
        </select>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>Order</th><th>Customer</th><th>Date</th><th>Payment</th><th>Fulfillment</th><th style="text-align:right">Items</th><th style="text-align:right">Total</th><th style="text-align:right">Refund</th>
      </tr></thead><tbody id="ordBody"></tbody></table></div></div>`;

    $('#ordSearch').addEventListener('input', e => { searchTerm = e.target.value; render(); });
    $('#ordFinFilter').addEventListener('change', e => { filterFin = e.target.value; render(); });
    $('#ordFulFilter').addEventListener('change', e => { filterFul = e.target.value; render(); });
    render();
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ─── ORDER DETAIL ───────────────────────────────

async function loadOrderDetail(orderId) {
  try {
    const { orders } = await (await fetch('/api/orders')).json();
    const order = orders.find(o => o.id === orderId);
    if (!order) throw new Error('Order not found');

    $('#content').innerHTML = `
      <div style="margin-bottom:16px"><button class="btn btn-sm" onclick="navigateTo('orders')">← Back to Orders</button></div>
      <div class="profile-header">
        <div class="profile-avatar" style="background:var(--blue)">${escHtml(order.name)}</div>
        <div class="profile-info">
          <h2>${escHtml(order.name)} ${financialBadge(order.financial)} ${fulfillmentBadge(order.fulfillment)}</h2>
          <div class="profile-meta">
            <span>📅 ${fmtDateTime(order.createdAt)}</span>
            <span>👤 ${escHtml(order.customer)}</span>
            ${order.customerEmail ? `<span>✉ ${escHtml(order.customerEmail)}</span>` : ''}
          </div>
        </div>
        <div class="profile-stats">
          <div><span class="profile-stat-val">${fmtMoney(order.total)}</span><span class="profile-stat-lbl">Total</span></div>
          <div><span class="profile-stat-val">${order.itemCount}</span><span class="profile-stat-lbl">Items</span></div>
          ${parseFloat(order.refunded) > 0 ? `<div><span class="profile-stat-val" style="color:var(--red)">${fmtMoney(order.refunded)}</span><span class="profile-stat-lbl">Refunded</span></div>` : ''}
        </div>
      </div>
      <div class="section">
        <div class="section-header"><h2 class="section-title">Line Items</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th style="text-align:right">Qty</th></tr></thead>
        <tbody>${order.items.map(i => `<tr>
          <td>${escHtml(i.title)}</td>
          <td style="font-family:monospace;font-size:12px">${escHtml(i.sku) || '—'}</td>
          <td style="text-align:right">${i.quantity}</td>
        </tr>`).join('')}</tbody></table></div>
      </div>
      ${order.customerId ? `<div style="margin-top:12px"><button class="btn" onclick="navigateTo('customer-profile','${encodeURIComponent(order.customerId)}')">View Customer Profile →</button></div>` : ''}
    `;
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ════════════════════════════════════════════════
//  INVENTORY PAGES (preserved & polished)
// ════════════════════════════════════════════════

async function loadInventory() {
  try {
    const res = await fetch('/api/inventory');
    const data = await res.json();
    let sortCol = 'daysOfStock', sortDir = 1, searchTerm = '', filterP = 'ALL', velocityPeriod = 'monthly';

    function getVelocityValue(v) {
      return velocityPeriod === 'daily' ? v.dailyVelocity : velocityPeriod === 'weekly' ? v.weeklyVelocity : v.monthlyVelocity;
    }

    function getVelocityLabel() {
      return velocityPeriod === 'daily' ? 'Daily' : velocityPeriod === 'weekly' ? 'Weekly' : 'Monthly';
    }

    function render() {
      let items = data.variants;
      if (searchTerm) { const s = searchTerm.toLowerCase(); items = items.filter(v => v.product.toLowerCase().includes(s) || v.variant.toLowerCase().includes(s) || v.sku.toLowerCase().includes(s) || v.vendor.toLowerCase().includes(s)); }
      if (filterP !== 'ALL') items = items.filter(v => v.velocityClass === filterP);
      items.sort((a, b) => { let va = a[sortCol], vb = b[sortCol]; if (typeof va === 'string') return va.localeCompare(vb) * sortDir; return (va - vb) * sortDir; });
      const tbody = document.getElementById('invBody');
      if (tbody) {
        tbody.innerHTML = items.slice(0, 200).map(v => `<tr>
          <td>${escHtml(v.product)}</td><td>${v.variant === 'Default Title' ? '—' : escHtml(v.variant)}</td>
          <td style="font-family:monospace;font-size:12px">${escHtml(v.sku) || '—'}</td>
          <td style="text-align:right">${v.available}</td><td style="text-align:right">${v.unitsSold}</td>
          <td style="text-align:right">${getVelocityValue(v)}</td>
          <td style="text-align:right;${v.daysOfStock < 14 ? 'color:var(--red);font-weight:600' : v.daysOfStock < 21 ? 'color:var(--orange)' : ''}">${v.daysOfStock === 999 ? '∞' : v.daysOfStock}</td>
          <td>${velocityBadge(v.velocityClass)}</td><td>${priorityBadge(v.priority)}</td>
          <td><span style="padding:2px 6px;border-radius:3px;font-size:11px;font-weight:600;background:${v.abcCategory === 'A' ? 'var(--accent-soft)' : v.abcCategory === 'B' ? 'var(--yellow-soft)' : 'var(--red-soft)'};color:${v.abcCategory === 'A' ? 'var(--accent)' : v.abcCategory === 'B' ? 'var(--yellow)' : 'var(--red)'}">${v.abcCategory}</span></td>
          <td>${v.alertMe ? '<span style="padding:2px 6px;border-radius:3px;font-size:11px;font-weight:600;background:var(--red-soft);color:var(--red)">ALERT</span>' : '—'}</td>
        </tr>`).join('');
        document.getElementById('invCount').textContent = `${items.length} of ${data.variants.length} variants`;
      }
    }

    $('#content').innerHTML = `
      <div class="section"><div class="section-header">
        <h2 class="section-title">Inventory — <span id="invCount">${data.variants.length} variants</span></h2>
        <button class="export-btn" id="exportInvBtn">Export CSV</button>
      </div>
      <div class="toolbar">
        <input type="text" class="search-input" id="invSearch" placeholder="Search products, SKUs, vendors...">
        <div class="filter-group">
          <button class="filter-btn active" data-filter="ALL">All</button>
          <button class="filter-btn" data-filter="FAST MOVER">Fast</button>
          <button class="filter-btn" data-filter="REGULAR">Regular</button>
          <button class="filter-btn" data-filter="SLOW MOVER">Slow</button>
          <button class="filter-btn" data-filter="NO SALES">No Sales</button>
        </div>
        <div class="filter-group" style="margin-left:auto">
          <button class="filter-btn active" data-vel="monthly" style="font-size:12px">Monthly</button>
          <button class="filter-btn" data-vel="weekly" style="font-size:12px">Weekly</button>
          <button class="filter-btn" data-vel="daily" style="font-size:12px">Daily</button>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th data-sort="product">Product</th><th data-sort="variant">Variant</th><th data-sort="sku">SKU</th>
        <th data-sort="available" style="text-align:right">Stock</th><th data-sort="unitsSold" style="text-align:right">Sold</th>
        <th data-sort="monthlyVelocity" style="text-align:right"><span id="velLabel">Monthly</span></th><th data-sort="daysOfStock" style="text-align:right">Days Left</th>
        <th data-sort="velocityClass">Velocity ${infoTip('FAST MOVER = sells 10+ units/month. REGULAR = 3-9 units/month. SLOW MOVER = under 3 units/month. NO SALES = zero sales in the reporting period.')}</th><th data-sort="priority">Status ${infoTip('CRITICAL = out of stock with sales history. URGENT = less than 14 days of stock left. REORDER = below safety level. WATCH = running lower than ideal. OK = well stocked.')}</th>
        <th data-sort="abcCategory">ABC</th><th data-sort="alertMe">Alert</th>
      </tr></thead><tbody id="invBody"></tbody></table></div></div>`;

    $('#invSearch').addEventListener('input', e => { searchTerm = e.target.value; render(); });
    $$('.filter-btn[data-filter]').forEach(btn => btn.addEventListener('click', () => { $$('.filter-btn[data-filter]').forEach(b => b.classList.remove('active')); btn.classList.add('active'); filterP = btn.dataset.filter; render(); }));
    $$('.filter-btn[data-vel]').forEach(btn => btn.addEventListener('click', () => { $$('.filter-btn[data-vel]').forEach(b => b.classList.remove('active')); btn.classList.add('active'); velocityPeriod = btn.dataset.vel; document.getElementById('velLabel').textContent = getVelocityLabel(); render(); }));
    $$('th[data-sort]').forEach(th => th.addEventListener('click', () => { const c = th.dataset.sort; if (sortCol === c) sortDir *= -1; else { sortCol = c; sortDir = 1; } render(); }));
    $('#exportInvBtn').addEventListener('click', () => exportCSV(data.variants, `inventory-${new Date().toISOString().split('T')[0]}.csv`));
    render();
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

async function loadReplenishment() {
  try {
    const res = await fetch('/api/replenishment');
    const data = await res.json();
    const totalEstCost = data.items.filter(i => ['CRITICAL','URGENT','REORDER'].includes(i.priority)).reduce((s, i) => s + i.suggestedQty * i.price * 0.4, 0);
    let filterP = 'ALL', searchT = '';

    function render() {
      let items = data.items;
      if (searchT) { const s = searchT.toLowerCase(); items = items.filter(v => v.product.toLowerCase().includes(s) || v.sku.toLowerCase().includes(s) || v.vendor.toLowerCase().includes(s)); }
      if (filterP !== 'ALL') items = items.filter(v => v.priority === filterP);
      items.sort((a, b) => { const o = { CRITICAL: 0, URGENT: 1, REORDER: 2, WATCH: 3 }; return (o[a.priority] ?? 9) - (o[b.priority] ?? 9); });
      const tbody = document.getElementById('replBody');
      if (tbody) {
        tbody.innerHTML = items.map(v => `<tr>
          <td>${priorityBadge(v.priority)}</td><td>${escHtml(v.product)}</td>
          <td>${v.variant === 'Default Title' ? '—' : escHtml(v.variant)}</td>
          <td style="font-family:monospace;font-size:12px">${escHtml(v.sku)}</td><td>${escHtml(v.vendor)}</td>
          <td style="text-align:right">${v.available}</td>
          <td style="text-align:right;${v.daysOfStock < 14 ? 'color:var(--red);font-weight:600' : ''}">${v.daysOfStock === 999 ? '∞' : v.daysOfStock}d</td>
          <td style="text-align:right">${v.monthlyVelocity}/mo</td>
          <td style="text-align:right;font-weight:600;color:var(--accent)">${v.suggestedQty}</td>
        </tr>`).join('');
        document.getElementById('replCount').textContent = `${items.length} items`;
      }
    }

    $('#content').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--red-soft);color:var(--red)">!</div><div class="kpi-data"><div class="kpi-value">${data.summary.critical}</div><div class="kpi-label">Critical ${infoTip('Out of stock items that had sales — need immediate reorder.')}</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--orange-soft);color:var(--orange)">⚠</div><div class="kpi-data"><div class="kpi-value">${data.summary.urgent}</div><div class="kpi-label">Urgent ${infoTip('Will run out in less than 14 days based on current sales rate.')}</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--yellow-soft);color:var(--yellow)">↻</div><div class="kpi-data"><div class="kpi-value">${data.summary.reorder}</div><div class="kpi-label">Reorder ${infoTip('Stock is below the recommended safety level — add to your next purchase order.')}</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--accent-soft);color:var(--accent)">📦</div><div class="kpi-data"><div class="kpi-value">${fmt(data.summary.totalUnitsToOrder)}</div><div class="kpi-label">Units to Order ${infoTip('Total units you should order now to cover the next 60 days of sales.')}</div><div class="kpi-sub">Est: ${fmtMoney(totalEstCost)}</div></div></div>
      </div>
      <div class="section"><div class="section-header">
        <h2 class="section-title">Purchase Order — <span id="replCount">${data.items.length} items</span></h2>
        <button class="export-btn" id="exportReplBtn">Export CSV</button>
      </div>
      <div class="toolbar">
        <input type="text" class="search-input" id="replSearch" placeholder="Search products, SKUs, vendors...">
        <div class="filter-group">
          <button class="filter-btn active" data-rfilter="ALL">All</button>
          <button class="filter-btn" data-rfilter="CRITICAL">Critical</button>
          <button class="filter-btn" data-rfilter="URGENT">Urgent</button>
          <button class="filter-btn" data-rfilter="REORDER">Reorder</button>
          <button class="filter-btn" data-rfilter="WATCH">Watch</button>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>Status</th><th>Product</th><th>Variant</th><th>SKU</th><th>Vendor</th>
        <th style="text-align:right">Stock</th><th style="text-align:right">Days Left</th>
        <th style="text-align:right">Sales</th><th style="text-align:right">Order Qty</th>
      </tr></thead><tbody id="replBody"></tbody></table></div></div>`;

    $('#replSearch')?.addEventListener('input', e => { searchT = e.target.value; render(); });
    $$('[data-rfilter]').forEach(btn => btn.addEventListener('click', () => { $$('[data-rfilter]').forEach(b => b.classList.remove('active')); btn.classList.add('active'); filterP = btn.dataset.rfilter; render(); }));
    $('#exportReplBtn')?.addEventListener('click', () => exportCSV(data.items.map(i => ({ Priority: i.priority, SKU: i.sku, Product: i.product, Variant: i.variant, Vendor: i.vendor, Stock: i.available, DaysLeft: i.daysOfStock, MonthlySales: i.monthlyVelocity, OrderQty: i.suggestedQty })), 'reorder-list.csv'));
    render();
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

async function loadAlerts() {
  try {
    const res = await fetch('/api/alerts');
    const data = await res.json();
    const groups = [
      { key: 'CRITICAL', title: 'Critical — Order Immediately', color: 'var(--red)' },
      { key: 'URGENT', title: 'Urgent — Add to This Week\'s PO', color: 'var(--orange)' },
      { key: 'REORDER', title: 'Reorder — Below Safety Stock', color: 'var(--yellow)' },
      { key: 'WATCH', title: 'Watch — Monitor This Week', color: 'var(--blue)' },
    ];
    const byGroup = {};
    data.alerts.forEach(a => { if (!byGroup[a.priority]) byGroup[a.priority] = []; byGroup[a.priority].push(a); });

    const counts = groups.map(g => (byGroup[g.key] || []).length);
    $('#content').innerHTML = `
      <div class="kpi-grid">
        ${groups.map((g, i) => `<div class="kpi-card"><div class="kpi-icon" style="background:${g.color}22;color:${g.color}">!</div><div class="kpi-data"><div class="kpi-value" style="color:${g.color}">${counts[i]}</div><div class="kpi-label">${g.key}</div></div></div>`).join('')}
      </div>
      ${groups.map(g => {
        const items = byGroup[g.key] || [];
        if (!items.length) return '';
        const alertTips = { CRITICAL: 'These items are out of stock and have proven sales — they are losing you revenue right now.', URGENT: 'These items will run out within 14 days at current sales pace.', REORDER: 'Below safety stock — include in your next purchase order.', WATCH: 'Stock is getting low, keep an eye on these this week.' };
        return `<div class="section"><div class="section-header"><h2 class="section-title" style="color:${g.color}">${g.title} (${items.length}) ${infoTip(alertTips[g.key] || '')}</h2></div>
          <div class="table-wrap"><table><thead><tr><th>Product</th><th>Variant</th><th>SKU</th><th style="text-align:right">Stock</th><th style="text-align:right">Days Left</th><th style="text-align:right">Monthly</th><th style="text-align:right">Order</th></tr></thead>
          <tbody>${items.map(a => `<tr>
            <td>${escHtml(a.product)}</td><td>${a.variant === 'Default Title' ? '—' : escHtml(a.variant)}</td>
            <td style="font-family:monospace;font-size:12px">${escHtml(a.sku) || '—'}</td>
            <td style="text-align:right;${a.available <= 0 ? 'color:var(--red);font-weight:600' : ''}">${a.available}</td>
            <td style="text-align:right">${a.daysOfStock === 999 ? '∞' : a.daysOfStock}</td>
            <td style="text-align:right">${a.monthlyVelocity}/mo</td>
            <td style="text-align:right;font-weight:600;color:var(--accent)">${a.suggestedQty}</td>
          </tr>`).join('')}</tbody></table></div></div>`;
      }).join('')}
      ${data.total === 0 ? '<div class="empty-state"><h3>All Clear!</h3><p>No low-stock alerts right now.</p></div>' : ''}`;
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ════════════════════════════════════════════════
//  CUSTOMERS
// ════════════════════════════════════════════════

async function loadCustomers() {
  try {
    let searchTerm = '', filterTier = 'all', sortCol = 'totalSpent', currentPage = 1;
    const pageSize = 50;
    let lastData = null;

    async function fetchAndRender() {
      const params = new URLSearchParams({ page: currentPage, limit: pageSize });
      if (searchTerm) params.set('search', searchTerm);
      if (filterTier !== 'all') params.set('tier', filterTier);
      if (sortCol === 'name') params.set('sort', 'name');
      else if (sortCol === 'totalOrders' || sortCol === 'recentOrders90d') params.set('sort', 'orders');
      else if (sortCol === 'lastOrder') params.set('sort', 'recent');
      const res = await fetch('/api/customers?' + params);
      const data = await res.json();
      lastData = data;

      const tbody = document.getElementById('custBody');
      if (tbody) {
        tbody.innerHTML = data.customers.map(c => `<tr class="clickable-row" onclick="navigateTo('customer-profile','${encodeURIComponent(c.id)}')">
          <td><div class="cell-with-avatar"><div class="mini-avatar">${(c.name || '?')[0].toUpperCase()}</div><div><strong>${escHtml(c.name) || '(no name)'}</strong><div style="font-size:11px;color:var(--text-muted)">${escHtml(c.email) || ''}</div></div></div></td>
          <td>${tierBadge(c.tier)} ${riskBadge(c.riskLevel)}</td>
          <td style="text-align:right">${c.totalOrders}</td>
          <td style="text-align:right;font-weight:600">${fmtMoney(c.totalSpent)}</td>
          <td style="text-align:right">${fmtMoney(c.avgOrderValue)}</td>
          <td style="text-align:right">${c.recentOrders90d}</td>
          <td style="font-size:12px;color:var(--text-dim)">${escHtml(c.location) || '—'}</td>
          <td style="font-size:12px">${c.lastOrder ? timeAgo(c.lastOrder) : '—'}</td>
        </tr>`).join('');
      }
      document.getElementById('custCount').textContent = `${data.totalFiltered} of ${data.total}`;

      // Pagination controls
      const pager = document.getElementById('custPager');
      if (pager) {
        const { page: pg, totalPages: tp } = data;
        pager.innerHTML = `
          <button class="btn btn-sm" ${pg <= 1 ? 'disabled' : ''} onclick="window.__custPage(${pg - 1})">← Prev</button>
          <span style="color:var(--text-muted);font-size:13px">Page ${pg} of ${tp}</span>
          <button class="btn btn-sm" ${pg >= tp ? 'disabled' : ''} onclick="window.__custPage(${pg + 1})">Next →</button>
        `;
      }

      // Update tier count cards
      if (data.tierCounts) {
        Object.entries(data.tierCounts).forEach(([tier, count]) => {
          const el = document.getElementById('tierCount_' + tier);
          if (el) el.textContent = count;
        });
      }
      const arEl = document.getElementById('tierCount_ATRISK');
      if (arEl) arEl.textContent = data.atRisk || 0;
    }

    window.__custPage = (p) => { currentPage = p; fetchAndRender(); };

    // Initial tier counts fetch (just for the header cards)
    const initRes = await fetch('/api/customers?limit=1');
    const initData = await initRes.json();

    const tierColors = { VIP: '--accent', LOYAL: '--green', REPEAT: '--blue', CUSTOMER: '--text-dim', NEW: '--text-muted' };
    const g = await getGlossary();
    const tierTips = { VIP: g?.tiers?.VIP?.description, LOYAL: g?.tiers?.LOYAL?.description, REPEAT: g?.tiers?.REPEAT?.description, CUSTOMER: g?.tiers?.CUSTOMER?.description, NEW: g?.tiers?.NEW?.description };

    $('#content').innerHTML = `
      <div class="kpi-grid">
        ${Object.entries(initData.tierCounts).map(([tier, count]) => {
          const c = tierColors[tier] || '--text-dim';
          const tip = tierTips[tier] ? infoTip(tierTips[tier]) : '';
          return `<div class="kpi-card mini clickable" onclick="document.querySelector('[data-cfilter=${tier}]')?.click()">
            <div class="kpi-value" style="color:var(${c});font-size:22px" id="tierCount_${tier}">${count}</div>
            <div class="kpi-label">${tier} ${tip}</div>
          </div>`;
        }).join('')}
        <div class="kpi-card mini"><div class="kpi-value" style="color:var(--red);font-size:22px" id="tierCount_ATRISK">${initData.atRisk || 0}</div><div class="kpi-label">At Risk ${infoTip(g?.risk?.high?.description || 'Customers who have not ordered in 120+ days and may be lost.')}</div></div>
      </div>
      <div class="section"><div class="section-header">
        <h2 class="section-title">Customers — <span id="custCount">${initData.total}</span></h2>
        <button class="export-btn" id="exportCustBtn">Export CSV</button>
      </div>
      <div class="toolbar">
        <input type="text" class="search-input" id="custSearch" placeholder="Search by name, email...">
        <div class="filter-group">
          <button class="filter-btn active" data-cfilter="all">All</button>
          <button class="filter-btn" data-cfilter="VIP">VIP</button>
          <button class="filter-btn" data-cfilter="LOYAL">Loyal</button>
          <button class="filter-btn" data-cfilter="REPEAT">Repeat</button>
          <button class="filter-btn" data-cfilter="CUSTOMER">1-Time</button>
          <button class="filter-btn" data-cfilter="NEW">New</button>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th data-csort="name">Customer</th><th data-csort="tier">Segment ${infoTip('Tier + Risk. Tier is based on spending and order count. Risk shows if a customer has not ordered recently.')}</th>
        <th data-csort="totalOrders" style="text-align:right">Orders</th><th data-csort="totalSpent" style="text-align:right">Total Spent</th>
        <th data-csort="avgOrderValue" style="text-align:right">AOV</th>
        <th data-csort="recentOrders90d" style="text-align:right">Recent (90d)</th>
        <th data-csort="location">Location</th><th data-csort="lastOrder">Last Order</th>
      </tr></thead><tbody id="custBody"></tbody></table></div>
      <div id="custPager" style="display:flex;align-items:center;justify-content:center;gap:12px;padding:16px 0"></div></div>`;

    let searchTimeout;
    $('#custSearch')?.addEventListener('input', e => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => { searchTerm = e.target.value; currentPage = 1; fetchAndRender(); }, 300);
    });
    $$('[data-cfilter]').forEach(btn => btn.addEventListener('click', () => {
      $$('[data-cfilter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterTier = btn.dataset.cfilter;
      currentPage = 1;
      fetchAndRender();
    }));
    $$('th[data-csort]').forEach(th => th.addEventListener('click', () => {
      sortCol = th.dataset.csort;
      currentPage = 1;
      fetchAndRender();
    }));
    $('#exportCustBtn')?.addEventListener('click', async () => {
      const all = await fetch('/api/customers?limit=200&page=1').then(r => r.json());
      exportCSV(all.customers.map(c => ({Name:c.name,Email:c.email,Tier:c.tier,Orders:c.totalOrders,Spent:c.totalSpent,AOV:c.avgOrderValue,Location:c.location})), 'customers.csv');
    });
    await fetchAndRender();
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ─── CUSTOMER PROFILE ───────────────────────────

async function loadCustomerProfile(shopifyId) {
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(shopifyId)}`);
    const c = await res.json();
    if (c.error) throw new Error(c.error);

    const avgOrder = c.avgOrderValue || '0.00';

    $('#content').innerHTML = `
      <div style="margin-bottom:16px"><button class="btn btn-sm" onclick="navigateTo('customers')">← Back to Customers</button></div>

      <div class="profile-header">
        <div class="profile-avatar">${(c.name || '?')[0].toUpperCase()}</div>
        <div class="profile-info">
          <h2>${escHtml(c.name)} ${tierBadge(c.tier)} ${riskBadge(c.riskLevel)}</h2>
          <div class="profile-meta">
            ${c.email ? `<span>✉ ${escHtml(c.email)}</span>` : ''}
            ${c.phone ? `<span>📱 ${escHtml(c.phone)}</span>` : ''}
            ${c.location ? `<span>📍 ${escHtml(c.location)}</span>` : ''}
            <span>📅 Customer since ${fmtDate(c.createdAt)}</span>
          </div>
        </div>
        <div class="profile-stats">
          <div><span class="profile-stat-val">${fmtMoney(c.totalSpent)}</span><span class="profile-stat-lbl">Lifetime Value</span></div>
          <div><span class="profile-stat-val">${c.totalOrders}</span><span class="profile-stat-lbl">Total Orders</span></div>
          <div><span class="profile-stat-val">${fmtMoney(avgOrder)}</span><span class="profile-stat-lbl">Avg Order</span></div>
          <div><span class="profile-stat-val">${c.recentOrders90d || 0}</span><span class="profile-stat-lbl">Recent (90d)</span></div>
        </div>
      </div>

      <div class="profile-grid">
        <div class="profile-col">
          ${c.topProducts && c.topProducts.length > 0 ? `
          <div class="section" style="margin-bottom:16px">
            <div class="section-header"><h2 class="section-title">Top Products</h2></div>
            <div class="table-wrap"><table><thead><tr><th>Product</th><th style="text-align:right">Qty Purchased</th></tr></thead>
            <tbody>${c.topProducts.map(p => `<tr><td>${escHtml(p.title)}</td><td style="text-align:right;font-weight:600">${p.quantity}</td></tr>`).join('')}</tbody></table></div>
          </div>` : ''}

          <div class="section">
            <div class="section-header"><h2 class="section-title">Order History (${c.orders.length})</h2></div>
            ${c.orders.length > 0 ? `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Date</th><th>Payment</th><th>Fulfillment</th><th style="text-align:right">Total</th></tr></thead>
            <tbody>${c.orders.map(o => `<tr>
              <td><strong>${escHtml(o.name)}</strong></td>
              <td>${fmtDate(o.createdAt)}</td>
              <td>${financialBadge(o.financial)}</td>
              <td>${fulfillmentBadge(o.fulfillment)}</td>
              <td style="text-align:right;font-weight:500">${fmtMoney(o.total)}</td>
            </tr>`).join('')}</tbody></table></div>` : '<p style="padding:20px;color:var(--text-muted)">No orders found in last 90 days.</p>'}
          </div>

          <div class="section" style="margin-top:16px">
            <div class="section-header">
              <h2 class="section-title">Support Tickets (${c.tickets.length})</h2>
              <button class="btn btn-sm" onclick="showNewTicketModal('${encodeURIComponent(c.id)}','${escHtml(c.name)}','${escHtml(c.email)}')">+ New Ticket</button>
            </div>
            ${c.tickets.length > 0 ? c.tickets.map(t => `
              <div class="ticket-card" onclick="navigateTo('ticket-detail','${t.id}')">
                <div class="ticket-card-top">
                  <span class="ticket-id">${t.id}</span>
                  ${statusBadge(t.status)} ${ticketPriorityBadge(t.priority)}
                  <span class="ticket-time">${timeAgo(t.createdAt)}</span>
                </div>
                <div class="ticket-card-subject">${escHtml(t.subject)}</div>
              </div>
            `).join('') : '<p style="padding:20px;color:var(--text-muted)">No tickets for this customer.</p>'}
          </div>
        </div>

        <div class="profile-col-side">
          <div class="section">
            <div style="padding:16px">
              <h3 style="font-size:12px;color:var(--text-muted);font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">NOTES</h3>
              <div id="custNotes">
                ${(c.notes || []).map(n => `
                  <div class="note-item">
                    <div class="note-meta">${escHtml(n.author)} · ${fmtDateTime(n.createdAt)}</div>
                    <div class="note-text">${escHtml(n.text).replace(/\n/g, '<br>')}</div>
                  </div>
                `).join('') || '<p style="color:var(--text-muted);font-size:13px;">No notes yet.</p>'}
              </div>
              <div style="margin-top:12px">
                <textarea id="custNoteText" class="form-input" rows="2" placeholder="Add a note..." style="font-size:13px;"></textarea>
                <button class="btn btn-sm" id="addCustNoteBtn" style="margin-top:6px;width:100%;">Add Note</button>
              </div>
            </div>
          </div>

          <div class="section" style="margin-top:16px">
            <div style="padding:16px">
              <h3 style="font-size:12px;color:var(--text-muted);font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">TAGS</h3>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;" id="tagContainer">
                ${(c.customTags || []).map(t => `<span class="badge badge-reorder tag-removable" data-tag="${escHtml(t)}">${escHtml(t)} ×</span>`).join('')}
              </div>
              <div style="display:flex;gap:6px;">
                <input type="text" id="newTagInput" class="form-input" placeholder="New tag..." style="font-size:12px;">
                <button class="btn btn-sm" id="addTagBtn">Add</button>
              </div>
              <div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap;">
                ${['VIP', 'Needs Follow-up', 'Return Risk', 'Influencer', 'Wholesale', 'Priority Support'].map(t => `<button class="btn btn-sm quick-tag" data-qt="${t}" style="font-size:11px;padding:3px 8px;">${t}</button>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Wire events
    $('#addCustNoteBtn').addEventListener('click', async () => {
      const text = $('#custNoteText').value.trim();
      if (!text) return;
      await fetch(`/api/customers/${encodeURIComponent(shopifyId)}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      toast('Note added', 'success');
      navigateTo('customer-profile', shopifyId);
    });

    let currentTags = [...(c.customTags || [])];
    async function saveTags() {
      await fetch(`/api/customers/${encodeURIComponent(shopifyId)}/tags`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: currentTags }),
      });
    }
    $('#addTagBtn').addEventListener('click', async () => {
      const tag = $('#newTagInput').value.trim();
      if (!tag || currentTags.includes(tag)) return;
      currentTags.push(tag); await saveTags(); toast('Tag added', 'success');
      navigateTo('customer-profile', shopifyId);
    });
    $$('.quick-tag').forEach(btn => btn.addEventListener('click', async () => {
      const tag = btn.dataset.qt; if (currentTags.includes(tag)) return;
      currentTags.push(tag); await saveTags(); toast('Tag added', 'success');
      navigateTo('customer-profile', shopifyId);
    }));
    $$('.tag-removable').forEach(el => el.addEventListener('click', async (e) => {
      e.stopPropagation();
      currentTags = currentTags.filter(t => t !== el.dataset.tag); await saveTags();
      navigateTo('customer-profile', shopifyId);
    }));
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ════════════════════════════════════════════════
//  SUPPORT TICKETS
// ════════════════════════════════════════════════

async function loadTickets() {
  try {
    const [tRes, cRes] = await Promise.all([fetch('/api/tickets'), fetch('/api/crm/categories')]);
    const tData = await tRes.json();
    const cData = await cRes.json();
    _categories = cData.categories || [];

    let filterStatus = 'active', searchTerm = '';

    function getFiltered() {
      let tickets = tData.tickets;
      if (searchTerm) { const s = searchTerm.toLowerCase(); tickets = tickets.filter(t => t.subject.toLowerCase().includes(s) || t.customerName.toLowerCase().includes(s) || (t.customerEmail||'').toLowerCase().includes(s) || t.id.toLowerCase().includes(s)); }
      if (filterStatus === 'active') tickets = tickets.filter(t => !['resolved', 'closed'].includes(t.status));
      else if (filterStatus !== 'all') tickets = tickets.filter(t => t.status === filterStatus);
      return tickets;
    }

    function render() {
      const tickets = getFiltered();
      const list = document.getElementById('ticketList');
      if (!list) return;
      if (!tickets.length) { list.innerHTML = '<div class="empty-state" style="padding:40px"><h3>No tickets found</h3><p>Create a new ticket or adjust filters.</p></div>'; return; }
      list.innerHTML = tickets.map(t => `
        <div class="ticket-card" onclick="navigateTo('ticket-detail', '${t.id}')">
          <div class="ticket-card-top">
            <span class="ticket-id">${t.id}</span>
            ${statusBadge(t.status)} ${ticketPriorityBadge(t.priority)}
            <span class="ticket-category">${categoryLabel(t.category)}</span>
            ${t.orderName ? `<span class="ticket-order">🧾 ${t.orderName}</span>` : ''}
            <span class="ticket-time">${timeAgo(t.createdAt)}</span>
          </div>
          <div class="ticket-card-subject">${escHtml(t.subject)}</div>
          <div class="ticket-card-meta">
            <span>👤 ${escHtml(t.customerName)}</span>
            ${t.customerEmail ? `<span style="color:var(--text-muted)">${escHtml(t.customerEmail)}</span>` : ''}
            <span style="margin-left:auto">${t.notes.length} note${t.notes.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
      `).join('');
    }

    const sc = { open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0 };
    tData.tickets.forEach(t => { sc[t.status] = (sc[t.status] || 0) + 1; });
    const activeCount = sc.open + sc.in_progress + sc.waiting;

    $('#content').innerHTML = `
      <div class="section-header" style="padding:0 0 16px;border:none;">
        <h2 class="section-title">Support Tickets (${tData.total})</h2>
        <button class="btn btn-primary" id="newTicketBtn">+ New Ticket</button>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card mini clickable" data-tfilter="active"><div class="kpi-value" style="color:var(--orange);font-size:20px">${activeCount}</div><div class="kpi-label">Active</div></div>
        <div class="kpi-card mini clickable" data-tfilter="open"><div class="kpi-value" style="color:var(--red);font-size:20px">${sc.open}</div><div class="kpi-label">Open</div></div>
        <div class="kpi-card mini clickable" data-tfilter="in_progress"><div class="kpi-value" style="color:var(--orange);font-size:20px">${sc.in_progress}</div><div class="kpi-label">In Progress</div></div>
        <div class="kpi-card mini clickable" data-tfilter="waiting"><div class="kpi-value" style="color:var(--yellow);font-size:20px">${sc.waiting}</div><div class="kpi-label">Waiting</div></div>
        <div class="kpi-card mini clickable" data-tfilter="all"><div class="kpi-value" style="font-size:20px">${tData.total}</div><div class="kpi-label">All Time</div></div>
      </div>

      <div class="section">
        <div class="toolbar">
          <input type="text" class="search-input" id="ticketSearch" placeholder="Search by subject, customer, ticket ID...">
        </div>
        <div id="ticketList" class="ticket-list"></div>
      </div>
    `;

    $('#ticketSearch').addEventListener('input', e => { searchTerm = e.target.value; render(); });
    $$('[data-tfilter]').forEach(el => el.addEventListener('click', () => {
      $$('[data-tfilter]').forEach(e2 => e2.classList.remove('active-filter'));
      el.classList.add('active-filter'); filterStatus = el.dataset.tfilter; render();
    }));
    $('#newTicketBtn').addEventListener('click', () => showNewTicketModal());
    render();
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ─── NEW TICKET MODAL ───────────────────────────

function showNewTicketModal(customerId, customerName, customerEmail) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header"><h3>Create Support Ticket</h3><button class="modal-close" id="modalClose">&times;</button></div>
      <div class="modal-body">
        <div class="form-group"><label>Customer Name</label><input type="text" id="tkName" class="form-input" value="${escHtml(decodeURIComponent(customerName || ''))}" placeholder="Customer name"></div>
        <div class="form-group"><label>Customer Email</label><input type="email" id="tkEmail" class="form-input" value="${escHtml(decodeURIComponent(customerEmail || ''))}" placeholder="email@example.com"></div>
        <div class="form-row">
          <div class="form-group"><label>Category</label><select id="tkCategory" class="form-input">${_categories.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('')}</select></div>
          <div class="form-group"><label>Priority</label><select id="tkPriority" class="form-input"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
        </div>
        <div class="form-group"><label>Subject</label><input type="text" id="tkSubject" class="form-input" placeholder="Brief description"></div>
        <div class="form-group"><label>Description</label><textarea id="tkDesc" class="form-input form-textarea" placeholder="Full details..."></textarea></div>
      </div>
      <div class="modal-footer"><button class="btn" id="modalCancel">Cancel</button><button class="btn btn-primary" id="modalSubmit">Create Ticket</button></div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.classList.add('show'), 10);

  const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector('#modalClose').addEventListener('click', close);
  overlay.querySelector('#modalCancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.querySelector('#modalSubmit').addEventListener('click', async () => {
    const body = {
      customerId: customerId ? decodeURIComponent(customerId) : null,
      customerName: overlay.querySelector('#tkName').value || 'Unknown',
      customerEmail: overlay.querySelector('#tkEmail').value || '',
      category: overlay.querySelector('#tkCategory').value,
      priority: overlay.querySelector('#tkPriority').value,
      subject: overlay.querySelector('#tkSubject').value || '(no subject)',
      description: overlay.querySelector('#tkDesc').value || '',
    };
    try {
      const r = await fetch('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const ticket = await r.json();
      close(); toast('Ticket created', 'success');
      navigateTo('ticket-detail', ticket.id);
    } catch (err) { toast('Failed to create ticket', 'error'); }
  });
}

// ─── TICKET DETAIL ──────────────────────────────

async function loadTicketDetail(ticketId) {
  try {
    const [tRes, srRes] = await Promise.all([fetch(`/api/tickets/${ticketId}`), fetch('/api/crm/saved-replies')]);
    const ticket = await tRes.json();
    const srData = await srRes.json();
    if (ticket.error) throw new Error(ticket.error);

    // SLA calculation
    const created = new Date(ticket.createdAt);
    const now = new Date();
    const hoursSinceCreated = (now - created) / 3600000;
    const slaHours = 24;
    const slaRemaining = slaHours - hoursSinceCreated;
    const slaClass = ticket.firstResponseAt ? 'ok' : slaRemaining < 0 ? 'critical' : slaRemaining < 4 ? 'urgent' : 'ok';
    const slaText = ticket.firstResponseAt ? 'Responded' : slaRemaining < 0 ? `SLA BREACHED (${Math.abs(Math.round(slaRemaining))}h overdue)` : `${Math.round(slaRemaining)}h remaining`;

    function renderTimeline() {
      const tl = document.getElementById('ticketTimeline');
      if (!tl) return;
      tl.innerHTML = ticket.notes.map(n => `
        <div class="timeline-item ${n.type}">
          <div class="timeline-dot ${n.type}"></div>
          <div class="timeline-content">
            <div class="timeline-header">
              <strong>${escHtml(n.author)}</strong>
              <span class="badge badge-${n.type === 'reply' ? 'ok' : n.type === 'system' ? 'nosales' : 'reorder'}">${n.type}</span>
              <span class="timeline-time">${fmtDateTime(n.createdAt)}</span>
            </div>
            <div class="timeline-text">${escHtml(n.text).replace(/\n/g, '<br>')}</div>
          </div>
        </div>
      `).join('') || '<p style="color:var(--text-muted);padding:20px;">No notes yet. Add a response below.</p>';
    }

    $('#content').innerHTML = `
      <div style="margin-bottom:16px"><button class="btn btn-sm" onclick="navigateTo('tickets')">← Back to Tickets</button></div>

      <div class="ticket-detail-grid">
        <div class="ticket-main">
          <div class="section">
            <div class="section-header">
              <h2 class="section-title"><span style="color:var(--text-muted);font-weight:400">${ticket.id}</span> ${escHtml(ticket.subject)}</h2>
              <div class="sla-indicator sla-${slaClass}">${slaText}</div>
            </div>
            ${ticket.description ? `<div style="padding:16px 20px;border-bottom:1px solid var(--border);color:var(--text-dim);font-size:13px;white-space:pre-wrap;line-height:1.6">${escHtml(ticket.description)}</div>` : ''}
            ${ticket.orderName ? `<div style="padding:10px 20px;border-bottom:1px solid var(--border);font-size:13px;color:var(--text-dim)">🧾 Linked Order: <strong>${escHtml(ticket.orderName)}</strong></div>` : ''}
            <div style="padding:16px 20px;border-bottom:1px solid var(--border);">
              <h3 style="font-size:13px;margin-bottom:12px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em">Activity Timeline</h3>
              <div id="ticketTimeline" class="timeline"></div>
            </div>
            <div style="padding:16px 20px;">
              <div class="form-group" style="margin-bottom:8px">
                <textarea id="noteText" class="form-input form-textarea" rows="3" placeholder="Type your response..."></textarea>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                <select id="noteType" class="form-input" style="width:auto;"><option value="reply">Customer Reply</option><option value="internal">Internal Note</option></select>
                <select id="savedReplySelect" class="form-input" style="width:auto;"><option value="">Insert saved reply...</option>${srData.replies.map(r => `<option value="${r.id}">${r.title}</option>`).join('')}</select>
                <button class="btn btn-primary" id="addNoteBtn">Send</button>
              </div>
            </div>
          </div>
        </div>

        <div class="ticket-sidebar-panel">
          <div class="section">
            <div style="padding:16px">
              <h3 class="panel-label">TICKET INFO</h3>
              <div class="detail-row"><span>Status</span>${statusBadge(ticket.status)}</div>
              <div class="detail-row"><span>Priority</span>${ticketPriorityBadge(ticket.priority)}</div>
              <div class="detail-row"><span>Category</span><span>${categoryLabel(ticket.category)}</span></div>
              <div class="detail-row"><span>Assignee</span><span>${escHtml(ticket.assignee || '—')}</span></div>
              <div class="detail-row"><span>Created</span><span style="font-size:12px">${fmtDateTime(ticket.createdAt)}</span></div>
              ${ticket.resolvedAt ? `<div class="detail-row"><span>Resolved</span><span style="font-size:12px">${fmtDateTime(ticket.resolvedAt)}</span></div>` : ''}

              <h3 class="panel-label" style="margin-top:16px">CUSTOMER</h3>
              <div class="detail-row"><span>Name</span><span>${escHtml(ticket.customerName)}</span></div>
              <div class="detail-row"><span>Email</span><span style="font-size:12px">${escHtml(ticket.customerEmail) || '—'}</span></div>
              ${ticket.customerId ? `<div style="margin-top:8px"><button class="btn btn-sm" style="width:100%" onclick="navigateTo('customer-profile','${encodeURIComponent(ticket.customerId)}')">View Profile →</button></div>` : ''}

              <h3 class="panel-label" style="margin-top:16px">ACTIONS</h3>
              <div style="display:flex;flex-direction:column;gap:6px">
                <select id="statusSelect" class="form-input">
                  ${['open','in_progress','waiting','resolved','closed'].map(s => `<option value="${s}" ${ticket.status === s ? 'selected' : ''}>${{open:'Open',in_progress:'In Progress',waiting:'Waiting on Customer',resolved:'Resolved',closed:'Closed'}[s]}</option>`).join('')}
                </select>
                <select id="prioritySelect" class="form-input">
                  ${['low','medium','high','urgent'].map(p => `<option value="${p}" ${ticket.priority === p ? 'selected' : ''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}
                </select>
                <button class="btn" id="updateTicketBtn" style="width:100%">Update Ticket</button>
                <button class="btn btn-danger" id="deleteTicketBtn">Delete Ticket</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    renderTimeline();

    $('#savedReplySelect').addEventListener('change', e => {
      const reply = srData.replies.find(r => r.id === e.target.value);
      if (reply) { let body = reply.body.replace('{name}', ticket.customerName || 'there'); $('#noteText').value = body; $('#noteType').value = 'reply'; }
      e.target.value = '';
    });

    $('#addNoteBtn').addEventListener('click', async () => {
      const text = $('#noteText').value.trim();
      if (!text) return;
      await fetch(`/api/tickets/${ticketId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, type: $('#noteType').value }) });
      const r = await fetch(`/api/tickets/${ticketId}`);
      Object.assign(ticket, await r.json());
      renderTimeline(); $('#noteText').value = '';
      toast('Note added', 'success');
    });

    $('#updateTicketBtn').addEventListener('click', async () => {
      await fetch(`/api/tickets/${ticketId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: $('#statusSelect').value, priority: $('#prioritySelect').value }) });
      toast('Ticket updated', 'success');
      navigateTo('ticket-detail', ticketId);
    });

    $('#deleteTicketBtn').addEventListener('click', async () => {
      if (!confirm('Delete this ticket permanently?')) return;
      await fetch(`/api/tickets/${ticketId}`, { method: 'DELETE' });
      toast('Ticket deleted', 'success');
      navigateTo('tickets');
    });
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ════════════════════════════════════════════════
//  CLEANUP
// ════════════════════════════════════════════════

async function loadCleanup() {
  try {
    const res = await fetch('/api/cleanup-report');
    const data = await res.json();

    // ── State ──
    let activeTab = 'overview';
    let page = 1;
    const PER = 15;
    // selected maps variantId → { product, sku, productId, category }
    const sel = new Map();

    // ── Helpers ──
    const cats = ['deadStock','zeroStock','missingData','slowMovers','noSales'];
    const catLabel = { deadStock:'Dead Stock', zeroStock:'Zero Stock', missingData:'Missing Data', slowMovers:'Slow Movers', noSales:'No Sales' };
    const catIcon  = { deadStock:'🗑', zeroStock:'📦', missingData:'⚠', slowMovers:'🐢', noSales:'○' };

    function paginate(arr) {
      const total = arr.length;
      const maxP = Math.ceil(total / PER) || 1;
      if (page > maxP) page = maxP;
      return { rows: arr.slice((page-1)*PER, page*PER), total, maxP };
    }

    function selBtnText() { return `✓ Selected (${sel.size})`; }

    // ── Build the skeleton once ──
    $('#content').innerHTML = `
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">Inventory Cleanup</h2>
          <p style="font-size:13px;color:var(--text-muted);margin:0">☑ Check items → Go to Selected → Pick action</p>
        </div>
        <div class="toolbar" style="border-bottom:0;overflow-x:auto">
          <div id="cleanupTabs" style="display:flex;gap:4px;min-width:min-content;padding-right:20px">
            <button class="filter-btn active" data-ctab="overview">Overview</button>
            <button class="filter-btn" data-ctab="selected" id="selTabBtn" style="background:var(--accent-soft);color:var(--accent);border-color:var(--accent);font-weight:700">${selBtnText()}</button>
            <button class="filter-btn" data-ctab="deadStock">${catIcon.deadStock} Dead (${data.deadStockCount})</button>
            <button class="filter-btn" data-ctab="zeroStock">${catIcon.zeroStock} Empty (${data.zeroStockCount})</button>
            <button class="filter-btn" data-ctab="missingData">${catIcon.missingData} Missing (${data.missingDataCount})</button>
            <button class="filter-btn" data-ctab="slowMovers">${catIcon.slowMovers} Slow (${data.slowMoversCount})</button>
            <button class="filter-btn" data-ctab="noSales">${catIcon.noSales} Never (${data.noSalesCount})</button>
          </div>
        </div>
      </div>
      <div class="section" style="padding:20px"><div id="cBody"></div></div>
    `;

    const body = document.getElementById('cBody');
    const selBtn = document.getElementById('selTabBtn');

    // ── Tab switching ──
    document.getElementById('cleanupTabs').addEventListener('click', e => {
      const btn = e.target.closest('[data-ctab]');
      if (!btn) return;
      document.querySelectorAll('[data-ctab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.ctab;
      page = 1;
      render();
    });

    // ── Render the active tab's content ──
    function render() {
      selBtn.textContent = selBtnText();
      if (activeTab === 'overview')       renderOverview();
      else if (activeTab === 'selected')  renderSelected();
      else                                 renderCategory(activeTab);
    }

    // ── Overview ──
    function renderOverview() {
      body.innerHTML = `
        ${sel.size > 0
          ? `<div style="padding:16px;background:var(--accent-soft);border-radius:6px;margin-bottom:16px;border-left:4px solid var(--accent)">
               <strong style="color:var(--accent)">${sel.size} items marked</strong>
               <button class="btn btn-sm" style="margin-left:12px" data-ctab="selected">GO TO ACTIONS →</button>
             </div>`
          : '<div style="padding:12px;background:var(--bg-muted);border-radius:6px;margin-bottom:16px;color:var(--text-muted)">No items selected yet. Go to any category and check items.</div>'}
        <div class="kpi-grid">
          ${cats.map(c => `
            <div class="kpi-card" style="cursor:pointer" data-ctab="${c}">
              <div class="kpi-icon" style="background:var(--${c==='deadStock'||c==='slowMovers'?'red':c==='zeroStock'?'orange':c==='missingData'?'yellow':'text-muted'}-soft);color:var(--${c==='deadStock'||c==='slowMovers'?'red':c==='zeroStock'?'orange':c==='missingData'?'yellow':'text-dim'})">${catIcon[c]}</div>
              <div class="kpi-data"><div class="kpi-value">${data[c+'Count']}</div><div class="kpi-label">${catLabel[c]}</div></div>
            </div>
          `).join('')}
        </div>`;
    }

    // ── Selected items tab ──
    function renderSelected() {
      if (sel.size === 0) {
        body.innerHTML = '<div class="empty-state" style="padding:40px"><h3>No items selected</h3><p>Go to any category and check the boxes next to items you want to clean up.</p></div>';
        return;
      }
      const items = Array.from(sel.entries()).map(([vid, info]) => ({ variantId: vid, ...info }));
      body.innerHTML = `
        <div style="padding:16px;background:var(--bg-muted);border-radius:6px;margin-bottom:20px;border-left:4px solid var(--accent)">
          <strong>${items.length} items ready</strong> — Pick an action:
        </div>
        <div style="margin-bottom:16px;display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
          <button class="btn btn-primary" id="actArchive" style="padding:14px;font-size:14px;font-weight:600">📦 ARCHIVE</button>
          <button class="btn btn-danger"  id="actDelete"  style="padding:14px;font-size:14px;font-weight:600">🗑 DELETE</button>
          <button class="btn"             id="actTag"     style="padding:14px;font-size:14px;font-weight:600">🏷 TAG</button>
          <button class="btn"             id="actClear"   style="padding:14px;font-size:14px">✕ CLEAR ALL</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th style="width:40px"></th></tr></thead>
          <tbody>${items.map(i => `<tr data-vid="${i.variantId}">
            <td><strong>${escHtml(i.product)}</strong></td>
            <td style="font-family:monospace;font-size:11px">${escHtml(i.sku)}</td>
            <td><span style="padding:2px 6px;border-radius:3px;font-size:11px;background:var(--accent-soft);color:var(--accent)">${catLabel[i.category]||i.category}</span></td>
            <td><button class="btn btn-sm sel-remove" data-vid="${i.variantId}">✕</button></td>
          </tr>`).join('')}</tbody>
        </table></div>`;

      // Remove individual item
      body.querySelectorAll('.sel-remove').forEach(btn => {
        btn.addEventListener('click', () => { sel.delete(btn.dataset.vid); render(); });
      });
      // Clear all
      document.getElementById('actClear').addEventListener('click', () => { sel.clear(); activeTab = 'overview'; page = 1; render(); });
      // Bulk actions
      ['archive','delete','tag'].forEach(action => {
        document.getElementById('act' + action.charAt(0).toUpperCase() + action.slice(1)).addEventListener('click', () => doBulkAction(action));
      });
    }

    // ── Category list with checkboxes ──
    function renderCategory(cat) {
      const allItems = data.reports[cat] || [];
      const { rows, total, maxP } = paginate(allItems);

      // Column headers per category
      let extraHead = '';
      if (cat === 'deadStock')   extraHead = '<th style="text-align:right">Price</th><th style="text-align:right">Sold</th><th>Last Sale</th>';
      if (cat === 'zeroStock')   extraHead = '<th style="text-align:right">Sold</th><th style="text-align:right">Days</th>';
      if (cat === 'missingData') extraHead = '<th>Missing</th>';
      if (cat === 'slowMovers')  extraHead = '<th style="text-align:right">Monthly</th><th style="text-align:right">Stock</th>';
      if (cat === 'noSales')     extraHead = '<th style="text-align:right">Stock</th><th style="text-align:right">Days</th>';

      // Rows
      const rowsHtml = rows.map(i => {
        const vid = i.variantId;
        const checked = sel.has(vid);
        let extra = '';
        if (cat === 'deadStock')   extra = `<td style="text-align:right">${fmtMoney(i.price)}</td><td style="text-align:right">${i.unitsSold}</td><td>${i.lastSale}</td>`;
        if (cat === 'zeroStock')   extra = `<td style="text-align:right">${i.unitsSold}</td><td style="text-align:right;color:var(--red)">${i.daysOfStock === 999 ? '∞' : i.daysOfStock}</td>`;
        if (cat === 'missingData') extra = `<td><span style="color:var(--red);font-size:11px">${i.missingFields.join(', ')}</span></td>`;
        if (cat === 'slowMovers')  extra = `<td style="text-align:right">${i.monthlyVelocity}</td><td style="text-align:right">${i.available}</td>`;
        if (cat === 'noSales')     extra = `<td style="text-align:right">${i.available}</td><td style="text-align:right">${i.daysTracked}d</td>`;
        return `<tr data-vid="${vid}" style="${checked ? 'background:var(--accent-soft)' : ''}">
          <td style="text-align:center"><input type="checkbox" class="rc" data-vid="${vid}" ${checked ? 'checked' : ''} style="cursor:pointer;width:18px;height:18px"/></td>
          <td><strong>${escHtml(i.product)}</strong></td>
          <td style="font-family:monospace;font-size:11px">${escHtml(i.sku)}</td>
          ${extra}
        </tr>`;
      }).join('');

      const allPageChecked = rows.length > 0 && rows.every(i => sel.has(i.variantId));

      // Pagination
      let pgn = '';
      if (maxP > 1) {
        pgn = `<div style="display:flex;gap:8px;justify-content:center;margin-top:16px;padding:12px;border-top:1px solid var(--border)">
          ${page > 1 ? '<button class="btn btn-sm" id="pgPrev">← Prev</button>' : ''}
          <span style="padding:6px 12px;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-size:12px">Page ${page} of ${maxP}</span>
          ${page < maxP ? '<button class="btn btn-sm" id="pgNext">Next →</button>' : ''}
        </div>`;
      }

      body.innerHTML = `
        <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <input type="checkbox" id="selAll" ${allPageChecked ? 'checked' : ''} style="cursor:pointer;width:18px;height:18px"/>
          <label for="selAll" style="cursor:pointer;font-size:13px;margin:0;flex:1"><strong>Select all on this page</strong></label>
          <span style="font-size:12px;color:var(--accent);font-weight:600">${sel.size} total selected</span>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th style="width:40px">☑</th><th>Product</th><th>SKU</th>${extraHead}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>
        ${pgn}`;

      // ── Wire up checkboxes (NO full re-render) ──
      const selAllCb = document.getElementById('selAll');

      // Individual checkboxes
      body.querySelectorAll('.rc').forEach(cb => {
        cb.addEventListener('change', () => {
          const vid = cb.dataset.vid;
          const item = rows.find(r => r.variantId === vid);
          if (cb.checked && item) {
            sel.set(vid, { product: item.product, sku: item.sku, productId: item.productId, category: cat });
          } else {
            sel.delete(vid);
          }
          // Update this row's background
          const tr = cb.closest('tr');
          if (tr) tr.style.background = cb.checked ? 'var(--accent-soft)' : '';
          // Update select-all state
          const allCbs = body.querySelectorAll('.rc');
          selAllCb.checked = allCbs.length > 0 && Array.from(allCbs).every(c => c.checked);
          // Update counts
          selBtn.textContent = selBtnText();
          const countSpan = body.querySelector('[style*="total selected"]');
          if (countSpan) countSpan.textContent = sel.size + ' total selected';
        });
      });

      // Select-all checkbox
      if (selAllCb) {
        selAllCb.addEventListener('change', () => {
          const checked = selAllCb.checked;
          body.querySelectorAll('.rc').forEach(cb => {
            cb.checked = checked;
            const vid = cb.dataset.vid;
            const item = rows.find(r => r.variantId === vid);
            if (checked && item) {
              sel.set(vid, { product: item.product, sku: item.sku, productId: item.productId, category: cat });
            } else {
              sel.delete(vid);
            }
            const tr = cb.closest('tr');
            if (tr) tr.style.background = checked ? 'var(--accent-soft)' : '';
          });
          selBtn.textContent = selBtnText();
          const countSpan = body.querySelector('[style*="total selected"]');
          if (countSpan) countSpan.textContent = sel.size + ' total selected';
        });
      }

      // Pagination buttons
      document.getElementById('pgPrev')?.addEventListener('click', () => { page--; render(); });
      document.getElementById('pgNext')?.addEventListener('click', () => { page++; render(); });
    }

    // ── Bulk action ──
    async function doBulkAction(action) {
      const msgs = { archive: 'Archive', delete: 'PERMANENTLY DELETE', tag: 'Tag' };
      if (!confirm(`${msgs[action]} ${sel.size} items?`)) return;
      try {
        const productIds = Array.from(sel.values()).map(v => v.productId);
        const r = await fetch('/api/cleanup-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, productIds, tags: action === 'tag' ? ['Under Review'] : undefined })
        });
        const result = await r.json();
        if (result.success) toast(`✓ ${result.success} items ${action}d!`, 'success');
        if (result.failed)  toast(`⚠ ${result.failed} failed`, 'warning');
        sel.clear();
        activeTab = 'overview';
        page = 1;
        setTimeout(() => loadCleanup(), 800);
      } catch (e) { toast(e.message, 'error'); }
    }

    // Initial render
    render();
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ════════════════════════════════════════════════
//  ANALYTICS
// ════════════════════════════════════════════════

async function loadAnalytics() {
  try {
    const [statsRes, dashRes, custRes, statusRes] = await Promise.all([
      fetch('/api/crm/stats'), fetch('/api/dashboard'), fetch('/api/customers'), fetch('/api/status'),
    ]);
    const stats = await statsRes.json();
    const dash = await dashRes.json();
    const custData = await custRes.json();
    const status = await statusRes.json();

    const maxCreated = Math.max(...stats.trend.map(d => d.created), 1);
    const trendBars = stats.trend.map(d => {
      const h = Math.max(2, (d.created / maxCreated) * 60);
      const rh = Math.max(2, (d.resolved / maxCreated) * 60);
      return `<div class="trend-col" title="${d.date}: ${d.created} created, ${d.resolved} resolved">
        <div class="trend-bar" style="height:${h}px;background:var(--accent);"></div>
        <div class="trend-bar" style="height:${rh}px;background:var(--green);margin-top:2px;"></div>
        <div class="trend-label">${d.date.slice(5)}</div>
      </div>`;
    }).join('');

    const catRows = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]).map(([catId, count]) => {
      const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0;
      return `<div class="cat-row"><span class="cat-label">${categoryLabel(catId)}</span><div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:var(--accent);"></div></div><span class="cat-count">${count} (${pct}%)</span></div>`;
    }).join('');

    // Revenue by day chart
    const revDays = Object.entries(dash.revByDay || {});
    const maxRev = Math.max(...revDays.map(([,v]) => v), 1);
    const revBars = revDays.map(([day, val]) => {
      const h = Math.max(2, (val / maxRev) * 60);
      return `<div class="trend-col" title="${day}: ${fmtMoney(val)}"><div class="trend-bar" style="height:${h}px;background:var(--green);"></div><div class="trend-label">${day.slice(5)}</div></div>`;
    }).join('');

    // Customer tier chart — may be empty if still loading
    const custLoading = !status.customers && status.state === 'fetching';
    const totalCust = custData.total || 1;
    const tierBars = custLoading
      ? `<div style="text-align:center;padding:20px;color:var(--text-muted)"><div class="spinner-sm" style="display:inline-block;margin-right:8px"></div>Loading customers... (${status.customerCount || 0} so far)</div>`
      : Object.entries(custData.tierCounts || {}).map(([tier, count]) => {
        const pct = Math.round((count / totalCust) * 100);
        const colors = { VIP: 'var(--accent)', LOYAL: 'var(--green)', REPEAT: 'var(--blue)', CUSTOMER: 'var(--text-dim)', NEW: 'var(--text-muted)' };
        return `<div class="cat-row"><span class="cat-label" style="color:${colors[tier]}">${tier}</span><div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${colors[tier]};"></div></div><span class="cat-count">${count} (${pct}%)</span></div>`;
      }).join('');

    $('#content').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--accent-soft);color:var(--accent)">✉</div><div class="kpi-data"><div class="kpi-value">${stats.total}</div><div class="kpi-label">Total Tickets</div><div class="kpi-sub">${stats.active} active</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--green-soft);color:var(--green)">✓</div><div class="kpi-data"><div class="kpi-value">${stats.resolvedThisWeek}</div><div class="kpi-label">Resolved This Week</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:${stats.avgResponseHrs > 24 ? 'var(--red-soft)' : 'var(--green-soft)'};color:${stats.avgResponseHrs > 24 ? 'var(--red)' : 'var(--green)'}">⏱</div><div class="kpi-data"><div class="kpi-value">${stats.total > 0 ? stats.avgResponseHrs + 'h' : '—'}</div><div class="kpi-label">Avg Response ${infoTip('Average time from ticket creation to first response.')}</div></div></div>
        <div class="kpi-card"><div class="kpi-icon" style="background:var(--blue-soft);color:var(--blue)">%</div><div class="kpi-data"><div class="kpi-value">${stats.slaCompliance}%</div><div class="kpi-label">SLA Compliance ${infoTip('Percentage of tickets resolved within the target timeframe defined in Settings.')}</div></div></div>
      </div>

      <div class="analytics-grid">
        <div class="section">
          <div class="section-header"><h2 class="section-title">Ticket Trend (14 Days)</h2></div>
          <div class="trend-chart">${trendBars}</div>
          <div style="padding:8px 16px;display:flex;gap:16px;font-size:11px;color:var(--text-muted)">
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--accent);border-radius:2px;margin-right:4px"></span>Created</span>
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--green);border-radius:2px;margin-right:4px"></span>Resolved</span>
          </div>
        </div>
        <div class="section">
          <div class="section-header"><h2 class="section-title">Revenue Trend (30 Days)</h2></div>
          <div class="trend-chart">${revBars}</div>
        </div>
      </div>

      <div class="analytics-grid" style="margin-top:16px;">
        <div class="section">
          <div class="section-header"><h2 class="section-title">Tickets by Category</h2></div>
          <div style="padding:16px">${catRows || '<p style="color:var(--text-muted)">No data yet</p>'}</div>
        </div>
        <div class="section">
          <div class="section-header"><h2 class="section-title">Customer Segments ${infoTip('Breakdown of all customers by spending tier. Segments update as customer data loads.')}</h2></div>
          <div style="padding:16px">${tierBars}</div>
        </div>
      </div>

      <div class="analytics-grid" style="margin-top:16px;">
        <div class="section">
          <div class="section-header"><h2 class="section-title">Tickets by Priority</h2></div>
          <div style="padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:12px;">
            ${['urgent','high','medium','low'].map(p => {
              const colors = { urgent: 'var(--red)', high: 'var(--orange)', medium: 'var(--yellow)', low: 'var(--green)' };
              return `<div style="text-align:center"><div style="font-size:28px;font-weight:700;color:${colors[p]}">${stats.byPriority[p]||0}</div><div style="font-size:12px;color:var(--text-muted)">${p.charAt(0).toUpperCase()+p.slice(1)}</div></div>`;
            }).join('')}
          </div>
        </div>
        <div class="section">
          <div class="section-header"><h2 class="section-title">Tickets by Status</h2></div>
          <div style="padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:12px;">
            ${['open','in_progress','waiting','resolved','closed'].map(s => {
              const colors = { open: 'var(--red)', in_progress: 'var(--orange)', waiting: 'var(--yellow)', resolved: 'var(--green)', closed: 'var(--text-dim)' };
              const labels = { open: 'Open', in_progress: 'In Prog', waiting: 'Waiting', resolved: 'Resolved', closed: 'Closed' };
              return `<div style="text-align:center"><div style="font-size:24px;font-weight:700;color:${colors[s]}">${stats.byStatus[s]||0}</div><div style="font-size:11px;color:var(--text-muted)">${labels[s]}</div></div>`;
            }).join('')}
          </div>
        </div>
      </div>

      ${Object.keys(stats.byAssignee || {}).length > 0 ? `
      <div class="section" style="margin-top:16px">
        <div class="section-header"><h2 class="section-title">By Assignee</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Assignee</th><th style="text-align:right">Total</th><th style="text-align:right">Open</th><th style="text-align:right">Resolved</th></tr></thead>
        <tbody>${Object.entries(stats.byAssignee).map(([name, d]) => `<tr><td><strong>${escHtml(name)}</strong></td><td style="text-align:right">${d.total}</td><td style="text-align:right;color:var(--orange)">${d.open}</td><td style="text-align:right;color:var(--green)">${d.resolved}</td></tr>`).join('')}</tbody></table></div>
      </div>` : ''}
    `;
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}

// ════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════

async function loadSettings() {
  try {
    const [settingsRes, repliesRes, catsRes] = await Promise.all([
      fetch('/api/crm/settings'), fetch('/api/crm/saved-replies'), fetch('/api/crm/categories'),
    ]);
    const settings = await settingsRes.json();
    const repliesData = await repliesRes.json();
    const catsData = await catsRes.json();

    $('#content').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div class="section">
          <div class="section-header"><h2 class="section-title">General Settings</h2></div>
          <div style="padding:20px">
            <div class="form-group"><label>Default Assignee</label><input type="text" id="sAutoAssignee" class="form-input" value="${escHtml(settings.autoAssignee || '')}"></div>
            <div class="form-group"><label>SLA Response Time (Hours)</label><input type="number" id="sSlaResponse" class="form-input" value="${settings.slaResponseHours || 24}"></div>
            <div class="form-group"><label>SLA Resolution Time (Hours)</label><input type="number" id="sSlaResolution" class="form-input" value="${settings.slaResolutionHours || 48}"></div>
            <div class="form-group"><label>Business Name</label><input type="text" id="sBizName" class="form-input" value="${escHtml(settings.businessName || '')}"></div>
            <button class="btn btn-primary" id="saveSettingsBtn">Save Settings</button>
          </div>
        </div>

        <div class="section">
          <div class="section-header"><h2 class="section-title">Ticket Categories</h2></div>
          <div style="padding:16px">
            ${(catsData.categories || []).map(c => `
              <div class="cat-setting-row">
                <span style="font-size:18px">${c.icon}</span>
                <span style="flex:1">${c.label}</span>
                <span class="badge" style="background:${c.color}22;color:${c.color}">${c.id}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="section" style="margin-top:16px">
        <div class="section-header">
          <h2 class="section-title">Saved Reply Templates (${repliesData.replies.length})</h2>
          <button class="btn btn-sm" id="addReplyBtn">+ Add Reply</button>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Title</th><th>Category</th><th style="width:50%">Preview</th><th>Action</th></tr></thead>
        <tbody id="repliesBody">
          ${repliesData.replies.map(r => `<tr>
            <td><strong>${escHtml(r.title)}</strong></td>
            <td>${escHtml(r.category)}</td>
            <td style="font-size:12px;color:var(--text-dim);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.body.substring(0, 80))}...</td>
            <td><button class="btn btn-sm btn-danger" data-del-reply="${r.id}">Delete</button></td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>
    `;

    $('#saveSettingsBtn').addEventListener('click', async () => {
      await fetch('/api/crm/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoAssignee: $('#sAutoAssignee').value,
          slaResponseHours: parseInt($('#sSlaResponse').value) || 24,
          slaResolutionHours: parseInt($('#sSlaResolution').value) || 48,
          businessName: $('#sBizName').value,
        }),
      });
      toast('Settings saved', 'success');
    });

    $$('[data-del-reply]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this saved reply?')) return;
      await fetch(`/api/crm/saved-replies/${btn.dataset.delReply}`, { method: 'DELETE' });
      toast('Reply deleted', 'success');
      navigateTo('settings');
    }));

    $('#addReplyBtn').addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-header"><h3>New Saved Reply</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button></div>
          <div class="modal-body">
            <div class="form-group"><label>Title</label><input type="text" id="nrTitle" class="form-input" placeholder="Reply title"></div>
            <div class="form-group"><label>Category</label><select id="nrCat" class="form-input">${_categories.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}</select></div>
            <div class="form-group"><label>Body</label><textarea id="nrBody" class="form-input form-textarea" rows="6" placeholder="Reply template text. Use {name}, {order}, etc."></textarea></div>
          </div>
          <div class="modal-footer"><button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button><button class="btn btn-primary" id="nrSubmit">Save Reply</button></div>
        </div>`;
      document.body.appendChild(overlay);
      setTimeout(() => overlay.classList.add('show'), 10);

      overlay.querySelector('#nrSubmit').addEventListener('click', async () => {
        await fetch('/api/crm/saved-replies', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: overlay.querySelector('#nrTitle').value, category: overlay.querySelector('#nrCat').value, body: overlay.querySelector('#nrBody').value }),
        });
        overlay.remove(); toast('Reply saved', 'success');
        navigateTo('settings');
      });
    });
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}
