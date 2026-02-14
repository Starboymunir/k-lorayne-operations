import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const SHOP    = process.env.SHOPIFY_SHOP;          // e.g. k-lorayne-apparel
const KEY     = process.env.SHOPIFY_CLIENT_ID;
const SECRET  = process.env.SHOPIFY_CLIENT_SECRET;
const PORT    = 3456;
const REDIRECT = `http://localhost:${PORT}/callback`;

// Scopes that match your Dev Dashboard version
const SCOPES = [
  'read_customers', 'write_customers',
  'write_inventory', 'read_inventory',
  'read_locations',
  'read_orders',
  'read_products', 'write_products'
].join(',');

// Random nonce for CSRF protection
const nonce = crypto.randomBytes(16).toString('hex');

// ── Build the authorization URL ──────────────────────────────────────
const authUrl =
  `https://${SHOP}.myshopify.com/admin/oauth/authorize` +
  `?client_id=${KEY}` +
  `&scope=${SCOPES}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&state=${nonce}` +
  `&grant_options[]=per-user`;

// Remove per-user if you want an offline (permanent) token:
const authUrlOffline =
  `https://${SHOP}.myshopify.com/admin/oauth/authorize` +
  `?client_id=${KEY}` +
  `&scope=${SCOPES}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&state=${nonce}`;

// ── Start a tiny HTTP server to catch the callback ───────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/callback') {
    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const shop  = url.searchParams.get('shop');

    // Verify state matches our nonce
    if (state !== nonce) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('State mismatch — possible CSRF. Try again.');
      return;
    }

    console.log(`\n✓ Authorization code received from ${shop}`);
    console.log(`  Code: ${code}`);

    // ── Exchange the code for an access token ─────────────────────
    try {
      const tokenRes = await fetch(
        `https://${shop}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: KEY,
            client_secret: SECRET,
            code: code,
          }),
        }
      );

      const tokenBody = await tokenRes.text();

      if (!tokenRes.ok) {
        console.error(`\n✗ Token exchange failed (${tokenRes.status}):`);
        console.error(tokenBody);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Token exchange failed: ${tokenBody}`);
        server.close();
        return;
      }

      const tokenData = JSON.parse(tokenBody);
      console.log('\n════════════════════════════════════════════');
      console.log('  SUCCESS — Access Token Received!');
      console.log('════════════════════════════════════════════');
      console.log(`  Access Token : ${tokenData.access_token}`);
      console.log(`  Scope        : ${tokenData.scope}`);
      console.log('════════════════════════════════════════════');
      console.log('\n→ Copy the access token above and paste it into your .env file as:');
      console.log('  SHOPIFY_ACCESS_TOKEN=<token>');
      console.log('\nThis token does NOT expire (offline token).\n');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h1 style="color:green;">&#10003; Connected!</h1>
          <p>Access token received. Check your terminal.</p>
          <p>You can close this tab.</p>
        </body></html>
      `);
    } catch (err) {
      console.error('Token exchange error:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${err.message}`);
    }

    // Shut down after a short delay so the response gets sent
    setTimeout(() => server.close(), 1000);
    return;
  }

  // For any other route, redirect to the auth URL
  res.writeHead(302, { Location: authUrlOffline });
  res.end();
});

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Shopify OAuth — K-Lorayne Operations       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Server running on http://localhost:${PORT}     ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Open this URL in your browser:             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n${authUrlOffline}\n`);
  console.log('Make sure you are logged into the Shopify admin for');
  console.log(`${SHOP}.myshopify.com before clicking the link.\n`);
  console.log('Waiting for callback...\n');
});
