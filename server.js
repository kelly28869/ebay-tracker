require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ── Postgres (notes only) ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_notes (
      order_id TEXT PRIMARY KEY,
      note TEXT,
      saved_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}
initDb().catch(e => console.error('DB init error:', e.message));

async function saveNote(orderId, note) {
  if (!note || note.trim() === '') {
    delete notesStore[orderId];
    try { await pool.query('DELETE FROM order_notes WHERE order_id=$1', [orderId]); }
    catch(e) { console.error('deleteNote error:', e.message); }
  } else {
    notesStore[orderId] = { note, savedAt: new Date().toISOString() };
    try {
      await pool.query(
        `INSERT INTO order_notes (order_id, note, saved_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (order_id) DO UPDATE SET note=$2, saved_at=NOW()`,
        [orderId, note]
      );
    } catch(e) { console.error('saveNote error:', e.message); }
  }
}

// ── In-memory tracking status store (re-checked on every sync via USPS) ───────
let trackingStatusStore = {};

// ── In-memory notes cache (backed by Postgres) ────────────────────────────────
let notesStore = {};
async function loadNotesFromDb() {
  try {
    const r = await pool.query('SELECT * FROM order_notes');
    notesStore = {};
    r.rows.forEach(row => { notesStore[row.order_id] = { note: row.note, savedAt: row.saved_at }; });
    console.log(`Loaded ${r.rows.length} notes from DB`);
  } catch(e) { console.error('loadNotesFromDb error:', e.message); }
}
loadNotesFromDb();
const EBAY_API_URL = 'https://api.ebay.com/ws/api.dll';
const {
  EBAY_APP_ID,
  EBAY_DEV_ID,
  EBAY_CERT_ID,
  EBAY_USER_TOKEN,
  USPS_CLIENT_ID,
  USPS_CLIENT_SECRET,
  DASHBOARD_USERNAME = 'admin',
  DASHBOARD_PASSWORD,
  PORT = 3000
} = process.env;

const EBAY_VERIFICATION_TOKEN = '7ab45f03b81598d67a1a5893a79e82de03914e64b8ada9f3fc23524b23aedba2';
const ENDPOINT_URL = 'https://ebay-tracker.onrender.com/ebay/account-deletion';

// ── Password Protection ──────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.path === '/ebay/account-deletion') return next();
  if (!DASHBOARD_PASSWORD) {
    console.warn('WARNING: DASHBOARD_PASSWORD not set — dashboard is unprotected!');
    return next();
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="OrderRadar Dashboard"');
    return res.status(401).send('Authentication required');
  }
  const base64 = authHeader.slice(6);
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const [username, ...rest] = decoded.split(':');
  const password = rest.join(':');
  try {
    const validUser = crypto.timingSafeEqual(Buffer.from(username || ''), Buffer.from(DASHBOARD_USERNAME));
    const validPass = crypto.timingSafeEqual(Buffer.from(password || ''), Buffer.from(DASHBOARD_PASSWORD));
    if (validUser && validPass) return next();
  } catch(e) {}
  res.set('WWW-Authenticate', 'Basic realm="OrderRadar Dashboard"');
  return res.status(401).send('Invalid username or password');
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── eBay API ─────────────────────────────────────────────────────────────────
async function callEbayAPI(callName, bodyXml) {
  const headers = {
    'Content-Type': 'text/xml',
    'X-EBAY-API-SITEID': '0',
    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
    'X-EBAY-API-CALL-NAME': callName,
    'X-EBAY-API-APP-NAME': EBAY_APP_ID,
    'X-EBAY-API-DEV-NAME': EBAY_DEV_ID,
    'X-EBAY-API-CERT-NAME': EBAY_CERT_ID,
  };
  const response = await axios.post(EBAY_API_URL, bodyXml, { headers });
  return await xml2js.parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: false });
}

async function fetchPage(createTimeFrom, createTimeTo, page) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${EBAY_USER_TOKEN}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <CreateTimeFrom>${createTimeFrom}</CreateTimeFrom>
  <CreateTimeTo>${createTimeTo}</CreateTimeTo>
  <OrderRole>Buyer</OrderRole>
  <OrderStatus>All</OrderStatus>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
  return await callEbayAPI('GetOrders', xml);
}

async function getAllOrders(daysBack, fromDateStr, toDateStr) {
  let createTimeFrom, createTimeTo;
  if (fromDateStr && toDateStr) {
    createTimeFrom = fromDateStr;
    createTimeTo = toDateStr;
  } else {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - (daysBack || 1));
    createTimeFrom = from.toISOString();
    createTimeTo = now.toISOString();
  }

  // eBay only allows fetching orders from the last 90 days
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  if (new Date(createTimeFrom) < ninetyDaysAgo) {
    throw new Error('eBay only allows fetching orders from the last 90 days. Please select a more recent date range.');
  }

  const page1Result = await fetchPage(createTimeFrom, createTimeTo, 1);
  const resp1 = page1Result.GetOrdersResponse;
  if (!resp1) throw new Error('Invalid eBay API response');
  const ack = resp1.Ack;
  if (ack !== 'Success' && ack !== 'Warning') {
    const errors = resp1.Errors;
    const msg = Array.isArray(errors) ? errors.map(e => e.LongMessage).join('; ') : (errors && errors.LongMessage) || 'Unknown eBay API error';
    throw new Error('eBay API error: ' + msg);
  }

  const totalPages = parseInt((resp1.PaginationResult && resp1.PaginationResult.TotalNumberOfPages) || '1', 10);
  const totalEntries = parseInt((resp1.PaginationResult && resp1.PaginationResult.TotalNumberOfEntries) || '0', 10);
  console.log('eBay: ' + totalEntries + ' orders across ' + totalPages + ' pages');

  const allRaw = [];
  const p1orders = resp1.OrderArray && resp1.OrderArray.Order;
  if (p1orders) allRaw.push(...(Array.isArray(p1orders) ? p1orders : [p1orders]));

  if (totalPages > 1) {
    const remaining = [];
    for (let p = 2; p <= totalPages; p++) remaining.push(p);
    while (remaining.length > 0) {
      const batch = remaining.splice(0, 5);
      const results = await Promise.all(batch.map(p => fetchPage(createTimeFrom, createTimeTo, p)));
      for (const result of results) {
        const resp = result.GetOrdersResponse;
        if (!resp) continue;
        const orders = resp.OrderArray && resp.OrderArray.Order;
        if (!orders) continue;
        allRaw.push(...(Array.isArray(orders) ? orders : [orders]));
      }
    }
  }

  console.log('Total orders fetched: ' + allRaw.length);
  return allRaw;
}

function getDeliveryStatus(order, transactions, allTracking) {
  // Fast fallback from Trading API data only.
  // Ground-truth status comes from scrapeOrderPageStatus() called per-order on demand.
  // Rules mirror the eBay order page stepper logic:
  //   delivered → any explicit delivery confirmation
  //   transit   → tracking number exists (shipped, en route)
  //   pending   → paid but no tracking yet

  const hasTrackingNumber = allTracking.some(t => t.trackingNumber && t.trackingNumber.length > 4);

  // Explicit delivery signals from Trading API
  if (order.ActualDeliveryTime) return 'delivered';
  const orderShipStatus = order.ShippingDetails
    && order.ShippingDetails.ShippingServiceSelected
    && order.ShippingDetails.ShippingServiceSelected.ShippingStatus;
  if (orderShipStatus === 'Delivered') return 'delivered';
  for (const tx of transactions) {
    const s = tx.ShippingDetails && tx.ShippingDetails.ShippingStatus;
    if (s === 'Delivered') return 'delivered';
  }

  if (hasTrackingNumber) return 'transit';
  return 'pending';
}

// ── Check order status via eBay Fulfillment REST API ─────────────────────────
// The REST API returns lineItemFulfillmentStatus = "FULFILLED" when delivered.
// This is what eBay's own purchase history page reads — far more reliable than
// the Trading API fields (ActualDeliveryTime is often null even after delivery).
//
// Status rules:
//   delivered → any lineItem has fulfillmentStatus = "FULFILLED"
//   transit   → has tracking number but not fulfilled
//   pending   → no tracking yet
// Delivery date:
//   delivered → blank
//   transit/pending → estimatedDeliveryDate from fulfillment spans
async function scrapeOrderPageStatus(orderId) {
  if (!EBAY_USER_TOKEN) return null;

  try {
    // eBay Fulfillment API v1 — uses same User Token as Bearer auth
    const restResp = await axios.get(
      `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`,
      {
        headers: {
          'Authorization': `Bearer ${EBAY_USER_TOKEN}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
        timeout: 10000,
        validateStatus: s => s < 500,
      }
    );

    if (restResp.status === 200 && restResp.data) {
      const order = restResp.data;
      console.log('Fulfillment API order', orderId, '→ fulfillmentStartInstructions:', JSON.stringify(order.fulfillmentStartInstructions || []).slice(0, 200));

      // lineItems[].lineItemFulfillmentStatus: "NOT_STARTED" | "IN_PROGRESS" | "FULFILLED"
      const lineItems = order.lineItems || [];
      const allFulfilled = lineItems.length > 0 && lineItems.every(li => li.lineItemFulfillmentStatus === 'FULFILLED');
      const anyFulfilled = lineItems.some(li => li.lineItemFulfillmentStatus === 'FULFILLED');

      // Estimated delivery from fulfillmentStartInstructions
      let estimatedDelivery = null;
      const instructions = order.fulfillmentStartInstructions || [];
      for (const inst of instructions) {
        const span = inst.maxEstimatedDeliveryDate || inst.minEstimatedDeliveryDate;
        if (span) {
          try {
            const minD = inst.minEstimatedDeliveryDate
              ? new Date(inst.minEstimatedDeliveryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : null;
            const maxD = inst.maxEstimatedDeliveryDate
              ? new Date(inst.maxEstimatedDeliveryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : null;
            estimatedDelivery = (minD && maxD && minD !== maxD) ? `${minD} – ${maxD}` : (maxD || minD);
          } catch {}
          break;
        }
      }

      // Also check shipping fulfillments for tracking
      const fulfillments = order.fulfillments || [];
      const hasTracking = fulfillments.some(f => f.trackingNumber && f.trackingNumber.length > 4)
        || lineItems.some(li => li.lineItemFulfillmentStatus !== 'NOT_STARTED');

      if (anyFulfilled) {
        console.log('Order', orderId, '→ DELIVERED (Fulfillment API)');
        return { status: 'delivered', deliveryDate: null };
      }
      if (hasTracking) {
        console.log('Order', orderId, '→ TRANSIT, est:', estimatedDelivery);
        return { status: 'transit', deliveryDate: estimatedDelivery };
      }
      console.log('Order', orderId, '→ PENDING, est:', estimatedDelivery);
      return { status: 'pending', deliveryDate: estimatedDelivery };
    }

    // Fulfillment API failed (404 = order not found, 401 = auth issue)
    // Fall back to Trading API GetOrders with OrderID
    console.log('Fulfillment API returned', restResp.status, 'for order', orderId, '— falling back to Trading API');
    return await checkStatusViaTradingAPI(orderId);

  } catch (err) {
    console.error('scrapeOrderPageStatus error for', orderId, ':', err.message);
    // Try Trading API fallback
    return await checkStatusViaTradingAPI(orderId);
  }
}

// ── Trading API fallback for order status ─────────────────────────────────────
async function checkStatusViaTradingAPI(orderId) {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${EBAY_USER_TOKEN}</eBayAuthToken></RequesterCredentials>
  <OrderIDArray><OrderID>${orderId}</OrderID></OrderIDArray>
  <OrderRole>Buyer</OrderRole>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

    const result = await callEbayAPI('GetOrders', xml);
    const resp = result.GetOrdersResponse;
    if (!resp || (resp.Ack !== 'Success' && resp.Ack !== 'Warning')) return null;

    const orderArr = resp.OrderArray && resp.OrderArray.Order;
    const order = orderArr ? (Array.isArray(orderArr) ? orderArr[0] : orderArr) : null;
    if (!order) return null;

    const txArray = order.TransactionArray && order.TransactionArray.Transaction;
    const txs = txArray ? (Array.isArray(txArray) ? txArray : [txArray]) : [];

    // Collect all tracking
    const allTracking = [];
    const shipArr = order.ShippingDetails && order.ShippingDetails.ShipmentTrackingDetails;
    if (shipArr) (Array.isArray(shipArr) ? shipArr : [shipArr]).forEach(t => {
      if (t.ShipmentTrackingNumber) allTracking.push(t);
    });
    txs.forEach(tx => {
      const tt = tx.ShippingDetails && tx.ShippingDetails.ShipmentTrackingDetails;
      if (tt) (Array.isArray(tt) ? tt : [tt]).forEach(t => {
        if (t.ShipmentTrackingNumber && !allTracking.find(x => x.ShipmentTrackingNumber === t.ShipmentTrackingNumber))
          allTracking.push(t);
      });
    });
    const hasTracking = allTracking.some(t => t.ShipmentTrackingNumber && t.ShipmentTrackingNumber.length > 4);

    // Delivery signals
    let delivered = false;
    if (order.ActualDeliveryTime) delivered = true;
    const oSS = order.ShippingDetails && order.ShippingDetails.ShippingServiceSelected && order.ShippingDetails.ShippingServiceSelected.ShippingStatus;
    if (oSS === 'Delivered') delivered = true;
    for (const tx of txs) {
      if (tx.ShippingDetails && tx.ShippingDetails.ShippingStatus === 'Delivered') delivered = true;
    }

    // Estimated delivery from ShippingMaxTime/MinTime
    const svc = order.ShippingDetails && order.ShippingDetails.ShippingServiceSelected;
    let estimatedDelivery = null;
    if (svc) {
      const fmt = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
      const minS = fmt(svc.ShippingMinTime), maxS = fmt(svc.ShippingMaxTime);
      if (minS && maxS && minS !== maxS) estimatedDelivery = `${minS} – ${maxS}`;
      else estimatedDelivery = maxS || minS;
    }

    if (delivered) return { status: 'delivered', deliveryDate: null };
    if (hasTracking) return { status: 'transit', deliveryDate: estimatedDelivery };
    return { status: 'pending', deliveryDate: estimatedDelivery };

  } catch (err) {
    console.error('checkStatusViaTradingAPI error:', err.message);
    return null;
  }
}

// ── Debug endpoint: returns raw HTML snippet around stepper icons ─────────────
// Call GET /api/debug-order?orderId=XXX to see what eBay actually returns
async function debugOrderPage(orderId) {
  const out = {};
  // 1. Trading API — dump entire raw order
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${EBAY_USER_TOKEN}</eBayAuthToken></RequesterCredentials>
  <OrderIDArray><OrderID>${orderId}</OrderID></OrderIDArray>
  <OrderRole>Buyer</OrderRole>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
    const result = await callEbayAPI('GetOrders', xml);
    const resp = result.GetOrdersResponse;
    const orderArr = resp && resp.OrderArray && resp.OrderArray.Order;
    const order = orderArr ? (Array.isArray(orderArr) ? orderArr[0] : orderArr) : null;
    out.tradingAPI = {
      ack: resp && resp.Ack,
      rawOrder: order, // full dump so we can see every field
    };
  } catch(err) {
    out.tradingAPIError = err.message;
  }
  // 2. Fulfillment REST API
  try {
    const restResp = await axios.get(
      `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`,
      {
        headers: {
          'Authorization': `Bearer ${EBAY_USER_TOKEN}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
        timeout: 10000,
        validateStatus: s => true,
      }
    );
    out.fulfillmentAPI = {
      status: restResp.status,
      data: restResp.data,
    };
  } catch(err) {
    out.fulfillmentAPIError = err.message;
  }
  return out;
}

function parseOrder(order) {
  const txArray = order.TransactionArray && order.TransactionArray.Transaction;
  const transactions = txArray ? (Array.isArray(txArray) ? txArray : [txArray]) : [];

  const allTracking = [];
  const shipmentArray = order.ShippingDetails && order.ShippingDetails.ShipmentTrackingDetails;
  const trackingEntries = shipmentArray ? (Array.isArray(shipmentArray) ? shipmentArray : [shipmentArray]) : [];
  trackingEntries.forEach(t => {
    if (t.ShipmentTrackingNumber) allTracking.push({ carrier: t.ShippingCarrierUsed || 'Unknown', trackingNumber: t.ShipmentTrackingNumber });
  });
  transactions.forEach(tx => {
    const txTracking = tx.ShippingDetails && tx.ShippingDetails.ShipmentTrackingDetails;
    if (txTracking) {
      const txArr = Array.isArray(txTracking) ? txTracking : [txTracking];
      txArr.forEach(t => {
        if (t.ShipmentTrackingNumber && !allTracking.find(x => x.trackingNumber === t.ShipmentTrackingNumber))
          allTracking.push({ carrier: t.ShippingCarrierUsed || 'Unknown', trackingNumber: t.ShipmentTrackingNumber });
      });
    }
  });

  const deliveryStatus = getDeliveryStatus(order, transactions, allTracking);

  // Resolve seller from multiple possible locations in eBay API response
  let seller = '';
  for (const tx of transactions) {
    // tx.Seller.UserID is the main location
    const s = tx.Seller;
    if (s && (s.UserID || s.SellerID)) {
      seller = s.UserID || s.SellerID;
      break;
    }
  }
  if (!seller && order.SellerUserID) seller = order.SellerUserID;
  if (!seller && order.Seller && order.Seller.UserID) seller = order.Seller.UserID;
  // ExtendedOrderID format: "12345678901234!sellerusername" on some API versions
  if (!seller && order.ExtendedOrderID && order.ExtendedOrderID.includes('!')) {
    seller = order.ExtendedOrderID.split('!')[1] || '';
  }
  // Log so you can see what the raw response looks like for debugging
  if (!seller && transactions.length > 0) {
    console.log('DEBUG seller missing, tx keys:', Object.keys(transactions[0]));
    if (transactions[0].Seller) console.log('DEBUG Seller node:', JSON.stringify(transactions[0].Seller));
  }

  const items = transactions.map(tx => ({
    itemId: (tx.Item && tx.Item.ItemID) || '',
    title: (tx.Item && tx.Item.Title) || 'Unknown Item',
    quantity: parseInt(tx.QuantityPurchased || '1', 10),
    price: parseFloat((tx.TransactionPrice && tx.TransactionPrice._) || tx.TransactionPrice || '0'),
    seller: (tx.Seller && (tx.Seller.UserID || tx.Seller.SellerID)) || seller || '',
  }));

  const totalRaw = order.Total;
  const totalQuantity = items.reduce((sum, i) => sum + (i.quantity || 1), 0);
  return {
    orderId: order.OrderID || '',
    extendedOrderId: order.ExtendedOrderID || order.OrderID || '',
    createdDate: order.CreatedTime || '',
    orderStatus: order.OrderStatus || '',
    deliveryStatus,
    items,
    totalQuantity,
    tracking: allTracking,
    totalAmount: parseFloat((totalRaw && totalRaw._) || totalRaw || '0'),
    currency: (totalRaw && totalRaw.$ && totalRaw.$.currencyID) || 'USD',
    seller,
    paidTime: order.PaidTime || null,
    shippedTime: order.ShippedTime || null,
    actualDeliveryTime: order.ActualDeliveryTime || null,
    checkoutStatus: (order.CheckoutStatus && order.CheckoutStatus.Status) || null,
  };
}

// ── USPS OAuth token cache ────────────────────────────────────────────────────
let uspsToken = null, uspsTokenExpiry = 0;

async function getUspsToken() {
  if (uspsToken && Date.now() < uspsTokenExpiry - 60000) return uspsToken;
  const resp = await axios.post(
    'https://apis.usps.com/oauth2/v3/token',
    { client_id: USPS_CLIENT_ID, client_secret: USPS_CLIENT_SECRET, grant_type: 'client_credentials' },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  uspsToken = resp.data.access_token;
  uspsTokenExpiry = Date.now() + (parseInt(resp.data.expires_in) * 1000);
  console.log('USPS token obtained, expires in', resp.data.expires_in, 's');
  return uspsToken;
}

// ── USPS Tracking API v3 ──────────────────────────────────────────────────────
async function scrapeCarrierStatus(carrier, trackingNumber) {
  const url = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  let status = 'unknown', delivered = false, deliveryDate = null;

  if (!USPS_CLIENT_ID || !USPS_CLIENT_SECRET) {
    console.log('No USPS_CLIENT_ID / USPS_CLIENT_SECRET configured');
    return { status, delivered, deliveryDate, url, carrier, trackingNumber };
  }

  try {
    const token = await getUspsToken();
    const resp = await axios.get(
      `https://apis.usps.com/tracking/v3/tracking/${encodeURIComponent(trackingNumber)}?expand=DETAIL`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        timeout: 10000,
      }
    );
    const data = resp.data;
    console.log('USPS tracking FULL response for', trackingNumber, ':', JSON.stringify(data));

    const eventType = (data.eventType || '').toUpperCase();
    const category  = (data.statusCategory || '').toUpperCase();

    if (eventType === 'DELIVERED' || category === 'DELIVERED') {
      status = 'delivered';
      delivered = true;
      // Extract date from statusSummary e.g. "...at 2:54 pm on February 9, 2026 in..."
      const match = (data.statusSummary || '').match(/on\s+([A-Za-z]+ \d+,\s*\d{4})/i);
      if (match) {
        try {
          deliveryDate = new Date(match[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch {}
      }
    } else if (category === 'PRE-SHIPMENT' || category === 'PRE_SHIPMENT') {
      status = 'pending';
    } else if (eventType || data.expectedDeliveryDate || category) {
      status = 'transit';
      if (data.expectedDeliveryDate) {
        try {
          deliveryDate = new Date(data.expectedDeliveryDate)
            .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch {}
      }
    }

  } catch (err) {
    console.error('USPS API error for', trackingNumber, ':', err.message);
    if (err.response) console.error('USPS response:', JSON.stringify(err.response.data || '').slice(0, 300));
    status = 'error';
  }

  return { status, delivered, deliveryDate, url, carrier, trackingNumber };
}
// ── Check if we already messaged a seller (GetMemberMessages) ────────────────

async function checkIfMessagedSeller(sellerIds, daysBack = 30) {
  // sellerIds can be a single string or array
  const sellers = Array.isArray(sellerIds) ? sellerIds : [sellerIds];
  const sellersLower = sellers.map(s => s.toLowerCase());
  const results = {};
  sellers.forEach(s => { results[s] = { messaged: false, messages: [] }; });

  const endTime = new Date().toISOString();
  const startTime = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMemberMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${EBAY_USER_TOKEN}</eBayAuthToken></RequesterCredentials>
  <MailMessageType>All</MailMessageType>
  <StartCreationTime>${startTime}</StartCreationTime>
  <EndCreationTime>${endTime}</EndCreationTime>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
</GetMemberMessagesRequest>`;

    try {
      const result = await callEbayAPI('GetMemberMessages', xml);
      const resp = result.GetMemberMessagesResponse;
      if (!resp || (resp.Ack !== 'Success' && resp.Ack !== 'Warning')) {
        const errors = resp && resp.Errors;
        const msg = Array.isArray(errors)
          ? errors.map(e => e.LongMessage || e.ShortMessage).join('; ')
          : (errors && (errors.LongMessage || errors.ShortMessage)) || 'Unknown error';
        console.error('GetMemberMessages error:', msg);
        break;
      }

      // Get total pages
      const pag = resp.PaginationResult;
      if (pag && pag.TotalNumberOfPages) {
        totalPages = parseInt(pag.TotalNumberOfPages, 10);
      }

      // Parse messages — structure varies, handle both shapes
      const memberMsgs = resp.MemberMessage;
      if (!memberMsgs) { page++; continue; }
      const msgArray = Array.isArray(memberMsgs) ? memberMsgs : [memberMsgs];

      for (const msg of msgArray) {
        // Could be nested under MemberMessageExchange or directly on the node
        const exchange = msg.MemberMessageExchange || msg;
        const question = exchange.Question || exchange;

        // Collect all possible recipient fields
        const recipientId = question.RecipientID
          || (exchange.RecipientID)
          || (question.Recipient && question.Recipient.UserID);
        const senderId = question.SenderID
          || (question.Sender && question.Sender.UserID);
        const body = question.Body || '';
        const subject = question.Subject || '';
        const creationDate = question.CreationDate || exchange.CreationDate || '';
        const itemId = (question.Item && question.Item.ItemID)
          || (exchange.Item && exchange.Item.ItemID) || '';

        // Check if any of our target sellers match the recipient
        const recipientLower = (recipientId || '').toLowerCase();
        const senderLower = (senderId || '').toLowerCase();

        for (let i = 0; i < sellersLower.length; i++) {
          if (recipientLower === sellersLower[i] || senderLower === sellersLower[i]) {
            results[sellers[i]].messaged = true;
            results[sellers[i]].messages.push({
              sender: senderId || null,
              recipient: recipientId || null,
              subject: subject || null,
              bodyPreview: typeof body === 'string' ? body.slice(0, 150) : null,
              date: creationDate || null,
              itemId: itemId || null,
            });
          }
        }
      }
    } catch (err) {
      console.error('GetMemberMessages page', page, 'error:', err.message);
      break;
    }

    page++;
    // Safety cap — don't go beyond 10 pages
    if (page > 10) break;
  }

  return results;
}

// Single seller check
app.get('/api/check-message', async (req, res) => {
  const { sellerId, daysBack } = req.query;
  if (!sellerId) return res.status(400).json({ error: 'sellerId required' });
  if (!EBAY_USER_TOKEN) return res.status(401).json({ error: 'EBAY_USER_TOKEN not configured' });

  try {
    const results = await checkIfMessagedSeller(sellerId, parseInt(daysBack || '30', 10));
    const result = results[sellerId];
    res.json({
      sellerId,
      messaged: result.messaged,
      messageCount: result.messages.length,
      messages: result.messages,
    });
  } catch (err) {
    console.error('check-message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Bulk check — POST body: { sellerIds: ["seller1","seller2",...], daysBack: 30 }
app.post('/api/check-messages', async (req, res) => {
  const { sellerIds, daysBack } = req.body;
  if (!sellerIds || !Array.isArray(sellerIds) || sellerIds.length === 0) {
    return res.status(400).json({ error: 'sellerIds array required' });
  }
  if (!EBAY_USER_TOKEN) return res.status(401).json({ error: 'EBAY_USER_TOKEN not configured' });

  try {
    const results = await checkIfMessagedSeller(sellerIds, parseInt(daysBack || '30', 10));
    res.json(results);
  } catch (err) {
    console.error('check-messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    configured: !!(EBAY_APP_ID && EBAY_DEV_ID && EBAY_CERT_ID && EBAY_USER_TOKEN),
    timestamp: new Date().toISOString(),
  });
});

// ── Server-side order cache ───────────────────────────────────────────────────
let orderCache = null;
let orderCacheExpiry = 0;
const ORDER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(daysBack, fromDate, toDate) {
  // Normalize: if requesting ~89 days worth of data, use a stable key
  if (fromDate && toDate) {
    const diffMs = new Date(toDate) - new Date(fromDate);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays >= 85) return 'full89';
  }
  if (daysBack >= 85) return 'full89';
  if (fromDate && toDate) return `${fromDate.slice(0,10)}|${toDate.slice(0,10)}`;
  return `days:${daysBack}`;
}

app.get('/api/orders', async (req, res) => {
  try {
    if (!EBAY_USER_TOKEN) return res.status(401).json({ error: 'EBAY_USER_TOKEN not configured in .env' });
    const { fromDate, toDate } = req.query;
    const daysBack = parseInt(req.query.daysBack || '1', 10);
    const cacheKey = getCacheKey(daysBack, fromDate, toDate);

    if (orderCache && orderCache.key === cacheKey && Date.now() < orderCacheExpiry) {
      console.log('Serving orders from cache (' + cacheKey + ')');
      return res.json(orderCache.data);
    }

    const rawOrders = await getAllOrders(daysBack, fromDate, toDate);
    const orders = rawOrders.map(parseOrder);
    const stats = {
      total: orders.length,
      delivered: orders.filter(o => o.deliveryStatus === 'delivered').length,
      transit: orders.filter(o => o.deliveryStatus === 'transit').length,
      label: 0,
      pending: orders.filter(o => o.deliveryStatus === 'pending').length,
      totalSpent: orders.reduce((s, o) => s + o.totalAmount, 0).toFixed(2),
    };
    const responseData = { orders, stats, fetchedAt: new Date().toISOString() };

    orderCache = { key: cacheKey, data: responseData };
    orderCacheExpiry = Date.now() + ORDER_CACHE_TTL;
    console.log('Orders cached (' + cacheKey + ') for 5 min');

    res.json(responseData);
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Scrape eBay order page stepper for ground-truth status ───────────────────
// Called when user clicks the order number in the dashboard.
// Returns { status } based on the stepper SVG icons on the eBay order page.
app.get('/api/order-status', async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const result = await scrapeOrderPageStatus(orderId);
    if (!result || result.status === null) {
      return res.json({ status: 'unknown', deliveryDate: null, message: 'Could not read eBay order page' });
    }
    res.json({ status: result.status, deliveryDate: result.deliveryDate || null, orderId });
  } catch (err) {
    res.status(500).json({ error: err.message, status: 'error' });
  }
});

// ── Debug endpoint: inspect raw eBay order page ──────────────────────────────
app.get('/api/debug-order', async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  const result = await debugOrderPage(orderId);
  res.json(result);
});

// ── Debug: see raw HTML from carrier tracking page ───────────────────────────
app.get('/api/debug-tracking', async (req, res) => {
  const { trackingNumber } = req.query;
  if (!trackingNumber) return res.status(400).json({ error: 'trackingNumber required' });
  try {
    const r = await axios.get(
      `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Referer': 'https://www.usps.com/',
        },
        timeout: 10000,
      }
    );
    const html = r.data;
    res.json({
      length: html.length,
      hasDelivered: html.includes('Your item was delivered'),
      hasExpected: html.includes('Expected Delivery by'),
      first1000: html.slice(0, 1000),
      // Search for the key phrases with surrounding context
      deliveredContext: (() => { const i = html.indexOf('Your item was delivered'); return i >= 0 ? html.slice(i-50, i+100) : null; })(),
      expectedContext: (() => { const i = html.indexOf('Expected Delivery by'); return i >= 0 ? html.slice(i-50, i+100) : null; })(),
    });
  } catch(err) {
    res.json({ error: err.message });
  }
});

// ── Debug: see raw AfterShip response for a tracking number ──────────────────
app.get('/api/debug-ship24', async (req, res) => {
  const { trackingNumber } = req.query;
  if (!trackingNumber) return res.status(400).json({ error: 'trackingNumber required' });
  if (!USPS_CLIENT_ID || !USPS_CLIENT_SECRET) return res.status(400).json({ error: 'USPS_CLIENT_ID / USPS_CLIENT_SECRET not set' });
  try {
    const token = await getUspsToken();
    const resp = await axios.get(
      `https://apis.usps.com/tracking/v3/tracking/${encodeURIComponent(trackingNumber)}?expand=DETAIL`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }, timeout: 10000 }
    );
    res.json(resp.data);
  } catch(err) {
    res.json({ error: err.message, response: err.response?.data });
  }
});

// ── Check real delivery status by scraping carrier page ───────────────────────
// Called when user clicks a tracking number in the dashboard.
// Returns { status, delivered, url } so frontend can update the row.
app.get('/api/check-tracking', async (req, res) => {
  const { carrier, trackingNumber } = req.query;
  if (!carrier || !trackingNumber) return res.status(400).json({ error: 'carrier and trackingNumber required' });
  try {
    const result = await scrapeCarrierStatus(carrier, trackingNumber);
    // Auto-save confirmed statuses to persistent store
    if (result.status === 'delivered' || result.status === 'transit') {
      trackingStatusStore[trackingNumber] = {
        status: result.status,
        deliveryDate: result.deliveryDate || null,
        carrier,
        savedAt: new Date().toISOString(),
      };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, status: 'error' });
  }
});

// ── Tracking statuses (in-memory only, re-checked on every sync) ──────────────
app.get('/api/tracking-statuses', (req, res) => {
  res.json(trackingStatusStore);
});

app.delete('/api/tracking-statuses', (req, res) => {
  trackingStatusStore = {};
  res.json({ ok: true, cleared: true });
});

app.post('/api/tracking-statuses', (req, res) => {
  const { trackingNumber, status, deliveryDate, carrier } = req.body;
  if (!trackingNumber || !status) return res.status(400).json({ error: 'trackingNumber and status required' });
  trackingStatusStore[trackingNumber] = { status, deliveryDate: deliveryDate || null, carrier: carrier || '', savedAt: new Date().toISOString() };
  res.json({ ok: true });
});

// ── Notes ─────────────────────────────────────────────────────────────────────
app.get('/api/notes', (req, res) => {
  res.json(notesStore);
});

app.post('/api/notes', async (req, res) => {
  const { orderId, note } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  await saveNote(orderId, note);
  res.json({ ok: true });
});

app.get('/api/tracking-url', (req, res) => {
  const { carrier, trackingNumber } = req.query;
  if (!carrier || !trackingNumber) return res.status(400).json({ error: 'carrier and trackingNumber required' });
  const c = (carrier || '').toUpperCase();
  let url = 'https://www.ebay.com/orders';
  if (c.includes('UPS')) url = 'https://www.ups.com/track?tracknum=' + trackingNumber;
  else if (c.includes('FEDEX')) url = 'https://www.fedex.com/apps/fedextrack/?tracknumbers=' + trackingNumber;
  else if (c.includes('USPS')) url = 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + trackingNumber;
  else if (c.includes('DHL')) url = 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + trackingNumber;
  res.json({ url });
});

app.get('/ebay/account-deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  const hash = crypto.createHash('sha256').update(challengeCode + EBAY_VERIFICATION_TOKEN + ENDPOINT_URL).digest('hex');
  res.json({ challengeResponse: hash });
});

app.post('/ebay/account-deletion', (req, res) => {
  console.log('eBay account deletion notification:', req.body);
  res.status(200).json({ acknowledged: true });
});

app.get('*', (req, res) => {
  // Only fall back to index.html for non-file routes (SPA routing)
  // Let express.static handle actual files like sellers.html
  const filePath = path.join(__dirname, 'public', req.path);
  if (req.path.includes('.')) {
    // Has an extension — try to serve the file, 404 if not found
    res.sendFile(filePath, err => {
      if (err) res.status(404).send('Not found');
    });
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log('\neBay Order Tracker running at http://localhost:' + PORT);
  if (!DASHBOARD_PASSWORD) console.log('WARNING: Set DASHBOARD_PASSWORD in .env!');
  else console.log('Dashboard is password protected.');
  console.log('');
});
