// Quick test: verify API connection works
import 'dotenv/config';
import { shopifyGraphQL, getShopDomain } from './auth.js';

async function testConnection() {
  console.log(`\nTesting connection to ${getShopDomain()}...\n`);

  try {
    const result = await shopifyGraphQL(`
      {
        shop {
          name
          email
          myshopifyDomain
          plan { displayName }
          currencyCode
        }
      }
    `);

    if (result.data?.shop) {
      const shop = result.data.shop;
      console.log('=== CONNECTION SUCCESSFUL ===');
      console.log(`Store Name:    ${shop.name}`);
      console.log(`Email:         ${shop.email}`);
      console.log(`Domain:        ${shop.myshopifyDomain}`);
      console.log(`Plan:          ${shop.plan?.displayName}`);
      console.log(`Currency:      ${shop.currencyCode}`);
      console.log('=============================\n');
    } else {
      console.error('Connection succeeded but no shop data returned:', result);
    }
  } catch (error) {
    console.error('CONNECTION FAILED:', error.message);
    console.error('\nPossible fixes:');
    console.error('1. Check .env credentials are correct');
    console.error('2. Make sure the app is installed on the store');
    console.error('3. Make sure scopes are set in the Dev Dashboard version');
  }
}

testConnection();
