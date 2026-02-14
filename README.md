# K.Lorayne Apparel — CRM Dashboard

## How to Start

### Easy Way (Recommended)
**Double-click `start.bat`** — this will start the server and open the dashboard in your browser automatically.

> **Important:** Keep the black command window open while you're using the dashboard. Closing it will stop the server.

### Manual Way
1. Open a terminal/command prompt in this folder
2. Run: `node src/server.js`
3. Open your browser and go to: **http://localhost:3456**

## First-Time Setup

If this is the first time running on a new computer:

1. **Install Node.js** — Download from [https://nodejs.org/](https://nodejs.org/) (choose the LTS version)
2. **Install dependencies** — Open a terminal in this folder and run: `npm install`
3. Then double-click `start.bat`

The `start.bat` script will handle step 2 automatically if you haven't done it yet.

## What Happens When You Start

1. The server starts immediately so you can begin browsing
2. Products and orders load first (takes ~10 seconds)
3. Customer data loads in the background — you'll see a loading bar showing progress
4. Once all data is loaded, everything is cached for fast browsing

## Pages

| Page | What It Shows |
|------|--------------|
| **Dashboard** | Overview of revenue, orders, customers, alerts |
| **Inventory** | Full stock view with velocity and status labels |
| **Replenishment** | Purchase order list — what to reorder and how much |
| **Alerts** | Critical/urgent stock alerts that need attention |
| **Orders** | All orders with payment and fulfillment status |
| **Customers** | Customer list with spending tiers and risk levels |
| **Tickets** | Support ticket management system |
| **Analytics** | Charts and reports for tickets, revenue, segments |
| **Settings** | Configure SLA times, saved replies, categories |

## Label Meanings

### Customer Tiers
- **VIP** — Spent $500+ or placed 10+ orders
- **LOYAL** — Spent $200+ or placed 5+ orders
- **REPEAT** — Placed 2+ orders
- **1-TIME** — Placed exactly 1 order
- **NEW** — No orders yet

### Customer Risk
- **High Risk** — No orders in 120+ days (may be lost)
- **Medium Risk** — No orders in 60-120 days (needs attention)
- **No Risk** — Ordered recently

### Inventory Status
- **CRITICAL** — Out of stock with proven sales (losing revenue)
- **URGENT** — Less than 14 days of stock left
- **REORDER** — Below safety stock level
- **WATCH** — Getting low, monitor this week
- **OK** — Well stocked

### Sales Velocity
- **FAST MOVER** — 10+ units sold per month
- **REGULAR** — 3-9 units per month
- **SLOW MOVER** — Under 3 units per month
- **NO SALES** — Zero sales in the reporting period

## Troubleshooting

- **"Cannot connect" in browser** — Make sure the black command window is still open and running
- **Data looks empty** — Wait a moment, data is being fetched from Shopify. Check if the loading bar shows progress
- **Port already in use** — Close any other running instances first (close the black command window), then try again
