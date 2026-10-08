/*
 * Marlowe & Finch operations dashboard, frontend.
 *
 * Plain JavaScript, no framework. The page talks to the Spring Boot API under /api and
 * draws both charts as inline SVG. Everything is wrapped in initApp(document, fetchImpl)
 * so the same code runs in the browser and inside Jest with jsdom (see
 * src/test/javascript/setup/loadApp.js).
 */
(function (root) {
  'use strict';

  var API = '/api';
  var DEFAULT_PRESET_DAYS = 30;
  var LATE_LIMIT = 20;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var THEME_KEY = 'ops-theme';
  var DEFAULT_THEME = 'dark';

  // ---------- API client ----------

  function createApi(fetchImpl) {
    function get(url) {
      return fetchImpl(url).then(function (response) {
        if (!response.ok) {
          throw new Error('Request failed: ' + response.status + ' ' + url);
        }
        return response.json();
      });
    }

    function ranged(path, from, to, extra) {
      return get(API + path + '?from=' + from + '&to=' + to + (extra || ''));
    }

    return {
      health: function () { return get(API + '/health'); },
      kpis: function (from, to) { return ranged('/kpis', from, to); },
      onTime: function (from, to) { return ranged('/deliveries/on-time', from, to); },
      late: function (from, to, limit) { return ranged('/deliveries/late', from, to, '&limit=' + limit); },
      ticketsByCategory: function (from, to) { return ranged('/tickets/by-category', from, to); },
      vendors: function () { return get(API + '/vendors'); }
    };
  }

  // ---------- Pure helpers ----------

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function parseIso(iso) {
    var parts = String(iso).split('-');
    return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function toIso(millis) {
    var d = new Date(millis);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /** 0.8981 -> "89.8%". null or NaN -> "n/a". */
  function formatRate(rate) {
    if (rate === null || rate === undefined || isNaN(rate)) {
      return 'n/a';
    }
    return (Math.round(Number(rate) * 1000) / 10).toFixed(1) + '%';
  }

  /** 360095.5 -> "£360,095.50". null -> "£0.00". */
  function formatMoney(amount) {
    var value = Number(amount || 0);
    var sign = value < 0 ? '-' : '';
    var fixed = Math.abs(value).toFixed(2);
    var whole = fixed.slice(0, -3);
    var cents = fixed.slice(-3);
    return sign + '£' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + cents;
  }

  /**
   * Scale a list of values to bar lengths. The largest value (or maxValue, when given)
   * fills maxLength. Empty input gives an empty list; all zeros give all zeros.
   */
  function barWidths(values, maxLength, maxValue) {
    var max = maxValue;
    if (max === undefined || max === null) {
      max = values.reduce(function (m, v) { return Math.max(m, Number(v) || 0); }, 0);
    }
    return values.map(function (v) {
      if (!max || max <= 0) {
        return 0;
      }
      return Math.round((Math.max(0, Number(v) || 0) / max) * maxLength * 100) / 100;
    });
  }

  /** The range "the last N days ending today": { from: today - N days, to: today }. */
  function applyPreset(days, today) {
    var end = parseIso(today);
    return { from: toIso(end - days * 86400000), to: toIso(end) };
  }

  /** Whole days from today to a date. Negative when the date has passed. */
  function daysUntil(iso, today) {
    return Math.round((parseIso(iso) - parseIso(today)) / 86400000);
  }

  /** Only the exact string "light" selects light; anything else (including junk) is the default. */
  function resolveTheme(stored) {
    return stored === 'light' ? 'light' : DEFAULT_THEME;
  }

  function nextTheme(theme) {
    return theme === 'dark' ? 'light' : 'dark';
  }

  // ---------- App ----------

  function initApp(document, fetchImpl) {
    var api = createApi(fetchImpl);

    var els = {
      status: document.getElementById('status-line'),
      form: document.getElementById('range-form'),
      from: document.getElementById('range-from'),
      to: document.getElementById('range-to'),
      presets: [7, 30, 90].map(function (days) {
        return { days: days, button: document.getElementById('preset-' + days) };
      }),
      kpiOnTime: document.getElementById('kpi-on-time'),
      kpiOpenTickets: document.getElementById('kpi-open-tickets'),
      kpiRevenue: document.getElementById('kpi-revenue'),
      kpiOrders: document.getElementById('kpi-orders'),
      chartOnTime: document.getElementById('chart-on-time'),
      chartTickets: document.getElementById('chart-tickets'),
      lateBody: document.getElementById('late-body'),
      vendors: document.getElementById('vendors-list'),
      themeToggle: document.getElementById('theme-toggle')
    };

    var state = {
      today: null,
      from: null,
      to: null,
      preset: DEFAULT_PRESET_DAYS,
      kpis: null,
      onTime: [],
      late: [],
      tickets: [],
      vendors: [],
      error: null,
      vendorsError: null,
      theme: DEFAULT_THEME
    };

    // ---------- Theme ----------

    function readStoredTheme() {
      try {
        return document.defaultView.localStorage.getItem(THEME_KEY);
      } catch (err) {
        return null;
      }
    }

    function storeTheme(theme) {
      try {
        document.defaultView.localStorage.setItem(THEME_KEY, theme);
      } catch (err) {
        // Storage can be blocked; the toggle still works for this page view.
      }
    }

    function applyTheme(theme) {
      state.theme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      els.themeToggle.textContent = 'Switch to ' + nextTheme(theme) + ' theme';
    }

    function svgEl(name, attrs, text) {
      var el = document.createElementNS(SVG_NS, name);
      Object.keys(attrs || {}).forEach(function (key) {
        el.setAttribute(key, attrs[key]);
      });
      if (text !== undefined) {
        el.textContent = text;
      }
      return el;
    }

    function clear(el) {
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
    }

    function setStatus(text, isError) {
      els.status.textContent = text;
      els.status.classList.toggle('error', Boolean(isError));
    }

    /** The status line shows the first outstanding error, or nothing. */
    function renderStatus() {
      var message = state.error || state.vendorsError;
      setStatus(message || '', Boolean(message));
    }

    function setKpi(el, value) {
      el.querySelector('.kpi-value').textContent = value;
    }

    // ---------- Rendering ----------

    function renderKpis(kpis) {
      setKpi(els.kpiOnTime, formatRate(kpis.onTimeRate));
      setKpi(els.kpiOpenTickets, String(kpis.openTickets));
      setKpi(els.kpiRevenue, formatMoney(kpis.revenue));
      setKpi(els.kpiOrders, String(kpis.orders));
    }

    function renderOnTimeChart(rows) {
      var svg = els.chartOnTime;
      clear(svg);
      var labelWidth = 150;
      var valueWidth = 60;
      var rowHeight = 32;
      var width = 480;
      var barMax = width - labelWidth - valueWidth;
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + Math.max(rowHeight, rows.length * rowHeight + 8));
      var widths = barWidths(rows.map(function (r) { return r.rate === null ? 0 : r.rate; }), barMax, 1);
      rows.forEach(function (row, i) {
        var y = i * rowHeight + 4;
        var g = svgEl('g', { 'class': 'bar-row', 'data-carrier': row.carrier });
        g.appendChild(svgEl('text', { 'class': 'bar-label', x: 0, y: y + 18 }, row.carrier));
        var barClass = 'bar' + (row.rate !== null && row.rate < 0.95 ? ' warn' : '');
        g.appendChild(svgEl('rect', { 'class': barClass, x: labelWidth, y: y + 4, width: widths[i], height: rowHeight - 12, rx: 3 }));
        g.appendChild(svgEl('text', { 'class': 'bar-value', x: labelWidth + widths[i] + 6, y: y + 18 }, formatRate(row.rate)));
        svg.appendChild(g);
      });
    }

    function renderTicketsChart(rows) {
      var svg = els.chartTickets;
      clear(svg);
      var width = 480;
      var height = 160;
      var chartHeight = 110;
      var slot = rows.length ? width / rows.length : width;
      var barWidth = Math.min(64, slot * 0.6);
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      var heights = barWidths(rows.map(function (r) { return r.total; }), chartHeight);
      rows.forEach(function (row, i) {
        var x = i * slot + (slot - barWidth) / 2;
        var g = svgEl('g', { 'class': 'bar-col', 'data-category': row.category });
        g.appendChild(svgEl('rect', { 'class': 'bar', x: x, y: 20 + chartHeight - heights[i], width: barWidth, height: heights[i], rx: 3 }));
        g.appendChild(svgEl('text', { 'class': 'bar-value', x: x + barWidth / 2, y: 20 + chartHeight - heights[i] - 4, 'text-anchor': 'middle' }, row.open + ' open / ' + row.total));
        g.appendChild(svgEl('text', { 'class': 'bar-label', x: x + barWidth / 2, y: height - 8, 'text-anchor': 'middle' }, row.category));
        svg.appendChild(g);
      });
    }

    function renderLate(rows) {
      var body = els.lateBody;
      clear(body);
      if (!rows.length) {
        var empty = document.createElement('tr');
        empty.className = 'empty';
        var cell = document.createElement('td');
        cell.setAttribute('colspan', '5');
        cell.textContent = 'No late deliveries in this range';
        empty.appendChild(cell);
        body.appendChild(empty);
        return;
      }
      rows.forEach(function (row) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-order', row.orderRef);
        [row.orderRef, row.carrier, row.promisedDate, row.deliveredDate, String(row.daysLate)].forEach(function (value, i) {
          var td = document.createElement('td');
          td.textContent = value;
          if (i === 4) {
            td.className = 'num';
          }
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }

    function renderVendors(vendors) {
      var list = els.vendors;
      clear(list);
      vendors.forEach(function (vendor) {
        var days = daysUntil(vendor.contractEnd, state.today);
        var due = days <= vendor.noticeDays;
        var li = document.createElement('li');
        li.className = 'vendor' + (due ? ' renewal-due' : '');
        li.setAttribute('data-vendor', vendor.name);

        var name = document.createElement('span');
        name.className = 'vendor-name';
        name.textContent = vendor.name;

        var meta = document.createElement('span');
        meta.className = 'vendor-meta';
        meta.textContent = vendor.category + ' · ' + formatMoney(vendor.annualSpend) + ' a year · ' + vendor.owner;

        var end = document.createElement('span');
        end.className = 'vendor-end';
        var when = days < 0 ? 'ended ' + Math.abs(days) + ' days ago' : 'in ' + days + ' days';
        end.textContent = 'Ends ' + vendor.contractEnd + ' (' + when + '), ' + vendor.noticeDays + ' days notice';

        li.appendChild(name);
        li.appendChild(meta);
        li.appendChild(end);
        list.appendChild(li);
      });
    }

    function renderRange() {
      els.from.value = state.from;
      els.to.value = state.to;
      els.presets.forEach(function (p) {
        p.button.classList.toggle('active', p.days === state.preset);
      });
    }

    // ---------- Loading ----------

    function load(from, to) {
      state.from = from;
      state.to = to;
      renderRange();
      setStatus('Loading…');
      return Promise.all([
        api.kpis(from, to),
        api.onTime(from, to),
        api.late(from, to, LATE_LIMIT),
        api.ticketsByCategory(from, to)
      ]).then(function (results) {
        state.kpis = results[0];
        state.onTime = results[1];
        state.late = results[2];
        state.tickets = results[3];
        state.error = null;
        renderKpis(state.kpis);
        renderOnTimeChart(state.onTime);
        renderTicketsChart(state.tickets);
        renderLate(state.late);
        renderStatus();
      }).catch(function (err) {
        state.error = 'Could not load the dashboard: ' + err.message;
        renderStatus();
      });
    }

    function loadVendors() {
      return api.vendors().then(function (vendors) {
        state.vendors = vendors;
        state.vendorsError = null;
        renderVendors(vendors);
      }).catch(function (err) {
        state.vendorsError = 'Could not load vendors: ' + err.message;
        renderStatus();
      });
    }

    function selectPreset(days) {
      state.preset = days;
      var range = applyPreset(days, state.today);
      return load(range.from, range.to);
    }

    applyTheme(resolveTheme(readStoredTheme()));

    els.themeToggle.addEventListener('click', function () {
      var theme = nextTheme(state.theme);
      applyTheme(theme);
      storeTheme(theme);
    });

    els.form.addEventListener('submit', function (event) {
      event.preventDefault();
      state.preset = null;
      load(els.from.value, els.to.value);
    });

    els.presets.forEach(function (p) {
      p.button.addEventListener('click', function () {
        selectPreset(p.days);
      });
    });

    var ready = api.health().then(function (health) {
      state.today = health.today;
      var range = applyPreset(DEFAULT_PRESET_DAYS, state.today);
      return Promise.all([load(range.from, range.to), loadVendors()]);
    }).catch(function (err) {
      state.error = 'Could not reach the API: ' + err.message;
      renderStatus();
    });

    return {
      ready: ready,
      state: state,
      load: load,
      selectPreset: selectPreset,
      api: api
    };
  }

  // ---------- Exports ----------

  var exported = {
    initApp: initApp,
    createApi: createApi,
    formatRate: formatRate,
    formatMoney: formatMoney,
    barWidths: barWidths,
    applyPreset: applyPreset,
    daysUntil: daysUntil,
    resolveTheme: resolveTheme,
    nextTheme: nextTheme
  };

  if (typeof module !== 'undefined') {
    module.exports = exported;
  } else if (root.document) {
    root.OpsDashboard = exported;
    root.document.addEventListener('DOMContentLoaded', function () {
      root.OpsDashboard.app = initApp(root.document, root.fetch.bind(root));
    });
  }
})(typeof window !== 'undefined' ? window : this);
