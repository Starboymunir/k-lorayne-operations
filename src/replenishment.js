// K.Lorayne Apparel — Weekly Replenishment Report
// Run every Monday: npm run replenishment
// Generates a prioritized purchase order recommendation

import 'dotenv/config';
import { shopifyGraphQL, getShopDomain } from './auth.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'output');

// ─── CONFIGURATION ─────────────────────────────────────
const CONFIG = {
  leadTimeDays: 14,       // How long it takes to receive an order from supplier
  safetyStockDays: 7,     // Buffer for demand spikes / late shipments
  orderCycleDays: 30,     // How much stock to order at a time (1 month supply)
  lookbackDays: 90,       // How far back to look for sales velocity
  lowStockDays: 21,       // Flag as "watch" if less than this many days of stock
};

// ─── QUERIES ────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query ($cursor: String) {
    products(first: 10, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          productType
          vendor
          tags
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                inventoryItem {
                  id
                  tracked
                  inventoryLevels(first: 5) {
                    edges {
                      node {
                        quantities(names: ["available", "committed", "on_hand"]) {
                          name
                          quantity
                        }
                        location { name }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const ORDERS_QUERY = `
  query ($cursor: String, $dateFilter: String) {
    orders(first: 50, after: $cursor, query: $dateFilter) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          createdAt
          lineItems(first: 100) {
            edges {
              node {
                sku
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

// ─── DATA FETCHING ──────────────────────────────────────

async function fetchActiveProducts() {
  let all = [];
  let cursor = null;
  let page = 0;
  while (true) {
    page++;
    const result = await shopifyGraphQL(PRODUCTS_QUERY, { cursor });
    const products = result.data.products.edges.map(e => e.node);
    all = all.concat(products);
    process.stdout.write(`\r  Products: ${all.length}`);
    if (result.data.products.pageInfo.hasNextPage) {
      cursor = result.data.products.pageInfo.endCursor;
    } else break;
  }
  console.log();
  return all;
}

async function fetchRecentOrders() {
  const sinceDate = new Date(Date.now() - CONFIG.lookbackDays * 86400000).toISOString().split('T')[0];
  const dateFilter = `created_at:>=${sinceDate}`;
  let all = [];
  let cursor = null;
  let page = 0;
  while (true) {
    page++;
    const result = await shopifyGraphQL(ORDERS_QUERY, { cursor, dateFilter });
    const orders = result.data.orders.edges.map(e => e.node);
    all = all.concat(orders);
    process.stdout.write(`\r  Orders: ${all.length}`);
    if (result.data.orders.pageInfo.hasNextPage) {
      cursor = result.data.orders.pageInfo.endCursor;
    } else break;
  }
  console.log();
  return all;
}

// ─── ANALYSIS ───────────────────────────────────────────

function analyze(products, orders) {
  // Build SKU sales map
  const skuSales = {};
  const orderDates = orders.map(o => new Date(o.createdAt));
  const now = new Date();
  const oldest = orderDates.length > 0 ? new Date(Math.min(...orderDates)) : now;
  const daysCovered = Math.max(1, Math.ceil((now - oldest) / 86400000));

  for (const order of orders) {
    for (const li of order.lineItems.edges) {
      const sku = li.node.sku || '';
      if (!sku) continue;
      skuSales[sku] = (skuSales[sku] || 0) + li.node.quantity;
    }
  }

  // Build variant list with inventory + velocity data
  const items = [];
  for (const product of products) {
    for (const ve of product.variants.edges) {
      const v = ve.node;
      const sku = v.sku || '';
      if (!sku) continue;
      if (!v.inventoryItem?.tracked) continue;

      const levels = v.inventoryItem.inventoryLevels?.edges?.map(e => e.node) || [];
      const available = levels.reduce((s, l) => {
        const q = l.quantities?.find(q => q.name === 'available');
        return s + (q?.quantity || 0);
      }, 0);
      const committed = levels.reduce((s, l) => {
        const q = l.quantities?.find(q => q.name === 'committed');
        return s + (q?.quantity || 0);
      }, 0);
      const onHand = levels.reduce((s, l) => {
        const q = l.quantities?.find(q => q.name === 'on_hand');
        return s + (q?.quantity || 0);
      }, 0);

      const unitsSold = skuSales[sku] || 0;
      const dailyVelocity = unitsSold / daysCovered;
      const weeklyVelocity = dailyVelocity * 7;
      const monthlyVelocity = dailyVelocity * 30;

      const daysOfStock = dailyVelocity > 0
        ? Math.round(available / dailyVelocity)
        : (available > 0 ? 999 : 0);

      const reorderPoint = Math.ceil(dailyVelocity * (CONFIG.leadTimeDays + CONFIG.safetyStockDays));
      const suggestedQty = Math.max(1, Math.ceil(dailyVelocity * CONFIG.orderCycleDays));
      const needsReorder = dailyVelocity > 0 && available <= reorderPoint;

      let priority;
      if (available <= 0 && unitsSold > 0)       priority = 'CRITICAL';
      else if (needsReorder && daysOfStock < 14)  priority = 'URGENT';
      else if (needsReorder)                      priority = 'REORDER';
      else if (daysOfStock < CONFIG.lowStockDays && dailyVelocity > 0) priority = 'WATCH';
      else                                        priority = 'OK';

      items.push({
        sku,
        product: product.title,
        variant: v.title,
        productType: product.productType || 'Unknown',
        vendor: product.vendor || 'Unknown',
        price: parseFloat(v.price),
        available,
        committed,
        onHand,
        unitsSold,
        dailyVelocity,
        weeklyVelocity: Math.round(weeklyVelocity * 10) / 10,
        monthlyVelocity: Math.round(monthlyVelocity),
        daysOfStock,
        reorderPoint,
        suggestedQty,
        needsReorder,
        priority,
        estimatedCost: suggestedQty * parseFloat(v.price) * 0.4, // rough COGS estimate at 40% of retail
      });
    }
  }

  return { items, daysCovered, totalOrders: orders.length };
}

// ─── REPORT GENERATION ──────────────────────────────────

function generateReplenishmentReport(data) {
  const { items, daysCovered, totalOrders } = data;
  const today = new Date().toISOString().split('T')[0];
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];

  const critical = items.filter(i => i.priority === 'CRITICAL');
  const urgent   = items.filter(i => i.priority === 'URGENT');
  const reorder  = items.filter(i => i.priority === 'REORDER');
  const watch    = items.filter(i => i.priority === 'WATCH');
  const allReorder = [...critical, ...urgent, ...reorder];

  let r = '';

  r += `╔══════════════════════════════════════════════════════════════════╗\n`;
  r += `║  K.LORAYNE APPAREL — WEEKLY REPLENISHMENT REPORT              ║\n`;
  r += `║  ${dayName}, ${today}                                              ║\n`;
  r += `╚══════════════════════════════════════════════════════════════════╝\n\n`;

  r += `  Settings: ${CONFIG.leadTimeDays}d lead time | ${CONFIG.safetyStockDays}d safety stock | ${CONFIG.lookbackDays}d lookback\n`;
  r += `  Data: ${totalOrders} orders over ${daysCovered} days | ${items.length} tracked SKUs\n\n`;

  // ── SUMMARY ──
  r += `═══ STATUS SUMMARY ═══\n\n`;
  r += `  🔴 CRITICAL (out of stock, has demand):  ${critical.length} SKUs\n`;
  r += `  🟠 URGENT (< 14 days of stock):          ${urgent.length} SKUs\n`;
  r += `  🟡 REORDER (below reorder point):        ${reorder.length} SKUs\n`;
  r += `  👀 WATCH (< 21 days of stock):           ${watch.length} SKUs\n`;
  r += `  ✅ OK:                                    ${items.filter(i => i.priority === 'OK').length} SKUs\n\n`;

  const totalEstCost = allReorder.reduce((s, i) => s + i.estimatedCost, 0);
  r += `  Estimated PO cost (all reorders): ~$${totalEstCost.toFixed(0)} (at ~40% of retail)\n\n`;

  // ── CRITICAL: ORDER IMMEDIATELY ──
  if (critical.length > 0) {
    r += `═══ 🔴 CRITICAL — ORDER IMMEDIATELY (${critical.length} SKUs) ═══\n\n`;
    // Group by product
    const byProduct = {};
    for (const item of critical) {
      if (!byProduct[item.product]) byProduct[item.product] = [];
      byProduct[item.product].push(item);
    }
    for (const [productName, variants] of Object.entries(byProduct)) {
      r += `  ${productName}\n`;
      for (const v of variants) {
        r += `    ${v.variant.padEnd(20)} SKU: ${v.sku.padEnd(20)} Monthly: ${String(v.monthlyVelocity).padStart(3)} → Order: ${v.suggestedQty} units\n`;
      }
      r += `\n`;
    }
  }

  // ── URGENT ──
  if (urgent.length > 0) {
    r += `═══ 🟠 URGENT — ADD TO THIS WEEK'S PO (${urgent.length} SKUs) ═══\n\n`;
    const byProduct = {};
    for (const item of urgent) {
      if (!byProduct[item.product]) byProduct[item.product] = [];
      byProduct[item.product].push(item);
    }
    for (const [productName, variants] of Object.entries(byProduct)) {
      r += `  ${productName}\n`;
      for (const v of variants) {
        r += `    ${v.variant.padEnd(20)} SKU: ${v.sku.padEnd(20)} Stock: ${String(v.available).padStart(3)} | ${v.daysOfStock}d left → Order: ${v.suggestedQty} units\n`;
      }
      r += `\n`;
    }
  }

  // ── REORDER ──
  if (reorder.length > 0) {
    r += `═══ 🟡 REORDER — BELOW REORDER POINT (${reorder.length} SKUs) ═══\n\n`;
    const byProduct = {};
    for (const item of reorder) {
      if (!byProduct[item.product]) byProduct[item.product] = [];
      byProduct[item.product].push(item);
    }
    for (const [productName, variants] of Object.entries(byProduct)) {
      r += `  ${productName}\n`;
      for (const v of variants) {
        r += `    ${v.variant.padEnd(20)} SKU: ${v.sku.padEnd(20)} Stock: ${String(v.available).padStart(3)} | ${v.daysOfStock}d left → Order: ${v.suggestedQty} units\n`;
      }
      r += `\n`;
    }
  }

  // ── WATCH LIST ──
  if (watch.length > 0) {
    r += `═══ 👀 WATCH LIST — MONITOR THIS WEEK (${watch.length} SKUs) ═══\n\n`;
    for (const v of watch.sort((a,b) => a.daysOfStock - b.daysOfStock)) {
      r += `  ${v.product.padEnd(35).slice(0,35)} ${v.variant.padEnd(15).slice(0,15)} Stock: ${String(v.available).padStart(3)} | ${v.daysOfStock}d left\n`;
    }
    r += `\n`;
  }

  // ── PURCHASE ORDER SUMMARY ──
  r += `═══ PURCHASE ORDER SUMMARY (by vendor) ═══\n\n`;
  const byVendor = {};
  for (const item of allReorder) {
    const vendor = item.vendor || 'Unknown';
    if (!byVendor[vendor]) byVendor[vendor] = [];
    byVendor[vendor].push(item);
  }
  for (const [vendor, vendorItems] of Object.entries(byVendor)) {
    const totalUnits = vendorItems.reduce((s, i) => s + i.suggestedQty, 0);
    const totalCost = vendorItems.reduce((s, i) => s + i.estimatedCost, 0);
    r += `  Vendor: ${vendor}\n`;
    r += `  Total SKUs: ${vendorItems.length} | Total Units: ${totalUnits} | Est. Cost: ~$${totalCost.toFixed(0)}\n`;
    r += `  ─────────────────────────────────────────────────────────\n`;
    for (const v of vendorItems) {
      r += `  ${v.sku.padEnd(22)} ${v.product.padEnd(30).slice(0,30)} ${v.variant.padEnd(15).slice(0,15)} Qty: ${String(v.suggestedQty).padStart(3)}\n`;
    }
    r += `\n`;
  }

  // ── NEXT ACTIONS ──
  r += `═══ WEEKLY CHECKLIST ═══\n\n`;
  r += `  □ Review CRITICAL items — place orders today\n`;
  r += `  □ Review URGENT items — add to this week's PO\n`;
  r += `  □ Check WATCH list — any accelerating sales?\n`;
  r += `  □ Confirm any pending shipments / incoming inventory\n`;
  r += `  □ Update lead times if supplier communicated changes\n`;
  r += `  □ Note any upcoming promotions that may spike demand\n\n`;

  r += `  Next report: Run again next Monday (npm run replenishment)\n`;
  r += `  Generated by K.Lorayne Operations Tool\n`;

  return r;
}

// ─── MAIN ───────────────────────────────────────────────

async function main() {
  console.log(`\n📦 Generating replenishment report for ${getShopDomain()}...\n`);

  console.log('  Fetching data...');
  const [products, orders] = await Promise.all([
    fetchActiveProducts(),
    fetchRecentOrders(),
  ]);

  console.log(`\n  Analyzing ${products.length} products, ${orders.length} orders...`);
  const data = analyze(products, orders);

  const report = generateReplenishmentReport(data);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const reportPath = join(OUTPUT_DIR, `replenishment-${today}.txt`);
  writeFileSync(reportPath, report, 'utf-8');
  console.log(`\n✅ Report saved: ${reportPath}`);

  // Also save as CSV for spreadsheet import
  const csvPath = join(OUTPUT_DIR, `reorder-list-${today}.csv`);
  const reorderItems = data.items.filter(i => i.priority !== 'OK');
  let csv = 'Priority,SKU,Product,Variant,Vendor,Type,Available,Committed,Monthly Sales,Days Left,Reorder Point,Order Qty,Est Cost\n';
  for (const i of reorderItems.sort((a,b) => {
    const pOrder = { CRITICAL: 0, URGENT: 1, REORDER: 2, WATCH: 3 };
    return (pOrder[a.priority] || 9) - (pOrder[b.priority] || 9);
  })) {
    csv += `${i.priority},"${i.sku}","${i.product}","${i.variant}","${i.vendor}","${i.productType}",${i.available},${i.committed},${i.monthlyVelocity},${i.daysOfStock},${i.reorderPoint},${i.suggestedQty},${i.estimatedCost.toFixed(2)}\n`;
  }
  writeFileSync(csvPath, csv, 'utf-8');
  console.log(`✅ CSV saved:    ${csvPath}`);

  // Print quick summary
  const crit = data.items.filter(i => i.priority === 'CRITICAL').length;
  const urg = data.items.filter(i => i.priority === 'URGENT').length;
  const reord = data.items.filter(i => i.priority === 'REORDER').length;
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`  🔴 ${crit} critical | 🟠 ${urg} urgent | 🟡 ${reord} reorder`);
  console.log(`  Full report: ${reportPath}`);
  console.log(`  CSV for PO:  ${csvPath}\n`);
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
