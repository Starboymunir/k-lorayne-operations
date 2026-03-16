/**
 * KLO Gmail → Tickets (AI-First v4 — OpenAI)
 *
 * Uses OpenAI GPT-4o-mini to intelligently classify every email sent to contact@kloapparel.com.
 * AI reads each email and decides: is this a real customer support issue or noise?
 *
 * Paste into https://script.google.com/ (logged into contact@kloapparel.com)
 * Configure Script Properties:
 * - KLO_INBOUND_URL = https://k-lorayne-operations.onrender.com/api/inbound/tickets
 * - KLO_INBOUND_TOKEN = <Render INBOUND_TOKEN>
 * - KLO_DEFAULT_ASSIGNEE = Krystle (or Showroom Manager)
 * - KLO_LOOKBACK_DAYS = 14
 * - KLO_OPENAI_API_KEY = <OpenAI API key>  ← REQUIRED
 *
 * BACKFILL: Run kloBackfill() once to reset previously-ignored emails
 *          so they get re-evaluated with the latest rules.
 */

function kloIngestAuto() {
  var props = PropertiesService.getScriptProperties();
  var inboundUrl = props.getProperty('KLO_INBOUND_URL');
  var inboundToken = props.getProperty('KLO_INBOUND_TOKEN');
  var defaultAssignee = props.getProperty('KLO_DEFAULT_ASSIGNEE') || 'Krystle';
  var lookbackDays = parseInt(props.getProperty('KLO_LOOKBACK_DAYS') || '14', 10);
  var openaiApiKey = props.getProperty('KLO_OPENAI_API_KEY') || '';

  if (!inboundUrl) throw new Error('Missing script property KLO_INBOUND_URL');
  if (!openaiApiKey) throw new Error('Missing script property KLO_OPENAI_API_KEY — get one at platform.openai.com');

  var ingestedLabel = ensureLabel_('KLO/Ingested');
  var failedLabel   = ensureLabel_('KLO/IngestFailed');
  var ignoredLabel  = ensureLabel_('KLO/Ignored');
  var supportLabel  = ensureLabel_('KLO/ToTicket/Support');

  // Search: emails to contact@, recent, NOT already processed or ignored
  var q = 'to:contact@kloapparel.com newer_than:' + lookbackDays + 'd -label:' + ingestedLabel.getName() + ' -label:' + ignoredLabel.getName();
  var threads = GmailApp.search(q, 0, 500);
  Logger.log('Found ' + threads.length + ' threads to process');
  var startTime = new Date().getTime();
  var ticketed = 0;
  var ignored = 0;
  var skipped = 0;

  for (var i = 0; i < threads.length; i++) {
    // Guard against Apps Script 6-minute time limit — stop at 5 min to be safe
    var elapsed = (new Date().getTime() - startTime) / 1000;
    if (elapsed > 300) {
      Logger.log('TIME LIMIT: ' + (ticketed + ignored + skipped) + '/' + threads.length + ' threads in 5 min (' + ticketed + ' ticketed, ' + ignored + ' ignored, ' + skipped + ' skipped). Run again to continue.');
      break;
    }

    var thread = threads[i];
    var msgs = thread.getMessages();
    if (!msgs || msgs.length === 0) { skipped++; continue; }

    // Get the best message to classify:
    // Start from the latest, but if it's from an internal address, walk backwards
    // to find the latest EXTERNAL message (the actual customer email)
    var m = null;
    for (var mi = msgs.length - 1; mi >= 0; mi--) {
      var candidateFrom = extractEmail_(msgs[mi].getFrom() || '').toLowerCase();
      if (!candidateFrom.endsWith('@kloapparel.com') && !candidateFrom.endsWith('@klorayne.com')) {
        m = msgs[mi];
        break;
      }
    }
    if (!m) {
      // Entire thread is internal — skip
      thread.addLabel(ignoredLabel);
      ignored++;
      continue;
    }

    var fromRaw = m.getFrom() || '';
    var fromEmail = extractEmail_(fromRaw).toLowerCase();
    var fromName = extractName_(fromRaw);
    var subjectRaw = m.getSubject() || '(no subject)';
    var subject = String(subjectRaw);
    var body = m.getPlainBody ? m.getPlainBody() : m.getBody();
    var bodySnippet = getBodySnippet_(body, 5000);
    var externalId = m.getId();

    // Collect full thread history — every message in the conversation
    var threadMessages = [];
    for (var ti = 0; ti < msgs.length; ti++) {
      var tm = msgs[ti];
      var tmFromRaw = tm.getFrom() || '';
      var tmEmail = extractEmail_(tmFromRaw).toLowerCase();
      var tmBody = tm.getPlainBody ? tm.getPlainBody() : tm.getBody();
      threadMessages.push({
        from: extractName_(tmFromRaw) || tmEmail,
        fromEmail: tmEmail,
        date: tm.getDate ? tm.getDate().toISOString() : null,
        body: getBodySnippet_(tmBody, 5000),
      });
    }

    Logger.log('[' + (i + 1) + '/' + threads.length + '] "' + subject + '" from ' + fromEmail);

    // ─── Fast pre-filter: skip obvious noise WITHOUT calling AI (saves ~2s per skip) ───
    var quickIgnore = isObviousNoise_(fromEmail, subject);
    if (quickIgnore) {
      Logger.log('QUICK SKIP: "' + subject + '" — ' + quickIgnore);
      thread.addLabel(ignoredLabel);
      ignored++;
      continue;
    }

    // ─── AI Classification — OpenAI reads the email and decides ───
    var aiResult = classifyWithOpenAI_(openaiApiKey, {
      fromEmail: fromEmail,
      fromName: fromName,
      subject: subject,
      bodySnippet: bodySnippet,
    });

    if (aiResult && !aiResult.ticket) {
      // AI says this is NOT a support email — ignore it
      Logger.log('AI IGNORED: "' + subject + '" — ' + (aiResult.reason || 'not support'));
      thread.addLabel(ignoredLabel);
      ignored++;
      continue;
    }

    var matched = null;
    if (aiResult && aiResult.ticket) {
      // AI says it IS a ticket
      matched = { name: aiResult.name, category: aiResult.category, priority: aiResult.priority };
      Logger.log('AI TICKET: "' + subject + '" → ' + matched.category + ' (' + matched.priority + ')');
    } else {
      // AI failed after retries — fall back to keyword classification
      Logger.log('AI unavailable for "' + subject + '" — using keyword fallback');
      matched = classifyByKeywords_(subject.toLowerCase() + ' ' + bodySnippet.toLowerCase(), SUPPORT_RULES);
      if (!matched) {
        // No keyword match either — safer to IGNORE than create noise
        Logger.log('FALLBACK IGNORED: "' + subject + '" — no keyword match');
        thread.addLabel(ignoredLabel);
        ignored++;
        continue;
      }
    }

    // ─── Create the ticket ───
    thread.addLabel(supportLabel);

    var payload = {
      externalId: externalId,
      fromName: fromName,
      fromEmail: fromEmail,
      createdAt: m.getDate && m.getDate() ? m.getDate().toISOString() : null,
      subject: subject,
      body: bodySnippet,
      messages: threadMessages,
      channel: 'email',
      category: matched.category,
      priority: matched.priority,
      assignee: defaultAssignee,
    };

    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      headers: inboundToken ? { 'x-inbound-token': inboundToken } : {},
    };

    try {
      var resp = UrlFetchApp.fetch(inboundUrl, options);
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        thread.addLabel(ingestedLabel);
        try { thread.removeLabel(failedLabel); } catch (e) {}
      } else {
        Logger.log('Failed ingest HTTP ' + code + ': ' + resp.getContentText());
        thread.addLabel(failedLabel);
      }
      ticketed++;
    } catch (fetchErr) {
      if (String(fetchErr).indexOf('Bandwidth quota') >= 0) {
        Logger.log('BANDWIDTH QUOTA HIT at thread ' + (i + 1) + '/' + threads.length + '. Run kloBackfillContinue() to resume.');
        break;
      }
      Logger.log('Fetch error: ' + fetchErr.message);
      thread.addLabel(failedLabel);
    }
    // Throttle to avoid Apps Script bandwidth quota
    Utilities.sleep(200);
  }
  Logger.log('Done: ' + ticketed + ' ticketed, ' + ignored + ' ignored, ' + skipped + ' skipped out of ' + threads.length + ' threads.');
}

// ─── FAST PRE-FILTER (skip obvious noise without calling AI) ───

// Known automated/marketing sender domains — no human wrote these
var NOISE_DOMAINS = [
  'mailer-daemon@', 'noreply@', 'no-reply@',
  'mailer@shopify.com', 'flow@shopify.com',
  'noreply-apps-scripts-notifications@google.com',
  'no-reply@accounts.google.com',
  'no-reply@canva.com', 'no-reply@account.canva.com',
  'employers-noreply@indeed.com',
];

// Subject patterns that are always automated noise
var NOISE_SUBJECT_PATTERNS = [
  /^payout for /i,
  /^\[.*\] order [A-Za-z0-9]+ placed by /i,
  /^delivery status notification/i,
  /^shipping label created/i,
  /^\[shopify\] update: shopify support chat/i,
  /^summary of failures for google apps script/i,
  /^security alert$/i,
  /^recovery email verified/i,
  /^inventory forecast for /i,
  /^weekly job summary$/i,
  /^your canva invoice$/i,
  /^end of week inventory count$/i,
];

// Known bulk marketing domains — never a real person
var MARKETING_DOMAINS = [
  '@shared1.ccsend.com', '@t.shopifyemail.com',
  '@us.shopping.hp.com', '@my.joinhoney.com',
  '@hello.blink.com', '@info.pinterest.com',
  '@mail.adobe.com', '@mkt.obws.com',
  '@gotprint.com', '@shop.tiktok.com',
];

// Subject patterns that should ALWAYS go to AI (never pre-filter skip)
var ALWAYS_TICKET_PATTERNS = [
  /new customer message/i,
  /new message from/i,
  /shopify inbox/i,
];

function isObviousNoise_(fromEmail, subject) {
  // Strip Re:/Fwd: prefixes so "Re: Payout for..." still matches "^Payout for..."
  var cleanSubject = subject.replace(/^(re:\s*|fwd?:\s*)+/i, '');
  // Exemptions first — these must NEVER be skipped, even from noreply senders
  for (var i = 0; i < ALWAYS_TICKET_PATTERNS.length; i++) {
    if (ALWAYS_TICKET_PATTERNS[i].test(cleanSubject)) return null;
  }
  // Check known noise senders
  for (var i = 0; i < NOISE_DOMAINS.length; i++) {
    if (fromEmail.indexOf(NOISE_DOMAINS[i]) >= 0) return 'noise sender';
  }
  // Check marketing domains
  for (var i = 0; i < MARKETING_DOMAINS.length; i++) {
    if (fromEmail.indexOf(MARKETING_DOMAINS[i]) >= 0) return 'marketing sender';
  }
  // Check subject patterns
  for (var i = 0; i < NOISE_SUBJECT_PATTERNS.length; i++) {
    if (NOISE_SUBJECT_PATTERNS[i].test(cleanSubject)) return 'noise subject';
  }
  return null; // Not obvious noise — send to AI
}

// ─── KEYWORD FALLBACK (only used if OpenAI is down) ───

var SUPPORT_RULES = [
  { name: 'refund', keywords: ['refund', 'money back', 'charge back', 'chargeback', 'dispute', 'cancel my order', 'cancel order', 'cancellation'], category: 'returns', priority: 'high' },
  { name: 'shipping', keywords: ['where is my order', 'not shipped', 'lost package', 'never received', 'not delivered', 'missing package', 'missing order', 'not arrived'], category: 'shipping', priority: 'medium' },
  { name: 'delay', keywords: ['delay', 'delayed', 'taking too long', 'still waiting', 'order status', 'when will'], category: 'order_status', priority: 'medium' },
  { name: 'address', keywords: ['change address', 'wrong address', 'update address', 'change shipping', 'new address'], category: 'shipping', priority: 'high' },
  { name: 'defective', keywords: ['defective', 'damaged', 'broken', 'ripped', 'torn', 'wrong item', 'wrong product', 'not as described'], category: 'damage', priority: 'high' },
  { name: 'sizing', keywords: ['wrong size', 'too small', 'too big', 'doesn\'t fit', 'size exchange', 'size chart'], category: 'sizing', priority: 'medium' },
  { name: 'return', keywords: ['return', 'returning', 'send back', 'return label', 'return policy', 'exchange', 'replacement'], category: 'returns', priority: 'medium' },
];

function classifyByKeywords_(text, rules) {
  // Return the FIRST matching rule (ordered by priority importance)
  for (var i = 0; i < rules.length; i++) {
    for (var k = 0; k < rules[i].keywords.length; k++) {
      if (text.indexOf(rules[i].keywords[k]) >= 0) {
        return { name: rules[i].name, category: rules[i].category, priority: rules[i].priority };
      }
    }
  }
  return null;
}

// ─── AI CLASSIFICATION (OpenAI GPT-4o-mini — primary classifier) ───

// Returns { ticket: true, name, category, priority } or { ticket: false, reason } or null on error
function classifyWithOpenAI_(apiKey, email) {
  try {
    var url = 'https://api.openai.com/v1/chat/completions';

    var systemPrompt = [
      'You are the email triage system for K.Lorayne, a clothing brand.',
      'The email inbox is contact@kloapparel.com.',
      '',
      'Your job: decide if this email needs a support ticket.',
      'YOUR DEFAULT IS TO CREATE A TICKET. Only ignore clearly automated/promotional noise.',
      '',
      'ALWAYS CREATE A TICKET for:',
      '- ANY email from a real human being (customer, business contact, collaborator, partner, developer, freelancer)',
      '- Business proposals, partnership inquiries, collaboration requests',
      '- Shopify Inbox customer chats ("New customer message", "New message from...")',
      '- Order inquiries, refunds, cancellations, chargebacks',
      '- Damaged/defective/wrong item reports',
      '- Return or exchange requests',
      '- Sizing or fit questions',
      '- Address change requests',
      '- Contact form submissions',
      '- Shopify chargeback/dispute/refund notifications',
      '- Return requested notifications',
      '- Inquiry opened notifications',
      '- Restock notification sign-ups',
      '- ANY email where a real person typed something and sent it',
      '',
      'ONLY IGNORE (automated/promotional noise — no human wrote this):',
      '- Mass marketing emails, newsletters, promos, sale alerts from brands/services',
      '- Automated platform notifications (password reset, security alert, account verification)',
      '- Shopify billing/invoices/subscription emails',
      '- Inventory forecast automated emails',
      '- Job platform automated summaries (Indeed, LinkedIn)',
      '- Canva/Google/social media automated notifications',
      '- Delivery Status Notification (Failure) bouncebacks',
      '- Shopify Support Chat updates (from Shopify support TO the store owner)',
      '',
      'KEY RULE: If a human being sat down and typed/sent this email, CREATE A TICKET.',
      'That includes: business proposals, freelancer pitches, collaboration requests, customer inquiries, complaints, anything personal.',
      'When in doubt, CREATE THE TICKET.',
      '',
      'Return ONLY valid JSON:',
      'If ticket: {"ticket":true,"type":"refund|shipping|delay|address|defective|sizing|return|chat|inquiry|general","priority":"low|medium|high","reason":"brief explanation"}',
      'If NOT ticket: {"ticket":false,"reason":"brief explanation"}',
    ].join('\n');

    var userMessage = [
      'Email to classify:',
      'From: ' + (email.fromName || '') + ' <' + (email.fromEmail || '') + '>',
      'Subject: ' + (email.subject || ''),
      'Body: ' + (email.bodySnippet || ''),
    ].join('\n');

    var req = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    };

    // Retry with exponential backoff for rate limits (429)
    var resp = null;
    var maxRetries = 4;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        var waitMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s, 16s
        Logger.log('Rate limited — waiting ' + (waitMs / 1000) + 's (attempt ' + (attempt + 1) + '/' + (maxRetries + 1) + ')');
        Utilities.sleep(waitMs);
      }
      resp = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(req), muteHttpExceptions: true,
        headers: { 'Authorization': 'Bearer ' + apiKey },
      });
      if (resp.getResponseCode() !== 429) break;
    }

    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
      Logger.log('OpenAI API error: HTTP ' + resp.getResponseCode() + ' — ' + resp.getContentText());
      return null;
    }

    var raw = JSON.parse(resp.getContentText() || '{}');
    var text = raw && raw.choices && raw.choices[0] && raw.choices[0].message
      && raw.choices[0].message.content;
    if (!text) return null;

    var out = JSON.parse(text);
    if (!out) return null;

    if (!out.ticket) {
      return { ticket: false, reason: out.reason || 'not support' };
    }

    // Map AI type to CRM category
    var typeMap = {
      refund: 'returns', shipping: 'shipping', delay: 'order_status',
      address: 'shipping', defective: 'damage', sizing: 'sizing',
      'return': 'returns', chat: 'general', inquiry: 'general', general: 'general',
    };
    var category = typeMap[out.type] || 'general';
    var priority = out.priority || 'medium';
    if (['low','medium','high'].indexOf(priority) < 0) priority = 'medium';

    return { ticket: true, name: out.type || 'general', category: category, priority: priority };
  } catch (e) {
    Logger.log('OpenAI classification error: ' + e.message);
    return null;
  }
}

// ─── HELPERS ───

function getBodySnippet_(body, maxChars) {
  var s = String(body || '');
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

var _labelCache = {};
function ensureLabel_(name) {
  if (_labelCache[name]) return _labelCache[name];
  var lbl = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  _labelCache[name] = lbl;
  return lbl;
}

function extractEmail_(from) {
  var m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}

function extractName_(from) {
  var m = from.match(/^\s*([^<]+)/);
  return m ? m[1].trim().replace(/^\"|\"$/g, '') : '';
}

function myFunction() {
  kloIngestAuto();
}

/**
 * BACKFILL — Run this ONCE to strip all labels, then use kloBackfillContinue().
 *
 * What it does:
 *   1. Strips ALL KLO labels from emails in the last 60 days
 *   2. Runs one batch of ingestion (60-day window)
 *
 * After this, run kloBackfillContinue() for subsequent batches.
 * kloBackfillContinue() does NOT strip labels — it picks up where the last run left off.
 */
function kloBackfill() {
  var backfillDays = 60;

  // Get all KLO labels
  var labels = {
    ignored:   GmailApp.getUserLabelByName('KLO/Ignored'),
    ingested:  GmailApp.getUserLabelByName('KLO/Ingested'),
    processed: GmailApp.getUserLabelByName('KLO/Processed'),
    support:   GmailApp.getUserLabelByName('KLO/ToTicket/Support'),
    failed:    GmailApp.getUserLabelByName('KLO/IngestFailed'),
  };

  var resetCount = 0;
  var labelNames = ['ignored', 'ingested', 'processed', 'support', 'failed'];

  for (var n = 0; n < labelNames.length; n++) {
    var lbl = labels[labelNames[n]];
    if (!lbl) {
      Logger.log('Label KLO/' + labelNames[n] + ' not found — skipping');
      continue;
    }

    var q = 'to:contact@kloapparel.com newer_than:' + backfillDays + 'd label:' + lbl.getName();
    Logger.log('Stripping ' + lbl.getName() + ' — query: ' + q);
    var threads = GmailApp.search(q, 0, 500);
    Logger.log('Found ' + threads.length + ' threads with ' + lbl.getName());

    // Use batch removeLabel (100 at a time) — much faster and avoids Gmail rate limits
    for (var i = 0; i < threads.length; i += 100) {
      var batch = threads.slice(i, i + 100);
      lbl.removeFromThreads(batch);
      resetCount += batch.length;
      if (i + 100 < threads.length) Utilities.sleep(500);
    }
  }

  Logger.log('Backfill: stripped labels from ' + resetCount + ' threads total.');
  Logger.log('Now running first batch of ingestion...');

  // Run first batch
  kloBackfillContinue_();
}

/**
 * BACKFILL CONTINUE — Run this to continue processing after kloBackfill().
 *
 * Does NOT strip labels. Picks up unprocessed threads and continues.
 * Run repeatedly until log shows all threads processed.
 */
function kloBackfillContinue() {
  kloBackfillContinue_();
}

function kloBackfillContinue_() {
  var props = PropertiesService.getScriptProperties();
  var originalLookback = props.getProperty('KLO_LOOKBACK_DAYS') || '14';
  props.setProperty('KLO_LOOKBACK_DAYS', '60');

  try {
    kloIngestAuto();
    Logger.log('Backfill batch complete!');
  } finally {
    props.setProperty('KLO_LOOKBACK_DAYS', originalLookback);
    Logger.log('Restored KLO_LOOKBACK_DAYS to ' + originalLookback);
  }
}

/**
 * IMPORT GMAIL TEMPLATES — Run once to pull Gmail canned responses into the CRM.
 *
 * Tries two methods to find templates:
 *   1. Search for drafts with Gmail's TEMPLATE label
 *   2. Fall back to ALL drafts (logs each one for debugging)
 *
 * Duplicates (same title) are automatically skipped server-side.
 */
function kloImportGmailTemplates() {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = (props.getProperty('KLO_INBOUND_URL') || '').replace('/api/inbound/tickets', '');
  var inboundToken = props.getProperty('KLO_INBOUND_TOKEN');

  if (!baseUrl) throw new Error('Missing KLO_INBOUND_URL in script properties');

  var templates = [];
  var seen = {}; // dedup by subject

  // ─── Method 1: Gmail TEMPLATE label search ───
  try {
    var templateThreads = GmailApp.search('label:TEMPLATE', 0, 100);
    Logger.log('Method 1 — label:TEMPLATE search found ' + templateThreads.length + ' threads');
    for (var t = 0; t < templateThreads.length; t++) {
      var msgs = templateThreads[t].getMessages();
      if (!msgs || msgs.length === 0) continue;
      var msg = msgs[0];
      var subject = msg.getSubject() || '';
      var body = msg.getPlainBody ? msg.getPlainBody() : msg.getBody();
      if (!subject && !body) continue;
      var key = subject.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      templates.push({ title: subject || 'Untitled Template', body: String(body || '').trim(), category: 'general' });
      Logger.log('  TEMPLATE: "' + subject + '" (' + String(body || '').length + ' chars)');
    }
  } catch (e) {
    Logger.log('Method 1 failed (label:TEMPLATE not available): ' + e.message);
  }

  // ─── Method 2: All drafts — include everything (skip only empty) ───
  var drafts = GmailApp.getDrafts();
  Logger.log('Method 2 — scanning ' + drafts.length + ' drafts');
  var draftTemplates = 0;
  for (var i = 0; i < drafts.length; i++) {
    var msg = drafts[i].getMessage();
    var subject = msg.getSubject() || '';
    var body = msg.getPlainBody ? msg.getPlainBody() : msg.getBody();
    var to = msg.getTo() || '';

    Logger.log('  Draft ' + (i + 1) + ': "' + subject + '" | To: ' + (to || '(none)') + ' | Body: ' + String(body || '').length + ' chars');

    // Skip empty drafts
    if (!subject && !body) { Logger.log('    → skipped (empty)'); continue; }

    var key = subject.toLowerCase();
    if (seen[key]) { Logger.log('    → skipped (already found via Method 1)'); continue; }
    seen[key] = true;

    templates.push({ title: subject || 'Untitled Template', body: String(body || '').trim(), category: 'general' });
    draftTemplates++;
    Logger.log('    → ADDED as template');
  }
  Logger.log('Method 2 added ' + draftTemplates + ' drafts as templates');

  Logger.log('TOTAL templates found: ' + templates.length);

  if (templates.length === 0) {
    Logger.log('No templates found in Gmail.');
    Logger.log('Option A: Gmail → Compose → type template → three dots → Templates → Save draft as template, then re-run.');
    Logger.log('Option B: Go to your CRM app → Settings → Saved Reply Templates → + Add Reply to add them manually.');
    return;
  }

  // Bulk import to CRM
  var url = baseUrl + '/api/crm/saved-replies/bulk';
  Logger.log('POSTing ' + templates.length + ' templates to ' + url);
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ replies: templates }),
    muteHttpExceptions: true,
    headers: inboundToken ? { 'x-inbound-token': inboundToken } : {},
  });

  var code = resp.getResponseCode();
  if (code >= 200 && code < 300) {
    var result = JSON.parse(resp.getContentText());
    Logger.log('SUCCESS: Imported ' + result.imported + ' new templates (' + result.total + ' total saved replies in CRM)');
  } else {
    Logger.log('FAILED: HTTP ' + code + ' — ' + resp.getContentText());
  }
}
