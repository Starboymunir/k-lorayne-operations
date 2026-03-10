# Google Workspace → K.Lorayne Operations Tickets (No Subscription)

This app can **send** email via SMTP, but it does **not read your inbox** automatically.

To turn customer emails into tickets **without a monthly subscription**, use:
- **Gmail labels + filters** (to decide what becomes a ticket)
- A small **Google Apps Script** (free) that runs in the `contact@kloapparel.com` Google Workspace account
- The app’s inbound endpoint: `POST https://k-lorayne-operations.onrender.com/api/inbound/tickets`

## 1) Render: set an inbound token (recommended)

In Render → Service → Environment:
- Add `INBOUND_TOKEN` = a long random string
- Redeploy

This prevents anyone from creating tickets without the token.

## 2) Gmail: create labels

In the `contact@kloapparel.com` Gmail account, create labels:
- `KLO/ToTicket/Support`
- `KLO/ToTicket/Reviews`
- `KLO/Processed` (script will apply this after ingest)
- `KLO/Ingested` (script-owned marker so it knows what it already ingested)

## 3) Gmail: create filters (decide what becomes a ticket)

Important: With filters configured, **you do not manually label emails**. Gmail applies the labels automatically when emails arrive.
Manual labeling is only a backup for edge cases.

If you cannot get the exact sender examples yet (or the client is slow to respond), skip filters for now and use the **Script-only option** below.

### Support emails (customer questions/concerns)
Create a filter that matches your real support emails and applies label `KLO/ToTicket/Support`.

Common patterns:
- `to:contact@kloapparel.com` AND NOT from Shopify notification senders
- Exclude marketing/no-reply senders

### Review emails (needs a response)
Create a filter for your reviews provider (examples):
- From: `noreply@judge.me` / `support@stamped.io` / `noreply@yotpo.com` (depends on what you use)
Apply label `KLO/ToTicket/Reviews`.

### Exclude Shopify order notifications
Create a filter that matches Shopify notifications and **does not** apply the ToTicket labels.
Examples (adjust as needed):
- From contains `@shopify.com`
- Subject contains `New order` / `Order confirmation` / `You’ve received a new order`

## 4) Google Apps Script (free): watch labeled emails and POST tickets

### Create the script
1. Go to https://script.google.com/ while logged into `contact@kloapparel.com`
2. New project
3. Paste the code from the `Apps Script Code` section below
4. In **Project Settings** → add Script Properties:
   - `KLO_INBOUND_URL` = `https://k-lorayne-operations.onrender.com/api/inbound/tickets`
   - `KLO_INBOUND_TOKEN` = the Render `INBOUND_TOKEN`
   - `KLO_LABEL_SUPPORT` = `KLO/ToTicket/Support`
   - `KLO_LABEL_REVIEWS` = `KLO/ToTicket/Reviews`
   - `KLO_LABEL_PROCESSED` = `KLO/Processed`
   - `KLO_DEFAULT_ASSIGNEE` = `Krystle` (or `Showroom Manager`)

### Create a trigger
1. In Apps Script → Triggers
2. Add Trigger
3. Choose function: `kloIngest`
4. Event source: **Time-driven**
5. Type: **Minutes timer** → Every 1 minute (or Every 5 minutes if preferred)

### First run permissions
Run `kloIngest()` once manually. Google will prompt for permissions:
- Read Gmail
- Make external requests

## Apps Script Code

```javascript
/**
 * KLO Email → Ticket Ingest (Google Apps Script)
 * - Looks for Gmail threads with ToTicket labels
 * - Creates tickets in K.Lorayne Operations via HTTPS POST
 * - Adds a Processed label so the same email isn't re-ingested
 */

function kloIngest() {
  const props = PropertiesService.getScriptProperties();
  const inboundUrl = props.getProperty('KLO_INBOUND_URL');
  const inboundToken = props.getProperty('KLO_INBOUND_TOKEN');
  const labelSupport = props.getProperty('KLO_LABEL_SUPPORT') || 'KLO/ToTicket/Support';
  const labelReviews = props.getProperty('KLO_LABEL_REVIEWS') || 'KLO/ToTicket/Reviews';
  const labelProcessed = props.getProperty('KLO_LABEL_PROCESSED') || 'KLO/Processed';
  const defaultAssignee = props.getProperty('KLO_DEFAULT_ASSIGNEE') || 'Krystle';

  if (!inboundUrl) throw new Error('Missing script property KLO_INBOUND_URL');

  const processedLabel = ensureLabel_(labelProcessed);

  // Process both streams
  processLabel_(labelSupport, processedLabel, inboundUrl, inboundToken, {
    channel: 'email',
    category: 'general',
    priority: 'medium',
    assignee: defaultAssignee,
  });

  processLabel_(labelReviews, processedLabel, inboundUrl, inboundToken, {
    channel: 'email',
    category: 'general',
    priority: 'medium',
    assignee: defaultAssignee,
    subjectPrefix: '[REVIEW] ',
  });
}

function processLabel_(labelName, processedLabel, inboundUrl, inboundToken, defaults) {
  const label = GmailApp.getUserLabelByName(labelName);
  if (!label) return; // label doesn't exist; nothing to do

  // Limit work per run to avoid Apps Script quotas
  const threads = label.getThreads(0, 20);

  for (var i = 0; i < threads.length; i++) {
    const thread = threads[i];
    // Skip if already processed
    const alreadyProcessed = thread.getLabels().some(l => l.getName() === processedLabel.getName());
    if (alreadyProcessed) continue;

    const msgs = thread.getMessages();
    if (!msgs || msgs.length === 0) continue;

    // Use the first message in the thread as the ticket source
    const m = msgs[0];
    const from = m.getFrom() || '';
    const fromEmail = extractEmail_(from);
    const fromName = extractName_(from);

    const subject = (defaults.subjectPrefix || '') + (m.getSubject() || '(no subject)');
    const body = m.getPlainBody ? m.getPlainBody() : m.getBody();

    // Stable id for idempotency (prevents duplicates on retries)
    const externalId = m.getId();

    const payload = {
      externalId: externalId,
      fromName: fromName,
      fromEmail: fromEmail,
      createdAt: m.getDate && m.getDate() ? m.getDate().toISOString() : null,
      subject: subject,
      body: body,
      channel: defaults.channel,
      category: defaults.category,
      priority: defaults.priority,
      assignee: defaults.assignee,
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
      // Mark processed to prevent re-ingest
      thread.addLabel(processedLabel);
    } else {
      // Leave unprocessed so we can retry next run
      Logger.log('Failed to ingest thread. HTTP ' + code + ': ' + resp.getContentText());
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
```

## Notes / Limitations
- This creates tickets from **emails you label** as ToTicket; it will not create tickets for unlabeled emails.
- It runs on a timer (1–5 minutes). If you need instant ingestion, consider a paid automation plan.
- If the Render service is on a sleep tier, the first request after sleep may be slow; the script will retry next run.

---

# Script-only Option (No Gmail Filters Required)

Use this when you want to start immediately without waiting on the client for exact sender examples.

How it works:
- The script scans recent inbox mail addressed to `contact@kloapparel.com`.
- It automatically **ignores** common Shopify/system notifications.
- It classifies **review** provider emails using common provider domains.
- Everything else becomes a **Support** ticket.

This option does not require Gmail filters. It will add labels itself:
- `KLO/Processed` (ingested)
- `KLO/Ingested` (ingested; script-owned marker)
- `KLO/Ignored` (skipped as system notification)

## Script Properties (recommended)

Add the standard properties:
- `KLO_INBOUND_URL`
- `KLO_INBOUND_TOKEN`
- `KLO_DEFAULT_ASSIGNEE`

Optional tuning:
- `KLO_LOOKBACK_DAYS` (default 7)

## Optional: AI triage (recommended if filters are too brittle)

If Gmail filters are too hard to maintain, you can add an **AI triage** step that reads each email and applies the same labels you already use:
- `KLO/ToTicket/Support`
- `KLO/ToTicket/Reviews`

This is still “no subscription” (it’s just an API key), but it may be subject to free-tier quotas depending on Google’s current pricing.

Add Script Property:
- `KLO_GEMINI_API_KEY` = a key from Google AI Studio

Then use the updated script in [docs/apps-script/klo-gmail-ingest-auto.js](docs/apps-script/klo-gmail-ingest-auto.js).

## Apps Script Code (Script-only)

```javascript
function kloIngestAuto() {
  const props = PropertiesService.getScriptProperties();
  const inboundUrl = props.getProperty('KLO_INBOUND_URL');
  const inboundToken = props.getProperty('KLO_INBOUND_TOKEN');
  const defaultAssignee = props.getProperty('KLO_DEFAULT_ASSIGNEE') || 'Krystle';
  const lookbackDays = parseInt(props.getProperty('KLO_LOOKBACK_DAYS') || '7', 10);

  if (!inboundUrl) throw new Error('Missing script property KLO_INBOUND_URL');

  const processedLabel = ensureLabel_('KLO/Processed');
  const ignoredLabel = ensureLabel_('KLO/Ignored');

  // Search: mail to contact@, recent, not already processed/ignored.
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

    // Idempotency: stable message id
    const externalId = m.getId();

    // Ignore common Shopify/system notifications (best-effort defaults)
    const ignoreDomains = [
      'shopify.com',
      'shopifyemail.com',
      'email.shopify.com',
    ];
    const ignoreSubjectContains = [
      'new order',
      'order confirmation',
      'you\'ve received a new order',
      'your order is confirmed',
      'shipping confirmation',
      'delivery confirmation',
      'payment failed',
    ];

    if (domainMatches_(fromEmail, ignoreDomains) || containsAny_(subjectLower, ignoreSubjectContains)) {
      thread.addLabel(ignoredLabel);
      continue;
    }

    // Review providers (common domains; can be refined later)
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
```

## Trigger
- Run `kloIngestAuto()` once manually to authorize
- Add a time-driven trigger every 1–5 minutes

## Later refinement
Once you get real examples, refine the ignore/review domains and subject patterns so it’s exact.
