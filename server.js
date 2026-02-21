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

const EBAY_API_URL = 'https://api.ebay.com/ws/api.dll';
const {
  EBAY_APP_ID,
  EBAY_DEV_ID,
  EBAY_CERT_ID,
  EBAY_USER_TOKEN,
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
  // 3-state logic:
  //   delivered → eBay or carrier explicitly confirms delivery
  //   transit   → tracking number exists
  //   pending   → paid, no tracking yet

  const hasTrackingNumber = allTracking.some(t => t.trackingNumber && t.trackingNumber.length > 4);

  // Signal 1: ActualDeliveryTime (set by eBay when carrier confirms)
  if (order.ActualDeliveryTime) return 'delivered';

  // Signal 2: ShippingServiceSelected.ShippingStatus = Delivered (order level)
  const orderShipStatus = order.ShippingDetails
    && order.ShippingDetails.ShippingServiceSelected
    && order.ShippingDetails.ShippingServiceSelected.ShippingStatus;
  if (orderShipStatus === 'Delivered') return 'delivered';

  // Signal 3: Transaction-level ShippingStatus
  for (const tx of transactions) {
    const s = tx.ShippingDetails && tx.ShippingDetails.ShippingStatus;
    if (s === 'Delivered') return 'delivered';
  }

  // Signal 4: OrderStatus "Completed" AND ShippedTime is set means delivered
  // (eBay only marks Completed once buyer confirms or return window closes after delivery)
  if (order.OrderStatus === 'Completed' && order.ShippedTime) return 'delivered';

  // Signal 5: CheckoutStatus complete + shipped = delivered
  const checkoutStatus = order.CheckoutStatus && order.CheckoutStatus.Status;
  if (checkoutStatus === 'Complete' && order.ShippedTime && hasTrackingNumber) return 'delivered';

  // Transit: has a tracking number
  if (hasTrackingNumber) return 'transit';

  // Pending: paid but nothing shipped yet
  return 'pending';
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
  return {
    orderId: order.OrderID || '',
    extendedOrderId: order.ExtendedOrderID || order.OrderID || '',
    createdDate: order.CreatedTime || '',
    orderStatus: order.OrderStatus || '',
    deliveryStatus,
    items,
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

// ── Carrier tracking status scraper ─────────────────────────────────────────
// Fetches the carrier's tracking page HTML and looks for "Delivered" keywords.
// This is the most accurate method — reads what the carrier website actually says.
async function scrapeCarrierStatus(carrier, trackingNumber) {
  const c = (carrier || '').toUpperCase();
  let url, delivered = false, status = 'unknown';

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };

  // Helper: parse carrier HTML for real status.
  // Key rule: "expected delivery" / "estimated delivery" / "by [date]" = NOT delivered yet = transit.
  // Only explicit past-tense "Delivered" with no future-date context = delivered.
  function parseCarrierHtml(html, carrier) {
    const h = html.toLowerCase();
    // Strip out "expected delivery", "estimated delivery", "scheduled delivery" — these are NOT delivered
    const hasExpectedDelivery = /expected delivery|estimated delivery|scheduled delivery|expected by|arrives by|delivery by|by [a-z]+ \d/i.test(html);
    const hasLabelCreated = /label created|shipping label created|pre-shipment|pre shipment/i.test(html);
    const hasOutForDelivery = /out for delivery/i.test(html);
    // "Delivered" only counts if it's NOT preceded/followed by future-delivery language
    const hasDelivered = /delivered/i.test(html)
      && !/attempted delivery|delivery attempt|delivery exception|failed delivery/i.test(html)
      && !hasExpectedDelivery;

    if (hasDelivered && !hasExpectedDelivery) return 'delivered';
    if (hasOutForDelivery) return 'out_for_delivery';
    if (hasExpectedDelivery) return 'transit'; // has a future delivery date = still in transit
    if (/in transit|in-transit|on the way|departed|arrived|accepted|picked up|processed/i.test(html)) return 'transit';
    if (hasLabelCreated) return 'label';
    return 'unknown';
  }

  try {
    if (c.includes('USPS') || c.includes('US POSTAL')) {
      url = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
      const apiResp = await axios.get(
        `https://tools.usps.com/go/TrackConfirmAction_input?origTrackNum=${trackingNumber}`,
        { headers, timeout: 8000 }
      );
      status = parseCarrierHtml(apiResp.data, 'usps');
      delivered = status === 'delivered';

    } else if (c.includes('UPS')) {
      url = `https://www.ups.com/track?tracknum=${trackingNumber}`;
      const apiResp = await axios.get(
        `https://www.ups.com/track?loc=en_US&tracknum=${trackingNumber}&requester=WT/trackdetails`,
        { headers, timeout: 8000 }
      );
      status = parseCarrierHtml(apiResp.data, 'ups');
      delivered = status === 'delivered';

    } else if (c.includes('FEDEX') || c.includes('FED EX')) {
      url = `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}`;
      const apiResp = await axios.get(url, { headers, timeout: 8000 });
      status = parseCarrierHtml(apiResp.data, 'fedex');
      delivered = status === 'delivered';

    } else if (c.includes('DHL')) {
      url = `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
      const apiResp = await axios.get(url, { headers, timeout: 8000 });
      status = parseCarrierHtml(apiResp.data, 'dhl');
      delivered = status === 'delivered';

    } else {
      url = `https://www.ebay.com/orders`;
      status = 'unknown';
    }
  } catch (err) {
    console.error('Carrier scrape error for ' + trackingNumber + ':', err.message);
    status = 'error';
  }

  return { status, delivered, url, carrier, trackingNumber };
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
    if (!EBAY_USER_TOKEN) return res.status(401).json({ error: 'EBAY_USER_TOKEN not configured in .env' });
    const { fromDate, toDate } = req.query;
    const daysBack = parseInt(req.query.daysBack || '1', 10);
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
    res.json({ orders, stats, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── NEW: Check real delivery status by scraping carrier page ─────────────────
// Called when user clicks a tracking number in the dashboard.
// Returns { status, delivered, url } so frontend can update the row.
app.get('/api/check-tracking', async (req, res) => {
  const { carrier, trackingNumber } = req.query;
  if (!carrier || !trackingNumber) return res.status(400).json({ error: 'carrier and trackingNumber required' });
  try {
    const result = await scrapeCarrierStatus(carrier, trackingNumber);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, status: 'error' });
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
  const hash = crypto.createHash('sha256').update(challengeCode + EBAY_VERIFICATION_TOKEN + ENDPOINT_URL).digest('hex');
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
  console.log('\neBay Order Tracker running at http://localhost:' + PORT);
  if (!DASHBOARD_PASSWORD) console.log('WARNING: Set DASHBOARD_PASSWORD in .env!');
  else console.log('Dashboard is password protected.');
  console.log('');
});
