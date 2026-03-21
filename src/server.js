// K.Lorayne Operations — Enterprise CRM & Inventory Server
import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { shopifyGraphQL, getShopDomain } from './auth.js';
import {
  getTickets, getTicketById, createTicket, updateTicket,
  addTicketNote, deleteTicket,
  getCustomerNotes, addCustomerNote,
  getCustomerTags, setCustomerTags,
  getSavedReplies, addSavedReply, deleteSavedReply, saveCustomReplies,
  getCategories, addCategory, updateCategory, deleteCategory,
  getCrmStats,
  getSettings, updateSettings,
  logActivity, getActivityLog,
} from './crm-store.js';
import { configureEmail, isEmailConfigured, sendEmail, sendTestEmail } from './email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3456;
const SHOPIFY_API_KEY = process.env.SHOPIFY_CLIENT_ID || '';
const SHOP_DOMAIN = process.env.SHOPIFY_SHOP ? `${process.env.SHOPIFY_SHOP}.myshopify.com` : '';
const SERVER_STARTED_AT = new Date().toISOString();

// ─── SHOPIFY EMBED HEADERS (allow iframe in Shopify admin) ───
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors https://admin.shopify.com https://${SHOP_DOMAIN}`
  );
  res.removeHeader('X-Frame-Options');
  next();
});

app.use(express.static(join(__dirname, '..', 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    const p = String(filePath || '').replace(/\\/g, '/');
    if (p.endsWith('/index.html') || p.endsWith('/app.js') || p.endsWith('/styles.css')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));
app.use(express.json());

app.get('/api/version', (req, res) => {
  res.json({
    startedAt: SERVER_STARTED_AT,
    commit: process.env.RENDER_GIT_COMMIT || null,
    nodeEnv: process.env.NODE_ENV || null,
  });
});

// ─── SHOPIFY GRAPHQL QUERIES ───────────────────

const PRODUCTS_QUERY = `
  query ($cursor: String) {
    products(first: 10, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id title handle productType vendor tags status
          totalInventory tracksInventory createdAt updatedAt
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
          variants(first: 100) {
            edges {
              node {
                id title sku price inventoryQuantity
                inventoryItem {
                  id tracked
                  inventoryLevels(first: 5) {
                    edges {
                      node {
                        quantities(names: ["available", "committed", "on_hand"]) {
                          name quantity
                        }
                        location { id name }
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
    orders(first: 100, after: $cursor, query: $dateFilter) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id name createdAt test
          displayFinancialStatus displayFulfillmentStatus
          cancelledAt cancelReason
          totalPriceSet { shopMoney { amount currencyCode } }
          currentTotalPriceSet { shopMoney { amount } }
          subtotalPriceSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          totalRefundedSet { shopMoney { amount } }
          customer { id displayName email phone }
          shippingAddress { city province country }
          lineItems(first: 100) {
            edges {
              node { sku quantity title variant { id } }
            }
          }
        }
      }
    }
  }
`;

const CUSTOMERS_QUERY = `
  query ($cursor: String) {
    customers(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id displayName email phone
          numberOfOrders
          amountSpent { amount currencyCode }
          createdAt updatedAt
          tags
          defaultAddress { city province country }
          lastOrder { id createdAt }
        }
      }
    }
  }
`;

// ─── BULK OPERATIONS (FAST FETCH FOR LARGE DATASETS) ───

const BULK_CUSTOMERS_MUTATION = `
  mutation {
    bulkOperationRunQuery(
      query: """
      {
        customers {
          edges {
            node {
              id
              displayName
              email
              phone
              numberOfOrders
              amountSpent { amount currencyCode }
              createdAt
              updatedAt
              tags
              defaultAddress { city province country }
              lastOrder { id createdAt }
            }
          }
        }
      }
      """
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const BULK_POLL_QUERY = `{ currentBulkOperation { id status errorCode objectCount fileSize url } }`;

async function fetchCustomersBulk() {
  // Cancel any lingering bulk operation (ignore errors — may not exist)
  try {
    const poll = await shopifyGraphQL(BULK_POLL_QUERY);
    const existing = poll.data?.currentBulkOperation;
    if (existing && (existing.status === 'RUNNING' || existing.status === 'CREATED')) {
      console.log(`[bulk] Cancelling existing operation ${existing.id}...`);
      await shopifyGraphQL(`mutation { bulkOperationCancel(id: "${existing.id}") { bulkOperation { id status } userErrors { field message } } }`);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (_) { /* no-op */ }

  // Step 1: Start bulk operation
  console.log('[bulk] Starting bulk customer fetch...');
  const start = await shopifyGraphQL(BULK_CUSTOMERS_MUTATION);
  const errs = start.data?.bulkOperationRunQuery?.userErrors;
  if (errs?.length) throw new Error('Bulk start failed: ' + errs.map(e => e.message).join(', '));
  console.log('[bulk] Operation submitted, waiting for Shopify to process...');

  // Step 2: Poll for completion
  let fileUrl = null;
  const t0 = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await shopifyGraphQL(BULK_POLL_QUERY);
    const op = poll.data?.currentBulkOperation;
    if (!op) throw new Error('Bulk operation disappeared');

    fetchStatus.customerCount = op.objectCount || fetchStatus.customerCount;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    if (op.status === 'COMPLETED') {
      fileUrl = op.url;
      console.log(`[bulk] Completed in ${elapsed}s — ${op.objectCount} objects, ${(op.fileSize / 1048576).toFixed(1)} MB`);
      break;
    } else if (op.status === 'FAILED' || op.status === 'CANCELED') {
      throw new Error(`Bulk operation ${op.status}: ${op.errorCode || 'unknown'}`);
    }
    if (parseInt(elapsed) % 10 === 0) console.log(`[bulk] ${op.status}... ${op.objectCount || 0} objects (${elapsed}s)`);
  }

  if (!fileUrl) { console.log('[bulk] No file URL — 0 customers'); return []; }

  // Step 3: Download JSONL and parse
  console.log('[bulk] Downloading results file...');
  const resp = await fetch(fileUrl);
  const text = await resp.text();

  const customers = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj.__parentId) customers.push(obj); // skip child connection rows
    } catch (_) { /* skip malformed lines */ }
  }

  console.log(`[bulk] Parsed ${customers.length} customers from JSONL`);
  fetchStatus.customerCount = customers.length;
  return customers;
}

// ─── PAGINATED FETCH ───────────────────────────

async function fetchAllPaginated(query, key, vars = {}, maxItems = Infinity) {
  let all = [];
  let cursor = null;
  let page = 0;
  while (true) {
    page++;
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await shopifyGraphQL(query, { ...vars, cursor });
        break;
      } catch (err) {
        console.error(`[fetch] ${key} page ${page} attempt ${attempt} error:`, err.message);
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    if (!result?.data?.[key]) {
      if (result?.errors) console.error(`[fetch] ${key} page ${page} GraphQL errors:`, JSON.stringify(result.errors));
      else console.log(`[fetch] ${key} page ${page}: no data (done or failed)`);
      break;
    }
    const items = result.data[key].edges.map(e => e.node);
    all = all.concat(items);
    console.log(`[fetch] ${key} page ${page}: got ${items.length} (total: ${all.length})`);
    if (key === 'customers') fetchStatus.customerCount = all.length;
    if (all.length >= maxItems) {
      console.log(`[fetch] ${key}: reached max ${maxItems}, stopping`);
      break;
    }
    if (result.data[key].pageInfo.hasNextPage) {
      cursor = result.data[key].pageInfo.endCursor;
    } else break;
  }
  return all;
}

// ─── INVENTORY ANALYSIS ────────────────────────

function analyzeInventory(products, orders, config = {}) {
  const leadTime = config.leadTimeDays || 14;
  const safetyDays = config.safetyStockDays || 7;
  const orderCycleDays = config.orderCycleDays || 30;

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

  const variants = [];
  for (const product of products) {
    for (const ve of product.variants.edges) {
      const v = ve.node;
      const sku = v.sku || '';
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
      const monthlyVelocity = dailyVelocity * 30;
      const daysOfStock = dailyVelocity > 0 ? Math.round(available / dailyVelocity) : (available > 0 ? 999 : 0);
      const reorderPoint = Math.ceil(dailyVelocity * (leadTime + safetyDays));
      const suggestedQty = Math.max(1, Math.ceil(dailyVelocity * orderCycleDays));
      const needsReorder = dailyVelocity > 0 && available <= reorderPoint;

      let priority = 'OK';
      if (available <= 0 && unitsSold > 0) priority = 'CRITICAL';
      else if (needsReorder && daysOfStock < leadTime) priority = 'URGENT';
      else if (needsReorder) priority = 'REORDER';
      else if (daysOfStock < 21 && dailyVelocity > 0) priority = 'WATCH';

      let velocityClass = 'NO SALES';
      if (monthlyVelocity >= 10) velocityClass = 'FAST MOVER';
      else if (monthlyVelocity >= 3) velocityClass = 'REGULAR';
      else if (monthlyVelocity > 0) velocityClass = 'SLOW MOVER';

      // Extract "Back in Stock" / "Alert Me" subscriber count from product metafields
      // Common apps store this in different namespaces: swym, appikon, bis, back_in_stock, klaviyo, etc.
      let alertMeCount = 0;
      const metaEdges = product.metafields?.edges || [];
      for (const e of metaEdges) {
        const ns = (e.node.namespace || '').toLowerCase();
        const k = (e.node.key || '').toLowerCase();
        const val = (e.node.value || '').trim();

        // Check for common back-in-stock app metafield patterns
        const isAlertField = (
          k.includes('alert') || k.includes('notify') || k.includes('waitlist') ||
          k.includes('subscriber') || k.includes('bis_count') || k.includes('back_in_stock') ||
          ns.includes('swym') || ns.includes('appikon') || ns.includes('bis') ||
          ns.includes('back_in_stock') || ns.includes('klaviyo')
        );
        if (isAlertField) {
          // Try to parse as number (subscriber count)
          const num = parseInt(val);
          if (!isNaN(num) && num > 0) { alertMeCount = Math.max(alertMeCount, num); }
          else if (val === 'true' || val === '1') { alertMeCount = Math.max(alertMeCount, 1); }
        }
      }

      variants.push({
        sku, product: product.title, variant: v.title,
        variantId: v.id, productId: product.id,
        productType: product.productType || '', vendor: product.vendor || '',
        price: parseFloat(v.price), available, committed, onHand,
        unitsSold, dailyVelocity: Math.round(dailyVelocity * 10) / 10,
        weeklyVelocity: Math.round(dailyVelocity * 7 * 10) / 10,
        monthlyVelocity: Math.round(monthlyVelocity),
        daysOfStock, reorderPoint, suggestedQty, needsReorder, priority, velocityClass,
        alertMe: alertMeCount > 0, alertMeCount,
      });
    }
  }

  // ─── ABC ANALYSIS (Pareto Classification) ───
  // A: Top 20% revenue, B: Next 30%, C: Rest 50%
  const totalRevenue = variants.reduce((sum, v) => sum + (v.price * v.unitsSold), 0);
  let cumulativeRevenue = 0;

  variants
    .sort((a, b) => (b.price * b.unitsSold) - (a.price * a.unitsSold))
    .forEach(v => {
      cumulativeRevenue += v.price * v.unitsSold;
      const percentage = totalRevenue > 0 ? (cumulativeRevenue / totalRevenue) * 100 : 0;
      v.abcCategory = percentage <= 80 ? 'A' : percentage <= 95 ? 'B' : 'C';
    });

  // Re-sort to original order (by SKU for consistency)
  variants.sort((a, b) => a.sku.localeCompare(b.sku));

  return { variants, skuSales, daysCovered, totalOrders: orders.length };
}

// ─── CACHE ─────────────────────────────────────

let cache = { products: null, orders: null, customers: null, lastFetch: 0 };
let fetchStatus = { state: 'idle', products: false, orders: false, customers: false, customerCount: 0, error: null };
const CACHE_TTL = 5 * 60 * 1000;

// ─── DISK CACHE FOR INSTANT CUSTOMER LOADING ───

const DATA_DIR = join(__dirname, '..', 'data');
const CUSTOMER_CACHE_FILE = join(DATA_DIR, 'customers-cache.json');

function loadCustomerCache() {
  try {
    if (existsSync(CUSTOMER_CACHE_FILE)) {
      const raw = readFileSync(CUSTOMER_CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.customers?.length > 0 && data.timestamp) {
        console.log(`[cache] Loaded ${data.customers.length} customers from disk (saved ${new Date(data.timestamp).toLocaleString()})`);
        return data;
      }
    }
  } catch (err) {
    console.error('[cache] Failed to read disk cache:', err.message);
  }
  return null;
}

function saveCustomerCache(customers) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CUSTOMER_CACHE_FILE, JSON.stringify({ customers, timestamp: new Date().toISOString() }));
    console.log(`[cache] Saved ${customers.length} customers to disk`);
  } catch (err) {
    console.error('[cache] Failed to write disk cache:', err.message);
  }
}

let _fetchLock = null; // Prevents concurrent data fetches (race condition fix)

// ─── STORE TIMEZONE (matches Shopify dashboard date boundaries) ───
let _storeTimezone = null;
async function getStoreTimezone() {
  if (_storeTimezone) return _storeTimezone;
  try {
    const res = await shopifyGraphQL('{ shop { ianaTimezone } }');
    _storeTimezone = res.data?.shop?.ianaTimezone || 'America/New_York';
  } catch (e) {
    console.error('[timezone] Failed to fetch store timezone:', e.message);
    _storeTimezone = 'America/New_York';
  }
  console.log('[timezone] Store timezone:', _storeTimezone);
  return _storeTimezone;
}

function dateInTZ(utcDateStr, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(utcDateStr));
}

async function getData(forceRefresh = false) {
  // Cache is valid only if products AND customers are loaded
  if (!forceRefresh && cache.products && cache.customers?.length > 0 && (Date.now() - cache.lastFetch < CACHE_TTL)) {
    return cache;
  }
  // If a fetch is already in progress, wait for it instead of starting a new one
  if (_fetchLock) {
    console.log('[server] getData() — waiting for in-progress fetch...');
    return _fetchLock;
  }
  _fetchLock = _doFetch(forceRefresh);
  try { return await _fetchLock; } finally { _fetchLock = null; }
}

async function _doFetch(forceRefresh) {
  console.log('[server] Fetching fresh data from Shopify...');
  fetchStatus = { state: 'fetching', products: false, orders: false, customers: false, customerCount: 0, error: null };
  const sinceDate = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

  // Phase 1: Fetch products and orders (fast)
  const [products, orders] = await Promise.all([
    fetchAllPaginated(PRODUCTS_QUERY, 'products'),
    fetchAllPaginated(ORDERS_QUERY, 'orders', { dateFilter: `created_at:>=${sinceDate}` }),
  ]);
  fetchStatus.products = true;
  fetchStatus.orders = true;
  // Don't set lastFetch yet — customers aren't loaded, so cache isn't complete
  cache = { products, orders, customers: cache.customers || [], lastFetch: 0 };
  console.log(`[server] Phase 1 done: ${products.length} products, ${orders.length} orders`);

  // Phase 2: Load customers — try instant disk cache first, then refresh in background
  const diskData = loadCustomerCache();
  if (diskData && !forceRefresh) {
    // Instant load from disk — dashboard is ready in seconds
    cache = { products, orders, customers: diskData.customers, lastFetch: Date.now() };
    fetchStatus.customers = true;
    fetchStatus.customerCount = diskData.customers.length;
    fetchStatus.state = 'ready';
    console.log(`[server] Phase 2 INSTANT: ${diskData.customers.length} customers from disk cache`);
    autoSeedTickets(orders, diskData.customers);

    // Background refresh — fetch fresh data without blocking the UI
    refreshCustomersInBackground(products, orders, diskData.timestamp).catch(err => {
      console.error('[server] Background customer refresh failed:', err.message);
    });
    return cache;
  }

  // No disk cache — full bulk fetch (first run only)
  console.log('[server] No disk cache found — running full bulk customer fetch...');
  try {
    const customers = await fetchCustomersBulk();
    fetchStatus.customers = true;
    fetchStatus.customerCount = customers.length;
    cache = { products, orders, customers, lastFetch: Date.now() };
    console.log(`[server] Phase 2 done: ${customers.length} customers`);
    saveCustomerCache(customers);
    autoSeedTickets(orders, customers);
  } catch (err) {
    console.error('[server] Bulk customer fetch failed, falling back to pagination...', err.message);
    try {
      const customers = await fetchAllPaginated(CUSTOMERS_QUERY, 'customers');
      fetchStatus.customers = true;
      fetchStatus.customerCount = customers.length;
      cache = { products, orders, customers, lastFetch: Date.now() };
      console.log(`[server] Phase 2 (fallback) done: ${customers.length} customers`);
      saveCustomerCache(customers);
      autoSeedTickets(orders, customers);
    } catch (err2) {
      console.error('[server] Customer fetch failed entirely:', err2.message);
      fetchStatus.error = 'Customer fetch failed: ' + err2.message;
    }
  }

  fetchStatus.state = 'ready';
  return cache;
}

// ─── BACKGROUND INCREMENTAL CUSTOMER REFRESH ───

async function refreshCustomersInBackground(products, orders, lastTimestamp) {
  const cacheAge = (Date.now() - new Date(lastTimestamp).getTime()) / 60000;
  console.log(`[bg-refresh] Disk cache is ${cacheAge.toFixed(0)} minutes old — starting incremental update...`);

  // If cache is less than 5 minutes old, skip refresh entirely
  if (cacheAge < 5) {
    console.log('[bg-refresh] Cache is fresh, skipping refresh');
    return;
  }

  // If cache is less than 24 hours old, try incremental update via paginated query with updated_at filter
  // (Faster than a full bulk operation for small numbers of changes)
  if (cacheAge < 1440) {
    try {
      const sinceStr = new Date(new Date(lastTimestamp).getTime() - 60000).toISOString(); // 1 min buffer
      console.log(`[bg-refresh] Fetching customers updated since ${sinceStr}...`);

      const updatedCustomers = await fetchAllPaginated(CUSTOMERS_QUERY, 'customers', { dateFilter: `updated_at:>=${sinceStr}` });
      console.log(`[bg-refresh] Found ${updatedCustomers.length} updated customers`);

      if (updatedCustomers.length > 0) {
        // Merge into existing customer list
        const existingMap = new Map(cache.customers.map(c => [c.id, c]));
        for (const c of updatedCustomers) {
          existingMap.set(c.id, c); // overwrite existing or add new
        }
        const mergedCustomers = Array.from(existingMap.values());

        cache = { products: cache.products, orders: cache.orders, customers: mergedCustomers, lastFetch: Date.now() };
        fetchStatus.customerCount = mergedCustomers.length;
        saveCustomerCache(mergedCustomers);
        console.log(`[bg-refresh] Incremental merge complete — ${mergedCustomers.length} total customers`);
      } else {
        // No changes, just update the cache timestamp
        saveCustomerCache(cache.customers);
      }
      return;
    } catch (err) {
      console.error('[bg-refresh] Incremental update failed, will do full refresh:', err.message);
    }
  }

  // Cache is old (24h+) or incremental failed — do a full bulk refresh in background
  console.log('[bg-refresh] Running full bulk refresh...');
  try {
    const customers = await fetchCustomersBulk();
    cache = { products: cache.products, orders: cache.orders, customers, lastFetch: Date.now() };
    fetchStatus.customerCount = customers.length;
    saveCustomerCache(customers);
    autoSeedTickets(orders, customers);
    console.log(`[bg-refresh] Full refresh complete — ${customers.length} customers`);
  } catch (err) {
    console.error('[bg-refresh] Full refresh failed:', err.message);
  }
}

// ─── AUTO-SEED TICKETS FROM ORDERS ─────────────

function autoSeedTickets(orders, customers) {
  const existing = getTickets({});
  const existingSeedKeys = new Set();

  function inferSeedKeyFromTicket(t) {
    if (!t?.orderId) return null;
    if (t.seedKey) return t.seedKey;
    const subj = String(t.subject || '').toLowerCase();
    if (subj.startsWith('cancelled order')) return `${t.orderId}|cancelled`;
    if (subj.startsWith('refund on order')) return `${t.orderId}|refunded`;
    if (subj.startsWith('unfulfilled order')) return `${t.orderId}|unfulfilled`;
    return `${t.orderId}|order`;
  }

  for (const t of existing) {
    const k = inferSeedKeyFromTicket(t);
    if (k) existingSeedKeys.add(k);
  }

  // Helper: build a bullet list of items from order line items
  function itemsList(order) {
    const items = (order.lineItems?.edges || []).map(li => {
      const n = li.node;
      return `  • ${n.title}${n.sku ? ` (SKU: ${n.sku})` : ''} × ${n.quantity}`;
    });
    return items.length ? items.join('\n') : '  (no items found)';
  }

  // Helper: format a date nicely
  function fmtDate(d) {
    if (!d) return 'Unknown';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Helper: shipping location string
  function shipTo(order) {
    const a = order.shippingAddress;
    if (!a) return 'No shipping address on file';
    return [a.city, a.province, a.country].filter(Boolean).join(', ');
  }

  let seeded = 0;
  for (const order of orders) {
    const custName = order.customer?.displayName || 'Unknown';
    const custEmail = order.customer?.email || '';
    const custId = order.customer?.id || null;
    const orderTotal = order.totalPriceSet?.shopMoney?.amount || '0';
    const currency = order.totalPriceSet?.shopMoney?.currencyCode || 'USD';

    // Cancelled orders
    if (order.cancelledAt) {
      const seedKey = `${order.id}|cancelled`;
      if (existingSeedKeys.has(seedKey)) continue;
      const reason = order.cancelReason
        ? order.cancelReason.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase())
        : 'Not specified by customer';
      createTicket({
        customerId: custId, customerName: custName, customerEmail: custEmail,
        category: 'returns', priority: 'medium', orderId: order.id, orderName: order.name,
        seedKey,
        createdAt: order.cancelledAt || order.createdAt,
        subject: `Cancelled Order ${order.name}`,
        description: [
          `═══ WHAT HAPPENED ═══`,
          `Order ${order.name} was cancelled on ${fmtDate(order.cancelledAt)}.`,
          `Cancellation reason: ${reason}`,
          ``,
          `═══ ORDER DETAILS ═══`,
          `Customer: ${custName} (${custEmail || 'no email'})`,
          `Order date: ${fmtDate(order.createdAt)}`,
          `Order total: $${parseFloat(orderTotal).toFixed(2)} ${currency}`,
          `Shipping to: ${shipTo(order)}`,
          ``,
          `Items in this order:`,
          itemsList(order),
          ``,
          `═══ ACTION REQUIRED ═══`,
          `1. Check if a refund has already been issued for this order`,
          `2. If no refund yet, process the refund in Shopify admin`,
          `3. Email the customer to confirm the cancellation and refund`,
          `4. If reason was "customer changed mind" — consider offering a discount code for next purchase`,
          `5. Mark this ticket as resolved once the refund is confirmed`,
        ].join('\n'),
      });
      seeded++;
      continue;
    }

    // Refunded orders
    const refunded = parseFloat(order.totalRefundedSet?.shopMoney?.amount || 0);
    if (refunded > 0) {
      const seedKey = `${order.id}|refunded`;
      if (existingSeedKeys.has(seedKey)) continue;
      const total = parseFloat(orderTotal);
      const isFullRefund = refunded >= total;
      createTicket({
        customerId: custId, customerName: custName, customerEmail: custEmail,
        category: 'returns', priority: 'medium', orderId: order.id, orderName: order.name,
        seedKey,
        createdAt: order.createdAt,
        subject: `Refund on Order ${order.name} — $${refunded.toFixed(2)}`,
        description: [
          `═══ WHAT HAPPENED ═══`,
          `A ${isFullRefund ? 'full' : 'partial'} refund of $${refunded.toFixed(2)} was processed on order ${order.name}.`,
          isFullRefund ? '' : `Original total: $${total.toFixed(2)} — remaining: $${(total - refunded).toFixed(2)}`,
          ``,
          `═══ ORDER DETAILS ═══`,
          `Customer: ${custName} (${custEmail || 'no email'})`,
          `Order date: ${fmtDate(order.createdAt)}`,
          `Order total: $${total.toFixed(2)} ${currency}`,
          `Amount refunded: $${refunded.toFixed(2)}`,
          `Shipping to: ${shipTo(order)}`,
          ``,
          `Items in this order:`,
          itemsList(order),
          ``,
          `═══ ACTION REQUIRED ═══`,
          `1. Check if the customer has been notified about the refund`,
          `2. If this was a return, verify the item(s) have been received back`,
          `3. Send a follow-up email asking if there's anything else you can help with`,
          isFullRefund
            ? `4. Consider asking for feedback on why they returned — helps improve product/service`
            : `4. Confirm the partial refund amount is correct and the customer is satisfied`,
          `5. Mark this ticket as resolved once confirmed`,
        ].filter(Boolean).join('\n'),
      });
      seeded++;
      continue;
    }

    // Old unfulfilled orders (paid but not fulfilled for 7+ days)
    if (order.displayFinancialStatus === 'PAID' &&
        order.displayFulfillmentStatus === 'UNFULFILLED') {
      const daysSinceOrder = (Date.now() - new Date(order.createdAt)) / 86400000;
      if (daysSinceOrder > 7) {
        const seedKey = `${order.id}|unfulfilled`;
        if (existingSeedKeys.has(seedKey)) continue;
        const daysRounded = Math.round(daysSinceOrder);
        const urgency = daysRounded > 14
          ? '🔴 CRITICAL — This order is severely overdue. The customer may file a chargeback or leave a negative review.'
          : '🟡 URGENT — This order should have shipped by now. Please prioritize fulfillment.';
        createTicket({
          customerId: custId, customerName: custName, customerEmail: custEmail,
          category: 'shipping', priority: daysSinceOrder > 14 ? 'high' : 'medium',
          orderId: order.id, orderName: order.name,
          seedKey,
          createdAt: order.createdAt,
          subject: `Unfulfilled Order ${order.name} — ${daysRounded} days`,
          description: [
            `═══ WHAT HAPPENED ═══`,
            `Order ${order.name} was placed ${daysRounded} days ago (${fmtDate(order.createdAt)}) and has been PAID but NOT YET FULFILLED.`,
            ``,
            urgency,
            ``,
            `═══ ORDER DETAILS ═══`,
            `Customer: ${custName} (${custEmail || 'no email'})`,
            `Order date: ${fmtDate(order.createdAt)}`,
            `Order total: $${parseFloat(orderTotal).toFixed(2)} ${currency}`,
            `Payment status: ${order.displayFinancialStatus}`,
            `Fulfillment status: ${order.displayFulfillmentStatus}`,
            `Shipping to: ${shipTo(order)}`,
            ``,
            `Items to ship:`,
            itemsList(order),
            ``,
            `═══ ACTION REQUIRED ═══`,
            `1. Check if these items are in stock and ready to ship`,
            `2. If in stock → fulfill and ship the order in Shopify admin immediately`,
            `3. If out of stock → contact the customer to offer alternatives, a backorder ETA, or a refund`,
            `4. Send the customer a proactive email with tracking info or an update`,
            daysRounded > 14
              ? `5. ⚠️ This is ${daysRounded} days overdue — email the customer ASAP to prevent a chargeback`
              : `5. Add a note here with the tracking number once shipped`,
            `6. Mark this ticket as resolved once the order is fulfilled`,
          ].join('\n'),
        });
        seeded++;
      }
    }
  }

  if (seeded > 0) {
    console.log(`[server] Auto-seeded ${seeded} tickets from order issues`);
    logActivity('system', 'auto_seed', `Auto-created ${seeded} tickets from order issues`);
  }
}

// ─── CUSTOMER ENRICHMENT ───────────────────────

function enrichCustomers(customers, orders) {
  const orderMap = {};
  for (const order of orders) {
    const email = order.customer?.email;
    if (!email) continue;
    if (!orderMap[email]) orderMap[email] = { count: 0, revenue: 0 };
    orderMap[email].count++;
    orderMap[email].revenue += parseFloat(order.totalPriceSet?.shopMoney?.amount || 0);
  }

  return customers.map(c => {
    const od = orderMap[c.email] || { count: 0, revenue: 0 };
    const totalSpent = parseFloat(c.amountSpent?.amount || 0);
    const numOrders = parseInt(c.numberOfOrders || 0);

    let tier = 'NEW';
    if (totalSpent >= 500 || numOrders >= 10) tier = 'VIP';
    else if (totalSpent >= 200 || numOrders >= 5) tier = 'LOYAL';
    else if (numOrders >= 2) tier = 'REPEAT';
    else if (numOrders >= 1) tier = 'CUSTOMER';

    // Use Shopify's lastOrder for risk detection (not limited to 90-day window)
    let riskLevel = 'none';
    const lastOrderDate = c.lastOrder?.createdAt ? new Date(c.lastOrder.createdAt) : null;
    if (numOrders >= 2 && lastOrderDate) {
      const daysSince = (Date.now() - lastOrderDate) / 86400000;
      if (daysSince > 120) riskLevel = 'high';
      else if (daysSince > 60) riskLevel = 'medium';
    }

    const avgOrderValue = numOrders > 0 ? totalSpent / numOrders : 0;

    return {
      id: c.id, name: c.displayName, email: c.email, phone: c.phone,
      totalOrders: numOrders, totalSpent: totalSpent.toFixed(2),
      avgOrderValue: avgOrderValue.toFixed(2),
      recentOrders90d: od.count, recentRevenue90d: od.revenue.toFixed(2),
      lastOrder: lastOrderDate, tier, riskLevel,
      tags: c.tags || [], customTags: getCustomerTags(c.id),
      location: c.defaultAddress ? `${c.defaultAddress.city || ''}, ${c.defaultAddress.province || ''}`.replace(/^, |, $/g, '') : '',
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }).sort((a, b) => parseFloat(b.totalSpent) - parseFloat(a.totalSpent));
}

// ═══════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════

// ─── APP CONFIG (for Shopify App Bridge) ───────

app.get('/api/app-config', (req, res) => {
  res.json({ apiKey: SHOPIFY_API_KEY, shop: SHOP_DOMAIN });
});

// ─── STATUS (for loading indicator) ────────────

app.get('/api/status', (req, res) => {
  res.json({
    state: fetchStatus.state,
    products: fetchStatus.products,
    orders: fetchStatus.orders,
    customers: fetchStatus.customers,
    productCount: cache.products?.length || 0,
    orderCount: cache.orders?.length || 0,
    customerCount: fetchStatus.customerCount || cache.customers?.length || 0,
    error: fetchStatus.error,
  });
});

// ─── GLOSSARY / LABEL INFO ─────────────────────

app.get('/api/glossary', (req, res) => {
  res.json({
    tiers: {
      VIP: { label: 'VIP', color: 'var(--accent)', description: 'Spent $500+ or placed 10+ orders. Your most valuable customers who drive the majority of revenue.' },
      LOYAL: { label: 'Loyal', color: 'var(--green)', description: 'Spent $200+ or placed 5+ orders. Consistent repeat buyers with strong brand affinity.' },
      REPEAT: { label: 'Repeat', color: 'var(--blue)', description: 'Placed 2+ orders. Customers who came back after their first purchase.' },
      CUSTOMER: { label: '1-Time', color: 'var(--text-dim)', description: 'Placed exactly 1 order. Potential to convert into repeat buyers with the right follow-up.' },
      NEW: { label: 'New', color: 'var(--text-muted)', description: 'Account created but no orders yet. May have signed up for newsletter or created account at checkout.' },
    },
    risk: {
      high: { label: 'At Risk', description: "Repeat customer who hasn't ordered in 120+ days. High chance of churning \u2014 consider a win-back email or discount." },
      medium: { label: 'Monitor', description: "Repeat customer who hasn't ordered in 60-120 days. Activity is slowing \u2014 may need re-engagement." },
      none: { label: 'Active', description: 'Customer is active or single-purchaser (no churn risk calculated).' },
    },
    velocity: {
      'FAST MOVER': { label: 'Fast Mover', description: 'Selling 10+ units/month. High demand \u2014 keep generous safety stock and reorder frequently.' },
      'REGULAR': { label: 'Regular', description: 'Selling 3-9 units/month. Steady seller \u2014 standard reorder cycle works well.' },
      'SLOW MOVER': { label: 'Slow Mover', description: 'Selling 1-2 units/month. Low demand \u2014 keep minimal stock, consider bundling or promotions.' },
      'NO SALES': { label: 'No Sales', description: 'Zero sales in the reporting period. May be new listing, seasonal item, or dead stock to consider marking down.' },
    },
    priority: {
      CRITICAL: { label: 'Critical', description: 'Out of stock on items that have proven sales. Losing revenue every day \u2014 order immediately.' },
      URGENT: { label: 'Urgent', description: "Stock will run out before the next delivery arrives based on lead time. Add to this week's purchase order." },
      REORDER: { label: 'Reorder', description: 'Stock has fallen below the calculated safety level (lead time + buffer days). Time to place a standard reorder.' },
      WATCH: { label: 'Watch', description: 'Less than 21 days of stock remaining. Not urgent yet, but keep an eye on it for the next order cycle.' },
      OK: { label: 'OK', description: 'Stock levels are healthy. No action needed right now.' },
    },
    ticketStatus: {
      open: { label: 'Open', description: "New ticket that hasn't been addressed yet. Needs first response." },
      in_progress: { label: 'In Progress', description: 'Being actively worked on by the team.' },
      waiting: { label: 'Waiting', description: 'Waiting on response from customer or external party.' },
      resolved: { label: 'Resolved', description: 'Issue has been fixed. Waiting for confirmation period before closing.' },
      closed: { label: 'Closed', description: 'Fully resolved and archived.' },
    },
    ticketPriority: {
      urgent: { label: 'Urgent', description: 'Needs immediate attention \u2014 customer is at risk of churning or issue is escalated.' },
      high: { label: 'High', description: 'Important issue, should be handled within a few hours.' },
      medium: { label: 'Medium', description: 'Standard priority \u2014 handle within the SLA window (default 24h).' },
      low: { label: 'Low', description: 'Non-urgent \u2014 can be handled when convenient.' },
    },
  });
});

// ─── DASHBOARD ─────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  try {
    const { products, orders, customers } = await getData();
    const analysis = analyzeInventory(products, orders);
    const enriched = enrichCustomers(customers, orders);
    const crmStats = getCrmStats();

    const critical = analysis.variants.filter(v => v.priority === 'CRITICAL');
    const urgent = analysis.variants.filter(v => v.priority === 'URGENT');
    const reorder = analysis.variants.filter(v => v.priority === 'REORDER');
    const totalValue = analysis.variants.reduce((s, v) => s + (v.available * v.price), 0);
    const totalUnits = analysis.variants.reduce((s, v) => s + v.available, 0);

    // Revenue period filter — uses store timezone to match Shopify dashboard
    const revPeriod = req.query.revPeriod || '30';
    const storeTZ = await getStoreTimezone();
    const now = new Date();
    const todayStr = dateInTZ(now, storeTZ); // e.g. "2026-03-20"
    const yd = new Date(now.getTime() - 86400000);
    const yesterdayStr = dateInTZ(yd, storeTZ);

    // Exclude test orders, cancelled orders, and voided orders
    const isSaleOrder = o => !o.test && !o.cancelledAt && o.displayFinancialStatus !== 'VOIDED';

    let periodOrders;
    if (revPeriod === 'today') {
      periodOrders = orders.filter(o => isSaleOrder(o) && dateInTZ(o.createdAt, storeTZ) === todayStr);
    } else if (revPeriod === 'yesterday') {
      periodOrders = orders.filter(o => isSaleOrder(o) && dateInTZ(o.createdAt, storeTZ) === yesterdayStr);
    } else {
      // "Last N days" in Shopify = today + N previous days (e.g. Last 7 = Mar 13-20 = 8 dates)
      // Shopify uses the store's IANA timezone; todayStr is already in that timezone
      const days = parseInt(revPeriod, 10) || 30;
      const [y, m, d] = todayStr.split('-').map(Number);
      const startDate = new Date(Date.UTC(y, m - 1, d - days));
      const cutoffStr = startDate.toISOString().split('T')[0]; // YYYY-MM-DD
      periodOrders = orders.filter(o => isSaleOrder(o) && dateInTZ(o.createdAt, storeTZ) >= cutoffStr);
    }
    // Use currentTotalPriceSet — reflects refunds + order edits (matches Shopify "Total sales")
    const revenue = periodOrders.reduce((s, o) => {
      return s + parseFloat(o.currentTotalPriceSet?.shopMoney?.amount || o.totalPriceSet?.shopMoney?.amount || 0);
    }, 0);
    const periodOrderCount = periodOrders.length;

    const velocityCounts = { 'FAST MOVER': 0, 'REGULAR': 0, 'SLOW MOVER': 0, 'NO SALES': 0 };
    analysis.variants.forEach(v => velocityCounts[v.velocityClass]++);

    const tierCounts = { VIP: 0, LOYAL: 0, REPEAT: 0, CUSTOMER: 0, NEW: 0 };
    enriched.forEach(c => tierCounts[c.tier]++);

    // Revenue trend — uses store timezone for date grouping
    const chartDays = revPeriod === 'today' ? 1 : revPeriod === 'yesterday' ? 1 : Math.min(parseInt(revPeriod, 10) || 30, 30);
    const revByDay = {};
    const [ty, tm, td] = todayStr.split('-').map(Number);
    for (let i = chartDays; i >= 0; i--) {
      const dd = new Date(Date.UTC(ty, tm - 1, td - i));
      revByDay[dd.toISOString().split('T')[0]] = 0;
    }
    orders.forEach(o => {
      if (!isSaleOrder(o)) return;
      const d = dateInTZ(o.createdAt, storeTZ);
      if (revByDay[d] !== undefined) {
        revByDay[d] += parseFloat(o.currentTotalPriceSet?.shopMoney?.amount || o.totalPriceSet?.shopMoney?.amount || 0);
      }
    });

    // Recent orders
    const recentOrders = [...orders]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 8)
      .map(o => ({
        id: o.id, name: o.name, createdAt: o.createdAt,
        customer: o.customer?.displayName || 'Guest',
        total: o.totalPriceSet?.shopMoney?.amount,
        financial: o.displayFinancialStatus,
        fulfillment: o.displayFulfillmentStatus,
      }));

    const activity = getActivityLog(8);
    const topCustomers = enriched.slice(0, 5).map(c => ({
      id: c.id, name: c.name, email: c.email, tier: c.tier,
      totalSpent: c.totalSpent, totalOrders: c.totalOrders,
    }));

    res.json({
      store: getShopDomain(),
      products: products.length,
      totalVariants: analysis.variants.length,
      totalOrders: orders.length,
      totalCustomers: customers.length,
      daysCovered: analysis.daysCovered, revenue: revenue.toFixed(2),
      revPeriod, periodOrderCount,
      totalInventoryValue: totalValue.toFixed(2),
      totalUnitsOnHand: totalUnits,
      alerts: { critical: critical.length, urgent: urgent.length, reorder: reorder.length },
      velocityCounts, tierCounts, revByDay, recentOrders, topCustomers, activity,
      crm: {
        total: crmStats.total, active: crmStats.active,
        avgResponseHrs: crmStats.avgResponseHrs, slaCompliance: crmStats.slaCompliance,
        thisWeek: crmStats.thisWeek, resolvedThisWeek: crmStats.resolvedThisWeek,
      },
      topIssues: critical.concat(urgent).slice(0, 8).map(v => ({
        product: v.product, variant: v.variant, sku: v.sku,
        available: v.available, monthlyVelocity: v.monthlyVelocity,
        priority: v.priority, daysOfStock: v.daysOfStock,
      })),
    });
  } catch (err) {
    console.error('[dashboard]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── INVENTORY ─────────────────────────────────

app.get('/api/inventory', async (req, res) => {
  try {
    const { products, orders } = await getData();
    const analysis = analyzeInventory(products, orders);
    res.json({ variants: analysis.variants, daysCovered: analysis.daysCovered, totalOrders: analysis.totalOrders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── REPLENISHMENT ─────────────────────────────

app.get('/api/replenishment', async (req, res) => {
  try {
    const { products, orders } = await getData();
    const analysis = analyzeInventory(products, orders);
    const needsAction = analysis.variants.filter(v => v.priority !== 'OK');
    const byVendor = {};
    for (const item of needsAction) {
      const vendor = item.vendor || 'Unknown';
      if (!byVendor[vendor]) byVendor[vendor] = [];
      byVendor[vendor].push(item);
    }
    res.json({
      items: needsAction, byVendor,
      summary: {
        critical: needsAction.filter(i => i.priority === 'CRITICAL').length,
        urgent: needsAction.filter(i => i.priority === 'URGENT').length,
        reorder: needsAction.filter(i => i.priority === 'REORDER').length,
        watch: needsAction.filter(i => i.priority === 'WATCH').length,
        totalUnitsToOrder: needsAction.filter(i => ['CRITICAL','URGENT','REORDER'].includes(i.priority))
          .reduce((s, i) => s + i.suggestedQty, 0),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── INVENTORY FORECAST ────────────────────────

app.get('/api/forecast', async (req, res) => {
  try {
    const { products, orders } = await getData();
    const analysis = analyzeInventory(products, orders);
    const now = new Date();

    // Build weekly sales buckets per SKU (last 12 weeks)
    const weekBuckets = {};
    for (const order of orders) {
      const orderDate = new Date(order.createdAt);
      const weeksAgo = Math.floor((now - orderDate) / (7 * 86400000));
      if (weeksAgo > 12) continue;
      for (const li of order.lineItems.edges) {
        const sku = li.node.sku || '';
        if (!sku) continue;
        if (!weekBuckets[sku]) weekBuckets[sku] = new Array(13).fill(0);
        weekBuckets[sku][weeksAgo] += li.node.quantity;
      }
    }

    // Enhanced forecast per variant
    const forecasts = analysis.variants.map(v => {
      const weeks = weekBuckets[v.sku] || new Array(13).fill(0);

      // Weighted Moving Average (recent weeks count more)
      // Weights: [current week x4, 1 week ago x3, 2 weeks ago x2.5, 3 weeks x2, then x1 each]
      const weights = [4, 3, 2.5, 2, 1.5, 1.5, 1, 1, 1, 1, 0.8, 0.8, 0.5];
      let weightedSum = 0, totalWeight = 0;
      for (let i = 0; i < 13; i++) {
        weightedSum += weeks[i] * weights[i];
        totalWeight += weeks[i] > 0 || i < 4 ? weights[i] : 0; // only count weeks with data (or first 4)
      }
      if (totalWeight === 0) totalWeight = 1;
      const wmaDailyVelocity = (weightedSum / totalWeight) / 7;

      // Trend detection: compare last 4 weeks vs prior 4 weeks
      const recent4 = weeks.slice(0, 4).reduce((a, b) => a + b, 0);
      const prior4 = weeks.slice(4, 8).reduce((a, b) => a + b, 0);
      let trend = 'stable';
      let trendPct = 0;
      if (prior4 > 0) {
        trendPct = Math.round(((recent4 - prior4) / prior4) * 100);
        if (trendPct > 25) trend = 'accelerating';
        else if (trendPct < -25) trend = 'declining';
      } else if (recent4 > 0) {
        trend = 'new_demand';
        trendPct = 100;
      }

      // Use WMA for forecast (more responsive to recent changes)
      const forecastDaily = wmaDailyVelocity > 0 ? wmaDailyVelocity : v.dailyVelocity;

      // Stock-out date prediction
      let stockOutDate = null;
      let daysUntilStockOut = v.available > 0 && forecastDaily > 0 
        ? Math.round(v.available / forecastDaily) : (v.available > 0 ? 999 : 0);
      if (daysUntilStockOut > 0 && daysUntilStockOut < 999) {
        stockOutDate = new Date(now.getTime() + daysUntilStockOut * 86400000).toISOString().split('T')[0];
      }

      // Revenue at risk (next 30 days of potential lost sales if out of stock)
      const projectedDemand30d = Math.round(forecastDaily * 30);
      const unmetDemand = daysUntilStockOut < 30 
        ? Math.round(forecastDaily * Math.max(0, 30 - daysUntilStockOut)) : 0;
      const revenueAtRisk = unmetDemand * v.price;

      // Sell-through rate (units sold / (units sold + available))
      const sellThrough = v.unitsSold + v.available > 0
        ? Math.round((v.unitsSold / (v.unitsSold + v.available)) * 100) : 0;

      // Optimal reorder date (order leadTime days before stock-out)
      let optimalReorderDate = null;
      const leadTimeDays = 14;
      if (daysUntilStockOut > leadTimeDays && daysUntilStockOut < 999) {
        optimalReorderDate = new Date(now.getTime() + (daysUntilStockOut - leadTimeDays) * 86400000).toISOString().split('T')[0];
      } else if (daysUntilStockOut <= leadTimeDays && forecastDaily > 0) {
        optimalReorderDate = 'OVERDUE';
      }

      return {
        sku: v.sku, product: v.product, variant: v.variant,
        variantId: v.variantId, productId: v.productId,
        vendor: v.vendor, price: v.price,
        available: v.available, committed: v.committed, onHand: v.onHand,
        unitsSold: v.unitsSold,
        dailyVelocity: v.dailyVelocity,
        forecastDailyVelocity: Math.round(forecastDaily * 10) / 10,
        monthlyVelocity: v.monthlyVelocity,
        forecastMonthly: Math.round(forecastDaily * 30),
        weeklySales: weeks.slice(0, 12).reverse(), // oldest to newest for charting
        daysOfStock: daysUntilStockOut,
        stockOutDate,
        optimalReorderDate,
        projectedDemand30d,
        unmetDemand,
        revenueAtRisk: Math.round(revenueAtRisk * 100) / 100,
        sellThrough,
        trend, trendPct,
        priority: v.priority,
        velocityClass: v.velocityClass,
        abcCategory: v.abcCategory,
        reorderPoint: v.reorderPoint,
        suggestedQty: v.suggestedQty,
      };
    });

    // Summary KPIs
    const totalRevenueAtRisk = forecasts.reduce((s, f) => s + f.revenueAtRisk, 0);
    const stockOutIn7 = forecasts.filter(f => f.daysOfStock > 0 && f.daysOfStock <= 7).length;
    const stockOutIn14 = forecasts.filter(f => f.daysOfStock > 0 && f.daysOfStock <= 14).length;
    const stockOutIn30 = forecasts.filter(f => f.daysOfStock > 0 && f.daysOfStock <= 30).length;
    const alreadyOut = forecasts.filter(f => f.daysOfStock === 0 && f.unitsSold > 0).length;
    const accelerating = forecasts.filter(f => f.trend === 'accelerating').length;
    const declining = forecasts.filter(f => f.trend === 'declining').length;
    const avgSellThrough = forecasts.length > 0 
      ? Math.round(forecasts.reduce((s, f) => s + f.sellThrough, 0) / forecasts.length) : 0;
    const totalInventoryValue = forecasts.reduce((s, f) => s + f.available * f.price, 0);
    const totalProjectedRevenue30d = forecasts.reduce((s, f) => s + f.projectedDemand30d * f.price, 0);

    // Top products by revenue
    const topByRevenue = [...forecasts]
      .sort((a, b) => (b.unitsSold * b.price) - (a.unitsSold * a.price))
      .slice(0, 10);

    // At-risk items (running out in 30 days with proven sales)
    const atRisk = forecasts
      .filter(f => f.daysOfStock > 0 && f.daysOfStock <= 30 && f.unitsSold > 0)
      .sort((a, b) => a.daysOfStock - b.daysOfStock);

    // Velocity distribution
    const velDist = { fast: 0, regular: 0, slow: 0, noSales: 0 };
    forecasts.forEach(f => {
      if (f.velocityClass === 'FAST MOVER') velDist.fast++;
      else if (f.velocityClass === 'REGULAR') velDist.regular++;
      else if (f.velocityClass === 'SLOW MOVER') velDist.slow++;
      else velDist.noSales++;
    });

    res.json({
      forecasts,
      summary: {
        totalVariants: forecasts.length,
        totalRevenueAtRisk: Math.round(totalRevenueAtRisk * 100) / 100,
        stockOutIn7, stockOutIn14, stockOutIn30, alreadyOut,
        accelerating, declining,
        avgSellThrough,
        totalInventoryValue: Math.round(totalInventoryValue * 100) / 100,
        totalProjectedRevenue30d: Math.round(totalProjectedRevenue30d * 100) / 100,
        velDist,
      },
      topByRevenue,
      atRisk,
      daysCovered: analysis.daysCovered,
    });
  } catch (err) {
    console.error('[forecast]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CLEANUP ANALYSIS ──────────────────────────

app.get('/api/cleanup-report', async (req, res) => {
  try {
    const { products, orders } = await getData();
    const analysis = analyzeInventory(products, orders);
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 86400000);

    const reports = {
      deadStock: [],
      zeroStock: [],
      missingData: [],
      duplicates: new Map(),
      slowMovers: [],
      noSales: [],
    };

    // Group by SKU to find duplicates
    const skuMap = new Map();
    analysis.variants.forEach(v => {
      if (!skuMap.has(v.sku)) skuMap.set(v.sku, []);
      skuMap.get(v.sku).push(v);
    });

    // Build a product lookup so we can get the product ID for each variant
    const productForVariant = new Map();
    for (const product of products) {
      for (const ve of product.variants.edges) {
        productForVariant.set(ve.node.id, { productId: product.id, productTitle: product.title });
      }
    }

    analysis.variants.forEach(v => {
      // Find last order date for this SKU
      let lastOrderDate = new Date(0);
      if (v.sku) {
        const matchingOrders = orders.filter(o => o.lineItems.edges.some(li => li.node.sku === v.sku));
        if (matchingOrders.length > 0) {
          const dates = matchingOrders.map(o => new Date(o.createdAt).getTime());
          lastOrderDate = new Date(Math.max(...dates));
        }
      }

      // The inline analyzeInventory uses: v.product, v.variant, v.sku, v.unitsSold
      // Look up the variant's GID from the products array
      let variantId = null;
      let productId = null;
      const pInfo = productForVariant.get(v.variantId || '');
      if (pInfo) { productId = pInfo.productId; }
      // Also search by matching product+variant title if variantId field doesn't exist
      if (!productId) {
        for (const product of products) {
          for (const ve of product.variants.edges) {
            if (product.title === v.product && ve.node.title === v.variant) {
              variantId = ve.node.id;
              productId = product.id;
              break;
            }
          }
          if (productId) break;
        }
      } else {
        variantId = v.variantId;
      }

      const base = {
        sku: v.sku || '(no SKU)',
        product: v.product || v.productTitle || '(unknown)',
        variant: v.variant || v.variantTitle || '',
        variantId: variantId,
        productId: productId,
      };

      // Dead Stock: Zero stock + No sales in 30 days OR never sold
      if (v.available === 0 && (lastOrderDate < thirtyDaysAgo || lastOrderDate.getTime() === 0)) {
        reports.deadStock.push({ ...base,
          lastSale: lastOrderDate.getTime() === 0 ? 'Never' : lastOrderDate.toISOString().split('T')[0],
          unitsSold: v.unitsSold || 0, price: v.price,
        });
      }

      // Zero Stock: out of stock but has had sales
      if (v.available === 0 && (v.unitsSold || 0) > 0) {
        reports.zeroStock.push({ ...base,
          unitsSold: v.unitsSold || 0, price: v.price, daysOfStock: v.daysOfStock,
        });
      }

      // Missing Data
      const missingFields = [
        (!v.sku || v.sku === '') ? 'SKU' : null,
        !v.price ? 'Price' : null,
        !(v.product || v.productTitle) ? 'Title' : null,
      ].filter(Boolean);
      if (missingFields.length > 0) {
        reports.missingData.push({ ...base, missingFields });
      }

      // Slow Movers: SLOW MOVER class (monthlyVelocity > 0 but < 5)
      if (v.velocityClass === 'SLOW MOVER') {
        reports.slowMovers.push({ ...base,
          monthlyVelocity: v.monthlyVelocity, available: v.available, unitsSold: v.unitsSold || 0,
        });
      }

      // No Sales: zero units sold in the tracked period
      if ((v.unitsSold || 0) === 0) {
        reports.noSales.push({ ...base,
          daysTracked: analysis.daysCovered, available: v.available, price: v.price,
        });
      }
    });

    // Find duplicates
    const duplicatesObj = {};
    skuMap.forEach((items, sku) => {
      if (items.length > 1 || sku === '' || sku === null) {
        duplicatesObj[sku || '(empty)'] = items;
      }
    });

    res.json({
      deadStockCount: reports.deadStock.length,
      zeroStockCount: reports.zeroStock.length,
      missingDataCount: reports.missingData.length,
      duplicatesCount: Object.keys(duplicatesObj).length,
      slowMoversCount: reports.slowMovers.length,
      noSalesCount: reports.noSales.length,
      reports: {
        deadStock: reports.deadStock,
        zeroStock: reports.zeroStock,
        missingData: reports.missingData,
        duplicates: duplicatesObj,
        slowMovers: reports.slowMovers,
        noSales: reports.noSales,
      },
      summary: {
        potentialSavings: reports.deadStock.reduce((s, i) => s + (i.price || 0), 0),
        potentialDeleteItems: reports.deadStock.length + reports.missingData.length,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CLEANUP ACTIONS (Delete, Tag, Archive) ────

app.post('/api/cleanup-action', async (req, res) => {
  try {
    const { action, productIds, tags } = req.body;
    
    if (!action || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'Missing action or productIds' });
    }

    // Deduplicate product IDs (multiple variants may share a product)
    const uniqueProductIds = [...new Set(productIds)];
    const { products } = await getData();
    const results = { success: 0, failed: 0, errors: [] };

    for (const productId of uniqueProductIds) {
      try {
        const prod = products.find(p => p.id === productId);
        if (!prod) {
          results.errors.push(`Product ${productId}: Not found`);
          results.failed++;
          continue;
        }

        if (action === 'delete') {
          const deleteQuery = `
            mutation($input: ProductDeleteInput!) {
              productDelete(input: $input) {
                deletedProductId
                userErrors { field message }
              }
            }
          `;
          
          const deleteResult = await shopifyGraphQL(deleteQuery, { input: { id: productId } });
          if (deleteResult.data?.productDelete?.userErrors?.length > 0) {
            results.errors.push(`${prod.title}: ${deleteResult.data.productDelete.userErrors[0].message}`);
            results.failed++;
          } else {
            results.success++;
          }
        } 
        else if (action === 'tag') {
          const currentTags = prod.tags || [];
          const newTags = Array.isArray(tags) ? tags : [tags];
          const allTags = [...new Set([...currentTags, ...newTags])];

          const tagQuery = `
            mutation($input: ProductInput!) {
              productUpdate(input: $input) {
                product { id tags }
                userErrors { field message }
              }
            }
          `;

          const tagResult = await shopifyGraphQL(tagQuery, { 
            input: { id: productId, tags: allTags } 
          });

          if (tagResult.data?.productUpdate?.userErrors?.length > 0) {
            results.errors.push(`${prod.title}: ${tagResult.data.productUpdate.userErrors[0].message}`);
            results.failed++;
          } else {
            results.success++;
          }
        }
        else if (action === 'archive') {
          const archiveQuery = `
            mutation($input: ProductInput!) {
              productUpdate(input: $input) {
                product { id status }
                userErrors { field message }
              }
            }
          `;

          const archiveResult = await shopifyGraphQL(archiveQuery, { 
            input: { id: productId, status: "ARCHIVED" } 
          });

          if (archiveResult.data?.productUpdate?.userErrors?.length > 0) {
            results.errors.push(`${prod.title}: ${archiveResult.data.productUpdate.userErrors[0].message}`);
            results.failed++;
          } else {
            results.success++;
          }
        }
        else {
          results.errors.push(`Unknown action: ${action}`);
          results.failed++;
        }
      } catch (err) {
        results.errors.push(`Product: ${err.message}`);
        results.failed++;
      }
    }

    // Invalidate cache on successful actions
    if (results.success > 0) {
      cache = { products: null, orders: null, customers: null, lastFetch: 0 };
    }

    res.json({ 
      action, 
      totalProcessed: uniqueProductIds.length,
      ...results 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SKU AUDIT ─────────────────────────────────

app.get('/api/sku-audit', async (req, res) => {
  try {
    const { products } = await getData();
    const missingSku = [];
    const duplicateSkus = new Map();
    const allSkus = new Map();
    const multiColorway = [];

    for (const product of products) {
      const variants = product.variants.edges.map(e => e.node);
      
      // Check for missing SKUs
      for (const v of variants) {
        if (!v.sku || v.sku.trim() === '') {
          missingSku.push({
            productId: product.id,
            variantId: v.id,
            product: product.title,
            variant: v.title,
            price: v.price,
            available: v.inventoryItem?.inventoryLevels?.edges?.reduce((s, l) => {
              const q = l.node.quantities?.find(q => q.name === 'available');
              return s + (q?.quantity || 0);
            }, 0) || 0,
            vendor: product.vendor || '',
          });
        } else {
          // Track all SKUs for duplicate detection
          const sku = v.sku.trim().toUpperCase();
          if (!allSkus.has(sku)) allSkus.set(sku, []);
          allSkus.get(sku).push({
            productId: product.id,
            variantId: v.id,
            product: product.title,
            variant: v.title,
            sku: v.sku,
          });
        }
      }

      // Check for multi-colorway issues: multiple images on product with only 1 variant
      // or multiple unrelated images that suggest different colorways lumped together
      const imageCount = product.images?.edges?.length || 0;
      const variantCount = variants.length;
      if (imageCount > 3 && variantCount === 1) {
        multiColorway.push({
          productId: product.id,
          product: product.title,
          imageCount,
          variantCount,
          vendor: product.vendor || '',
        });
      }
    }

    // Find actual duplicates (same SKU on different products)
    const duplicates = [];
    allSkus.forEach((items, sku) => {
      const uniqueProducts = new Set(items.map(i => i.productId));
      if (uniqueProducts.size > 1) {
        duplicates.push({ sku, items });
      }
    });

    // Generate suggested SKUs for items missing them
    const suggestedSkus = missingSku.map(item => {
      const brandPrefix = 'KLO';
      const productWords = item.product.replace(/[^a-zA-Z0-9 ]/g, '').split(' ').filter(Boolean);
      const productCode = productWords.slice(0, 2).map(w => w.substring(0, 3).toUpperCase()).join('');
      const variantCode = item.variant !== 'Default Title' 
        ? '-' + item.variant.replace(/[^a-zA-Z0-9]/g, '').substring(0, 4).toUpperCase() 
        : '';
      const seq = String(missingSku.indexOf(item) + 1).padStart(3, '0');
      return {
        ...item,
        suggestedSku: `${brandPrefix}-${productCode}${variantCode}-${seq}`,
      };
    });

    res.json({
      missingSkuCount: missingSku.length,
      duplicateSkuCount: duplicates.length,
      multiColorwayCount: multiColorway.length,
      totalProducts: products.length,
      totalVariants: products.reduce((s, p) => s + p.variants.edges.length, 0),
      missingSku: suggestedSkus,
      duplicates,
      multiColorway,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sku-update', async (req, res) => {
  try {
    const { updates } = req.body; // [{ variantId, sku }]
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }
    
    const results = { success: 0, failed: 0, errors: [] };
    
    for (const update of updates) {
      try {
        const mutation = `
          mutation productVariantUpdate($input: ProductVariantInput!) {
            productVariantUpdate(input: $input) {
              productVariant { id sku }
              userErrors { field message }
            }
          }
        `;
        const result = await shopifyGraphQL(mutation, {
          input: { id: update.variantId, sku: update.sku }
        });
        
        if (result.data?.productVariantUpdate?.userErrors?.length > 0) {
          results.errors.push(`${update.variantId}: ${result.data.productVariantUpdate.userErrors[0].message}`);
          results.failed++;
        } else {
          results.success++;
        }
      } catch (err) {
        results.errors.push(`${update.variantId}: ${err.message}`);
        results.failed++;
      }
    }

    // Invalidate cache after SKU updates
    if (results.success > 0) {
      cache = { products: null, orders: null, customers: null, lastFetch: 0 };
    }

    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── METAFIELD DIAGNOSTICS (for Alert Me / Back in Stock integration) ───

app.get('/api/metafields-diagnostic', async (req, res) => {
  try {
    const { products } = await getData();
    const allMeta = {};
    let productsWithMeta = 0;
    for (const p of products) {
      const edges = p.metafields?.edges || [];
      if (edges.length > 0) productsWithMeta++;
      for (const e of edges) {
        const nsKey = `${e.node.namespace}.${e.node.key}`;
        if (!allMeta[nsKey]) allMeta[nsKey] = { namespace: e.node.namespace, key: e.node.key, count: 0, sampleValues: [] };
        allMeta[nsKey].count++;
        if (allMeta[nsKey].sampleValues.length < 3) allMeta[nsKey].sampleValues.push(e.node.value?.substring(0, 100));
      }
    }
    res.json({
      totalProducts: products.length,
      productsWithMetafields: productsWithMeta,
      metafields: Object.values(allMeta).sort((a, b) => b.count - a.count),
      tip: 'If you use a "Back in Stock" or "Notify Me" app (Klaviyo, Swym, Appikon, etc.), its subscriber data should appear here as metafields. If none show alert/notify/waitlist data, the app may store data externally.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ALERTS ────────────────────────────────────

app.get('/api/alerts', async (req, res) => {
  try {
    const { products, orders } = await getData();
    const analysis = analyzeInventory(products, orders);
    const alerts = analysis.variants.filter(v => v.priority !== 'OK')
      .sort((a, b) => {
        const order = { CRITICAL: 0, URGENT: 1, REORDER: 2, WATCH: 3 };
        return (order[a.priority] || 9) - (order[b.priority] || 9);
      });
    
    // Summary counts for the enhanced alerts page
    const critical = alerts.filter(a => a.priority === 'CRITICAL').length;
    const urgent = alerts.filter(a => a.priority === 'URGENT').length;
    const reorder = alerts.filter(a => a.priority === 'REORDER').length;
    const watch = alerts.filter(a => a.priority === 'WATCH').length;
    const totalRevAtRisk = alerts.filter(a => a.priority === 'CRITICAL')
      .reduce((s, a) => s + (a.price * a.monthlyVelocity), 0);

    res.json({ 
      alerts, total: alerts.length,
      summary: { critical, urgent, reorder, watch, totalRevAtRisk },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send alert email notification for low stock items
app.post('/api/alerts/notify', async (req, res) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(400).json({ error: 'Email not configured. Set up SMTP in Settings first.' });
    }
    const settings = getSettings();
    const { products, orders } = await getData();
    const analysis = analyzeInventory(products, orders);
    const alerts = analysis.variants.filter(v => v.priority !== 'OK')
      .sort((a, b) => {
        const order = { CRITICAL: 0, URGENT: 1, REORDER: 2, WATCH: 3 };
        return (order[a.priority] || 9) - (order[b.priority] || 9);
      });
    
    const critical = alerts.filter(a => a.priority === 'CRITICAL');
    const urgent = alerts.filter(a => a.priority === 'URGENT');

    const alertRows = [...critical, ...urgent].map(a => 
      `<tr><td style="padding:6px 12px;border:1px solid #eee">${a.product}</td><td style="padding:6px 12px;border:1px solid #eee">${a.variant}</td><td style="padding:6px 12px;border:1px solid #eee;font-family:monospace">${a.sku || '—'}</td><td style="padding:6px 12px;border:1px solid #eee;text-align:right;font-weight:bold;color:${a.available <= 0 ? '#dc2626' : '#ea580c'}">${a.available}</td><td style="padding:6px 12px;border:1px solid #eee">${a.priority}</td></tr>`
    ).join('');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
        <h2 style="color:#1a1a2e">⚠ K.Lorayne Inventory Alert</h2>
        <p>There are <strong>${critical.length} CRITICAL</strong> and <strong>${urgent.length} URGENT</strong> low-stock alerts that need your attention.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <thead><tr style="background:#f5f5f5"><th style="padding:8px 12px;border:1px solid #eee;text-align:left">Product</th><th style="padding:8px 12px;border:1px solid #eee;text-align:left">Variant</th><th style="padding:8px 12px;border:1px solid #eee;text-align:left">SKU</th><th style="padding:8px 12px;border:1px solid #eee;text-align:right">Stock</th><th style="padding:8px 12px;border:1px solid #eee">Priority</th></tr></thead>
          <tbody>${alertRows}</tbody>
        </table>
        <p style="color:#666;font-size:13px">Generated ${new Date().toLocaleString()} by K.Lorayne Operations</p>
      </div>
    `;

    const to = settings.notifyEmail || settings.smtpUser || 'contact@kloapparel.com';
    const result = await sendEmail(to, `⚠ Inventory Alert: ${critical.length} Critical, ${urgent.length} Urgent`, html);
    
    logActivity('system', 'alert_sent', `Low stock alert sent to ${to} (${critical.length} critical, ${urgent.length} urgent)`);
    res.json({ success: true, sentTo: to, critical: critical.length, urgent: urgent.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ORDERS ────────────────────────────────────

app.get('/api/orders', async (req, res) => {
  try {
    const { orders } = await getData();
    const { search, financial, fulfillment } = req.query;

    let filtered = orders.map(o => ({
      id: o.id, name: o.name, createdAt: o.createdAt,
      financial: o.displayFinancialStatus,
      fulfillment: o.displayFulfillmentStatus,
      cancelled: !!o.cancelledAt,
      total: o.totalPriceSet?.shopMoney?.amount || '0',
      refunded: o.totalRefundedSet?.shopMoney?.amount || '0',
      customer: o.customer?.displayName || 'Guest',
      customerEmail: o.customer?.email || '',
      customerId: o.customer?.id || null,
      shippingCity: o.shippingAddress?.city || '',
      shippingProvince: o.shippingAddress?.province || '',
      itemCount: o.lineItems.edges.reduce((s, li) => s + li.node.quantity, 0),
      items: o.lineItems.edges.map(li => ({
        title: li.node.title, quantity: li.node.quantity, sku: li.node.sku,
      })),
    }));

    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(o =>
        o.name.toLowerCase().includes(s) || o.customer.toLowerCase().includes(s) ||
        o.customerEmail.toLowerCase().includes(s)
      );
    }
    if (financial) filtered = filtered.filter(o => o.financial === financial);
    if (fulfillment) filtered = filtered.filter(o => o.fulfillment === fulfillment);

    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const totalRevenue = filtered.reduce((s, o) => s + parseFloat(o.total), 0);
    const totalRefunds = filtered.reduce((s, o) => s + parseFloat(o.refunded), 0);
    const avgOrderValue = filtered.length > 0 ? totalRevenue / filtered.length : 0;

    const financialBreakdown = {};
    const fulfillmentBreakdown = {};
    filtered.forEach(o => {
      financialBreakdown[o.financial] = (financialBreakdown[o.financial] || 0) + 1;
      fulfillmentBreakdown[o.fulfillment || 'PENDING'] = (fulfillmentBreakdown[o.fulfillment || 'PENDING'] || 0) + 1;
    });

    res.json({
      orders: filtered, total: filtered.length,
      totalRevenue: totalRevenue.toFixed(2),
      totalRefunds: totalRefunds.toFixed(2),
      avgOrderValue: avgOrderValue.toFixed(2),
      financialBreakdown, fulfillmentBreakdown,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── RETURNS & CHARGEBACKS ─────────────────────

app.get('/api/returns', async (req, res) => {
  try {
    const { orders } = await getData();
    const tickets = getTickets({});

    const returns = [];
    const chargebacks = [];

    for (const order of orders) {
      const refunded = parseFloat(order.totalRefundedSet?.shopMoney?.amount || 0);
      const total = parseFloat(order.totalPriceSet?.shopMoney?.amount || 0);
      
      // Find linked tickets for this order
      const linkedTickets = tickets.filter(t => t.orderId === order.id);

      if (order.cancelledAt) {
        returns.push({
          type: 'cancellation',
          orderId: order.id,
          orderName: order.name,
          createdAt: order.createdAt,
          cancelledAt: order.cancelledAt,
          cancelReason: order.cancelReason || 'Not specified',
          total,
          refunded,
          customer: order.customer?.displayName || 'Guest',
          customerEmail: order.customer?.email || '',
          customerId: order.customer?.id || null,
          financial: order.displayFinancialStatus,
          hasTicket: linkedTickets.length > 0,
          ticketId: linkedTickets[0]?.id || null,
          ticketStatus: linkedTickets[0]?.status || null,
        });
      } else if (refunded > 0) {
        const isPartial = refunded < total;
        returns.push({
          type: isPartial ? 'partial_refund' : 'full_refund',
          orderId: order.id,
          orderName: order.name,
          createdAt: order.createdAt,
          cancelledAt: null,
          cancelReason: null,
          total,
          refunded,
          customer: order.customer?.displayName || 'Guest',
          customerEmail: order.customer?.email || '',
          customerId: order.customer?.id || null,
          financial: order.displayFinancialStatus,
          hasTicket: linkedTickets.length > 0,
          ticketId: linkedTickets[0]?.id || null,
          ticketStatus: linkedTickets[0]?.status || null,
          items: order.lineItems.edges.map(li => ({
            title: li.node.title, quantity: li.node.quantity, sku: li.node.sku,
          })),
        });
      }

      // Chargebacks: PAID orders marked as having disputes/chargebacks
      if (order.displayFinancialStatus === 'REFUNDED' && !order.cancelledAt && refunded >= total) {
        chargebacks.push({
          type: 'chargeback',
          orderId: order.id,
          orderName: order.name,
          createdAt: order.createdAt,
          total,
          refunded,
          customer: order.customer?.displayName || 'Guest',
          customerEmail: order.customer?.email || '',
          customerId: order.customer?.id || null,
          hasTicket: linkedTickets.length > 0,
          ticketId: linkedTickets[0]?.id || null,
          ticketStatus: linkedTickets[0]?.status || null,
        });
      }
    }

    returns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    chargebacks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const totalRefunded = returns.reduce((s, r) => s + r.refunded, 0);
    const withoutTicket = returns.filter(r => !r.hasTicket).length;
    const openTickets = returns.filter(r => r.hasTicket && !['resolved', 'closed'].includes(r.ticketStatus)).length;

    res.json({
      returns,
      chargebacks,
      summary: {
        totalReturns: returns.length,
        totalChargebacks: chargebacks.length,
        totalRefunded,
        withoutTicket,
        openTickets,
        cancellations: returns.filter(r => r.type === 'cancellation').length,
        partialRefunds: returns.filter(r => r.type === 'partial_refund').length,
        fullRefunds: returns.filter(r => r.type === 'full_refund').length,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CUSTOMERS ─────────────────────────────────

app.get('/api/customers', async (req, res) => {
  try {
    const { customers, orders } = await getData();
    const enriched = enrichCustomers(customers, orders);

    // Tier counts (before filtering)
    const tierCounts = { VIP: 0, LOYAL: 0, REPEAT: 0, CUSTOMER: 0, NEW: 0 };
    enriched.forEach(c => tierCounts[c.tier]++);
    const atRisk = enriched.filter(c => c.riskLevel !== 'none').length;

    // Filtering
    let filtered = enriched;
    const { tier, risk, search, sort, page, limit: lim } = req.query;
    if (tier && tier !== 'all') filtered = filtered.filter(c => c.tier === tier);
    if (risk === 'at-risk') filtered = filtered.filter(c => c.riskLevel !== 'none');
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q)
      );
    }

    // Sorting
    if (sort === 'orders') filtered.sort((a, b) => b.totalOrders - a.totalOrders);
    else if (sort === 'recent') filtered.sort((a, b) => new Date(b.lastOrder || 0) - new Date(a.lastOrder || 0));
    else if (sort === 'name') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    // default: sorted by totalSpent (already from enrichCustomers)

    // Pagination
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(lim) || 50));
    const totalFiltered = filtered.length;
    const paged = filtered.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    res.json({
      customers: paged, tierCounts, total: enriched.length,
      totalFiltered, atRisk, page: pageNum, pageSize,
      totalPages: Math.ceil(totalFiltered / pageSize),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/customers/:shopifyId', async (req, res) => {
  try {
    const { customers, orders } = await getData();
    const shopifyId = decodeURIComponent(req.params.shopifyId);
    const customer = customers.find(c => c.id === shopifyId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const custOrders = orders
      .filter(o => o.customer?.email === customer.email)
      .map(o => ({
        id: o.id, name: o.name, createdAt: o.createdAt,
        financial: o.displayFinancialStatus,
        fulfillment: o.displayFulfillmentStatus,
        total: o.totalPriceSet?.shopMoney?.amount,
        refunded: o.totalRefundedSet?.shopMoney?.amount || '0',
        items: o.lineItems.edges.map(li => ({
          title: li.node.title, quantity: li.node.quantity, sku: li.node.sku,
        })),
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const tickets = getTickets({ customerId: shopifyId });
    const notes = getCustomerNotes(shopifyId);
    const customTags = getCustomerTags(shopifyId);

    const totalSpent = parseFloat(customer.amountSpent?.amount || 0);
    const numOrders = parseInt(customer.numberOfOrders || 0);
    const avgOrderValue = numOrders > 0 ? totalSpent / numOrders : 0;

    let tier = 'NEW';
    if (totalSpent >= 500 || numOrders >= 10) tier = 'VIP';
    else if (totalSpent >= 200 || numOrders >= 5) tier = 'LOYAL';
    else if (numOrders >= 2) tier = 'REPEAT';
    else if (numOrders >= 1) tier = 'CUSTOMER';

    let riskLevel = 'none';
    const recentOrders = custOrders.filter(o => (Date.now() - new Date(o.createdAt)) / 86400000 < 90);
    if (numOrders >= 2 && recentOrders.length === 0) {
      const lastOrder = custOrders[0];
      const daysSince = lastOrder ? (Date.now() - new Date(lastOrder.createdAt)) / 86400000 : 999;
      if (daysSince > 90) riskLevel = 'high';
      else if (daysSince > 60) riskLevel = 'medium';
    }

    const productCounts = {};
    custOrders.forEach(o => o.items.forEach(i => {
      productCounts[i.title] = (productCounts[i.title] || 0) + i.quantity;
    }));
    const topProducts = Object.entries(productCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([title, qty]) => ({ title, quantity: qty }));

    res.json({
      id: customer.id, name: customer.displayName, email: customer.email, phone: customer.phone,
      totalOrders: numOrders, totalSpent: totalSpent.toFixed(2),
      avgOrderValue: avgOrderValue.toFixed(2), tier, riskLevel,
      tags: customer.tags || [], customTags,
      location: customer.defaultAddress
        ? `${customer.defaultAddress.city || ''}, ${customer.defaultAddress.province || ''}, ${customer.defaultAddress.country || ''}`.replace(/^, |, $/g, '').replace(/, ,/g, ',')
        : '',
      createdAt: customer.createdAt, updatedAt: customer.updatedAt,
      orders: custOrders, tickets, notes, topProducts,
      recentOrders90d: recentOrders.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/customers/:shopifyId/notes', (req, res) => {
  try {
    const shopifyId = decodeURIComponent(req.params.shopifyId);
    const note = addCustomerNote(shopifyId, req.body);
    logActivity(req.body.author || 'Krystle', 'note_added', 'Added note to customer', { customerId: shopifyId });
    res.status(201).json(note);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/customers/:shopifyId/tags', (req, res) => {
  try {
    const shopifyId = decodeURIComponent(req.params.shopifyId);
    const tags = setCustomerTags(shopifyId, req.body.tags || []);
    logActivity('Krystle', 'tags_updated', 'Updated customer tags', { customerId: shopifyId });
    res.json({ tags });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CRM: TICKETS ──────────────────────────────

// Inbound message ingestion (optional)
// Use this to push customer inquiries (email/DM) into Tickets via Zapier/Make/Webhooks.
// Security: if INBOUND_TOKEN is set, requests must include header `x-inbound-token: <token>`.
function requireInboundToken(req, res, next) {
  const token = process.env.INBOUND_TOKEN;
  if (!token) return next();
  const provided = req.get('x-inbound-token');
  if (!provided || provided !== token) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

app.post('/api/inbound/tickets', requireInboundToken, (req, res) => {
  try {
    const body = req.body || {};

    // Optional idempotency: if the caller provides a stable external message ID,
    // we can prevent duplicates when automations retry.
    const externalId = body.externalId || body.messageId || body.emailMessageId || null;
    const seedKey = externalId ? `inbound|${String(externalId)}` : (body.seedKey || null);
    if (seedKey) {
      const existing = getTickets({}).find(t => t.seedKey === seedKey);
      if (existing) return res.status(200).json(existing);
    }

    const ticket = createTicket({
      customerId: body.customerId || null,
      customerName: body.customerName || body.fromName || 'Unknown',
      customerEmail: body.customerEmail || body.fromEmail || '',
      category: body.category || 'general',
      priority: body.priority || 'medium',
      channel: body.channel || body.source || 'email',
      subject: body.subject || '(no subject)',
      description: body.description || body.body || '',
      messages: body.messages || [],
      orderId: body.orderId || null,
      orderName: body.orderName || null,
      assignee: body.assignee,
      seedKey,
      createdAt: body.createdAt || body.receivedAt || body.timestamp || null,
    });
    logActivity(body.actor || 'System', 'inbound_ticket_created', `Inbound ticket: ${ticket.subject}`, {
      ticketId: ticket.id,
      channel: ticket.channel,
    });
    res.status(201).json(ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets', (req, res) => {
  try {
    const tickets = getTickets({
      status: req.query.status, category: req.query.category,
      priority: req.query.priority, customerId: req.query.customerId,
      search: req.query.search, orderId: req.query.orderId,
      channel: req.query.channel,
    });
    res.json({ tickets, total: tickets.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tickets/:id', (req, res) => {
  try {
    const ticket = getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets', (req, res) => {
  try {
    const ticket = createTicket(req.body);
    logActivity(req.body.assignee || 'Krystle', 'ticket_created', `Created ticket: ${ticket.subject}`, { ticketId: ticket.id });
    res.status(201).json(ticket);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk update ticket status/priority/category — MUST be before :id route
app.patch('/api/tickets/bulk', (req, res) => {
  try {
    const { ids, updates } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const allowed = {};
    if (updates.status) allowed.status = updates.status;
    if (updates.priority) allowed.priority = updates.priority;
    if (updates.category) allowed.category = updates.category;
    let count = 0;
    for (const id of ids) {
      if (updateTicket(id, allowed)) count++;
    }
    logActivity('Krystle', 'bulk_update', `Bulk-updated ${count} tickets to ${JSON.stringify(allowed)}`);
    res.json({ success: true, updated: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/tickets/:id', (req, res) => {
  try {
    const ticket = updateTicket(req.params.id, req.body);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    logActivity('Krystle', 'ticket_updated', `Updated ticket ${ticket.id}`, { ticketId: ticket.id });
    res.json(ticket);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tickets/:id', (req, res) => {
  try {
    const ok = deleteTicket(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Ticket not found' });
    logActivity('Krystle', 'ticket_deleted', `Deleted ticket ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk-delete all tickets for a given channel (e.g. email)
app.delete('/api/tickets/bulk/:channel', (req, res) => {
  try {
    const channel = req.params.channel;
    const tickets = getTickets({ channel });
    let count = 0;
    for (const t of tickets) {
      if (deleteTicket(t.id)) count++;
    }
    logActivity('System', 'bulk_delete', `Bulk-deleted ${count} ${channel} tickets`);
    res.json({ success: true, deleted: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets/:id/notes', async (req, res) => {
  try {
    const note = addTicketNote(req.params.id, req.body);
    if (!note) return res.status(404).json({ error: 'Ticket not found' });
    logActivity(req.body.author || 'Krystle', 'note_added', `Added note to ticket ${req.params.id}`, { ticketId: req.params.id });

    // If it's a customer reply and email is configured, send the email
    let emailResult = null;
    if (req.body.type === 'reply' && req.body.sendEmail !== false) {
      const ticket = getTicketById(req.params.id);
      if (ticket && ticket.customerEmail && isEmailConfigured()) {
        const settings = getSettings();
        emailResult = await sendEmail(
          ticket.customerEmail,
          ticket.subject || 'Support Update',
          req.body.text,
          { ticketId: ticket.id, businessName: settings.businessName }
        );
        // Add a system note about the email
        if (emailResult.success) {
          addTicketNote(req.params.id, {
            text: `📧 Email sent to ${ticket.customerEmail}`,
            author: 'System',
            type: 'system',
          });
        }
      }
    }

    res.status(201).json({ ...note, emailResult });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk ticket actions
app.post('/api/tickets/bulk', (req, res) => {
  try {
    const { ids, action, value } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'No ticket IDs' });
    let updated = 0;
    for (const id of ids) {
      const updates = {};
      if (action === 'status') updates.status = value;
      else if (action === 'priority') updates.priority = value;
      else if (action === 'assignee') updates.assignee = value;
      if (updateTicket(id, updates)) updated++;
    }
    logActivity('Krystle', 'bulk_action', `Bulk ${action} update on ${updated} tickets`);
    res.json({ updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CRM: SAVED REPLIES & CATEGORIES ──────────

app.get('/api/crm/saved-replies', (req, res) => res.json({ replies: getSavedReplies() }));
app.post('/api/crm/saved-replies', (req, res) => {
  try { res.status(201).json(addSavedReply(req.body)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/crm/saved-replies/bulk', (req, res) => {
  try {
    const { replies } = req.body;
    if (!Array.isArray(replies)) return res.status(400).json({ error: 'replies array required' });
    const existing = getSavedReplies();
    const existingTitles = new Set(existing.map(r => r.title.toLowerCase()));
    let imported = 0;
    const newCustom = [];
    for (const r of replies) {
      if (!r.title || !r.body) continue;
      if (existingTitles.has(r.title.toLowerCase())) continue;
      const entry = addSavedReply({ title: r.title, body: r.body, category: r.category || 'general' });
      newCustom.push(entry);
      existingTitles.add(r.title.toLowerCase());
      imported++;
    }
    // Persist imported replies to config file so they survive deploys
    if (newCustom.length) {
      try { saveCustomReplies(getSavedReplies().filter(r => !r.id.match(/^sr-[1-6]$/))); } catch (e) { /* non-critical */ }
    }
    res.json({ imported, total: getSavedReplies().length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/crm/saved-replies/:id', (req, res) => {
  try {
    const ok = deleteSavedReply(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/crm/categories', (req, res) => res.json({ categories: getCategories() }));
app.post('/api/crm/categories', (req, res) => {
  try {
    const cat = addCategory(req.body);
    if (!cat) return res.status(409).json({ error: 'Category ID already exists' });
    logActivity('Krystle', 'category_added', `Added category: ${cat.label}`);
    res.status(201).json(cat);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/crm/categories/:id', (req, res) => {
  try {
    const cat = updateCategory(req.params.id, req.body);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    logActivity('Krystle', 'category_updated', `Updated category: ${cat.label}`);
    res.json(cat);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/crm/categories/:id', (req, res) => {
  try {
    const ok = deleteCategory(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Cannot delete this category' });
    logActivity('Krystle', 'category_deleted', `Deleted category: ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── EMAIL ─────────────────────────────────────

app.get('/api/email/status', (req, res) => {
  res.json({ configured: isEmailConfigured() });
});

app.post('/api/email/test', async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient email required' });
    const result = await sendTestEmail(to);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/email/send', async (req, res) => {
  try {
    const { to, subject, body, ticketId } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'Missing to, subject, or body' });
    const settings = getSettings();
    const result = await sendEmail(to, subject, body, { ticketId, businessName: settings.businessName });
    if (result.success) logActivity('Krystle', 'email_sent', `Sent email to ${to}`, { ticketId });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CRM: STATS / SETTINGS / ACTIVITY ─────────

app.get('/api/crm/stats', (req, res) => {
  try { res.json(getCrmStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/crm/settings', (req, res) => res.json(getSettings()));
app.patch('/api/crm/settings', (req, res) => {
  try {
    const settings = updateSettings(req.body);
    // Reconfigure email if SMTP settings changed
    if (req.body.smtpHost !== undefined || req.body.smtpUser !== undefined || req.body.smtpPass !== undefined) {
      configureEmail(settings);
    }
    logActivity('Krystle', 'settings_updated', 'Updated CRM settings');
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ activity: getActivityLog(limit) });
});

// ─── GLOBAL SEARCH ─────────────────────────────

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json({ results: [] });
    const { customers, orders } = await getData();
    const enriched = enrichCustomers(customers, orders);
    const tickets = getTickets({});
    const results = [];

    enriched.filter(c =>
      (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q)
    ).slice(0, 5).forEach(c => results.push({
      type: 'customer', id: c.id, title: c.name, subtitle: c.email,
      meta: `${c.tier} · $${c.totalSpent}`,
    }));

    orders.filter(o =>
      o.name.toLowerCase().includes(q) || (o.customer?.displayName || '').toLowerCase().includes(q)
    ).slice(0, 5).forEach(o => results.push({
      type: 'order', id: o.id, title: o.name,
      subtitle: o.customer?.displayName || 'Guest',
      meta: `$${o.totalPriceSet?.shopMoney?.amount}`,
    }));

    tickets.filter(t =>
      t.subject.toLowerCase().includes(q) || t.customerName.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)
    ).slice(0, 5).forEach(t => results.push({
      type: 'ticket', id: t.id, title: t.subject,
      subtitle: t.customerName, meta: `${t.status}`,
    }));

    res.json({ results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── REFRESH & SPA FALLBACK ───────────────────

app.post('/api/refresh', async (req, res) => {
  try {
    cache = { products: null, orders: null, customers: null, lastFetch: 0 };
    await getData(true);
    logActivity('system', 'data_refresh', 'Shopify data manually refreshed');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/{*splat}', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// ─── START ─────────────────────────────────────

process.on('uncaughtException', (err) => console.error('[FATAL] Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('[FATAL] Unhandled rejection:', err));

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  K.Lorayne Operations — Enterprise CRM       ║`);
  console.log(`║  http://localhost:${PORT}                        ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`  Store: ${getShopDomain()}`);
  // Initialize email transporter from saved settings
  const settings = getSettings();
  if (settings.smtpHost && settings.smtpUser) {
    const ok = configureEmail(settings);
    console.log(`  Email: ${ok ? '✓ SMTP configured' : '✗ SMTP not ready'}`);
  } else {
    console.log(`  Email: Not configured (set SMTP in Settings)`);
  }
  console.log(`  Server ready — fetching data in background...\n`);
  // Fetch data in background so the server starts immediately
  getData().then(() => console.log('  ✓ All data loaded!\n')).catch(err => console.error('[server] Pre-warm failed:', err));
});
