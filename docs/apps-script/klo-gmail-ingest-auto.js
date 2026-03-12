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

  // In backfill mode, don't use -label: exclusions (Gmail index lags after label removal)
  var backfillMode = props.getProperty('KLO_BACKFILL_MODE') === 'true';
  var q = 'to:contact@kloapparel.com newer_than:' + lookbackDays + 'd';
  if (!backfillMode) {
    q += ' -label:' + ingestedLabel.getName() + ' -label:' + ignoredLabel.getName();
  }
  var batchSize = backfillMode ? 500 : 100;
  var threads = GmailApp.search(q, 0, batchSize);
  Logger.log('Found ' + threads.length + ' threads to process (backfill=' + backfillMode + ')');
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
    var bodySnippet = getBodySnippet_(body, 1500);
    var externalId = m.getId();

    Logger.log('[' + (i + 1) + '/' + threads.length + '] "' + subject + '" from ' + fromEmail);

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
  }
  Logger.log('Done: ' + ticketed + ' ticketed, ' + ignored + ' ignored, ' + skipped + ' skipped out of ' + threads.length + ' threads.');
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
      'Your job: read this email and decide if it needs a support ticket or not.',
      'DEFAULT TO CREATING A TICKET. When in doubt, CREATE a ticket. Only ignore things that are clearly automated noise with no customer involved.',
      '',
      'ALWAYS CREATE A TICKET for:',
      '- ANY message from a real customer (order questions, complaints, inquiries, anything)',
      '- Shopify Inbox customer chat messages (subject like "New customer message" or "New message from...")',
      '- A customer asking about their order (status, shipping, delivery)',
      '- A customer wanting a refund, cancellation, or chargeback dispute',
      '- A customer reporting a damaged, defective, or wrong item',
      '- A customer wanting to return or exchange something',
      '- A customer asking about sizing or fit',
      '- A customer wanting to change their shipping address',
      '- Contact form submissions from the website',
      '- ANY message that a human might need to read and respond to',
      '- Shopify chargeback/dispute notifications',
      '- Shopify refund requests',
      '- Anything where a customer is trying to reach the store',
      '',
      'ONLY ignore these (clearly automated noise with NO customer action needed):',
      '- Order confirmation emails ("You have a new order #1234", "Order confirmed")',
      '- Shipping label created notifications',
      '- Payout/deposit notifications',
      '- Marketing emails, newsletters, promos from OTHER brands',
      '- Social media notifications (Facebook, Instagram, TikTok)',
      '- Payment processor receipts (Stripe, PayPal)',
      '- Carrier tracking updates (USPS, FedEx, UPS) that are just status updates',
      '- Review request emails (Judge.me, Yotpo asking customer to leave review)',
      '- Password reset / verify email / security alerts',
      '- Spam',
      '- Shopify billing, invoices, subscription emails (store owner admin)',
      '- App install/remove notifications',
      '',
      'IMPORTANT RULES:',
      '- "New customer message" from Shopify = ALWAYS a ticket (customer is chatting)',
      '- "Contact form submission" = ALWAYS a ticket',
      '- If a real person wrote something, it\'s a ticket',
      '- Shopify Support Chat updates (from Shopify support TO the store owner) = NOT a ticket',
      '- When in doubt, CREATE THE TICKET',
      '',
      'Return ONLY valid JSON:',
      'If ticket: {"ticket":true,"type":"refund|shipping|delay|address|defective|sizing|return|chat|general","priority":"low|medium|high","reason":"brief explanation"}',
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
      'return': 'returns', chat: 'general', general: 'general',
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

function ensureLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
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
 * BACKFILL — Run this ONCE to reset ALL labels and re-ingest everything.
 *
 * What it does:
 *   1. Strips KLO/Ignored, KLO/Ingested, KLO/Processed, KLO/ToTicket/Support
 *      from ALL emails in the last 60 days
 *   2. Automatically runs ingestion (60-day window) so tickets appear in the app
 *
 * Just run kloBackfill — that's it. No need to run kloIngestAuto after.
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

    // GmailApp.search uses the label name as-is (with slashes)
    var q = 'to:contact@kloapparel.com newer_than:' + backfillDays + 'd label:' + lbl.getName();
    Logger.log('Stripping ' + lbl.getName() + ' — query: ' + q);
    var threads = GmailApp.search(q, 0, 500);
    Logger.log('Found ' + threads.length + ' threads with ' + lbl.getName());

    for (var i = 0; i < threads.length; i++) {
      threads[i].removeLabel(lbl);
      resetCount++;
    }
  }

  Logger.log('Backfill: stripped labels from ' + resetCount + ' threads total.');
  Logger.log('Now running ingestion with 60-day lookback...');

  // Temporarily override lookback to 60 days and run ingestion
  var props = PropertiesService.getScriptProperties();
  var originalLookback = props.getProperty('KLO_LOOKBACK_DAYS') || '14';
  props.setProperty('KLO_LOOKBACK_DAYS', '60');
  props.setProperty('KLO_BACKFILL_MODE', 'true');

  try {
    // Process in batches to stay within Apps Script 6-minute limit
    kloIngestAuto();
    Logger.log('Backfill ingestion complete!');
  } finally {
    // Restore original settings
    props.setProperty('KLO_LOOKBACK_DAYS', originalLookback);
    props.deleteProperty('KLO_BACKFILL_MODE');
    Logger.log('Restored KLO_LOOKBACK_DAYS to ' + originalLookback);
  }
}
