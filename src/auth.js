// Auth module - uses offline access token from OAuth flow

const SHOP = process.env.SHOPIFY_SHOP;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!SHOP || !ACCESS_TOKEN) {
  throw new Error(
    'Missing env vars. Set SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN in .env'
  );
}

export async function getToken() {
  return ACCESS_TOKEN;
}

export function getShopDomain() {
  return `${SHOP}.myshopify.com`;
}

// GraphQL helper - makes authenticated requests to the Admin API
export async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getToken();
  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/api/2026-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`[graphql] Request failed (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  if (result.errors) {
    console.error('[graphql] Errors:', JSON.stringify(result.errors, null, 2));
  }

  return result;
}
