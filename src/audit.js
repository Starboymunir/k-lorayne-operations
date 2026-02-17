// K.Lorayne Apparel - Full Inventory Audit Script
// Pulls all products, variants, inventory levels, and order history
// Generates a comprehensive audit report

import 'dotenv/config';
import { shopifyGraphQL, getShopDomain } from './auth.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'output');

// ─── QUERIES ───────────────────────────────────────────

const PRODUCTS_QUERY = `
  query ($cursor: String) {
    products(first: 10, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          status
          productType
          vendor
          tags
          totalInventory
          tracksInventory
          createdAt
          updatedAt
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
                  inventoryLevels(first: 10) {
                    edges {
                      node {
                        id
                        quantities(names: ["available", "committed", "incoming", "on_hand"]) {
                          name
                          quantity
                        }
                        location {
                          id
                          name
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
  }
`;

const ORDERS_QUERY = `
  query ($cursor: String, $dateFilter: String) {
    orders(first: 50, after: $cursor, query: $dateFilter) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 100) {
            edges {
              node {
                sku
                quantity
                variant {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

const LOCATIONS_QUERY = `
  {
    locations(first: 20) {
      edges {
        node {
          id
          name
          isActive
          address { address1 city province country }
        }
      }
    }
  }
`;

// ─── DATA FETCHING ─────────────────────────────────────

async function fetchAllProducts() {
  console.log('[audit] Fetching all products...');
  let allProducts = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const result = await shopifyGraphQL(PRODUCTS_QUERY, { cursor });
    const products = result.data.products.edges.map(e => e.node);
    allProducts = allProducts.concat(products);
    console.log(`  Page ${page}: fetched ${products.length} products (total: ${allProducts.length})`);

    if (result.data.products.pageInfo.hasNextPage) {
      cursor = result.data.products.pageInfo.endCursor;
    } else {
      break;
    }
  }

  return allProducts;
}

async function fetchOrders(daysBack = 90) {
  const sinceDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const dateFilter = `created_at:>=${sinceDate}`;
  console.log(`[audit] Fetching orders since ${sinceDate}...`);

  let allOrders = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const result = await shopifyGraphQL(ORDERS_QUERY, { cursor, dateFilter });
    const orders = result.data.orders.edges.map(e => e.node);
    allOrders = allOrders.concat(orders);
    console.log(`  Page ${page}: fetched ${orders.length} orders (total: ${allOrders.length})`);

    if (result.data.orders.pageInfo.hasNextPage) {
      cursor = result.data.orders.pageInfo.endCursor;
    } else {
      break;
    }
  }

  return allOrders;
}

async function fetchLocations() {
  console.log('[audit] Fetching locations...');
  const result = await shopifyGraphQL(LOCATIONS_QUERY);
  return result.data.locations.edges.map(e => e.node);
}

// ─── ANALYSIS ──────────────────────────────────────────

function analyzeInventory(products, orders) {
  // Build variant lookup
  const variants = [];
  for (const product of products) {
    for (const ve of product.variants.edges) {
      const v = ve.node;
      const levels = v.inventoryItem?.inventoryLevels?.edges?.map(e => e.node) || [];
      const quantities = {};
      for (const level of levels) {
        for (const q of level.quantities || []) {
          quantities[q.name] = (quantities[q.name] || 0) + q.quantity;
        }
      }

      variants.push({
        productTitle: product.title,
        productStatus: product.status,
        productType: product.productType,
        vendor: product.vendor,
        tags: product.tags,
        variantTitle: v.title,
        sku: v.sku || '(no SKU)',
        price: parseFloat(v.price),
        tracked: v.inventoryItem?.tracked ?? false,
        available: quantities.available || 0,
        committed: quantities.committed || 0,
        incoming: quantities.incoming || 0,
        onHand: quantities.on_hand || 0,
        totalInventory: product.totalInventory,
        locationName: levels[0]?.location?.name || 'Unknown',
        variantId: v.id,
        productId: product.id,
        productCreatedAt: product.createdAt,
      });
    }
  }

  // Calculate sales velocity from orders (units sold per SKU over the period)
  const skuSales = {};
  const orderDates = [];

  for (const order of orders) {
    orderDates.push(new Date(order.createdAt));
    for (const li of order.lineItems.edges) {
      const sku = li.node.sku || '(no SKU)';
      skuSales[sku] = (skuSales[sku] || 0) + li.node.quantity;
    }
  }

  // Calculate the actual date range
  const now = new Date();
  const oldestOrder = orderDates.length > 0 ? new Date(Math.min(...orderDates)) : now;
  const daysCovered = Math.max(1, Math.ceil((now - oldestOrder) / (1000 * 60 * 60 * 24)));

  // Enrich variants with sales data
  for (const v of variants) {
    const totalSold = skuSales[v.sku] || 0;
    v.unitsSold90d = totalSold;
    v.dailyVelocity = totalSold / daysCovered;
    v.weeklyVelocity = v.dailyVelocity * 7;
    v.monthlyVelocity = v.dailyVelocity * 30;

    // Days of stock remaining (at current velocity)
    v.daysOfStock = v.dailyVelocity > 0 ? Math.round(v.available / v.dailyVelocity) : (v.available > 0 ? 999 : 0);

    // Classification
    if (v.monthlyVelocity >= 10) v.velocityClass = 'FAST MOVER';
    else if (v.monthlyVelocity >= 3) v.velocityClass = 'REGULAR';
    else if (v.monthlyVelocity > 0) v.velocityClass = 'SLOW MOVER';
    else v.velocityClass = 'NO SALES';
  }

  return { variants, skuSales, daysCovered, orderCount: orders.length };
}

function identifyIssues(variants) {
  const issues = [];

  for (const v of variants) {
    if (v.productStatus !== 'ACTIVE') continue;

    // No SKU
    if (v.sku === '(no SKU)') {
      issues.push({ sku: v.sku, product: v.productTitle, variant: v.variantTitle, severity: 'MEDIUM', issue: 'Missing SKU — cannot track properly' });
    }

    // Not tracked
    if (!v.tracked) {
      issues.push({ sku: v.sku, product: v.productTitle, variant: v.variantTitle, severity: 'HIGH', issue: 'Inventory NOT tracked — will never show stockout' });
    }

    // Zero stock but selling
    if (v.available <= 0 && v.unitsSold90d > 0) {
      issues.push({ sku: v.sku, product: v.productTitle, variant: v.variantTitle, severity: 'CRITICAL', issue: `OUT OF STOCK — sold ${v.unitsSold90d} units in last 90 days` });
    }

    // Low stock (less than 2 weeks of supply)
    if (v.available > 0 && v.daysOfStock < 14 && v.dailyVelocity > 0) {
      issues.push({ sku: v.sku, product: v.productTitle, variant: v.variantTitle, severity: 'HIGH', issue: `LOW STOCK — only ${v.daysOfStock} days left (${v.available} units) at current sell rate` });
    }

    // Dead stock (has inventory but no sales)
    if (v.available > 10 && v.unitsSold90d === 0) {
      issues.push({ sku: v.sku, product: v.productTitle, variant: v.variantTitle, severity: 'LOW', issue: `DEAD STOCK — ${v.available} units but 0 sales in 90 days` });
    }

    // Oversupply (>6 months of stock)
    if (v.daysOfStock > 180 && v.dailyVelocity > 0 && v.available > 20) {
      issues.push({ sku: v.sku, product: v.productTitle, variant: v.variantTitle, severity: 'LOW', issue: `OVERSUPPLY — ${v.daysOfStock} days of stock (${v.available} units). Consider promotions or markdown.` });
    }
  }

  // Sort by severity
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return issues;
}

function generateReorderRecommendations(variants, leadTimeDays = 14, safetyStockDays = 7) {
  const recommendations = [];

  for (const v of variants) {
    if (v.productStatus !== 'ACTIVE') continue;
    if (v.dailyVelocity === 0) continue;

    const reorderPoint = Math.ceil(v.dailyVelocity * (leadTimeDays + safetyStockDays));
    const reorderQty = Math.ceil(v.dailyVelocity * 30); // 1 month supply

    const needsReorder = v.available <= reorderPoint;

    recommendations.push({
      sku: v.sku,
      product: v.productTitle,
      variant: v.variantTitle,
      currentStock: v.available,
      dailyVelocity: v.dailyVelocity.toFixed(2),
      monthlyVelocity: Math.round(v.monthlyVelocity),
      daysOfStock: v.daysOfStock,
      reorderPoint,
      suggestedOrderQty: reorderQty,
      needsReorder: needsReorder ? 'YES — ORDER NOW' : 'No',
      velocityClass: v.velocityClass,
    });
  }

  // Sort: needs reorder first, then by days of stock ascending
  recommendations.sort((a, b) => {
    if (a.needsReorder !== b.needsReorder) return a.needsReorder === 'YES — ORDER NOW' ? -1 : 1;
    return a.daysOfStock - b.daysOfStock;
  });

  return recommendations;
}

// ─── REPORT GENERATION ─────────────────────────────────

function generateReport(products, orders, locations, analysis, issues, recommendations) {
  const activeProducts = products.filter(p => p.status === 'ACTIVE');
  const activeVariants = analysis.variants.filter(v => v.productStatus === 'ACTIVE');
  const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
  const highIssues = issues.filter(i => i.severity === 'HIGH');
  const needsReorder = recommendations.filter(r => r.needsReorder === 'YES — ORDER NOW');

  const totalInventoryValue = activeVariants.reduce((sum, v) => sum + (v.available * v.price), 0);

  let report = '';

  report += `╔══════════════════════════════════════════════════════════════╗\n`;
  report += `║       K.LORAYNE APPAREL — INVENTORY AUDIT REPORT          ║\n`;
  report += `║       Generated: ${new Date().toISOString().split('T')[0]}                             ║\n`;
  report += `╚══════════════════════════════════════════════════════════════╝\n\n`;

  // ── STORE OVERVIEW ──
  report += `═══ STORE OVERVIEW ═══\n\n`;
  report += `  Total Products:        ${products.length}\n`;
  report += `  Active Products:       ${activeProducts.length}\n`;
  report += `  Total Variants:        ${analysis.variants.length}\n`;
  report += `  Active Variants:       ${activeVariants.length}\n`;
  report += `  Inventory Locations:   ${locations.length}\n`;
  for (const loc of locations) {
    report += `    → ${loc.name} (${loc.isActive ? 'Active' : 'Inactive'})${loc.address ? ` — ${loc.address.city || ''}, ${loc.address.province || ''}` : ''}\n`;
  }
  report += `\n`;

  // ── SALES OVERVIEW ──
  report += `═══ SALES OVERVIEW (Last ${analysis.daysCovered} days) ═══\n\n`;
  report += `  Total Orders:          ${analysis.orderCount}\n`;
  report += `  Avg Orders/Day:        ${(analysis.orderCount / analysis.daysCovered).toFixed(1)}\n`;
  report += `  Avg Orders/Month:      ${Math.round(analysis.orderCount / analysis.daysCovered * 30)}\n`;
  report += `  Unique SKUs Sold:      ${Object.keys(analysis.skuSales).length}\n`;
  report += `  Total Units Sold:      ${Object.values(analysis.skuSales).reduce((a, b) => a + b, 0)}\n`;
  report += `\n`;

  // ── INVENTORY HEALTH ──
  report += `═══ INVENTORY HEALTH ═══\n\n`;
  report += `  Total Inventory Value:  $${totalInventoryValue.toFixed(2)}\n`;
  report += `  Total Units On Hand:    ${activeVariants.reduce((s, v) => s + v.onHand, 0)}\n`;
  report += `  Total Units Available:  ${activeVariants.reduce((s, v) => s + v.available, 0)}\n`;
  report += `  Total Units Committed:  ${activeVariants.reduce((s, v) => s + v.committed, 0)}\n`;
  report += `\n`;

  const velocityGroups = { 'FAST MOVER': 0, 'REGULAR': 0, 'SLOW MOVER': 0, 'NO SALES': 0 };
  for (const v of activeVariants) velocityGroups[v.velocityClass]++;
  report += `  Velocity Breakdown (active variants):\n`;
  for (const [cls, count] of Object.entries(velocityGroups)) {
    report += `    ${cls.padEnd(15)} ${count} variants\n`;
  }
  report += `\n`;

  // ── CRITICAL ISSUES ──
  report += `═══ ISSUES FOUND: ${issues.length} total ═══\n`;
  report += `  🔴 CRITICAL: ${criticalIssues.length}\n`;
  report += `  🟠 HIGH:     ${highIssues.length}\n`;
  report += `  🟡 MEDIUM:   ${issues.filter(i => i.severity === 'MEDIUM').length}\n`;
  report += `  🟢 LOW:      ${issues.filter(i => i.severity === 'LOW').length}\n\n`;

  if (issues.length > 0) {
    for (const issue of issues) {
      const icon = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🟢' }[issue.severity];
      report += `  ${icon} [${issue.severity}] ${issue.product}`;
      if (issue.variant !== 'Default Title') report += ` / ${issue.variant}`;
      report += `\n     SKU: ${issue.sku}\n     ${issue.issue}\n\n`;
    }
  }

  // ── REORDER RECOMMENDATIONS ──
  report += `═══ REORDER RECOMMENDATIONS ═══\n`;
  report += `  (Assuming ${14}-day lead time + ${7}-day safety stock)\n\n`;

  if (needsReorder.length > 0) {
    report += `  ⚠️  ${needsReorder.length} SKUs NEED REORDER NOW:\n\n`;
    for (const r of needsReorder) {
      report += `  → ${r.product}`;
      if (r.variant !== 'Default Title') report += ` / ${r.variant}`;
      report += `\n    SKU: ${r.sku} | Stock: ${r.currentStock} | Days Left: ${r.daysOfStock} | Monthly Sales: ${r.monthlyVelocity}\n`;
      report += `    Reorder Point: ${r.reorderPoint} | Suggested Order Qty: ${r.suggestedOrderQty}\n\n`;
    }
  } else {
    report += `  ✅ All active SKUs are above reorder point.\n\n`;
  }

  // ── FULL VARIANT TABLE ──
  report += `═══ FULL VARIANT INVENTORY TABLE ═══\n\n`;
  report += `${'SKU'.padEnd(25)} ${'Product'.padEnd(35)} ${'Variant'.padEnd(20)} ${'Avail'.padStart(6)} ${'Sold90d'.padStart(8)} ${'Daily'.padStart(6)} ${'DaysLeft'.padStart(9)} ${'Class'.padEnd(12)}\n`;
  report += `${'─'.repeat(130)}\n`;

  // Sort by days of stock ascending for active selling items
  const sortedVariants = [...activeVariants].sort((a, b) => a.daysOfStock - b.daysOfStock);
  for (const v of sortedVariants) {
    report += `${v.sku.padEnd(25).slice(0, 25)} ${v.productTitle.padEnd(35).slice(0, 35)} ${v.variantTitle.padEnd(20).slice(0, 20)} ${String(v.available).padStart(6)} ${String(v.unitsSold90d).padStart(8)} ${v.dailyVelocity.toFixed(1).padStart(6)} ${String(v.daysOfStock).padStart(9)} ${v.velocityClass.padEnd(12)}\n`;
  }
  report += `\n`;

  // ── TOP SELLERS ──
  report += `═══ TOP 20 SELLERS (by units, last ${analysis.daysCovered} days) ═══\n\n`;
  const topSellers = Object.entries(analysis.skuSales)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  for (let i = 0; i < topSellers.length; i++) {
    const [sku, qty] = topSellers[i];
    const variant = activeVariants.find(v => v.sku === sku);
    report += `  ${String(i + 1).padStart(2)}. ${sku.padEnd(25)} — ${qty} units sold`;
    if (variant) report += ` | Stock: ${variant.available} | Days Left: ${variant.daysOfStock}`;
    report += `\n`;
  }
  report += `\n`;

  // ── SUMMARY ──
  report += `═══ AUDIT SUMMARY ═══\n\n`;
  report += `  This audit covers ${products.length} products with ${analysis.variants.length} variants\n`;
  report += `  across ${locations.length} location(s), with ${analysis.orderCount} orders over the last ${analysis.daysCovered} days.\n\n`;

  if (criticalIssues.length > 0) {
    report += `  ⚡ IMMEDIATE ACTION: ${criticalIssues.length} SKUs are OUT OF STOCK with active demand.\n`;
  }
  if (needsReorder.length > 0) {
    report += `  ⚡ REORDER NOW: ${needsReorder.length} SKUs are below their reorder point.\n`;
  }
  report += `\n  Report generated by K.Lorayne Operations Tool\n`;

  return report;
}

// ─── MAIN ──────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Starting inventory audit for ${getShopDomain()}...\n`);

  try {
    // Fetch all data
    const [products, locations] = await Promise.all([
      fetchAllProducts(),
      fetchLocations(),
    ]);

    const orders = await fetchOrders(90);

    console.log(`\n[audit] Data fetched: ${products.length} products, ${orders.length} orders, ${locations.length} locations\n`);

    // Analyze
    const analysis = analyzeInventory(products, orders);
    const issues = identifyIssues(analysis.variants);
    const recommendations = generateReorderRecommendations(analysis.variants);

    // Generate report
    const report = generateReport(products, orders, locations, analysis, issues, recommendations);

    // Output
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const reportPath = join(OUTPUT_DIR, `inventory-audit-${new Date().toISOString().split('T')[0]}.txt`);
    writeFileSync(reportPath, report, 'utf-8');
    console.log(`\n✅ Audit report saved to: ${reportPath}`);

    // Also save raw data as JSON for further processing
    const dataPath = join(OUTPUT_DIR, `inventory-data-${new Date().toISOString().split('T')[0]}.json`);
    writeFileSync(dataPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      store: getShopDomain(),
      products: products.length,
      orders: orders.length,
      locations,
      variants: analysis.variants,
      issues,
      recommendations,
      skuSales: analysis.skuSales,
      daysCovered: analysis.daysCovered,
    }, null, 2), 'utf-8');
    console.log(`✅ Raw data saved to: ${dataPath}`);

    // Print summary to console
    const critCount = issues.filter(i => i.severity === 'CRITICAL').length;
    const highCount = issues.filter(i => i.severity === 'HIGH').length;
    const reorderCount = recommendations.filter(r => r.needsReorder === 'YES — ORDER NOW').length;

    console.log(`\n═══ QUICK SUMMARY ═══`);
    console.log(`  Products: ${products.length} | Variants: ${analysis.variants.length} | Orders (90d): ${orders.length}`);
    console.log(`  Issues: 🔴 ${critCount} critical | 🟠 ${highCount} high | ${issues.length} total`);
    console.log(`  Reorder Now: ${reorderCount} SKUs`);
    console.log(`\n  Full report: ${reportPath}\n`);

  } catch (error) {
    console.error('\n❌ Audit failed:', error.message);
    if (error.message.includes('token') || error.message.includes('401')) {
      console.error('   → Check your .env credentials and make sure the app is installed on the store.');
    }
    throw error;
  }
}

main();
