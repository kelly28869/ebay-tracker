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

// ── eBay API call helper ─────────────────────────────────────────────────────
async function callEbayTradingAPI(callName, bodyXml) {
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
  const parsed = await xml2js.parseStringPromise(response.data, {
    explicitArray: false,
    ignoreAttrs: false,
  });
  return parsed;
}

// ── Fetch a single page of orders ───────────────────────────────────────────
async function fetchOrderPage(createTimeFrom, createTimeTo, page) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${EBAY_USER_TOKEN}</eBayAuthToken>
  </RequesterCredentials>
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
  return await callEbayTradingAPI('GetOrders', xml);
}

// ── Fetch ALL orders across all pages ───────────────────────────────────────
// eBay max is 100 per page, so we paginate automatically
async function getAllBuyerOrders(daysBack) {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - daysBack);
  const createTimeFrom = from.toISOString();
  const createTimeTo = now.toISOString();

  // Page 1 — also tells us total number of pages
  const page1 = await fetchOrderPage(createTimeFrom, createTimeTo, 1);
  const response1 = page1.GetOrdersResponse;

  if (!response1) throw new Error('Invalid eBay API response');
  const ack = response1.Ack;
  if (ack !== 'Success' && ack !== 'Warning') {
    const errors = response1.Errors;
    const msg = Array.isArray(errors)
      ? errors.map(e => e.LongMessage).join('; ')
      : (errors && errors.LongMessage) || 'Unknown eBay API error';
    throw new Error('eBay API error: ' + msg);
  }

  const totalPages = parseInt((response1.PaginationResult && response1.PaginationResult.TotalNumberOfPages) || '1', 10);
  const totalOrders = parseInt((response1.PaginationResult && response1.PaginationResult.TotalNumberOfEntries) || '0', 10);
  console.log('eBay: ' + totalOrders + ' total orders across ' + totalPages + ' pages');

  // Collect orders from page 1
  const allOrderData = [];
  const page1Orders = response1.OrderArray && response1.OrderArray.Order;
  if (page1Orders) {
    const arr = Array.isArray(page1Orders) ? page1Orders : [page1Orders];
    allOrderData.push(...arr);
  }

  // Fetch remaining pages in parallel batches of 5
  if (totalPages > 1) {
    const remaining = [];
    for (let p = 2; p <= totalPages; p++) remaining.push(p);

    while (remaining.length > 0) {
      const batch = remaining.splice(0, 5);
      const results = await Promise.all(
        batch.map(p => fetchOrderPage(createTimeFrom, createTimeTo, p))
      );
      for (const result of results) {
        const resp = result.GetOrdersResponse;
        if (!resp) continue;
        const orders = resp.OrderArray && resp.OrderArray.Order;
        if (!orders) continue;
        const arr = Array.isArray(orders) ? orders : [orders];
        allOrderData.push(...arr);
      }
    }
  }

  console.log('Total orders collected: ' + allOrderData.length);
  return allOrderData;
}

// ── Parse raw eBay order objects into clean format ───────────────────────────
function parseOrder(order) {
  const txArray = order.TransactionArray && order.TransactionArray.Transaction;
  const transactions = txArray
    ? (Array.isArray(txArray) ? txArray : [txArray])
    : [];

  const shippingDetails = order.ShippingDetails || {};
  const shipmentArray = shippingDetails.ShipmentTrackingDetails;
  const trackingEntries = shipmentArray
    ? (Array.isArray(shipmentArray) ? shipmentArray : [shipmentArray])
    : [];

  const allTracking = [];
  trackingEntries.forEach(function(t) {
    if (t.ShipmentTrackingNumber) {
      allTracking.push({
        carrier: t.ShippingCarrierUsed || 'Unknown',
        trackingNumber: t.ShipmentTrackingNumber,
      });
    }
  });

  // Also check per-transaction tracking
  transactions.forEach(function(tx) {
    const txTracking = tx.ShippingDetails && tx.ShippingDetails.ShipmentTrackingDetails;
    if (txTracking) {
      const txArr = Array.isArray(txTracking) ? txTracking : [txTracking];
      txArr.forEach(function(t) {
        if (t.ShipmentTrackingNumber && !allTracking.find(function(x) { return x.trackingNumber === t.ShipmentTrackingNumber; })) {
          allTracking.push({
            carrier: t.ShippingCarrierUsed || 'Unknown',
            trackingNumber: t.ShipmentTrackingNumber,
          });
        }
      });
    }
  });

  const orderStatus = order.OrderStatus || 'Unknown';
  const checkoutStatus = (order.CheckoutStatus && order.CheckoutStatus.Status) || '';
  let deliveryStatus = 'pending';
  if (orderStatus === 'Completed') deliveryStatus = 'delivered';
  else if (allTracking.length > 0) deliveryStatus = 'transit';
  else if (checkoutStatus === 'Complete') deliveryStatus = 'label';

  const items = transactions.map(function(tx) {
    return {
      itemId: (tx.Item && tx.Item.ItemID) || '',
      title: (tx.Item && tx.Item.Title) || 'Unknown Item',
      quantity: parseInt(tx.QuantityPurchased || '1', 10),
      price: parseFloat((tx.TransactionPrice && tx.TransactionPrice._) || tx.TransactionPrice || '0'),
    };
  });

  const totalRaw = order.Total;
  const totalAmount = parseFloat((totalRaw && totalRaw._) || totalRaw || '0');
  const currency = (totalRaw && totalRaw.$ && totalRaw.$.currencyID) || 'USD';

  return {
    orderId: order.OrderID || '',
    extendedOrderId: order.ExtendedOrderID || order.OrderID || '',
    createdDate: order.CreatedTime || '',
    orderStatus: orderStatus,
    deliveryStatus: deliveryStatus,
    items: items,
    tracking: allTracking,
    totalAmount: totalAmount,
    currency: currency,
    seller: (transactions[0] && transactions[0].Seller && transactions[0].Seller.UserID) || '',
    paidTime: order.PaidTime || null,
    shippedTime: order.ShippedTime || null,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', function(req, res) {
  res.json({
    status: 'ok',
    configured: !!(EBAY_APP_ID && EBAY_DEV_ID && EBAY_CERT_ID && EBAY_USER_TOKEN),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/orders', async function(req, res) {
  try {
    if (!EBAY_USER_TOKEN) {
      return res.status(401).json({ error: 'EBAY_USER_TOKEN not configured in .env' });
    }
    const daysBack = parseInt(req.query.daysBack || '1', 10);

    const rawOrders = await getAllBuyerOrders(daysBack);
    const orders = rawOrders.map(parseOrder);

    const stats = {
      total: orders.length,
      delivered: orders.filter(function(o) { return o.deliveryStatus === 'delivered'; }).length,
      transit: orders.filter(function(o) { return o.deliveryStatus === 'transit'; }).length,
      label: orders.filter(function(o) { return o.deliveryStatus === 'label'; }).length,
      pending: orders.filter(function(o) { return o.deliveryStatus === 'pending'; }).length,
      totalSpent: orders.reduce(function(s, o) { return s + o.totalAmount; }, 0).toFixed(2),
    };

    res.json({ orders: orders, stats: stats, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tracking-url', function(req, res) {
  const carrier = req.query.carrier;
  const trackingNumber = req.query.trackingNumber;
  if (!carrier || !trackingNumber) {
    return res.status(400).json({ error: 'carrier and trackingNumber required' });
  }
  const c = (carrier || '').toUpperCase();
  let url = 'https://www.ebay.com/orders';
  if (c.indexOf('UPS') !== -1) url = 'https://www.ups.com/track?tracknum=' + trackingNumber;
  else if (c.indexOf('FEDEX') !== -1) url = 'https://www.fedex.com/apps/fedextrack/?tracknumbers=' + trackingNumber;
  else if (c.indexOf('USPS') !== -1) url = 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + trackingNumber;
  else if (c.indexOf('DHL') !== -1) url = 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + trackingNumber;
  res.json({ url: url });
});

app.get('/ebay/account-deletion', function(req, res) {
  const challengeCode = req.query.challenge_code;
  const hash = crypto.createHash('sha256')
    .update(challengeCode + EBAY_VERIFICATION_TOKEN + ENDPOINT_URL)
    .digest('hex');
  res.json({ challengeResponse: hash });
});

app.post('/ebay/account-deletion', function(req, res) {
  console.log('eBay account deletion notification:', req.body);
  res.status(200).json({ acknowledged: true });
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function() {
  console.log('\neBay Order Tracker running at http://localhost:' + PORT);
  console.log('API health: http://localhost:' + PORT + '/api/health');
  console.log('Orders:     http://localhost:' + PORT + '/api/orders?daysBack=1\n');
});
