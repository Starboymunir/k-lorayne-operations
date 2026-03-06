/**
 * KLO Gmail → Tickets (Auto Rules)
 *
 * Paste into https://script.google.com/ (logged into contact@kloapparel.com)
 * Configure Script Properties:
 * - KLO_INBOUND_URL = https://k-lorayne-operations.onrender.com/api/inbound/tickets
 * - KLO_INBOUND_TOKEN = <Render INBOUND_TOKEN>
 * - KLO_DEFAULT_ASSIGNEE = Krystle (or Showroom Manager)
 * - KLO_LOOKBACK_DAYS = 7
 *
 * Optional AI triage (no subscription; uses an API key and may have a free tier/quota):
 * - KLO_GEMINI_API_KEY = <Google AI Studio API key>
 */

function kloIngestAuto() {
  const props = PropertiesService.getScriptProperties();
  const inboundUrl = props.getProperty('KLO_INBOUND_URL');
  const inboundToken = props.getProperty('KLO_INBOUND_TOKEN');
  const defaultAssignee = props.getProperty('KLO_DEFAULT_ASSIGNEE') || 'Krystle';
  const lookbackDays = parseInt(props.getProperty('KLO_LOOKBACK_DAYS') || '7', 10);
  const geminiApiKey = props.getProperty('KLO_GEMINI_API_KEY') || '';

  if (!inboundUrl) throw new Error('Missing script property KLO_INBOUND_URL');

  const processedLabel = ensureLabel_('KLO/Processed');
  const ignoredLabel = ensureLabel_('KLO/Ignored');
  const supportLabel = ensureLabel_('KLO/ToTicket/Support');
  const reviewsLabel = ensureLabel_('KLO/ToTicket/Reviews');

  const q = `to:contact@kloapparel.com newer_than:${lookbackDays}d -label:"${processedLabel.getName()}" -label:"${ignoredLabel.getName()}"`;
  const threads = GmailApp.search(q, 0, 30);

  for (var i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const msgs = thread.getMessages();
    if (!msgs || msgs.length === 0) continue;

    const m = msgs[0];
    const fromRaw = m.getFrom() || '';
    const fromEmail = extractEmail_(fromRaw).toLowerCase();
    const fromName = extractName_(fromRaw);
    const subjectRaw = m.getSubject() || '(no subject)';
    const subject = String(subjectRaw);
    const subjectLower = subject.toLowerCase();
    const body = m.getPlainBody ? m.getPlainBody() : m.getBody();
    const bodySnippet = getBodySnippet_(body, 2000);

    const externalId = m.getId();

    const ignoreDomains = [
      'shopify.com',
      'shopifyemail.com',
      'email.shopify.com',
    ];
    const ignoreSubjectContains = [
      'new order',
      'order confirmation',
      "you've received a new order",
      'your order is confirmed',
      'shipping confirmation',
      'delivery confirmation',
      'payment failed',
    ];

    if (domainMatches_(fromEmail, ignoreDomains) || containsAny_(subjectLower, ignoreSubjectContains)) {
      thread.addLabel(ignoredLabel);
      continue;
    }

    const reviewDomains = [
      'judge.me',
      'stamped.io',
      'yotpo.com',
      'okendo.io',
      'reviews.io',
      'loox.io',
    ];
    // If the thread is already labeled, respect that.
    const threadLabelNames = thread.getLabels().map(l => l.getName());
    const alreadySupport = threadLabelNames.indexOf(supportLabel.getName()) >= 0;
    const alreadyReviews = threadLabelNames.indexOf(reviewsLabel.getName()) >= 0;

    // Default classification: known review providers.
    var triage = alreadyReviews ? 'reviews' : (alreadySupport ? 'support' : null);
    if (!triage) {
      const isKnownReview = domainMatches_(fromEmail, reviewDomains) || (subjectLower.includes('review') && !subjectLower.includes('preview'));
      if (isKnownReview) triage = 'reviews';
    }

    // Optional AI triage (only if we still don't know)
    if (!triage && geminiApiKey) {
      const aiLabel = classifyWithGemini_(geminiApiKey, {
        fromEmail: fromEmail,
        fromName: fromName,
        subject: subject,
        bodySnippet: bodySnippet,
      });
      if (aiLabel) triage = aiLabel;
    }

    // If still unknown, fall back to Support (safer than missing inquiries)
    if (!triage) triage = 'support';

    // Apply labels so the inbox reflects the decision
    if (triage === 'ignore') {
      thread.addLabel(ignoredLabel);
      continue;
    }
    if (triage === 'reviews') thread.addLabel(reviewsLabel);
    if (triage === 'support') thread.addLabel(supportLabel);

    const isReview = triage === 'reviews';

    const payload = {
      externalId: externalId,
      fromName: fromName,
      fromEmail: fromEmail,
      subject: isReview ? `[REVIEW] ${subject}` : subject,
      body: body,
      channel: 'email',
      category: 'general',
      priority: 'medium',
      assignee: defaultAssignee,
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      headers: inboundToken ? { 'x-inbound-token': inboundToken } : {},
    };

    const resp = UrlFetchApp.fetch(inboundUrl, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      thread.addLabel(processedLabel);
    } else {
      Logger.log('Failed ingest HTTP ' + code + ': ' + resp.getContentText());
    }
  }
}

function getBodySnippet_(body, maxChars) {
  const s = String(body || '');
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

// Returns one of: 'support' | 'reviews' | 'ignore' | null
function classifyWithGemini_(apiKey, email) {
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + encodeURIComponent(apiKey);

    const prompt = [
      'You are triaging emails for a clothing brand support inbox (contact@kloapparel.com).',
      'Decide which Gmail label to apply:',
      '- support: customer inquiry that needs a support reply (address change, order status, return, exchange, sizing, shipping, cancellation, payment issues, etc)',
      '- reviews: review-provider email that needs a response (Judge.me / Stamped / Yotpo etc)',
      '- ignore: automated notification, marketing/newsletter, internal system email, or spam that should NOT become a support ticket',
      '',
      'Rules:',
      '- Shopify order notifications (new order / order confirmation / shipping confirmation) are ignore.',
      '- If unsure between support vs ignore, choose support.',
      '',
      'Return ONLY JSON like: {"label":"support|reviews|ignore","confidence":0.0,"reason":"..."}',
      '',
      'Email:',
      'From: ' + (email.fromName ? (email.fromName + ' ') : '') + '<' + (email.fromEmail || '') + '>',
      'Subject: ' + (email.subject || ''),
      'Body (snippet): ' + (email.bodySnippet || ''),
    ].join('\n');

    const req = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    };

    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(req),
      muteHttpExceptions: true,
    });

    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) return null;

    const raw = JSON.parse(resp.getContentText() || '{}');
    const text = raw && raw.candidates && raw.candidates[0] && raw.candidates[0].content && raw.candidates[0].content.parts && raw.candidates[0].content.parts[0] && raw.candidates[0].content.parts[0].text;
    if (!text) return null;

    const out = JSON.parse(text);
    const label = out && out.label ? String(out.label).toLowerCase() : '';
    if (label === 'support' || label === 'reviews' || label === 'ignore') return label;
    return null;
  } catch (e) {
    return null;
  }
}

function ensureLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function extractEmail_(from) {
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}

function extractName_(from) {
  const m = from.match(/^\s*([^<]+)/);
  return m ? m[1].trim().replace(/^\"|\"$/g, '') : '';
}

function domainMatches_(email, domains) {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  const dom = at >= 0 ? email.slice(at + 1) : email;
  for (var i = 0; i < domains.length; i++) {
    const d = String(domains[i]).toLowerCase();
    if (dom === d || dom.endsWith('.' + d)) return true;
  }
  return false;
}

function containsAny_(haystackLower, needlesLower) {
  for (var i = 0; i < needlesLower.length; i++) {
    if (haystackLower.includes(String(needlesLower[i]).toLowerCase())) return true;
  }
  return false;
}

// Apps Script defaults the Run button to `myFunction` in new projects.
// Keeping this wrapper avoids the "Script function not found: myFunction" error.
function myFunction() {
  kloIngestAuto();
}
