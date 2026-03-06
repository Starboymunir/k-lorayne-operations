/**
 * KLO Gmail → Tickets (Auto Rules)
 *
 * Paste into https://script.google.com/ (logged into contact@kloapparel.com)
 * Configure Script Properties:
 * - KLO_INBOUND_URL = https://k-lorayne-operations.onrender.com/api/inbound/tickets
 * - KLO_INBOUND_TOKEN = <Render INBOUND_TOKEN>
 * - KLO_DEFAULT_ASSIGNEE = Krystle (or Showroom Manager)
 * - KLO_LOOKBACK_DAYS = 7
 */

function kloIngestAuto() {
  const props = PropertiesService.getScriptProperties();
  const inboundUrl = props.getProperty('KLO_INBOUND_URL');
  const inboundToken = props.getProperty('KLO_INBOUND_TOKEN');
  const defaultAssignee = props.getProperty('KLO_DEFAULT_ASSIGNEE') || 'Krystle';
  const lookbackDays = parseInt(props.getProperty('KLO_LOOKBACK_DAYS') || '7', 10);

  if (!inboundUrl) throw new Error('Missing script property KLO_INBOUND_URL');

  const processedLabel = ensureLabel_('KLO/Processed');
  const ignoredLabel = ensureLabel_('KLO/Ignored');

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
    const isReview = domainMatches_(fromEmail, reviewDomains) || (subjectLower.includes('review') && !subjectLower.includes('preview'));

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
