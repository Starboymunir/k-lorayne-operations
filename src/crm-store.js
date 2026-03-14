// K.Lorayne Operations — CRM Data Store (Enterprise Edition)
// Persistent JSON storage for tickets, notes, tags, activity log
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STORE_FILE = join(DATA_DIR, 'crm-store.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── DEFAULT STORE ─────────────────────────────

const DEFAULT_STORE = {
  tickets: [],
  notes: {},
  customTags: {},
  activityLog: [],
  savedReplies: [
    { id: 'sr-1', title: 'Order Status', category: 'order_status', body: 'Hi {name},\n\nThank you for reaching out! Your order {order} is currently {status}. You can track it here: {tracking_url}\n\nPlease let us know if you have any other questions!\n\nBest,\nK.Lorayne Team' },
    { id: 'sr-2', title: 'Return Instructions', category: 'returns', body: 'Hi {name},\n\nWe\'re sorry to hear that you need to make a return. Here\'s how:\n\n1. Email us your order number and reason\n2. We\'ll send a return shipping label\n3. Package in original packaging\n4. Drop off at nearest carrier\n\nReturns processed within 5-7 business days.\n\nBest,\nK.Lorayne Team' },
    { id: 'sr-3', title: 'Sizing Help', category: 'sizing', body: 'Hi {name},\n\nHere are our sizing recommendations:\n\n• XS: 0-2\n• S: 4-6\n• M: 8-10\n• L: 12-14\n• XL: 16-18\n\nIf between sizes, we recommend sizing up.\n\nBest,\nK.Lorayne Team' },
    { id: 'sr-4', title: 'Shipping Delay', category: 'shipping', body: 'Hi {name},\n\nWe apologize for the delay with your order. We\'re experiencing {reason} and expect to ship within {timeframe}.\n\nWe\'ll send tracking as soon as it ships.\n\nBest,\nK.Lorayne Team' },
    { id: 'sr-5', title: 'Damage Report', category: 'damage', body: 'Hi {name},\n\nWe\'re sorry your item arrived damaged! Please send us:\n\n1. Photos of the damage\n2. Your order number\n3. Replacement or refund preference\n\nWe\'ll take care of this right away.\n\nBest,\nK.Lorayne Team' },
    { id: 'sr-6', title: 'VIP Thank You', category: 'general', body: 'Hi {name},\n\nThank you for being an amazing customer! Your support means the world.\n\nAs a VIP you get early access to drops and exclusive discounts. Stay tuned!\n\nWith love,\nK.Lorayne Team' },
  ],
  categories: [
    { id: 'order_status', label: 'Order Status', icon: '📦', color: '#3b82f6' },
    { id: 'returns', label: 'Returns & Exchanges', icon: '🔄', color: '#f97316' },
    { id: 'chargebacks', label: 'Chargebacks', icon: '⚠', color: '#dc2626' },
    { id: 'damage', label: 'Damaged Items', icon: '💔', color: '#ef4444' },
    { id: 'sizing', label: 'Sizing Questions', icon: '📏', color: '#8b5cf6' },
    { id: 'shipping', label: 'Shipping Issues', icon: '🚚', color: '#eab308' },
    { id: 'billing', label: 'Billing / Payment', icon: '💳', color: '#22c55e' },
    { id: 'social_media', label: 'Social Media', icon: '📱', color: '#e91e8b' },
    { id: 'general', label: 'General Inquiry', icon: '💬', color: '#8b8da0' },
    { id: 'vip', label: 'VIP Follow-up', icon: '⭐', color: '#f59e0b' },
  ],
  settings: {
    theme: 'light',
    autoAssignee: 'Krystle',
    slaResponseHours: 24,
    slaResolutionHours: 48,
    businessName: 'K.Lorayne Apparel',
    notifyEmail: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    emailFrom: '',
  },
};

function repairDuplicateTicketIds(storeObj) {
  const tickets = Array.isArray(storeObj?.tickets) ? storeObj.tickets : [];
  if (tickets.length === 0) return false;

  const seen = new Set();
  let changed = false;

  for (const t of tickets) {
    if (!t || typeof t !== 'object') continue;
    const cur = String(t.id || '');
    if (!cur || !cur.startsWith('TK-')) {
      t.id = `TK-${randomUUID().split('-')[0].toUpperCase()}`;
      changed = true;
      continue;
    }
    if (seen.has(cur)) {
      t.id = `TK-${randomUUID().split('-')[0].toUpperCase()}`;
      changed = true;
      continue;
    }
    seen.add(cur);
  }
  return changed;
}

// ─── LOAD / SAVE ───────────────────────────────

function load() {
  try {
    if (existsSync(STORE_FILE)) {
      const raw = readFileSync(STORE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const hydrated = {
        ...DEFAULT_STORE,
        ...parsed,
        activityLog: parsed.activityLog || [],
        categories: parsed.categories || DEFAULT_STORE.categories,
        savedReplies: parsed.savedReplies || DEFAULT_STORE.savedReplies,
        settings: { ...DEFAULT_STORE.settings, ...parsed.settings },
      };
      const changed = repairDuplicateTicketIds(hydrated);

      // One-time migration: purge old auto-seeded tickets so they re-create with enriched descriptions
      const SEED_MIGRATION_KEY = '_seedDescV2';
      if (!hydrated[SEED_MIGRATION_KEY]) {
        const before = hydrated.tickets.length;
        hydrated.tickets = hydrated.tickets.filter(t => !t.seedKey);
        hydrated[SEED_MIGRATION_KEY] = true;
        const removed = before - hydrated.tickets.length;
        if (removed > 0) console.log(`[crm-store] Migration: purged ${removed} old seeded tickets (will re-create with rich descriptions)`);
        save(hydrated);
        return hydrated;
      }

      if (changed) save(hydrated);
      console.log(`[crm-store] Loaded ${hydrated.tickets.length} tickets from ${STORE_FILE}`);
      return hydrated;
    }
    console.log(`[crm-store] No store file found at ${STORE_FILE} — starting fresh`);
  } catch (err) {
    console.error('[crm-store] Load error, using defaults:', err.message);
  }
  return structuredClone(DEFAULT_STORE);
}

function save(store) {
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

let store = load();

// ─── ACTIVITY LOG ──────────────────────────────

export function logActivity(actor, action, description, meta = {}) {
  const entry = {
    id: randomUUID(),
    actor,
    action,
    description,
    meta,
    timestamp: new Date().toISOString(),
  };
  store.activityLog.unshift(entry);
  // Keep last 500 entries
  if (store.activityLog.length > 500) store.activityLog = store.activityLog.slice(0, 500);
  save(store);
  return entry;
}

export function getActivityLog(limit = 50) {
  return store.activityLog.slice(0, limit);
}

// ─── TICKETS ───────────────────────────────────

export function getTickets(filters = {}) {
  let tickets = store.tickets;

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    tickets = tickets.filter(t => statuses.includes(t.status));
  }
  if (filters.category) tickets = tickets.filter(t => t.category === filters.category);
  if (filters.priority) tickets = tickets.filter(t => t.priority === filters.priority);
  if (filters.customerId) tickets = tickets.filter(t => t.customerId === filters.customerId);
  if (filters.assignee) tickets = tickets.filter(t => t.assignee === filters.assignee);
  if (filters.orderId) tickets = tickets.filter(t => t.orderId === filters.orderId);
  if (filters.channel) tickets = tickets.filter(t => (t.channel || 'shopify') === filters.channel);
  if (filters.search) {
    const s = filters.search.toLowerCase();
    tickets = tickets.filter(t =>
      t.subject.toLowerCase().includes(s) ||
      t.customerName.toLowerCase().includes(s) ||
      (t.customerEmail || '').toLowerCase().includes(s) ||
      t.description.toLowerCase().includes(s) ||
      t.id.toLowerCase().includes(s)
    );
  }

  tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return tickets;
}

export function getTicketById(id) {
  return store.tickets.find(t => t.id === id) || null;
}

export function createTicket(data = {}) {
  const normalizeIso = (value) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  };

  const nowIso = new Date().toISOString();
  const createdAt = normalizeIso(data.createdAt) || nowIso;
  const updatedAt = normalizeIso(data.updatedAt) || createdAt;

  const id = `TK-${randomUUID().split('-')[0].toUpperCase()}`;

  const ticket = {
    id,
    customerId: data.customerId || null,
    customerName: data.customerName || 'Unknown',
    customerEmail: data.customerEmail || '',
    category: data.category || 'general',
    priority: data.priority || 'medium',
    status: 'open',
    subject: data.subject || '',
    description: data.description || '',
    assignee: data.assignee || store.settings.autoAssignee,
    orderId: data.orderId || null,
    orderName: data.orderName || null,
    seedKey: data.seedKey || null,
    channel: data.channel || 'shopify',   // shopify | email | social_fb | social_ig | social_tiktok | manual
    messages: Array.isArray(data.messages) ? data.messages : [],
    notes: [],
    createdAt,
    updatedAt,
    resolvedAt: null,
    firstResponseAt: null,
  };
  store.tickets.unshift(ticket);
  save(store);
  return ticket;
}

export function updateTicket(id, updates) {
  const ticket = store.tickets.find(t => t.id === id);
  if (!ticket) return null;

  if (updates.status) {
    ticket.status = updates.status;
    if (updates.status === 'resolved' || updates.status === 'closed') {
      ticket.resolvedAt = new Date().toISOString();
    }
  }
  if (updates.priority) ticket.priority = updates.priority;
  if (updates.category) ticket.category = updates.category;
  if (updates.assignee !== undefined) ticket.assignee = updates.assignee;
  if (updates.subject) ticket.subject = updates.subject;

  ticket.updatedAt = new Date().toISOString();
  save(store);
  return ticket;
}

export function addTicketNote(ticketId, note) {
  const ticket = store.tickets.find(t => t.id === ticketId);
  if (!ticket) return null;

  const entry = {
    id: randomUUID(),
    text: note.text,
    author: note.author || store.settings.autoAssignee,
    type: note.type || 'internal',
    createdAt: new Date().toISOString(),
  };

  if (!ticket.firstResponseAt && entry.type === 'reply') {
    ticket.firstResponseAt = entry.createdAt;
  }

  ticket.notes.push(entry);
  ticket.updatedAt = new Date().toISOString();
  save(store);
  return entry;
}

export function deleteTicket(id) {
  const idx = store.tickets.findIndex(t => t.id === id);
  if (idx < 0) return false;
  store.tickets.splice(idx, 1);
  save(store);
  return true;
}

// ─── CUSTOMER NOTES ────────────────────────────

export function getCustomerNotes(customerId) {
  return store.notes[customerId] || [];
}

export function addCustomerNote(customerId, note) {
  if (!store.notes[customerId]) store.notes[customerId] = [];
  const entry = {
    id: randomUUID(),
    text: note.text,
    author: note.author || store.settings.autoAssignee,
    createdAt: new Date().toISOString(),
  };
  store.notes[customerId].push(entry);
  save(store);
  return entry;
}

// ─── CUSTOMER TAGS ─────────────────────────────

export function getCustomerTags(customerId) {
  return store.customTags[customerId] || [];
}

export function setCustomerTags(customerId, tags) {
  store.customTags[customerId] = tags;
  save(store);
  return tags;
}

// ─── SAVED REPLIES ─────────────────────────────

export function getSavedReplies() {
  return store.savedReplies;
}

export function addSavedReply(reply) {
  const entry = {
    id: `sr-${Date.now()}`,
    title: reply.title,
    category: reply.category || 'general',
    body: reply.body,
  };
  store.savedReplies.push(entry);
  save(store);
  return entry;
}

export function deleteSavedReply(id) {
  const idx = store.savedReplies.findIndex(r => r.id === id);
  if (idx < 0) return false;
  store.savedReplies.splice(idx, 1);
  save(store);
  return true;
}

// ─── CATEGORIES ────────────────────────────────

export function getCategories() {
  return store.categories;
}

export function addCategory(data) {
  const cat = {
    id: data.id || data.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, ''),
    label: data.label,
    icon: data.icon || '🏷️',
    color: data.color || '#8b8da0',
  };
  // Prevent duplicate IDs
  if (store.categories.find(c => c.id === cat.id)) return null;
  store.categories.push(cat);
  save(store);
  return cat;
}

export function updateCategory(id, updates) {
  const cat = store.categories.find(c => c.id === id);
  if (!cat) return null;
  if (updates.label !== undefined) cat.label = updates.label;
  if (updates.icon !== undefined) cat.icon = updates.icon;
  if (updates.color !== undefined) cat.color = updates.color;
  save(store);
  return cat;
}

export function deleteCategory(id) {
  // Don't delete 'general' — it's the fallback
  if (id === 'general') return false;
  const idx = store.categories.findIndex(c => c.id === id);
  if (idx < 0) return false;
  store.categories.splice(idx, 1);
  // Move tickets in this category to 'general'
  store.tickets.forEach(t => { if (t.category === id) t.category = 'general'; });
  save(store);
  return true;
}

// ─── SETTINGS ──────────────────────────────────

export function getSettings() {
  return store.settings;
}

export function updateSettings(updates) {
  Object.assign(store.settings, updates);
  save(store);
  return store.settings;
}

// ─── CRM STATS ─────────────────────────────────

export function getCrmStats() {
  const now = new Date();
  const tickets = store.tickets;

  const byStatus = { open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0 };
  tickets.forEach(t => { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });

  const byCategory = {};
  tickets.forEach(t => { byCategory[t.category] = (byCategory[t.category] || 0) + 1; });

  const byPriority = { low: 0, medium: 0, high: 0, urgent: 0 };
  tickets.forEach(t => { byPriority[t.priority] = (byPriority[t.priority] || 0) + 1; });

  const active = tickets.filter(t => !['resolved', 'closed'].includes(t.status));

  const responseTimes = tickets
    .filter(t => t.firstResponseAt && t.createdAt)
    .map(t => (new Date(t.firstResponseAt) - new Date(t.createdAt)) / 3600000);
  const avgResponseHrs = responseTimes.length > 0
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0;

  const resolutionTimes = tickets
    .filter(t => t.resolvedAt && t.createdAt)
    .map(t => (new Date(t.resolvedAt) - new Date(t.createdAt)) / 3600000);
  const avgResolutionHrs = resolutionTimes.length > 0
    ? resolutionTimes.reduce((a, b) => a + b, 0) / resolutionTimes.length : 0;

  const weekAgo = new Date(now - 7 * 86400000);
  const thisWeek = tickets.filter(t => new Date(t.createdAt) >= weekAgo);
  const resolvedThisWeek = tickets.filter(t => t.resolvedAt && new Date(t.resolvedAt) >= weekAgo);

  const slaResponse = store.settings.slaResponseHours;
  const withinSla = responseTimes.filter(t => t <= slaResponse).length;
  const slaCompliance = responseTimes.length > 0
    ? Math.round((withinSla / responseTimes.length) * 100) : 100;

  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(now - i * 86400000);
    const dayStr = day.toISOString().split('T')[0];
    const created = tickets.filter(t => t.createdAt.startsWith(dayStr)).length;
    const resolved = tickets.filter(t => t.resolvedAt && t.resolvedAt.startsWith(dayStr)).length;
    trend.push({ date: dayStr, created, resolved });
  }

  // By assignee
  const byAssignee = {};
  tickets.forEach(t => {
    const a = t.assignee || 'Unassigned';
    if (!byAssignee[a]) byAssignee[a] = { total: 0, open: 0, resolved: 0 };
    byAssignee[a].total++;
    if (['resolved', 'closed'].includes(t.status)) byAssignee[a].resolved++;
    else byAssignee[a].open++;
  });

  return {
    total: tickets.length, active: active.length,
    byStatus, byCategory, byPriority, byAssignee,
    avgResponseHrs: Math.round(avgResponseHrs * 10) / 10,
    avgResolutionHrs: Math.round(avgResolutionHrs * 10) / 10,
    thisWeek: thisWeek.length, resolvedThisWeek: resolvedThisWeek.length,
    slaCompliance, trend, categories: store.categories,
  };
}
