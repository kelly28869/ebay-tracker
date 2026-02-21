# OrderRadar — eBay Buyer Order Tracking Dashboard

A real-time dashboard that pulls **all your eBay purchases**, order numbers,
tracking numbers, and delivery status — auto-synced from the eBay API.

---

## ⚡ Quick Start (5 minutes)

### Step 1 — Install Node.js
Download from https://nodejs.org (LTS version)

### Step 2 — Install dependencies
```bash
cd ebay-tracker
npm install
```

### Step 3 — Get eBay API credentials

1. Go to **https://developer.ebay.com** and sign in (create account if needed — it's free)
2. Click **"My Account" → "Application Keys"**
3. Create a new app (Keyset type: **Production**)
4. Copy your **App ID**, **Dev ID**, and **Cert ID**

### Step 4 — Get your User Token

This is the key step that authorizes the app to read YOUR purchase history.

1. On the Application Keys page, click **"User Tokens"** next to your Production keyset
2. Click **"Get a User Token"**
3. Sign in with your **buyer eBay account** (the one you buy hundreds of items from)
4. Copy the full token (starts with `AgAAAA**...`)

> **Token lifetime**: ~18 months. The app will tell you when it expires.

### Step 5 — Configure .env

```bash
cp .env.example .env
```

Open `.env` and fill in:
```
EBAY_APP_ID=YourAppID-Production
EBAY_DEV_ID=YourDevID
EBAY_CERT_ID=YourCertID-Production
EBAY_USER_TOKEN=AgAAAA**AQAAAA**...your-full-token
```

### Step 6 — Run

```bash
node server.js
```

Open **http://localhost:3000** in your browser.

---

## 📦 What it does

| Feature | Details |
|---|---|
| **Order sync** | Fetches all your eBay purchases for today, 3 days, 7 days, or 90 days |
| **Order ID** | Shows the full eBay order number (ExtendedOrderID) |
| **Tracking #** | Pulls tracking directly from eBay — no separate carrier API needed |
| **Carrier** | UPS, FedEx, USPS, DHL — clicking a tracking number opens the carrier's site |
| **Status** | Delivered / In Transit / Label Created / Pending |
| **Search** | Filter by order ID, item name, seller, or tracking number |
| **CSV Export** | One-click export of all visible orders |
| **Auto-refresh** | Click Sync or select a different time range |

---

## 🔌 API Used

This uses eBay's **Trading API — `GetOrders`** with `OrderRole=Buyer`.

This is the correct endpoint for buyer purchase history. The REST Fulfillment API
(`/sell/fulfillment/v1/order`) only works for sellers, not buyers.

**Endpoint**: `https://api.ebay.com/ws/api.dll`  
**Call**: `GetOrders`  
**Auth**: Auth'n'Auth User Token with buyer scope  
**Returns**: Order ID, item titles, seller, tracking numbers, carrier, status, amounts

---

## 🚀 Running in Production (always-on)

To run 24/7 on a server or your machine:

```bash
# Install PM2 process manager
npm install -g pm2

# Start the app
pm2 start server.js --name ebay-tracker

# Auto-start on reboot
pm2 startup
pm2 save
```

Access from any device on your network: `http://YOUR-MACHINE-IP:3000`

---

## 🔧 Troubleshooting

| Problem | Fix |
|---|---|
| `EBAY_USER_TOKEN not configured` | Check your `.env` file is saved and has no extra spaces |
| `eBay API error: Invalid token` | Re-generate your user token at developer.ebay.com |
| `Empty orders array` | Token might be for wrong account, or no orders in selected date range |
| `Cannot reach backend` | Make sure `node server.js` is running |

---

## 📁 File Structure

```
ebay-tracker/
├── server.js          ← Node.js backend (Express + eBay API)
├── package.json       ← Dependencies
├── .env.example       ← Credentials template
├── .env               ← Your actual credentials (never commit this!)
├── public/
│   └── index.html     ← The dashboard UI
└── README.md
```
