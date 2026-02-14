// K.Lorayne Apparel — Low-Stock Alert Check
// Quick daily/on-demand check for items running low
// Run: npm run alerts
// Faster than full replenishment report — just scans current inventory vs velocity

import 'dotenv/config';
import { shopifyGraphQL, getShopDomain } from './auth.js';

// ─── CONFIGURATION ─────────────────────────────────────
const LEAD_TIME_DAYS = 14;
const SAFETY_DAYS = 7;
const ALERT_DAYS = LEAD_TIME_DAYS + SAFETY_DAYS; // 21 days

// Lightweight query — just active products with inventory
const PRODUCTS_QUERY = `
  query ($cursor: String) {
    products(first: 10, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          variants(first: 100) {
            edges {
              node {
                title
                sku
                price
                inventoryQuantity
                inventoryItem {
                  tracked
                  inventoryLevels(first: 5) {
                    edges {
                      node {
                        quantities(names: ["available"]) { name quantity }
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
              node { sku quantity }
            }
          }
        }
      }
    }
  }
`;

// ─── FETCH ──────────────────────────────────────────────

async function fetchAll(query, key, vars = {}) {
  let all = [];
  let cursor = null;
  while (true) {
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await shopifyGraphQL(query, { ...vars, cursor });
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    const items = result.data[key].edges.map(e => e.node);
    all = all.concat(items);
    if (result.data[key].pageInfo.hasNextPage) {
      cursor = result.data[key].pageInfo.endCursor;
    } else break;
  }
  return all;
}

// ─── MAIN ───────────────────────────────────────────────

async function main() {
  const shop = getShopDomain();
  console.log(`\n⚡ Low-stock alert check for ${shop}\n`);

  // Fetch products
  process.stdout.write('  Loading products...');
  const products = await fetchAll(PRODUCTS_QUERY, 'products');
  console.log(` ${products.length}`);

  // Fetch recent orders for velocity
  const sinceDate = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
  process.stdout.write('  Loading orders (90d)...');
  const orders = await fetchAll(ORDERS_QUERY, 'orders', { dateFilter: `created_at:>=${sinceDate}` });
  console.log(` ${orders.length}`);

  // Build sales velocity
  const skuSales = {};
  const orderDates = orders.map(o => new Date(o.createdAt));
  const daysCovered = Math.max(1, Math.ceil((new Date() - new Date(Math.min(...orderDates))) / 86400000));

  for (const order of orders) {
    for (const li of order.lineItems.edges) {
      if (li.node.sku) {
        skuSales[li.node.sku] = (skuSales[li.node.sku] || 0) + li.node.quantity;
      }
    }
  }

  // Scan inventory
  const alerts = { critical: [], urgent: [], watch: [] };
  let totalChecked = 0;

  for (const product of products) {
    for (const ve of product.variants.edges) {
      const v = ve.node;
      if (!v.sku || !v.inventoryItem?.tracked) continue;
      totalChecked++;

      const available = v.inventoryItem.inventoryLevels?.edges?.reduce((s, e) => {
        const q = e.node.quantities?.find(q => q.name === 'available');
        return s + (q?.quantity || 0);
      }, 0) || 0;

      const sold = skuSales[v.sku] || 0;
      const dailyVel = sold / daysCovered;

      if (dailyVel === 0) continue; // Skip items with no sales

      const daysLeft = Math.round(available / dailyVel);
      const reorderPoint = Math.ceil(dailyVel * ALERT_DAYS);
      const monthlyVel = Math.round(dailyVel * 30);

      const entry = {
        product: product.title,
        variant: v.title,
        sku: v.sku,
        available,
        daysLeft,
        monthlyVel,
        orderQty: Math.max(1, Math.ceil(dailyVel * 30)),
      };

      if (available <= 0) {
        alerts.critical.push(entry);
      } else if (daysLeft < LEAD_TIME_DAYS) {
        alerts.urgent.push(entry);
      } else if (daysLeft < ALERT_DAYS) {
        alerts.watch.push(entry);
      }
    }
  }

  // ── DISPLAY RESULTS ──
  const total = alerts.critical.length + alerts.urgent.length + alerts.watch.length;

  console.log(`\n  Checked ${totalChecked} tracked SKUs\n`);

  if (total === 0) {
    console.log('  ✅ All items are above alert thresholds. No action needed.\n');
    return;
  }

  // Critical
  if (alerts.critical.length > 0) {
    console.log(`  🔴 CRITICAL — OUT OF STOCK (${alerts.critical.length} items):\n`);
    for (const a of alerts.critical.sort((a,b) => b.monthlyVel - a.monthlyVel)) {
      const name = a.variant === 'Default Title' ? a.product : `${a.product} / ${a.variant}`;
      console.log(`     ${name}`);
      console.log(`     SKU: ${a.sku} | Monthly sales: ${a.monthlyVel} | → Order ${a.orderQty} units\n`);
    }
  }

  // Urgent
  if (alerts.urgent.length > 0) {
    console.log(`  🟠 URGENT — WILL STOCKOUT BEFORE RESTOCK (${alerts.urgent.length} items):\n`);
    for (const a of alerts.urgent.sort((a,b) => a.daysLeft - b.daysLeft)) {
      const name = a.variant === 'Default Title' ? a.product : `${a.product} / ${a.variant}`;
      console.log(`     ${name}`);
      console.log(`     SKU: ${a.sku} | Stock: ${a.available} | ${a.daysLeft}d left | → Order ${a.orderQty} units\n`);
    }
  }

  // Watch
  if (alerts.watch.length > 0) {
    console.log(`  👀 WATCH — APPROACHING REORDER POINT (${alerts.watch.length} items):\n`);
    for (const a of alerts.watch.sort((a,b) => a.daysLeft - b.daysLeft)) {
      const name = a.variant === 'Default Title' ? a.product : `${a.product} / ${a.variant}`;
      console.log(`     ${name} — ${a.daysLeft}d left (${a.available} units)\n`);
    }
  }

  // Summary
  console.log(`  ═══════════════════════════════════════`);
  console.log(`  Total alerts: ${total}`);
  console.log(`  🔴 ${alerts.critical.length} critical | 🟠 ${alerts.urgent.length} urgent | 👀 ${alerts.watch.length} watch`);
  console.log(`  ═══════════════════════════════════════\n`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
