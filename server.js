require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EBAY_API_URL = 'https://api.ebay.com/ws/api.dll';
const {
  EBAY_APP_ID,
  EBAY_DEV_ID,
  EBAY_CERT_ID,
  EBAY_USER_TOKEN,
  PORT = 3000
} = process.env;

const EBAY_VERIFICATION_TOKEN = '7ab45f03b81598d67a1a5893a79e82de03914e64b8ada9f3fc23524b23aedba2';
const ENDPOINT_URL = 'https://ebay-tracker.onrender.com/ebay/account-deletion';

// ── eBay API call ────────────────────────────────────────────────────────────
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

// ── Fetch one page of orders ─────────────────────────────────────────────────
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

// ── Fetch ALL orders (handles pagination automatically) ──────────────────────
async function getAllOrders(daysBack) {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - daysBack);
  const createTimeFrom = from.toISOString();
  const createTimeTo = now.toISOString();

  // Page 1 first — gives us total page count
  const page1Result = await fetchPage(createTimeFrom, createTimeTo, 1);
  const resp1 = page1Result.GetOrdersResponse;

  if (!resp1) throw new Error('Invalid eBay API response');

  const ack = resp1.Ack;
  if (ack !== 'Success' && ack !== 'Warning') {
    const errors = resp1.Errors;
    const msg = Array.isArray(errors)
      ? errors.map(e => e.LongMessage).join('; ')
      : (errors && errors.LongMessage) || 'Unknown eBay API error';
    throw new Error('eBay API error: ' + msg);
  }

  const totalPages = parseInt((resp1.PaginationResult && resp1.PaginationResult.TotalNumberOfPages) || '1', 10);
  const totalEntries = parseInt((resp1.PaginationResult && resp1.PaginationResult.TotalNumberOfEntries) || '0', 10);
  console.log('eBay: ' + totalEntries + ' orders across ' + totalPages + ' pages');

  // Collect page 1 orders
  const allRaw = [];
  const p1orders = resp1.OrderArray && resp1.OrderArray.Order;
  if (p1orders) {
    const arr = Array.isArray(p1orders) ? p1orders : [p1orders];
    allRaw.push(...arr);
  }

  // Fetch remaining pages in parallel batches of 5
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
        const arr = Array.isArray(orders) ? orders : [orders];
        allRaw.push(...arr);
      }
    }
  }

  console.log('Total orders fetched: ' + allRaw.length);
  return allRaw;
}

// ── Determine real delivery status ───────────────────────────────────────────
// eBay's OrderStatus="Completed" just means PAYMENT is done, NOT delivery.
// We use actual shipping fields to determine the real status.
function getDeliveryStatus(order, transactions, allTracking) {
  const hasTrackingNumber = allTracking.some(t => t.trackingNumber && t.trackingNumber.length > 4);
  const hasShippedTime = !!(order.ShippedTime);

  // 1. Check transaction-level shipping status (most accurate when present)
  for (const tx of transactions) {
    const txShipStatus = tx.ShippingDetails && tx.ShippingDetails.ShippingStatus;
    if (txShipStatus === 'Delivered') return 'delivered';
    if (txShipStatus === 'Shipped' || txShipStatus === 'InTransit') {
      // Has a real tracking number = in transit; no tracking = shipped without tracking
      return hasTrackingNumber ? 'transit' : 'transit';
    }
  }

  // 2. Check order-level shipping status
  const orderShipStatus = order.ShippingDetails
    && order.ShippingDetails.ShippingServiceSelected
    && order.ShippingDetails.ShippingServiceSelected.ShippingStatus;
  if (orderShipStatus === 'Delivered') return 'delivered';
  if (orderShipStatus === 'Shipped' || orderShipStatus === 'InTransit') return 'transit';

  // 3. Fall back to tracking + ShippedTime heuristics
  if (hasTrackingNumber && hasShippedTime) {
    // Has tracking AND seller marked shipped — genuinely in transit
    return 'transit';
  }

  if (hasTrackingNumber && !hasShippedTime) {
    // Tracking number exists but seller hasn't marked shipped — label only
    return 'label';
  }

  if (hasShippedTime && !hasTrackingNumber) {
    // Marked shipped but no tracking (e.g. letter mail) — treat as transit
    return 'transit';
  }

  // 4. Nothing shipped yet
  return 'pending';
}

// ── Parse a raw eBay order object ────────────────────────────────────────────
function parseOrder(order) {
  const txArray = order.TransactionArray && order.TransactionArray.Transaction;
  const transactions = txArray ? (Array.isArray(txArray) ? txArray : [txArray]) : [];

  // Collect tracking from order-level ShippingDetails
  const allTracking = [];
  const shipmentArray = order.ShippingDetails && order.ShippingDetails.ShipmentTrackingDetails;
  const trackingEntries = shipmentArray ? (Array.isArray(shipmentArray) ? shipmentArray : [shipmentArray]) : [];
  trackingEntries.forEach(t => {
    if (t.ShipmentTrackingNumber) {
      allTracking.push({ carrier: t.ShippingCarrierUsed || 'Unknown', trackingNumber: t.ShipmentTrackingNumber });
    }
  });

  // Also collect from transaction-level ShippingDetails
  transactions.forEach(tx => {
    const txTracking = tx.ShippingDetails && tx.ShippingDetails.ShipmentTrackingDetails;
    if (txTracking) {
      const txArr = Array.isArray(txTracking) ? txTracking : [txTracking];
      txArr.forEach(t => {
        if (t.ShipmentTrackingNumber && !allTracking.find(x => x.trackingNumber === t.ShipmentTrackingNumber)) {
          allTracking.push({ carrier: t.ShippingCarrierUsed || 'Unknown', trackingNumber: t.ShipmentTrackingNumber });
        }
      });
    }
  });

  const deliveryStatus = getDeliveryStatus(order, transactions, allTracking);

  const items = transactions.map(tx => ({
    itemId: (tx.Item && tx.Item.ItemID) || '',
    title: (tx.Item && tx.Item.Title) || 'Unknown Item',
    quantity: parseInt(tx.QuantityPurchased || '1', 10),
    price: parseFloat((tx.TransactionPrice && tx.TransactionPrice._) || tx.TransactionPrice || '0'),
  }));

  const totalRaw = order.Total;
  return {
    orderId: order.OrderID || '',
    extendedOrderId: order.ExtendedOrderID || order.OrderID || '',
    createdDate: order.CreatedTime || '',
    orderStatus: order.OrderStatus || '',
    deliveryStatus: deliveryStatus,
    items: items,
    tracking: allTracking,
    totalAmount: parseFloat((totalRaw && totalRaw._) || totalRaw || '0'),
    currency: (totalRaw && totalRaw.$ && totalRaw.$.currencyID) || 'USD',
    seller: (transactions[0] && transactions[0].Seller && transactions[0].Seller.UserID) || '',
    paidTime: order.PaidTime || null,
    shippedTime: order.ShippedTime || null,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    configured: !!(EBAY_APP_ID && EBAY_DEV_ID && EBAY_CERT_ID && EBAY_USER_TOKEN),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/orders', async (req, res) => {
  try {
    if (!EBAY_USER_TOKEN) {
      return res.status(401).json({ error: 'EBAY_USER_TOKEN not configured in .env' });
    }
    const daysBack = parseInt(req.query.daysBack || '1', 10);
    const rawOrders = await getAllOrders(daysBack);
    const orders = rawOrders.map(parseOrder);
    const stats = {
      total: orders.length,
      delivered: orders.filter(o => o.deliveryStatus === 'delivered').length,
      transit: orders.filter(o => o.deliveryStatus === 'transit').length,
      label: orders.filter(o => o.deliveryStatus === 'label').length,
      pending: orders.filter(o => o.deliveryStatus === 'pending').length,
      totalSpent: orders.reduce((s, o) => s + o.totalAmount, 0).toFixed(2),
    };
    res.json({ orders, stats, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  const hash = crypto.createHash('sha256')
    .update(challengeCode + EBAY_VERIFICATION_TOKEN + ENDPOINT_URL)
    .digest('hex');
  res.json({ challengeResponse: hash });
});

app.post('/ebay/account-deletion', (req, res) => {
  console.log('eBay account deletion notification:', req.body);
  res.status(200).json({ acknowledged: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('\neBay Order Tracker running at http://localhost:' + PORT + '\n');
});
