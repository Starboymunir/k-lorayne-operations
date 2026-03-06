# Krystle — Email → Tickets Setup (Google Workspace / Gmail)

Goal: Only the emails you choose (Support + Reviews) become tickets in K.Lorayne Operations.

## What you will do (in Gmail)

### Step 1 — Create the labels (yes, the label name includes the slashes)

1. Log into Gmail as `contact@kloapparel.com`
2. Click the gear icon → **See all settings**
3. Go to **Labels**
4. Create these labels:
   - `KLO/ToTicket/Support`
   - `KLO/ToTicket/Reviews`
   - `KLO/Processed`

Tip: In Gmail, slashes create “nested” labels automatically.

### Step 2 — Smooth workflow (recommended): Gmail auto-labels the right emails

The goal is: **you do NOT manually tag every email**.

Instead, Gmail filters automatically apply the labels as emails arrive. The script then turns those labeled emails into tickets.

#### 2A) Filter for Support tickets (customer questions/concerns)

1. Gmail → gear → **See all settings**
2. **Filters and Blocked Addresses** → **Create a new filter**
3. In the search fields, start with:
   - **To:** `contact@kloapparel.com`
4. Click **Create filter**
5. Check **Apply the label** → `KLO/ToTicket/Support`

Then, add exclusions so Shopify system notifications don’t become tickets. You can do this by editing the filter later and adding (examples):
- Exclude senders like `@shopify.com`
- Exclude subjects like “New order”, “Order confirmation”, “You’ve received a new order”

If you forward me 1 example Shopify notification email, I can tell you the exact “From/Subject” values to exclude.

#### 2B) Filter for Review tickets (needs a response)

1. Create another filter
2. **From:** put the review provider sender (example: `noreply@judge.me`, `support@stamped.io`, `noreply@yotpo.com`)
3. Apply label → `KLO/ToTicket/Reviews`

### Step 3 — Backup workflow (only for edge cases): label one email manually

If an email should become a ticket but didn’t match the filters:
- Open the email → Label → apply `KLO/ToTicket/Support` (or `KLO/ToTicket/Reviews`)

That’s only for exceptions, not the normal daily flow.

### If you don’t have examples yet (or want it working today)

We can skip Gmail filters entirely and use the **Script-only Auto Rules** setup.
It automatically ignores common Shopify notification emails and creates tickets for customer emails + review emails.
See: `docs/google-workspace-email-to-tickets.md` → “Script-only Option”.

## What Munir will do (one-time backend setup)

1. Ensure the app is deployed on Render with the email-ingestion endpoint enabled.
2. Set a secure token (so nobody can create tickets except your Gmail script): `INBOUND_TOKEN`.
3. Provide you a short Google Apps Script to paste (you just click Run once to authorize).

## How you will test (2 minutes)

1. Send an email to `contact@kloapparel.com` from your personal email with subject: `TEST SUPPORT TICKET`
2. Do **nothing** (don’t label it manually)
3. Wait 1–5 minutes
4. Open the app → Tickets → confirm a new ticket exists

If it doesn’t show up, that means the Support filter needs 1 tweak.

## Notes

- Shopify “new order” notifications should NOT be labeled `KLO/ToTicket/...`.
- The script will apply `KLO/Processed` after it creates a ticket, so the same email is not ingested twice.
