#!/usr/bin/env node
/**
 * Salama Brewing — Daily AI Cash Flow Analysis
 *
 * What it does:
 *   1. Loads invoice history (from Procountor CSV export or demo data)
 *   2. Computes actual DSO per customer from paid invoice history
 *   3. Calls Claude Haiku with the full picture
 *   4. Gets back: DSO updates, cash alerts, top action of the day
 *   5. Saves to data/insights.json (loaded by the dashboard on next page load)
 *
 * Usage:
 *   node analyze.js                                    # demo data
 *   node analyze.js --invoice-file invoices.csv        # real Procountor export
 *   ANTHROPIC_API_KEY=sk-ant-... node analyze.js       # via env var
 *   node analyze.js --key sk-ant-... --invoice-file f  # via flag
 *
 * Schedule (GitHub Actions): see .github/workflows/daily-analysis.yml
 *   Runs 06:00 and 17:00 Helsinki time (03:00 and 14:00 UTC)
 */

const https = require('https');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MODEL           = 'claude-haiku-4-5-20251001';
const OUTPUT          = path.join(__dirname, 'data', 'insights.json');
const BRIEFINGS_OUT   = path.join(__dirname, 'data', 'briefings.json');
const ODOO_INV_OUT    = path.join(__dirname, 'data', 'odoo_inventory.json');
const ACTION_LOG_PATH = path.join(__dirname, 'data', 'action_log.json');
const TODAY           = new Date();

// ─── ODOO CONFIG ───────────────────────────────────────────────────────────
const ODOO_URL  = process.env.ODOO_URL  || 'salama.avoin.app';
const ODOO_DB   = process.env.ODOO_DB   || 'salama.avoin.app';
const ODOO_USER = process.env.ODOO_USER || 'christian@salamabrewing.com';
const ODOO_KEY  = process.env.ODOO_KEY  || '';

// Baseline DSO profiles — must match dashboard PROFILES object
const DSO_BASELINES = {
  'Kesko (direct)':   28,
  'SOK Central':      39,
  'SOK Bars':         35,
  'Alko':             21,
  'Espoo Shop':        3,
  'Online Shop':       5,
  'Bars & Pubs FI':   41,
  'Export (Brill)':   51,
  'Systembolaget':    48,
  'Salama Own Bars':   3,
  'Other Export':     57,
  'Bemböle':          30,
};

// Monthly revenue budget (Jan–Dec 2026) for context
const BUD12 = [116575,167111,174194,201863,204761,209750,229261,281684,234374,188881,209865,154095];

// ─── ARG PARSING ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const r = { key: process.env.ANTHROPIC_API_KEY || '', file: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key')          r.key  = args[++i];
    if (args[i] === '--invoice-file') r.file = args[++i];
  }
  return r;
}

// ─── DEMO DATA ──────────────────────────────────────────────────────────────
// Realistic Salama invoices — replace with real Procountor export
const DEMO_INVOICES = [
  // Historical PAID — used to compute actual DSO vs baseline
  { id:900, date:'2026-01-10', dueDate:'2026-02-09', customer:'Kesko (direct)',  amount:8200,  paidDate:'2026-02-07', status:'PAID' },
  { id:901, date:'2026-01-15', dueDate:'2026-02-14', customer:'Bars & Pubs FI', amount:18500, paidDate:'2026-03-01', status:'PAID' },
  { id:902, date:'2025-12-01', dueDate:'2025-12-31', customer:'Other Export',    amount:22000, paidDate:'2026-02-15', status:'PAID' },
  { id:903, date:'2026-02-01', dueDate:'2026-03-02', customer:'Kesko (direct)',  amount:9100,  paidDate:'2026-03-04', status:'PAID' },
  { id:904, date:'2026-01-20', dueDate:'2026-02-19', customer:'SOK Central',     amount:12400, paidDate:'2026-02-28', status:'PAID' },
  { id:905, date:'2026-02-05', dueDate:'2026-03-06', customer:'Bars & Pubs FI', amount:16800, paidDate:'2026-03-22', status:'PAID' },
  { id:906, date:'2026-01-08', dueDate:'2026-01-29', customer:'Alko',            amount:4800,  paidDate:'2026-01-28', status:'PAID' },
  { id:907, date:'2026-02-10', dueDate:'2026-04-10', customer:'Export (Brill)',  amount:14200, paidDate:'2026-04-01', status:'PAID' },
  // Current OPEN / OVERDUE
  { id:1000, date:'2026-03-01', dueDate:'2026-03-23', customer:'Kesko (direct)',  amount:9860,  paidDate:null, status:'OVERDUE' },
  { id:1001, date:'2026-03-05', dueDate:'2026-03-22', customer:'Kesko (direct)',  amount:8740,  paidDate:null, status:'OVERDUE' },
  { id:1007, date:'2026-03-09', dueDate:'2026-03-30', customer:'Bars & Pubs FI', amount:20741, paidDate:null, status:'UNPAID'  },
  { id:1018, date:'2026-02-12', dueDate:'2026-03-05', customer:'Bars & Pubs FI', amount:14651, paidDate:null, status:'OVERDUE' },
  { id:1019, date:'2026-02-22', dueDate:'2026-03-15', customer:'Other Export',   amount:25200, paidDate:null, status:'OVERDUE' },
  { id:1020, date:'2026-02-18', dueDate:'2026-03-11', customer:'Export (Brill)', amount:14302, paidDate:null, status:'OVERDUE' },
  { id:1002, date:'2026-03-18', dueDate:'2026-04-03', customer:'Kesko (direct)', amount:9966,  paidDate:null, status:'UNPAID'  },
  { id:1003, date:'2026-03-02', dueDate:'2026-03-16', customer:'SOK Central',    amount:10020, paidDate:null, status:'OVERDUE' },
  { id:1008, date:'2026-03-14', dueDate:'2026-04-04', customer:'Bars & Pubs FI', amount:23071, paidDate:null, status:'UNPAID'  },
];

// ─── CSV PARSER ─────────────────────────────────────────────────────────────
// Expected columns (Procountor export): date, dueDate, customer, amount, paidDate, status
// Flexible: maps common column name variants
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines   = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const col = (names) => {
    for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const iDate    = col(['date','invoice date','issued']);
  const iDue     = col(['duedate','due date','due','payment date']);
  const iCust    = col(['customer','counterpartyname','counterparty','name']);
  const iAmt     = col(['amount','totalamount','total','sum']);
  const iPaid    = col(['paiddate','paid date','payment date actual','paid']);
  const iStatus  = col(['status','state']);

  return lines.slice(1).map(line => {
    const v = line.split(',').map(x => x.trim().replace(/"/g, ''));
    return {
      date:     v[iDate]   || '',
      dueDate:  v[iDue]    || '',
      customer: v[iCust]   || '',
      amount:   parseFloat(v[iAmt] || '0') || 0,
      paidDate: v[iPaid]   || null,
      status:   (v[iStatus]||'').toUpperCase() || 'UNKNOWN',
    };
  }).filter(r => r.customer && r.amount > 0);
}

// ─── ODOO XML-RPC HELPERS ──────────────────────────────────────────────────
function xmlrpc(host, urlPath, method, params) {
  return new Promise((resolve, reject) => {
    // Build XML-RPC request body
    function encodeValue(v) {
      if (v === null || v === undefined) return '<value><boolean>0</boolean></value>';
      if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
      if (typeof v === 'number' && Number.isInteger(v)) return `<value><int>${v}</int></value>`;
      if (typeof v === 'number') return `<value><double>${v}</double></value>`;
      if (typeof v === 'string') return `<value><string>${v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</string></value>`;
      if (Array.isArray(v)) {
        return `<value><array><data>${v.map(encodeValue).join('')}</data></array></value>`;
      }
      if (typeof v === 'object') {
        const members = Object.entries(v).map(([k, val]) =>
          `<member><name>${k}</name>${encodeValue(val)}</member>`
        ).join('');
        return `<value><struct>${members}</struct></value>`;
      }
      return `<value><string>${String(v)}</string></value>`;
    }

    const paramsXml = params.map(encodeValue).map(v => `<param>${v}</param>`).join('');
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramsXml}</params></methodCall>`;

    const req = https.request({
      hostname: host,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Odoo XML-RPC timeout')); });
    req.write(body);
    req.end();
  });
}

function parseXmlRpc(xmlString) {
  // Extract text content between tags
  function between(s, open, close, from) {
    var start = s.indexOf(open, from || 0);
    if (start === -1) return null;
    start += open.length;
    var end = s.indexOf(close, start);
    if (end === -1) return null;
    return { text: s.slice(start, end), end: end + close.length };
  }

  function parseValue(xml, pos) {
    pos = pos || 0;
    var start = xml.indexOf('<value>', pos);
    if (start === -1) return null;
    var inner = xml.indexOf('>', start) + 1;
    var innerXml = xml.slice(inner);

    if (innerXml.startsWith('<int>') || innerXml.startsWith('<i4>')) {
      var tag = innerXml.startsWith('<int>') ? 'int' : 'i4';
      var r = between(xml, `<${tag}>`, `</${tag}>`, start);
      return r ? { value: parseInt(r.text, 10), end: r.end } : null;
    }
    if (innerXml.startsWith('<double>')) {
      var r = between(xml, '<double>', '</double>', start);
      return r ? { value: parseFloat(r.text), end: r.end } : null;
    }
    if (innerXml.startsWith('<boolean>')) {
      var r = between(xml, '<boolean>', '</boolean>', start);
      return r ? { value: r.text.trim() === '1', end: r.end } : null;
    }
    if (innerXml.startsWith('<string>') || innerXml.startsWith('\n') || innerXml.match(/^[^<]/)) {
      // String (explicit or implicit)
      if (innerXml.startsWith('<string>')) {
        var r = between(xml, '<string>', '</string>', start);
        return r ? { value: r.text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'), end: r.end } : null;
      }
      // Implicit string — text directly between <value> and </value>
      var r = between(xml, '<value>', '</value>', start);
      return r ? { value: r.text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'), end: r.end } : null;
    }
    if (innerXml.startsWith('<array>')) {
      var dataStart = xml.indexOf('<data>', start);
      if (dataStart === -1) return null;
      // Find MATCHING </data> by counting nesting depth (nested arrays also have <data> tags)
      var depth = 1, searchPos = dataStart + '<data>'.length, dataEnd = -1;
      while (searchPos < xml.length) {
        var nextOpen  = xml.indexOf('<data>',  searchPos);
        var nextClose = xml.indexOf('</data>', searchPos);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++; searchPos = nextOpen + '<data>'.length;
        } else {
          depth--;
          if (depth === 0) { dataEnd = nextClose; break; }
          searchPos = nextClose + '</data>'.length;
        }
      }
      if (dataEnd === -1) return null;
      var items = [];
      var cur = dataStart + '<data>'.length;
      while (cur < dataEnd) {
        var vStart = xml.indexOf('<value>', cur);
        if (vStart === -1 || vStart >= dataEnd) break;
        var item = parseValue(xml, vStart);
        if (!item) break;
        items.push(item.value);
        cur = item.end;
      }
      var arrEnd = xml.indexOf('</array>', dataEnd) + '</array>'.length;
      var valEnd = xml.indexOf('</value>', arrEnd) + '</value>'.length;
      return { value: items, end: valEnd };
    }
    if (innerXml.startsWith('<struct>')) {
      var structStart = xml.indexOf('<struct>', start);
      // Find MATCHING </struct> by counting nesting depth
      var depth = 1, searchPos = structStart + '<struct>'.length, structEnd = -1;
      while (searchPos < xml.length) {
        var nextOpen  = xml.indexOf('<struct>',  searchPos);
        var nextClose = xml.indexOf('</struct>', searchPos);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++; searchPos = nextOpen + '<struct>'.length;
        } else {
          depth--;
          if (depth === 0) { structEnd = nextClose; break; }
          searchPos = nextClose + '</struct>'.length;
        }
      }
      if (structEnd === -1) return null;
      var obj = {};
      var cur = structStart + '<struct>'.length;
      while (cur < structEnd) {
        var mStart = xml.indexOf('<member>', cur);
        if (mStart === -1 || mStart >= structEnd) break;
        var nameR = between(xml, '<name>', '</name>', mStart);
        if (!nameR) break;
        var valR = parseValue(xml, xml.indexOf('<value>', nameR.end));
        if (!valR) break;
        obj[nameR.text] = valR.value;
        cur = xml.indexOf('</member>', valR.end) + '</member>'.length;
      }
      var sValEnd = xml.indexOf('</value>', structEnd) + '</value>'.length;
      return { value: obj, end: sValEnd };
    }
    // Fallback: implicit string
    var r = between(xml, '<value>', '</value>', start);
    return r ? { value: r.text, end: r.end } : null;
  }

  try {
    // Check for fault
    if (xmlString.includes('<fault>')) {
      var faultVal = parseValue(xmlString, xmlString.indexOf('<fault>'));
      throw new Error('XML-RPC fault: ' + JSON.stringify(faultVal ? faultVal.value : 'unknown'));
    }
    var paramsStart = xmlString.indexOf('<params>');
    if (paramsStart === -1) return null;
    var paramStart = xmlString.indexOf('<param>', paramsStart);
    if (paramStart === -1) return null;
    var result = parseValue(xmlString, xmlString.indexOf('<value>', paramStart));
    return result ? result.value : null;
  } catch (e) {
    throw e;
  }
}

function dateNDaysAgo(n) {
  var d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function odooAuthenticate() {
  if (!ODOO_KEY) return null;
  try {
    const xml = await xmlrpc(ODOO_URL, '/xmlrpc/2/common', 'authenticate', [
      ODOO_DB, ODOO_USER, ODOO_KEY, {}
    ]);
    const uid = parseXmlRpc(xml);
    if (typeof uid === 'number' && uid > 0) {
      console.log(`  Odoo auth OK — uid: ${uid}`);
      return uid;
    }
    console.warn('  Odoo auth returned non-integer uid:', uid);
    return null;
  } catch (e) {
    console.warn('  Odoo auth failed:', e.message);
    return null;
  }
}

// ⚠️  READ-ONLY POLICY: This function ONLY uses 'search_read' — a read-only Odoo method.
// Never use 'create', 'write', 'unlink', or any other mutating method here.
// Same policy applies to Procountor when added: GET endpoints only, never POST/PUT/DELETE.
async function fetchOdooData(uid) {
  async function searchRead(model, domain, fields, limit) {
    const xml = await xmlrpc(ODOO_URL, '/xmlrpc/2/object', 'execute_kw', [
      ODOO_DB, uid, ODOO_KEY,
      model, 'search_read',
      [domain],
      { fields, limit }
    ]);
    const result = parseXmlRpc(xml);
    return Array.isArray(result) ? result : [];
  }

  console.log('  Fetching open invoices (account.move)...');
  const invoices = await searchRead(
    'account.move',
    [['move_type','=','out_invoice'],['state','=','posted'],['payment_state','in',['not_paid','partial']]],
    ['name','partner_id','amount_residual','invoice_date_due','invoice_date','payment_state'],
    200
  );

  console.log(`  Fetching purchase orders...`);
  const purchase_orders = await searchRead(
    'purchase.order',
    [['state','in',['purchase','draft','sent']]],
    ['name','partner_id','amount_total','date_planned','state'],
    100
  );

  console.log(`  Fetching stock quants...`);
  const stock = await searchRead(
    'stock.quant',
    [['location_id.usage','=','internal'],['quantity','>',0]],
    ['product_id','quantity','reserved_quantity','location_id','value'],
    200
  );

  console.log(`  Fetching recent sales orders...`);
  const sales_pipeline = await searchRead(
    'sale.order',
    [['state','in',['sale']],['date_order','>=',dateNDaysAgo(30)]],
    ['name','partner_id','amount_total','date_order'],
    50
  );

  console.log(`  Odoo: ${invoices.length} invoices, ${purchase_orders.length} POs, ${stock.length} stock lines, ${sales_pipeline.length} recent sales`);
  return { invoices, purchase_orders, stock, sales_pipeline };
}

// ─── ACTUAL DSO COMPUTATION ─────────────────────────────────────────────────
function computeActualDso(invoices) {
  const byCustomer = {};
  invoices
    .filter(inv => inv.status === 'PAID' && inv.paidDate && inv.date)
    .forEach(inv => {
      const issued   = new Date(inv.date);
      const paid     = new Date(inv.paidDate);
      const actualDso = Math.round((paid - issued) / 86400000);
      if (!byCustomer[inv.customer]) byCustomer[inv.customer] = [];
      byCustomer[inv.customer].push({ actualDso, amount: inv.amount, date: inv.date });
    });

  const result = {};
  Object.entries(byCustomer).forEach(([cust, recs]) => {
    recs.sort((a, b) => new Date(a.date) - new Date(b.date));
    const recent    = recs.slice(-6);
    const avg       = Math.round(recent.reduce((s, r) => s + r.actualDso, 0) / recent.length);
    const baseline  = DSO_BASELINES[cust] || 30;
    const last2     = recent.slice(-2);
    const trend     = last2.length < 2 ? 'insufficient' :
                      last2[1].actualDso > last2[0].actualDso ? 'slowing' :
                      last2[1].actualDso < last2[0].actualDso ? 'improving' : 'stable';
    result[cust] = { actual_avg: avg, baseline, delta: avg - baseline, sample_size: recs.length, trend };
  });
  return result;
}

// ─── CLAUDE PROMPT ─────────────────────────────────────────────────────────
function buildPrompt(invoices, actualDso, odooData) {
  const open          = invoices.filter(i => i.status !== 'PAID');
  const overdue       = open.filter(i => i.status === 'OVERDUE' || new Date(i.dueDate) < TODAY);
  const totalOpen     = open.reduce((s, i) => s + i.amount, 0);
  const totalOverdue  = overdue.reduce((s, i) => s + i.amount, 0);
  const currentMonth  = TODAY.getMonth(); // 0-based
  const budgetRev     = BUD12[currentMonth] || 0;

  const dsoLines = Object.entries(actualDso)
    .map(([c, d]) => `  ${c}: actual ${d.actual_avg}d vs baseline ${d.baseline}d (${d.delta >= 0 ? '+' : ''}${d.delta}d, n=${d.sample_size}, trend: ${d.trend})`)
    .join('\n') || '  No payment history yet — using baselines only';

  // Top 10 overdue by amount — avoids bloating the prompt with 50+ lines
  const overdueLines = overdue
    .sort((a,b) => b.amount - a.amount)
    .slice(0, 10)
    .map(i => `  #${i.id || '?'} ${i.customer} €${Math.round(i.amount).toLocaleString()} due ${i.dueDate}`)
    .join('\n') || '  None';

  // Odoo supplementary context
  let odooCtx = '';
  if (odooData) {
    const poTotal = odooData.purchase_orders.reduce((s, p) => s + (parseFloat(p.amount_total) || 0), 0);
    const sales30dTotal = odooData.sales_pipeline.reduce((s, so) => s + (parseFloat(so.amount_total) || 0), 0);
    odooCtx = `
ODOO LIVE DATA:
  Open POs (purchase orders): ${odooData.purchase_orders.length} orders, total €${Math.round(poTotal).toLocaleString()}
  Stock lines (internal locations): ${odooData.stock.length}
  Recent sales (last 30 days): ${odooData.sales_pipeline.length} orders, total €${Math.round(sales30dTotal).toLocaleString()}`;
  }

  return `You are a cash flow analyst for Salama Brewing Company Oy (Finnish craft brewery, growing ~62% YoY).
Analysis date: ${TODAY.toISOString().slice(0, 10)}
Current month budget revenue: €${Math.round(budgetRev).toLocaleString()}

OPEN AR: €${Math.round(totalOpen).toLocaleString()} across ${open.length} invoices
OVERDUE: €${Math.round(totalOverdue).toLocaleString()} across ${overdue.length} invoices${odooCtx}

ACTUAL PAYMENT BEHAVIOR (from invoice history):
${dsoLines}

OVERDUE INVOICES:
${overdueLines}

CONTEXT:
- Fixed monthly costs: Personnel €47,425 + OP Loan €15,356 = €62,781 (immovable)
- August is peak revenue (€282K budget) but cash arrives 6-8 weeks later due to export DSO
- Own channels (Espoo Shop, Online Shop, Own Bars) pay in 3-5 days — protect these
- Bemböle contract (€25K/mo) ends September 2026

Analyze and return ONLY valid JSON (no markdown, no extra text):
{
  "dso_updates": {
    "CustomerName": {
      "recommended_dso": <integer>,
      "confidence": "high|medium|low",
      "reason": "<one sentence>"
    }
  },
  "alerts": [
    {
      "level": "urgent|warning|info",
      "customer": "<name or null>",
      "message": "<concrete action to take>",
      "amount": <number or null>
    }
  ],
  "weekly_cash_risk": "<one sentence: biggest cash risk this week>",
  "top_action": "<single most important action today, specific and actionable>",
  "pattern_insights": [
    "<insight about payment patterns or trends, max 2 items>"
  ],
  "wc_note": "<one sentence on working capital position relative to growth>"
}`;
}

// ─── ACTION LOG ──────────────────────────────────────────────────────────────
function loadActionLog() {
  try { return JSON.parse(fs.readFileSync(ACTION_LOG_PATH, 'utf8')); }
  catch (_) { return { history: [] }; }
}

function getUnclosedActions(actionLog, invoices) {
  const cutoff = new Date(TODAY);
  cutoff.setDate(cutoff.getDate() - 5); // look back 5 days

  const paidIds = new Set(
    invoices.filter(i => i.status === 'PAID' && i.paidDate).map(i => String(i.id))
  );

  const unclosed = [];
  for (const entry of (actionLog.history || [])) {
    const entryDate = new Date(entry.date);
    if (entryDate < cutoff) continue;
    const daysSince = Math.max(1, Math.round((TODAY - entryDate) / 86400000));
    for (const action of (entry.actions || [])) {
      if (action.status === 'closed') continue;
      // Auto-resolve if the related invoice is now paid
      if (action.invoiceId && paidIds.has(String(action.invoiceId))) continue;
      unclosed.push({ ...action, days_open: daysSince, source_date: entry.date });
    }
  }
  return unclosed;
}

function updateActionLog(actionLog, newActions) {
  const today = TODAY.toISOString().slice(0, 10);
  const cutoff = new Date(TODAY);
  cutoff.setDate(cutoff.getDate() - 14);
  const history = (actionLog.history || []).filter(e => new Date(e.date) >= cutoff);
  // Replace today's entry if it exists (idempotent on re-runs)
  const filtered = history.filter(e => e.date !== today);
  filtered.push({ date: today, actions: newActions });
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  return { history: filtered };
}

// ─── BRIEFINGS PROMPT ────────────────────────────────────────────────────────
function buildBriefingsPrompt(invoices, actualDso, odooData, runType) {
  const isMonday = TODAY.getDay() === 1;
  const hour     = TODAY.getUTCHours();
  if (!runType) runType = isMonday ? 'weekly' : (hour < 12 ? 'morning' : 'evening');

  const open     = invoices.filter(i => i.status !== 'PAID');
  const overdue  = open.filter(i => i.status === 'OVERDUE' || new Date(i.dueDate) < TODAY);
  const totalOpen    = open.reduce((s, i) => s + i.amount, 0);
  const totalOverdue = overdue.reduce((s, i) => s + i.amount, 0);

  // Top 5 overdue by amount
  const top5Overdue = [...overdue]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map(i => `  ${i.customer}: €${Math.round(i.amount).toLocaleString()} (due ${i.dueDate}, ${Math.round((TODAY - new Date(i.dueDate))/86400000)}d late)`)
    .join('\n') || '  None';

  // DSO summary
  const dsoLines = Object.entries(actualDso)
    .map(([c, d]) => `  ${c}: ${d.actual_avg}d avg (baseline ${d.baseline}d, ${d.delta >= 0 ? '+' : ''}${d.delta}d, trend: ${d.trend})`)
    .join('\n') || '  No DSO history — using baselines';

  // Odoo context
  let odooCtx = '  No live Odoo data — using demo invoices';
  let poTotal = 0, stockLines = 0, sales30dCount = 0, sales30dTotal = 0;
  if (odooData) {
    poTotal = odooData.purchase_orders.reduce((s, p) => s + (parseFloat(p.amount_total) || 0), 0);
    stockLines = odooData.stock.length;
    sales30dCount = odooData.sales_pipeline.length;
    sales30dTotal = odooData.sales_pipeline.reduce((s, so) => s + (parseFloat(so.amount_total) || 0), 0);
    odooCtx = `  Open POs: ${odooData.purchase_orders.length} orders totalling €${Math.round(poTotal).toLocaleString()}
  Stock: ${stockLines} quant lines (internal locations)
  Sales (last 30d): ${sales30dCount} confirmed orders, €${Math.round(sales30dTotal).toLocaleString()}`;
  }

  const currentMonth = TODAY.getMonth();
  const BUD12_local = [116575,167111,174194,201863,204761,209750,229261,281684,234374,188881,209865,154095];
  const budgetRev = BUD12_local[currentMonth] || 0;

  return `You are generating ${runType} management briefings for Salama Brewing Company Oy.
Finnish craft brewery. €2.4M revenue target 2026. Growing fast (~62% YoY). Small team — every hour matters.
Date: ${TODAY.toISOString().slice(0,10)} · Run type: ${runType}
${isMonday ? 'TODAY IS MONDAY — include the "weekly" section.\n' : ''}
CASH SNAPSHOT:
  Open AR: €${Math.round(totalOpen).toLocaleString()} across ${open.length} invoices
  Overdue: €${Math.round(totalOverdue).toLocaleString()} across ${overdue.length} invoices
  Current month budget revenue: €${Math.round(budgetRev).toLocaleString()}
  Fixed monthly costs: €62,781 (personnel €47,425 + OP loan €15,356 — immovable)

TOP 5 OVERDUE INVOICES:
${top5Overdue}

ODOO LIVE DATA:
${odooCtx}

CUSTOMER DSO PATTERNS:
${dsoLines}

CUSTOMER PAYMENT SEGMENTS:
  Own channels (Espoo Shop, Online, Own Bars): 3–5d — fast cash, protect
  Domestic trade (Kesko, SOK, Alko): 21–39d — generally reliable
  Bars & Pubs FI: 41d avg but often slow — follow up at 35d
  Export (Brill, Systembolaget, Other): 48–57d — bulk of AR, long tail
  Bemböle: €25K/month fixed contract, ends September 2026

KEY BUSINESS CONTEXT:
  August = revenue peak (€282K budget). Cash from Aug shipments arrives Oct–Nov.
  Raw materials for summer must be ordered by end of April.
  China export order planned later this year (not yet in forecast).
  Bemböle production contract ends Sep 2026 — needs replacement revenue.

ROLE-SPECIFIC GUIDANCE:
  CEO: cash position, runway, AR health, strategic risks, financial lever to pull
  Sales: which customers to chase today, pipeline opportunities, DSO by customer
  Production: raw material stock coverage, PO status, brew schedule impact vs cash
  Marketing: channel performance, which channels generate fastest cash, budget utilization

Generate tight, role-specific briefings across THREE time horizons per role.
Be specific: use customer names, amounts, dates. Each section readable in under 60 seconds.
Status must reflect REAL urgency based on the numbers above.

Return ONLY valid JSON (no markdown, no explanation):
{
  "run_type": "${runType}",
  "unclosed_count": 0,
  "unclosed": [],
  "roles": {
    "ceo": {
      "7day": {
        "status": "red|amber|green",
        "headline": "<12 words max — the one thing CEO/CFO must know this week>",
        "narrative": "<2–3 sentences: cash situation + what changes this week + decision needed>",
        "focus": "<single most important focus for CEO today>",
        "cash_in_7d": <estimated euros coming in next 7 days>,
        "cash_out_7d": <estimated fixed outflows next 7 days>,
        "actions": [{"id":"c7_1","text":"<specific action>","urgent":true}]
      },
      "monthly": {
        "status": "red|amber|green",
        "headline": "<monthly financial health in 12 words>",
        "narrative": "<2–3 sentences: monthly revenue vs budget + AR + working capital>",
        "kpis": {"revenue_forecast":"€X","vs_budget":"+X%","open_ar":"€X"},
        "actions": [{"id":"cm_1","text":"<monthly action>","urgent":false}]
      },
      "13week": {
        "status": "red|amber|green",
        "headline": "<13-week outlook in 12 words>",
        "narrative": "<2–3 sentences: structural risks, cash trough, August peak planning>",
        "risks": ["<risk 1>","<risk 2>"],
        "actions": [{"id":"c13_1","text":"<strategic action>","urgent":false}]
      }
    },
    "sales": {
      "7day": {
        "status": "red|amber|green",
        "headline": "<collections message>",
        "narrative": "<who to call, overdue amounts, DSO trends>",
        "focus": "<single most important sales/collections focus>",
        "cash_in_7d": <expected collections>,
        "cash_out_7d": 0,
        "actions": [{"id":"s7_1","text":"<specific customer action>","urgent":true}]
      },
      "monthly": {
        "status": "red|amber|green",
        "headline": "<monthly sales health>",
        "narrative": "<pipeline vs target, channel performance>",
        "kpis": {"pipeline_total":"€X","overdue_ratio":"X%","dso_trend":"improving|stable|worsening"},
        "actions": [{"id":"sm_1","text":"<monthly sales action>","urgent":false}]
      },
      "13week": {
        "status": "red|amber|green",
        "headline": "<13-week sales outlook>",
        "narrative": "<seasonal opportunities, export pipeline, Bemböle replacement>",
        "risks": ["<risk 1>","<risk 2>"],
        "actions": [{"id":"s13_1","text":"<strategic sales action>","urgent":false}]
      }
    },
    "production": {
      "7day": {
        "status": "red|amber|green",
        "headline": "<production/materials message>",
        "narrative": "<immediate material needs vs cash position>",
        "focus": "<single most important production focus>",
        "cash_in_7d": 0,
        "cash_out_7d": <expected material payments>,
        "actions": [{"id":"p7_1","text":"<immediate production action>","urgent":false}]
      },
      "monthly": {
        "status": "red|amber|green",
        "headline": "<monthly production health>",
        "narrative": "<material orders, brew schedule, PO commitments>",
        "kpis": {"open_pos":"€X","stock_lines":"X","brew_capacity":"X%"},
        "actions": [{"id":"pm_1","text":"<monthly production action>","urgent":false}]
      },
      "13week": {
        "status": "red|amber|green",
        "headline": "<13-week production planning>",
        "narrative": "<August capacity planning, material ordering timeline, cost forecasts>",
        "risks": ["<risk 1>","<risk 2>"],
        "actions": [{"id":"p13_1","text":"<strategic production action>","urgent":false}]
      }
    },
    "marketing": {
      "7day": {
        "status": "red|amber|green",
        "headline": "<spend vs cash message>",
        "narrative": "<what spend is safe this week, what to hold>",
        "focus": "<single most important marketing focus>",
        "cash_in_7d": 0,
        "cash_out_7d": <expected marketing spend>,
        "actions": [{"id":"m7_1","text":"<immediate marketing action>","urgent":false}]
      },
      "monthly": {
        "status": "red|amber|green",
        "headline": "<monthly marketing health>",
        "narrative": "<budget utilization, which channels perform best>",
        "kpis": {"budget_used":"X%","best_channel":"<name>","roi_trend":"improving|stable|worsening"},
        "actions": [{"id":"mm_1","text":"<monthly marketing action>","urgent":false}]
      },
      "13week": {
        "status": "red|amber|green",
        "headline": "<13-week marketing outlook>",
        "narrative": "<summer campaign timing, August peak strategy, Bemböle replacement channels>",
        "risks": ["<risk 1>","<risk 2>"],
        "actions": [{"id":"m13_1","text":"<strategic marketing action>","urgent":false}]
      }
    }
  },
  "weekly": {
    "headline": "<week ahead in 10 words>",
    "trend": "improving|stable|worsening",
    "highlights": ["<highlight 1>","<highlight 2>","<highlight 3>"],
    "decisions_needed": ["<decision 1>","<decision 2>"]
  }
}`;
}

function extractActionsForLog(briefings) {
  const roles = ['ceo', 'sales', 'production', 'marketing'];
  const horizons = ['7day', 'monthly', '13week'];
  const actions = [];
  const rolesData = briefings.roles || briefings; // support both new (with .roles) and old format
  roles.forEach(role => {
    const roleData = rolesData[role];
    if (!roleData) return;
    // New format: role data has horizons
    if (roleData['7day'] || roleData.monthly || roleData['13week']) {
      horizons.forEach(h => {
        const hData = roleData[h];
        if (!hData || !hData.actions) return;
        hData.actions.forEach(a => {
          actions.push({
            id:        a.id || `${role}-${h}-${Date.now()}`,
            role,
            horizon:   h,
            text:      a.text,
            urgent:    a.urgent || false,
            invoiceId: a.invoiceId || null,
            status:    'open',
          });
        });
      });
    } else if (roleData.actions) {
      // Old flat format fallback
      roleData.actions.forEach(a => {
        actions.push({
          id:        a.id || `${role}-${Date.now()}`,
          role,
          text:      a.text,
          urgent:    a.urgent || false,
          invoiceId: a.invoiceId || null,
          status:    'open',
        });
      });
    }
  });
  return actions;
}

// ─── ANTHROPIC API CALL ─────────────────────────────────────────────────────
function callClaude(apiKey, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 700,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
        'content-type':         'application/json',
        'content-length':       Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content?.[0]?.text || '{}');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();

  console.log('━━━ Salama Brewing — Daily AI Cash Analysis ━━━');
  console.log(`Date:  ${TODAY.toISOString().slice(0, 10)}`);
  console.log(`Model: ${MODEL}`);

  if (!args.key) {
    console.error('\nERROR: No API key found.');
    console.error('Set ANTHROPIC_API_KEY environment variable or use --key sk-ant-...\n');
    process.exit(1);
  }

  // ── Try Odoo connection ─────────────────────────────────────────────────
  let odooData = null;
  if (ODOO_KEY) {
    console.log('\nConnecting to Odoo...');
    try {
      const uid = await odooAuthenticate();
      if (uid) {
        odooData = await fetchOdooData(uid);
        // Save raw inventory data for the dashboard
        fs.mkdirSync(path.dirname(ODOO_INV_OUT), { recursive: true });
        fs.writeFileSync(ODOO_INV_OUT, JSON.stringify(odooData.stock, null, 2));
        console.log(`✓ Odoo inventory saved to: ${ODOO_INV_OUT}`);
      }
    } catch (e) {
      console.warn('Odoo connection failed, falling back to demo data:', e.message);
      odooData = null;
    }
  } else {
    console.log('ODOO_KEY not set — skipping Odoo connection');
  }

  // ── Load invoices ────────────────────────────────────────────────────────
  let invoices;
  if (odooData && odooData.invoices.length > 0) {
    // Convert Odoo invoices to internal format
    console.log('\nConverting Odoo invoices to internal format...');
    invoices = odooData.invoices.map(inv => ({
      id:       inv.id,
      date:     (inv.invoice_date || '').slice(0, 10),
      dueDate:  (inv.invoice_date_due || '').slice(0, 10),
      customer: (inv.partner_id && inv.partner_id[1]) || 'Unknown',
      amount:   parseFloat(inv.amount_residual) || 0,
      paidDate: null,
      status:   inv.payment_state === 'partial' ? 'UNPAID' :
                (inv.invoice_date_due && new Date(inv.invoice_date_due) < TODAY) ? 'OVERDUE' : 'UNPAID',
    })).filter(r => r.amount > 0);
    console.log(`  → ${invoices.length} open invoices from Odoo`);
  } else if (args.file) {
    console.log(`\nLoading invoices: ${args.file}`);
    invoices = parseCSV(args.file);
    console.log(`  → ${invoices.length} invoices loaded`);
  } else {
    console.log('\nUsing demo invoice data (no Odoo connection, no --invoice-file)');
    invoices = DEMO_INVOICES;
  }

  // Compute actual DSO from payment history
  const actualDso = computeActualDso(invoices);
  const dsoKeys   = Object.keys(actualDso);
  console.log(`DSO patterns found: ${dsoKeys.length > 0 ? dsoKeys.join(', ') : 'none (demo or no paid invoices)'}`);

  // ── Odoo summary banner ───────────────────────────────────────────────────
  if (odooData) {
    const poTotal = odooData.purchase_orders.reduce((s, p) => s + (parseFloat(p.amount_total) || 0), 0);
    console.log('\n─── Odoo Data ────────────────────────────────');
    console.log(`  Open invoices (AR):   ${odooData.invoices.length}`);
    console.log(`  Open POs:             ${odooData.purchase_orders.length} (€${Math.round(poTotal).toLocaleString()})`);
    console.log(`  Stock quant lines:    ${odooData.stock.length}`);
    console.log(`  Recent sales (30d):   ${odooData.sales_pipeline.length}`);
  }

  // ── Call Claude for insights ──────────────────────────────────────────────
  console.log('\nCalling Claude API (insights)...');
  const prompt = buildPrompt(invoices, actualDso, odooData);
  let rawResponse;
  try {
    rawResponse = await callClaude(args.key, prompt, 2000);
  } catch(e) {
    console.error('API call failed:', e.message);
    process.exit(1);
  }

  // Parse response — strip markdown code fences if present
  let insights;
  try {
    const cleaned = rawResponse.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
    insights = JSON.parse(cleaned);
  } catch(_) {
    const match = rawResponse.match(/\{[\s\S]*\}/);
    if (match) {
      try { insights = JSON.parse(match[0]); }
      catch(e) { console.error('Could not parse JSON from response:\n', rawResponse); process.exit(1); }
    } else {
      console.error('No JSON in response:\n', rawResponse);
      process.exit(1);
    }
  }

  // Build Odoo summary for insights.json (summarized, not raw)
  let odooSummary = null;
  if (odooData) {
    const poTotal = odooData.purchase_orders.reduce((s, p) => s + (parseFloat(p.amount_total) || 0), 0);
    const sales30dTotal = odooData.sales_pipeline.reduce((s, so) => s + (parseFloat(so.amount_total) || 0), 0);
    odooSummary = {
      invoice_count:      odooData.invoices.length,
      purchase_order_total: Math.round(poTotal),
      stock_lines:        odooData.stock.length,
      sales_30d_count:    odooData.sales_pipeline.length,
      sales_30d_total:    Math.round(sales30dTotal),
    };
  }

  // Save insights
  const output = {
    generated_at:    TODAY.toISOString(),
    model:           MODEL,
    actual_dso:      actualDso,
    insights,
    invoice_count:   invoices.length,
    open_count:      invoices.filter(i => i.status !== 'PAID').length,
    overdue_count:   invoices.filter(i => i.status === 'OVERDUE').length,
    odoo_data:       odooSummary,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log('\n✓ Insights saved to:', OUTPUT);

  // ── Generate role briefings ───────────────────────────────────────────────
  const actionLog       = loadActionLog();
  const unclosedActions = getUnclosedActions(actionLog, invoices);
  console.log(`Unclosed actions carried over: ${unclosedActions.length}`);

  const briefingPrompt = buildBriefingsPrompt(invoices, actualDso, odooData);
  console.log('\nGenerating role briefings (2000 tokens)...');
  let briefingRaw;
  try {
    briefingRaw = await callClaude(args.key, briefingPrompt, 2000);
  } catch(e) {
    console.warn('Briefing API call failed (insights already saved):', e.message);
    briefingRaw = null;
  }

  let briefings = null;
  if (briefingRaw) {
    try {
      const cleaned = briefingRaw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
      briefings = JSON.parse(cleaned);
    } catch(_) {
      const match = briefingRaw.match(/\{[\s\S]*\}/);
      if (match) try { briefings = JSON.parse(match[0]); } catch(e2) { console.warn('Could not parse briefings JSON'); }
    }
  }

  if (briefings) {
    const newActions = extractActionsForLog(briefings);
    const updatedLog = updateActionLog(actionLog, newActions);

    // Support both new format (with .roles) and fallback
    const rolesData = briefings.roles || {
      ceo: briefings.ceo, sales: briefings.sales,
      production: briefings.production, marketing: briefings.marketing
    };

    const briefingOutput = {
      generated_at:   TODAY.toISOString(),
      is_monday:      TODAY.getDay() === 1,
      run_type:       briefings.run_type || (TODAY.getUTCHours() < 12 ? 'morning' : 'evening'),
      unclosed_count: unclosedActions.length,
      unclosed:       unclosedActions,
      roles:          rolesData,
      weekly:         briefings.weekly || null,
    };

    fs.writeFileSync(BRIEFINGS_OUT,   JSON.stringify(briefingOutput, null, 2));
    fs.writeFileSync(ACTION_LOG_PATH, JSON.stringify(updatedLog,     null, 2));
    console.log('✓ Briefings saved to:', BRIEFINGS_OUT);
    console.log('✓ Action log updated:', ACTION_LOG_PATH);

    // Print CEO 7-day headline
    const ceo7 = (rolesData.ceo || {})['7day'] || rolesData.ceo || {};
    const ceoStatus = ceo7.status || '?';
    console.log(`\n─── CEO Briefing (7-day) [${ceoStatus.toUpperCase()}] ────────────`);
    console.log(ceo7.headline || '(none)');
    if (ceo7.actions?.length) ceo7.actions.forEach((a,i) => console.log(`  ${i+1}. ${a.urgent?'🔴 ':''}${a.text}`));
  }

  // Print summary
  console.log('\n─── Top Action ───────────────────────────────');
  console.log(insights.top_action || '(none)');
  console.log('\n─── Weekly Cash Risk ─────────────────────────');
  console.log(insights.weekly_cash_risk || '(none)');
  if (insights.alerts?.length) {
    console.log('\n─── Alerts ───────────────────────────────────');
    insights.alerts.forEach(a => console.log(`  [${(a.level||'info').toUpperCase()}] ${a.message}${a.amount ? ` — €${Math.round(a.amount).toLocaleString()}` : ''}`));
  }
  if (dsoKeys.length > 0) {
    console.log('\n─── DSO Updates ──────────────────────────────');
    Object.entries(insights.dso_updates || {}).forEach(([c, d]) =>
      console.log(`  ${c}: ${d.recommended_dso}d (${d.confidence}) — ${d.reason}`)
    );
  }
  if (odooData) {
    const poTotal = odooData.purchase_orders.reduce((s, p) => s + (parseFloat(p.amount_total) || 0), 0);
    console.log('\n─── Odoo Summary ─────────────────────────────');
    console.log(`  Invoices: ${odooData.invoices.length} · POs: €${Math.round(poTotal).toLocaleString()} · Stock: ${odooData.stock.length} lines`);
  }
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(e => { console.error(e); process.exit(1); });
