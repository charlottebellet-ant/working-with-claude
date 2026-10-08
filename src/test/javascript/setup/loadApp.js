/*
 * Test harness for the frontend.
 *
 * loadApp() puts index.html into the jsdom document, replaces fetch with a small
 * in-memory fake of every /api endpoint, requires app.js and starts it.
 *
 * REGISTERED_IDS lists every element id the harness knows about. harness.test.js
 * checks that index.html contains no id outside this list, so that anyone adding a
 * new interactive element also updates the harness (and, ideally, the tests).
 */
const fs = require('fs');
const path = require('path');

const STATIC_DIR = path.resolve(__dirname, '../../../main/resources/static');
const APP_PATH = path.join(STATIC_DIR, 'app.js');
const HTML_PATH = path.join(STATIC_DIR, 'index.html');

const REGISTERED_IDS = [
  'app-header',
  'app-title',
  'app-subtitle',
  'range-form',
  'range-from',
  'range-to',
  'range-apply',
  'preset-7',
  'preset-30',
  'preset-90',
  'status-line',
  'kpis',
  'kpi-on-time',
  'kpi-open-tickets',
  'kpi-revenue',
  'kpi-orders',
  'chart-on-time',
  'chart-tickets',
  'late-table',
  'late-body',
  'vendors-list',
  'theme-toggle'
];

const TODAY = '2026-09-21';

/** The localStorage key the app stores the chosen theme under. */
const THEME_KEY = 'ops-theme';
const CSS_PATH = path.join(STATIC_DIR, 'style.css');

/** Fixtures shaped like the real API responses (numbers from docs/data/ANSWER-KEY.md). */
const FIXTURES = {
  health: { status: 'UP', today: TODAY },
  kpis: {
    from: '2026-08-22',
    to: TODAY,
    onTimeRate: 0.937,
    deliveries: 651,
    onTimeDeliveries: 610,
    openTickets: 114,
    revenue: 360095.5,
    orders: 624
  },
  onTime: [
    { carrier: 'Harbour Express', delivered: 125, onTime: 120, rate: 0.96 },
    { carrier: 'Kessler Logistics', delivered: 265, onTime: 238, rate: 0.8981 },
    { carrier: 'Northwind Freight', delivered: 168, onTime: 162, rate: 0.9643 },
    { carrier: 'Redwood Couriers', delivered: 93, onTime: 90, rate: 0.9677 }
  ],
  late: [
    { orderRef: 'MF-01801', carrier: 'Kessler Logistics', promisedDate: '2026-09-12', deliveredDate: '2026-09-17', daysLate: 5 },
    { orderRef: 'MF-01755', carrier: 'Kessler Logistics', promisedDate: '2026-09-10', deliveredDate: '2026-09-13', daysLate: 3 },
    { orderRef: 'MF-01790', carrier: 'Harbour Express', promisedDate: '2026-09-15', deliveredDate: '2026-09-16', daysLate: 1 }
  ],
  ticketsByCategory: [
    { category: 'Delivery delay', open: 41, total: 90 },
    { category: 'Billing question', open: 26, total: 53 },
    { category: 'Damaged on arrival', open: 22, total: 51 },
    { category: 'Missing parts', open: 16, total: 40 },
    { category: 'Warranty claim', open: 9, total: 29 }
  ],
  vendors: [
    { id: 3, name: 'Volta Parts GmbH', category: 'Spare parts', annualSpend: 238000, contractEnd: '2026-10-15', noticeDays: 30, owner: 'Hanna Lindqvist', daysUntilContractEnd: 24, inNoticeWindow: true },
    { id: 7, name: 'Lumen Creative', category: 'Marketing agency', annualSpend: 62000, contractEnd: '2026-10-31', noticeDays: 45, owner: 'Sofia Marchetti', daysUntilContractEnd: 40, inNoticeWindow: true },
    { id: 1, name: 'Kessler Logistics', category: 'Carrier', annualSpend: 412000, contractEnd: '2026-11-30', noticeDays: 90, owner: 'Priya Nandakumar', daysUntilContractEnd: 70, inNoticeWindow: true },
    { id: 5, name: 'HelpSpark', category: 'Support desk software', annualSpend: 31800, contractEnd: '2026-12-31', noticeDays: 30, owner: 'Aisha Rahman', daysUntilContractEnd: 101, inNoticeWindow: false },
    { id: 2, name: 'BrightLeaf Packaging', category: 'Packaging', annualSpend: 86500, contractEnd: '2027-03-31', noticeDays: 60, owner: 'Tom Aldridge', daysUntilContractEnd: 191, inNoticeWindow: false }
  ]
};

function readIndexHtml() {
  return fs.readFileSync(HTML_PATH, 'utf8');
}

function extractIds(html) {
  const ids = [];
  const re = /\sid="([^"]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

function parseUrl(url) {
  const [pathname, query] = url.split('?');
  const params = {};
  if (query) {
    query.split('&').forEach((pair) => {
      const [key, value] = pair.split('=');
      params[decodeURIComponent(key)] = decodeURIComponent(value || '');
    });
  }
  return { pathname, params };
}

/**
 * A tiny fake of the backend. Serves the fixtures (or the overrides given) for each
 * /api endpoint and records every call. `failing` lists paths that answer 500.
 */
function createFakeApi(overrides) {
  const data = Object.assign({}, FIXTURES, overrides || {});
  const failing = (overrides && overrides.failing) || [];
  const calls = [];

  function json(status, body) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body)
    });
  }

  function fetchImpl(url) {
    const { pathname, params } = parseUrl(url);
    calls.push({ url, path: pathname, params });

    if (failing.includes(pathname)) {
      return json(500, { error: 'boom' });
    }
    switch (pathname) {
      case '/api/health':
        return json(200, data.health);
      case '/api/kpis':
        return json(200, Object.assign({}, data.kpis, { from: params.from, to: params.to }));
      case '/api/deliveries/on-time':
        return json(200, data.onTime.map((r) => Object.assign({}, r)));
      case '/api/deliveries/late': {
        const limit = params.limit === undefined ? data.late.length : Number(params.limit);
        return json(200, data.late.slice(0, Math.max(0, limit)).map((r) => Object.assign({}, r)));
      }
      case '/api/tickets/by-category':
        return json(200, data.ticketsByCategory.map((r) => Object.assign({}, r)));
      case '/api/vendors':
        return json(200, data.vendors.map((r) => Object.assign({}, r)));
      default:
        return json(404, { error: 'no route for ' + url });
    }
  }

  return { fetchImpl, calls, data };
}

/**
 * Load the page and start the app against a fake API. `overrides` replaces any of the
 * fixtures by name (health, kpis, onTime, late, ticketsByCategory, vendors, failing).
 * `theme` pre-seeds the stored theme choice in localStorage (any string); without it
 * nothing is stored. The <html> data-theme attribute and localStorage are reset on
 * every call so tests never leak a theme into each other.
 * Returns { app, api, document, module } once the initial load has finished.
 */
async function loadApp(overrides) {
  const html = readIndexHtml();
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  document.body.innerHTML = bodyMatch[1].replace(/<script[^>]*><\/script>/g, '');

  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
  if (overrides && overrides.theme !== undefined) {
    window.localStorage.setItem(THEME_KEY, overrides.theme);
  }

  const api = createFakeApi(overrides);
  global.fetch = api.fetchImpl;

  jest.resetModules();
  const mod = require(APP_PATH);
  const app = mod.initApp(document, api.fetchImpl);
  await app.ready;
  return { app, api, document, module: mod };
}

function requireApp() {
  jest.resetModules();
  return require(APP_PATH);
}

module.exports = {
  REGISTERED_IDS,
  FIXTURES,
  TODAY,
  THEME_KEY,
  CSS_PATH,
  loadApp,
  requireApp,
  createFakeApi,
  readIndexHtml,
  extractIds,
  APP_PATH,
  HTML_PATH
};
