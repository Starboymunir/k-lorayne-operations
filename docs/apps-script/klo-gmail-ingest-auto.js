/**
 * KLO Gmail → Tickets (Auto Rules v2)
 *
 * Only creates tickets for REAL customer support emails about:
 *   refunds, shipping issues, order delays, address changes,
 *   defective/damaged items, wrong size/fit
 *
 * Everything else (ads, promos, newsletters, Shopify notifications) is ignored.
 *
 * Paste into https://script.google.com/ (logged into contact@kloapparel.com)
 * Configure Script Properties:
 * - KLO_INBOUND_URL = https://k-lorayne-operations.onrender.com/api/inbound/tickets
 * - KLO_INBOUND_TOKEN = <Render INBOUND_TOKEN>
 * - KLO_DEFAULT_ASSIGNEE = Krystle (or Showroom Manager)
 * - KLO_LOOKBACK_DAYS = 14
 *
 * Optional AI triage (improves accuracy):
 * - KLO_GEMINI_API_KEY = <Google AI Studio API key>
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
  var geminiApiKey = props.getProperty('KLO_GEMINI_API_KEY') || '';

  if (!inboundUrl) throw new Error('Missing script property KLO_INBOUND_URL');

  var ingestedLabel = ensureLabel_('KLO/Ingested');
  var failedLabel   = ensureLabel_('KLO/IngestFailed');
  var ignoredLabel  = ensureLabel_('KLO/Ignored');
  var supportLabel  = ensureLabel_('KLO/ToTicket/Support');

  // ─── DOMAINS TO ALWAYS IGNORE (ads, marketing, notifications) ───
  var IGNORE_DOMAINS = [
    // Shopify
    'shopify.com', 'shopifyemail.com', 'email.shopify.com', 'shopify.email',
    // Marketing / Newsletter platforms
    'mailchimp.com', 'mandrillapp.com', 'klaviyo.com', 'sendgrid.net', 'sendgrid.com',
    'omnisend.com', 'mailgun.org', 'mailgun.com', 'constantcontact.com',
    'hubspot.com', 'hubspotmail.com', 'sendinblue.com', 'brevo.com',
    'mailerlite.com', 'drip.com', 'convertkit.com', 'activecampaign.com',
    'getresponse.com', 'aweber.com', 'campaignmonitor.com', 'moosend.com',
    'flodesk.com', 'beehiiv.com', 'substack.com',
    // Social media notifications
    'facebookmail.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com',
    'pinterest.com', 'linkedin.com', 'youtube.com',
    // Payment processors (notifications, not customer messages)
    'paypal.com', 'stripe.com', 'squareup.com', 'afterpay.com',
    'klarna.com', 'affirm.com', 'sezzle.com',
    // Shipping carrier notifications
    'ups.com', 'fedex.com', 'usps.com', 'dhl.com', 'shipstation.com',
    'shippo.com', 'easypost.com', 'aftership.com', 'route.com',
    // Review platforms (not customer inquiries)
    'judge.me', 'stamped.io', 'yotpo.com', 'okendo.io', 'reviews.io', 'loox.io',
    // Google / system
    'google.com', 'googlemail.com', 'accounts.google.com',
    // Other common non-customer senders
    'notion.so', 'slack.com', 'zoom.us', 'calendly.com', 'canva.com',
    'godaddy.com', 'namecheap.com', 'render.com', 'github.com',
    'noreply.github.com', 'vercel.com', 'netlify.com',
  ];

  // ─── SUBJECT LINES TO ALWAYS IGNORE ───
  var IGNORE_SUBJECTS = [
    'new order', 'order confirmation', "you've received a new order",
    'your order is confirmed', 'shipping confirmation', 'delivery confirmation',
    'payment failed', 'payment received', 'payout', 'your payout',
    'newsletter', 'weekly digest', 'monthly recap', 'sale alert',
    'flash sale', 'limited time', 'discount code', 'promo code',
    'free shipping', 'shop now', 'buy now', 'deal of the day',
    'don\'t miss', 'last chance', 'expires today', 'act now',
    'unsubscribe', 'subscription confirmed', 'welcome to',
    'verify your email', 'confirm your email', 'password reset',
    'security alert', 'sign-in', 'login attempt',
    'invoice', 'receipt', 'statement', 'billing statement',
    'your shipment', 'tracking number', 'out for delivery', 'delivered',
  ];

  // ─── SUPPORT KEYWORDS — only emails matching these become tickets ───
  // Each group: { keywords: [...], category: 'crm_category', priority: 'low|medium|high' }
  var SUPPORT_RULES = [
    {
      name: 'refund',
      keywords: ['refund', 'money back', 'get my money', 'charge back', 'chargeback', 'dispute', 'cancel my order', 'cancel order', 'cancellation', 'want to cancel'],
      category: 'returns',
      priority: 'high',
    },
    {
      name: 'shipping',
      keywords: ['shipping', 'ship my order', 'not shipped', 'hasn\'t shipped', 'hasnt shipped', 'where is my order', 'where\'s my order', 'wheres my order', 'tracking', 'track my order', 'lost package', 'lost in transit', 'never received', 'didn\'t receive', 'didnt receive', 'not delivered', 'missing package', 'missing order', 'haven\'t received', 'havent received', 'still haven\'t got', 'still havent got', 'package lost', 'order lost', 'not arrived', 'hasn\'t arrived', 'hasnt arrived', 'never arrived', 'where is it', 'where\'s my package', 'not here yet'],
      category: 'shipping',
      priority: 'medium',
    },
    {
      name: 'delay',
      keywords: ['delay', 'delayed', 'taking too long', 'taking so long', 'still waiting', 'been waiting', 'how long', 'when will', 'when is my order', 'order status', 'update on my order', 'update on order', 'eta', 'expected delivery'],
      category: 'order_status',
      priority: 'medium',
    },
    {
      name: 'address',
      keywords: ['change address', 'change my address', 'wrong address', 'update address', 'update my address', 'change shipping', 'change delivery', 'new address', 'moved', 'ship to different', 'redirect', 'update my delivery', 'change my delivery', 'correct address', 'fix address', 'fix my address', 'delivery address', 'delivery info', 'shipping info', 'update shipping'],
      category: 'shipping',
      priority: 'high',
    },
    {
      name: 'defective',
      keywords: ['defective', 'damaged', 'broken', 'ripped', 'torn', 'stain', 'stained', 'hole', 'faulty', 'quality issue', 'poor quality', 'fell apart', 'falling apart', 'not as described', 'looks different', 'wrong item', 'wrong product', 'sent me the wrong', 'received wrong'],
      category: 'damage',
      priority: 'high',
    },
    {
      name: 'sizing',
      keywords: ['wrong size', 'too small', 'too big', 'too large', 'too tight', 'too loose', 'doesn\'t fit', 'doesnt fit', 'does not fit', 'didn\'t fit', 'didnt fit', 'size exchange', 'exchange size', 'exchange for', 'swap size', 'return for size', 'sizing', 'size chart', 'what size', 'which size', 'size guide', 'true to size', 'runs small', 'runs large', 'runs big'],
      category: 'sizing',
      priority: 'medium',
    },
    {
      name: 'return',
      keywords: ['return', 'returning', 'send back', 'send it back', 'return label', 'return policy', 'exchange', 'swap', 'replace', 'replacement'],
      category: 'returns',
      priority: 'medium',
    },
    {
      name: 'general_support',
      keywords: ['help with my order', 'need help', 'help me', 'customer service', 'support', 'question about my order', 'issue with my order', 'problem with my order', 'order issue', 'order problem', 'complaint', 'not happy', 'unhappy', 'disappointed', 'frustrated', 'urgent', 'asap', 'please help', 'can you help', 'reach out', 'reaching out', 'follow up', 'following up', 'i ordered', 'my order', 'order number', 'order #'],
      category: 'general',
      priority: 'medium',
    },
  ];

  // Search: emails to contact@, recent, NOT already processed or ignored
  var q = 'to:contact@kloapparel.com newer_than:' + lookbackDays + 'd -label:' + ingestedLabel.getName() + ' -label:' + ignoredLabel.getName();
  var threads = GmailApp.search(q, 0, 100);

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var msgs = thread.getMessages();
    if (!msgs || msgs.length === 0) continue;

    // Use the LATEST message in the thread (catches customer replies)
    var m = msgs[msgs.length - 1];
    var fromRaw = m.getFrom() || '';
    var fromEmail = extractEmail_(fromRaw).toLowerCase();
    var fromName = extractName_(fromRaw);
    var subjectRaw = m.getSubject() || '(no subject)';
    var subject = String(subjectRaw);
    var subjectLower = subject.toLowerCase();
    var body = m.getPlainBody ? m.getPlainBody() : m.getBody();
    var bodySnippet = getBodySnippet_(body, 2000);
    var textToScan = (subjectLower + ' ' + bodySnippet.toLowerCase());
    var externalId = m.getId();

    // ─── Step 0: Contact form submissions from Shopify — ALWAYS process ───
    var isContactForm = (subjectLower.indexOf('contact form') >= 0 ||
                         subjectLower.indexOf('contact us') >= 0 ||
                         subjectLower.indexOf('form submission') >= 0 ||
                         bodySnippet.toLowerCase().indexOf('contact form submission') >= 0 ||
                         bodySnippet.toLowerCase().indexOf('submitted from your online store') >= 0 ||
                         bodySnippet.toLowerCase().indexOf('message from your online store') >= 0);

    // ─── Step 1: Ignore known non-customer domains (but NOT contact forms) ───
    if (!isContactForm && domainMatches_(fromEmail, IGNORE_DOMAINS)) {
      thread.addLabel(ignoredLabel);
      continue;
    }

    // ─── Step 2: Ignore known automated/promo subject lines (but NOT contact forms) ───
    if (!isContactForm && containsAny_(subjectLower, IGNORE_SUBJECTS)) {
      thread.addLabel(ignoredLabel);
      continue;
    }

    // ─── Step 3: Ignore emails from own domain (internal) ───
    if (fromEmail.endsWith('@kloapparel.com') || fromEmail.endsWith('@klorayne.com')) {
      thread.addLabel(ignoredLabel);
      continue;
    }

    // ─── Step 4: Ignore likely marketing (common signals in body) ───
    var marketingSignals = ['unsubscribe', 'view in browser', 'view this email in', 'email preferences',
      'manage preferences', 'opt out', 'no longer wish to receive', 'update your preferences',
      'powered by klaviyo', 'powered by mailchimp', 'sent via', 'view online'];
    var marketingHits = 0;
    for (var ms = 0; ms < marketingSignals.length; ms++) {
      if (textToScan.indexOf(marketingSignals[ms]) >= 0) marketingHits++;
    }
    // If 2+ marketing signals AND no support keywords → ignore
    if (marketingHits >= 2 && !matchesSupportKeywords_(textToScan, SUPPORT_RULES)) {
      thread.addLabel(ignoredLabel);
      continue;
    }

    // ─── Step 5: Check if email matches a support category ───
    var matched = classifyByKeywords_(textToScan, SUPPORT_RULES);

    // ─── Step 6: Optional AI triage if no keyword match ───
    if (!matched && geminiApiKey) {
      var aiResult = classifyWithGemini_(geminiApiKey, {
        fromEmail: fromEmail,
        fromName: fromName,
        subject: subject,
        bodySnippet: bodySnippet,
      });
      if (aiResult) matched = aiResult;
    }

    // ─── Step 7: If still no match → check if contact form (auto-categorize) or IGNORE ───
    if (!matched) {
      if (isContactForm) {
        // Contact forms are always real customer messages — categorize as general support
        matched = { name: 'contact_form', category: 'general', priority: 'medium' };
      } else {
        thread.addLabel(ignoredLabel);
        continue;
      }
    }

    // ─── Step 8: This IS a support email — create the ticket ───
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
  }
}

// ─── KEYWORD CLASSIFICATION ───

function matchesSupportKeywords_(text, rules) {
  for (var i = 0; i < rules.length; i++) {
    for (var k = 0; k < rules[i].keywords.length; k++) {
      if (text.indexOf(rules[i].keywords[k]) >= 0) return true;
    }
  }
  return false;
}

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

// ─── AI TRIAGE (Gemini) ───

// Returns { category, priority } or null
function classifyWithGemini_(apiKey, email) {
  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(apiKey);

    var prompt = [
      'You triage emails for a clothing brand (contact@kloapparel.com).',
      'Decide if this is a REAL customer support inquiry or not.',
      '',
      'ONLY create a ticket for these issues:',
      '- refund: customer wants money back, cancellation, chargeback dispute',
      '- shipping: shipping problem, lost package, not delivered, tracking issues',
      '- delay: order taking too long, customer asking for status/ETA',
      '- address: customer wants to change shipping address',
      '- defective: damaged, broken, wrong item sent, quality issue',
      '- sizing: wrong size, doesn\'t fit, size exchange, sizing question',
      '- return: general return or exchange request',
      '',
      'IGNORE these (not a ticket):',
      '- Ads, promotions, newsletters, marketing emails',
      '- Automated Shopify/payment/shipping notifications',
      '- Spam, social media notifications',
      '- Internal emails, system emails',
      '',
      'Return ONLY JSON: {"ticket":true/false,"type":"refund|shipping|delay|address|defective|sizing|return","priority":"low|medium|high","reason":"..."}',
      'If not a ticket: {"ticket":false,"reason":"..."}',
      '',
      'Email:',
      'From: ' + (email.fromName || '') + ' <' + (email.fromEmail || '') + '>',
      'Subject: ' + (email.subject || ''),
      'Body: ' + (email.bodySnippet || ''),
    ].join('\n');

    var req = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    };

    var resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(req), muteHttpExceptions: true,
    });

    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) return null;

    var raw = JSON.parse(resp.getContentText() || '{}');
    var text = raw && raw.candidates && raw.candidates[0] && raw.candidates[0].content
      && raw.candidates[0].content.parts && raw.candidates[0].content.parts[0]
      && raw.candidates[0].content.parts[0].text;
    if (!text) return null;

    var out = JSON.parse(text);
    if (!out || !out.ticket) return null;

    // Map AI type to CRM category
    var typeMap = {
      refund: 'returns', shipping: 'shipping', delay: 'order_status',
      address: 'shipping', defective: 'damage', sizing: 'sizing', return: 'returns',
    };
    var category = typeMap[out.type] || 'general';
    var priority = out.priority || 'medium';
    if (['low','medium','high'].indexOf(priority) < 0) priority = 'medium';

    return { name: out.type || 'general', category: category, priority: priority };
  } catch (e) {
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

function domainMatches_(email, domains) {
  if (!email) return false;
  var at = email.lastIndexOf('@');
  var dom = at >= 0 ? email.slice(at + 1) : email;
  for (var i = 0; i < domains.length; i++) {
    var d = String(domains[i]).toLowerCase();
    if (dom === d || dom.endsWith('.' + d)) return true;
  }
  return false;
}

function containsAny_(haystackLower, needlesLower) {
  for (var i = 0; i < needlesLower.length; i++) {
    if (haystackLower.indexOf(String(needlesLower[i]).toLowerCase()) >= 0) return true;
  }
  return false;
}

function myFunction() {
  kloIngestAuto();
}

/**
 * BACKFILL — Run this ONCE to reset previously-ignored emails.
 * Removes BOTH KLO/Ignored AND KLO/Ingested labels from recent emails
 * so that kloIngestAuto() will fully re-evaluate them with updated rules.
 *
 * Steps:
 *   1. Open Apps Script → Run → kloBackfill
 *   2. Check Execution Log for the count of reset threads
 *   3. Then run kloIngestAuto (or wait for the trigger)
 */
function kloBackfill() {
  // Always look back 60 days for backfill — independent of KLO_LOOKBACK_DAYS
  var backfillDays = 60;

  var ignoredLabel = GmailApp.getUserLabelByName('KLO/Ignored');
  var ingestedLabel = GmailApp.getUserLabelByName('KLO/Ingested');
  var processedLabel = GmailApp.getUserLabelByName('KLO/Processed');

  var resetCount = 0;

  // Reset ignored threads
  if (ignoredLabel) {
    var q1 = 'to:contact@kloapparel.com newer_than:' + backfillDays + 'd label:' + ignoredLabel.getName().replace(/\//g, '-');
    Logger.log('Backfill search (ignored): ' + q1);
    var threads1 = GmailApp.search(q1, 0, 500);
    Logger.log('Found ' + threads1.length + ' ignored threads');
    for (var i = 0; i < threads1.length; i++) {
      threads1[i].removeLabel(ignoredLabel);
      if (processedLabel) { try { threads1[i].removeLabel(processedLabel); } catch(e) {} }
      resetCount++;
    }
  } else {
    Logger.log('No KLO/Ignored label found');
  }

  // Also reset ingested threads so they can be re-evaluated
  if (ingestedLabel) {
    var q2 = 'to:contact@kloapparel.com newer_than:' + backfillDays + 'd label:' + ingestedLabel.getName().replace(/\//g, '-');
    Logger.log('Backfill search (ingested): ' + q2);
    var threads2 = GmailApp.search(q2, 0, 500);
    Logger.log('Found ' + threads2.length + ' ingested threads');
    for (var j = 0; j < threads2.length; j++) {
      threads2[j].removeLabel(ingestedLabel);
      if (processedLabel) { try { threads2[j].removeLabel(processedLabel); } catch(e) {} }
      resetCount++;
    }
  } else {
    Logger.log('No KLO/Ingested label found');
  }

  Logger.log('Backfill complete: reset ' + resetCount + ' total threads. Run kloIngestAuto() next.');
}
