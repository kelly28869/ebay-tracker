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

async function getBuyerOrders({ daysBack = 1, page = 1, pageSize = 200 } = {}) {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - daysBack);
  const createTimeFrom = from.toISOString();
  const createTimeTo = now.toISOString();

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
    <EntriesPerPage>${pageSize}</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

  const result = await callEbayTradingAPI('GetOrders', xml);
  return result;
}

function parseOrders(rawResult) {
  const response = rawResult?.GetOrdersResponse;
  if (!response) throw new Error('Invalid eBay API response');

  const ack = response.Ack;
  if (ack !== 'Success' && ack !== 'Warning') {
    const errors = response.Errors;
    const msg = Array.isArray(errors)
      ? errors.map(e => e.LongMessage).join('; ')
      : errors?.LongMessage || 'Unknown eBay API error';
    throw new Error(`eBay API error: ${msg}`);
  }

  const orderArray = response.OrderArray?.Order;
  if (!orderArray) return [];
  const orders = Array.isArray(orderArray) ? orderArray : [orderArray];

  return orders.map(order => {
    const txArray = order.TransactionArray?.Transaction;
    const transactions = txArray
      ? (Array.isArray(txArray) ? txArray : [txArray])
      : [];

    const shippingDetails = order.ShippingDetails || {};
    const shipmentArray = shippingDetails.ShipmentTrackingDetails;
    const trackingEntries = shipmentArray
      ? (Array.isArray(shipmentArray) ? shipmentArray : [shipmentArray])
      : [];

    const allTracking = [];
    trackingEntries.forEach(t => {
      if (t.ShipmentTrackingNumber) {
        allTracking.push({
          carrier: t.ShippingCarrierUsed || 'Unknown',
          trackingNumber: t.ShipmentTrackingNumber,
        });
      }
    });

    transactions.forEach(tx => {
      const txTracking = tx.ShippingDetails?.ShipmentTrackingDetails;
      if (txTracking) {
        const txTrackArr = Array.isArray(txTracking) ? txTracking : [txTracking];
        txTrackArr.forEach(t => {
          if (t.ShipmentTrackingNumber && !allTracking.find(x => x.trackingNumber === t.ShipmentTrackingNumber)) {
            allTracking.push({
              carrier: t.ShippingCarrierUsed || 'Unknown',
              trackingNumber: t.ShipmentTrackingNumber,
            });
          }
        });
      }
    });

    const orderStatus = order.OrderStatus || 'Unknown';
    const checkoutStatus = order.CheckoutStatus?.Status || '';
    let deliveryStatus = 'pending';
    if (orderStatus === 'Completed') deliveryStatus = 'delivered';
    else if (allTracking.length > 0) deliveryStatus = 'transit';
    else if (checkoutStatus === 'Complete') deliveryStatus = 'label';

    const items = transactions.map(tx => ({
      itemId: tx.Item?.ItemID || '',
      title: tx.Item?.Title || 'Unknown Item',
      quantity: parseInt(tx.QuantityPurchased || '1', 10),
      price: parseFloat(tx.TransactionPrice?._ || tx.TransactionPrice || '0'),
    }));

    return {
      orderId: order.OrderID || '',
      extendedOrderId: order.ExtendedOrderID || order.OrderID || '',
      createdDate: order.CreatedTime || '',
      orderStatus,
      deliveryStatus,
      items,
      tracking: allTracking,
      totalAmount: parseFloat(order.Total?._ || order.Total || '0'),
      currency: order.Total?.$?.currencyID || 'USD',
      seller: transactions[0]?.Seller?.UserID || '',
      paidTime: order.PaidTime || null,
      shippedTime: order.ShippedTime || null,
    };
  });
}

// ── Routes ──────────────────────────────────────────────────────────────────

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
    const page = parseInt(req.query.page || '1', 10);
    const raw = await getBuyerOrders({ daysBack, page });
    const orders = parseOrders(raw);
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
  if (!carrier || !trackingNumber) {
    return res.status(400).json({ error: 'carrier and trackingNumber required' });
  }
  const c = (carrier || '').toUpperCase();
  let url = 'https://www.ebay.com/orders';
  if (c.includes('UPS')) url = `https://www.ups.com/track?tracknum=${trackingNumber}`;
  else if (c.includes('FEDEX')) url = `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}`;
  else if (c.includes('USPS')) url = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  else if (c.includes('DHL')) url = `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
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
  console.log(`\n🚀 eBay Order Tracker running at http://localhost:${PORT}`);
  console.log(`   API health: http://localhost:${PORT}/api/health`);
  console.log(`   Orders:     http://localhost:${PORT}/api/orders?daysBack=1\n`);
});
