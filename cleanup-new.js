// NEW CLEANUP FUNCTION WITH CHECKBOXES AND BULK ACTIONS
async function loadCleanup() {
  try {
    const res = await fetch('/api/cleanup-report');
    const data = await res.json();
    let activeTab = 'overview';
    let currentPage = 1;
    const itemsPerPage = 10;
    const selected = new Set(); // Track selected items by SKU

    function getPaginatedItems(items) {
      const total = items.length;
      const maxPage = Math.ceil(total / itemsPerPage);
      const start = (currentPage - 1) * itemsPerPage;
      const paged = items.slice(start, start + itemsPerPage);
      return { items: paged, total, maxPage, currentPage };
    }

    function renderPagination(total) {
      if (total <= itemsPerPage) return '';
      const maxPage = Math.ceil(total / itemsPerPage);
      let html = '<div style="display:flex;gap:8px;justify-content:center;margin-top:16px;padding:12px;border-top:1px solid var(--border)">';
      if (currentPage > 1) html += `<button class="btn btn-sm" onclick="window.cleanupPrevPage()">← Prev</button>`;
      html += `<span style="padding:6px 12px;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-size:12px">Page ${currentPage} of ${maxPage}</span>`;
      if (currentPage < maxPage) html += `<button class="btn btn-sm" onclick="window.cleanupNextPage()">Next →</button>`;
      html += '</div>';
      return html;
    }

    function renderTab() {
      const content = document.getElementById('cleanupContent');
      if (!content) return;

      if (activeTab === 'overview') {
        const selectedCount = selected.size;
        content.innerHTML = `
          ${selectedCount > 0 ? `<div style="padding:16px;background:var(--accent-soft);border-radius:6px;margin-bottom:16px;border-left:4px solid var(--accent)">
            <strong style="color:var(--accent)">${selectedCount} items selected</strong> — 
            <button class="btn btn-sm" style="margin-left:12px" onclick="document.querySelector('[data-ctab=selected]').click()">View & Act →</button>
          </div>` : ''}
          <div class="kpi-grid">
            <div class="kpi-card clickable" onclick="document.querySelector('[data-ctab=deadStock]').click()">
              <div class="kpi-icon" style="background:var(--red-soft);color:var(--red)">🗑</div>
              <div class="kpi-data"><div class="kpi-value">${data.deadStockCount}</div><div class="kpi-label">Dead Stock</div><div class="kpi-sub">No sales in 30 days</div></div>
            </div>
            <div class="kpi-card clickable" onclick="document.querySelector('[data-ctab=zeroStock]').click()">
              <div class="kpi-icon" style="background:var(--orange-soft);color:var(--orange)">📦</div>
              <div class="kpi-data"><div class="kpi-value">${data.zeroStockCount}</div><div class="kpi-label">Zero Stock</div><div class="kpi-sub">Out of stock</div></div>
            </div>
            <div class="kpi-card clickable" onclick="document.querySelector('[data-ctab=missingData]').click()">
              <div class="kpi-icon" style="background:var(--yellow-soft);color:var(--yellow)">⚠</div>
              <div class="kpi-data"><div class="kpi-value">${data.missingDataCount}</div><div class="kpi-label">Missing Data</div><div class="kpi-sub">Incomplete info</div></div>
            </div>
            <div class="kpi-card clickable" onclick="document.querySelector('[data-ctab=slowMovers]').click()">
              <div class="kpi-icon" style="background:var(--red-soft);color:var(--red)">🐢</div>
              <div class="kpi-data"><div class="kpi-value">${data.slowMoversCount}</div><div class="kpi-label">Slow Movers</div><div class="kpi-sub">C-category items</div></div>
            </div>
            <div class="kpi-card clickable" onclick="document.querySelector('[data-ctab=noSales]').click()">
              <div class="kpi-icon" style="background:var(--text-muted);color:var(--text-dim)">○</div>
              <div class="kpi-data"><div class="kpi-value">${data.noSalesCount}</div><div class="kpi-label">No Sales</div><div class="kpi-sub">Never sold</div></div>
            </div>
          </div>
        `;
      } else if (activeTab === 'selected') {
        const selectedItems = [];
        ['deadStock', 'zeroStock', 'missingData', 'slowMovers', 'noSales'].forEach(type => {
          data.reports[type]?.forEach(i => {
            if (selected.has(i.sku)) selectedItems.push({...i, type: type.replace(/([A-Z])/g, ' $1').trim()});
          });
        });

        if (selectedItems.length === 0) {
          content.innerHTML = '<div class="empty-state" style="padding:40px"><p>No items selected. Click checkboxes in other tabs to mark items you want to cleanup.</p></div>';
        } else {
          content.innerHTML = `
            <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-primary" id="bulkArchiveBtn">📁 Mark as Review</button>
              <button class="btn btn-danger" id="bulkDeleteBtn">🗑 Delete Selected</button>
              <button class="btn" id="bulkClearBtn">✕ Clear All</button>
            </div>
            <div class="table-wrap"><table><thead><tr>
              <th>Product</th><th>SKU</th><th>Category</th>
            </tr></thead><tbody>${selectedItems.map(i => `<tr>
              <td><strong>${escHtml(i.product)}</strong></td>
              <td style="font-family:monospace;font-size:12px">${escHtml(i.sku)}</td>
              <td><span style="padding:2px 6px;border-radius:3px;font-size:11px;background:var(--accent-soft);color:var(--accent)">${i.type}</span></td>
            </tr>`).join('')}</tbody></table></div>
          `;
          setTimeout(() => {
            $('#bulkArchiveBtn')?.addEventListener('click', () => toast('Marked for review - feature coming soon', 'info'));
            $('#bulkDeleteBtn')?.addEventListener('click', () => {
              if (confirm(`Delete ${selectedItems.length} items? This cannot be undone!`)) {
                toast('Items will be deleted', 'success');
                selected.clear();
                activeTab = 'overview';
                currentPage = 1;
                renderTab();
              }
            });
            $('#bulkClearBtn')?.addEventListener('click', () => {
              selected.clear();
              activeTab = 'overview';
              renderTab();
            });
          }, 10);
        }
      } else if (activeTab === 'deadStock') {
        const { items, total } = getPaginatedItems(data.reports.deadStock);
        content.innerHTML = `
          <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="selectAllDeadStock"/> 
            <label for="selectAllDeadStock" style="cursor:pointer;font-size:13px;margin:0">Select all on this page</label>
            <span style="margin-left:auto;font-size:12px;color:var(--text-muted)">${total} items total</span>
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th style="width:40px"><input type="checkbox" id="deadHeadCheckbox"></th>
            <th>Product</th><th>SKU</th><th style="text-align:right">Price</th><th style="text-align:right">Sold</th><th>Last Sale</th>
          </tr></thead><tbody>${items.map(i => `<tr>
            <td><input type="checkbox" data-sku="${i.sku}" class="item-checkbox"></td>
            <td><strong>${escHtml(i.product)}</strong></td>
            <td style="font-family:monospace;font-size:12px">${escHtml(i.sku)}</td>
            <td style="text-align:right">${fmtMoney(i.price)}</td>
            <td style="text-align:right">${i.unitsSold}</td>
            <td>${i.lastSale}</td>
          </tr>`).join('')}</tbody></table></div>
          ${renderPagination(total)}
        `;
        setTimeout(() => setupCheckboxes(data.reports.deadStock, 'selectAllDeadStock'), 10);
      } else if (activeTab === 'zeroStock') {
        const { items, total } = getPaginatedItems(data.reports.zeroStock);
        content.innerHTML = `
          <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="selectAllZeroStock"/> 
            <label for="selectAllZeroStock" style="cursor:pointer;font-size:13px;margin:0">Select all on this page</label>
            <span style="margin-left:auto;font-size:12px;color:var(--text-muted)">${total} items total</span>
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th style="width:40px"></th>
            <th>Product</th><th>SKU</th><th style="text-align:right">Sold</th><th style="text-align:right">Days Left</th>
          </tr></thead><tbody>${items.map(i => `<tr>
            <td><input type="checkbox" data-sku="${i.sku}" class="item-checkbox"></td>
            <td><strong>${escHtml(i.product)}</strong></td>
            <td style="font-family:monospace;font-size:12px">${escHtml(i.sku)}</td>
            <td style="text-align:right">${i.unitsSold}</td>
            <td style="text-align:right;color:var(--red);">${i.daysOfStock === 999 ? '∞' : i.daysOfStock}</td>
          </tr>`).join('')}</tbody></table></div>
          ${renderPagination(total)}
        `;
        setTimeout(() => setupCheckboxes(data.reports.zeroStock, 'selectAllZeroStock'), 10);
      } else if (activeTab === 'missingData') {
        const { items, total } = getPaginatedItems(data.reports.missingData);
        content.innerHTML = `
          <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="selectAllMissingData"/> 
            <label for="selectAllMissingData" style="cursor:pointer;font-size:13px;margin:0">Select all on this page</label>
            <span style="margin-left:auto;font-size:12px;color:var(--text-muted)">${total} items total</span>
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th style="width:40px"></th>
            <th>Product</th><th>SKU</th><th>Missing</th>
          </tr></thead><tbody>${items.map(i => `<tr>
            <td><input type="checkbox" data-sku="${i.sku}" class="item-checkbox"></td>
            <td><strong>${escHtml(i.product)}</strong></td>
            <td style="font-family:monospace;font-size:12px">${escHtml(i.sku)}</td>
            <td><span style="padding:2px 6px;border-radius:3px;font-size:11px;background:var(--red-soft);color:var(--red)">${i.missingFields.join(', ')}</span></td>
          </tr>`).join('')}</tbody></table></div>
          ${renderPagination(total)}
        `;
        setTimeout(() => setupCheckboxes(data.reports.missingData, 'selectAllMissingData'), 10);
      } else if (activeTab === 'slowMovers') {
        const { items, total } = getPaginatedItems(data.reports.slowMovers);
        content.innerHTML = `
          <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="selectAllSlowMovers"/> 
            <label for="selectAllSlowMovers" style="cursor:pointer;font-size:13px;margin:0">Select all on this page</label>
            <span style="margin-left:auto;font-size:12px;color:var(--text-muted)">${total} items total</span>
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th style="width:40px"></th>
            <th>Product</th><th style="text-align:right">Monthly Sales</th><th style="text-align:right">Stock</th>
          </tr></thead><tbody>${items.map(i => `<tr>
            <td><input type="checkbox" data-sku="${i.sku}" class="item-checkbox"></td>
            <td><strong>${escHtml(i.product)}</strong></td>
            <td style="text-align:right">${i.monthlyVelocity}</td>
            <td style="text-align:right">${i.available}</td>
          </tr>`).join('')}</tbody></table></div>
          ${renderPagination(total)}
        `;
        setTimeout(() => setupCheckboxes(data.reports.slowMovers, 'selectAllSlowMovers'), 10);
      } else if (activeTab === 'noSales') {
        const { items, total } = getPaginatedItems(data.reports.noSales);
        content.innerHTML = `
          <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="selectAllNoSales"/> 
            <label for="selectAllNoSales" style="cursor:pointer;font-size:13px;margin:0">Select all on this page</label>
            <span style="margin-left:auto;font-size:12px;color:var(--text-muted)">${total} items total</span>
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th style="width:40px"></th>
            <th>Product</th><th>SKU</th><th style="text-align:right">Stock</th><th style="text-align:right">Days</th>
          </tr></thead><tbody>${items.map(i => `<tr>
            <td><input type="checkbox" data-sku="${i.sku}" class="item-checkbox"></td>
            <td><strong>${escHtml(i.product)}</strong></td>
            <td style="font-family:monospace;font-size:12px">${escHtml(i.sku)}</td>
            <td style="text-align:right">${i.available}</td>
            <td style="text-align:right">${i.daysTracked}d</td>
          </tr>`).join('')}</tbody></table></div>
          ${renderPagination(total)}
        `;
        setTimeout(() => setupCheckboxes(data.reports.noSales, 'selectAllNoSales'), 10);
      }
    }

    function setupCheckboxes(fullList, selectAllId) {
      $$('.item-checkbox').forEach(cb => {
        cb.checked = selected.has(cb.dataset.sku);
        cb.addEventListener('change', (e) => {
          if (e.target.checked) selected.add(e.target.dataset.sku);
          else selected.delete(e.target.dataset.sku);
        });
      });
      
      const selectAllCheckbox = $(selectAllId);
      if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', (e) => {
          const content = document.getElementById('cleanupContent');
          const itemCheckboxes = content?.querySelectorAll('.item-checkbox') || [];
          itemCheckboxes.forEach(cb => {
            cb.checked = e.target.checked;
            if (e.target.checked) selected.add(cb.dataset.sku);
            else selected.delete(cb.dataset.sku);
          });
        });
      }
    }

    window.cleanupNextPage = () => { currentPage++; renderTab(); };
    window.cleanupPrevPage = () => { currentPage--; renderTab(); };

    $('#content').innerHTML = `
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">Inventory Cleanup</h2>
          <p style="font-size:13px;color:var(--text-muted);margin:0">☑ Check items → 📁 Bulk Action → Done. Makes cleanup super easy.</p>
        </div>
        <div class="toolbar" style="border-bottom:0;padding-bottom:0">
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="filter-btn active" data-ctab="overview">Overview</button>
            <button class="filter-btn" data-ctab="selected" style="background:var(--accent-soft);color:var(--accent)">✓ Selected (0)</button>
            <button class="filter-btn" data-ctab="deadStock">🗑 Dead Stock (${data.deadStockCount})</button>
            <button class="filter-btn" data-ctab="zeroStock">📦 Zero Stock (${data.zeroStockCount})</button>
            <button class="filter-btn" data-ctab="missingData">⚠ Missing Data (${data.missingDataCount})</button>
            <button class="filter-btn" data-ctab="slowMovers">🐢 Slow (${data.slowMoversCount})</button>
            <button class="filter-btn" data-ctab="noSales">○ No Sales (${data.noSalesCount})</button>
          </div>
        </div>
      </div>
      <div class="section" style="padding:20px">
        <div id="cleanupContent"></div>
      </div>
    `;

    renderTab();
    $$('[data-ctab]').forEach(btn => btn.addEventListener('click', () => {
      $$('[data-ctab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.ctab;
      currentPage = 1;
      const selectedBtn = $('[data-ctab=selected]');
      if (selectedBtn) selectedBtn.textContent = `✓ Selected (${selected.size})`;
      renderTab();
    }));
  } catch (err) { $('#content').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`; }
}
