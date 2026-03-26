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
const ACTION_LOG_PATH = path.join(__dirname, 'data', 'action_log.json');
const TODAY           = new Date();

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
function buildPrompt(invoices, actualDso) {
  const open          = invoices.filter(i => i.status !== 'PAID');
  const overdue       = open.filter(i => i.status === 'OVERDUE' || new Date(i.dueDate) < TODAY);
  const totalOpen     = open.reduce((s, i) => s + i.amount, 0);
  const totalOverdue  = overdue.reduce((s, i) => s + i.amount, 0);
  const currentMonth  = TODAY.getMonth(); // 0-based
  const budgetRev     = BUD12[currentMonth] || 0;

  const dsoLines = Object.entries(actualDso)
    .map(([c, d]) => `  ${c}: actual ${d.actual_avg}d vs baseline ${d.baseline}d (${d.delta >= 0 ? '+' : ''}${d.delta}d, n=${d.sample_size}, trend: ${d.trend})`)
    .join('\n') || '  No payment history yet — using baselines only';

  const overdueLines = overdue
    .map(i => `  #${i.id || '?'} ${i.customer} €${Math.round(i.amount).toLocaleString()} due ${i.dueDate}`)
    .join('\n') || '  None';

  return `You are a cash flow analyst for Salama Brewing Company Oy (Finnish craft brewery, growing ~62% YoY).
Analysis date: ${TODAY.toISOString().slice(0, 10)}
Current month budget revenue: €${Math.round(budgetRev).toLocaleString()}

OPEN AR: €${Math.round(totalOpen).toLocaleString()} across ${open.length} invoices
OVERDUE: €${Math.round(totalOverdue).toLocaleString()} across ${overdue.length} invoices

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

// ─── BRIEFING PROMPT ─────────────────────────────────────────────────────────
function buildBriefingPrompt(invoices, insights, unclosedActions) {
  const isMonday = TODAY.getDay() === 1;
  const hour     = TODAY.getUTCHours();
  const runType  = hour < 12 ? 'Morning' : 'Evening';

  const open     = invoices.filter(i => i.status !== 'PAID');
  const overdue  = open.filter(i => i.status === 'OVERDUE' || new Date(i.dueDate) < TODAY);
  const totalOpen    = open.reduce((s, i) => s + i.amount, 0);
  const totalOverdue = overdue.reduce((s, i) => s + i.amount, 0);

  // Overdue grouped by customer, sorted by total desc
  const byCustomer = {};
  overdue.forEach(inv => {
    if (!byCustomer[inv.customer]) byCustomer[inv.customer] = { total: 0, items: [] };
    const daysLate = Math.round((TODAY - new Date(inv.dueDate)) / 86400000);
    byCustomer[inv.customer].total += inv.amount;
    byCustomer[inv.customer].items.push(`#${inv.id} €${Math.round(inv.amount).toLocaleString()} (${daysLate}d late)`);
  });
  const overdueLines = Object.entries(byCustomer)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([c, d]) => `  ${c}: €${Math.round(d.total).toLocaleString()} — ${d.items.join(', ')}`)
    .join('\n') || '  None';

  const unclosedLines = unclosedActions.length
    ? unclosedActions.map(a =>
        `  [${(a.role||'ALL').toUpperCase()}] "${a.text}" — ${a.days_open}d open${a.invoiceId ? ` (inv#${a.invoiceId})` : ''}`)
      .join('\n')
    : '  None — clean slate';

  const urgentAlerts = (insights.alerts || []).filter(a => a.level === 'urgent').map(a => a.message).join('; ') || 'none';

  return `You are generating ${runType}${isMonday ? ' Monday' : ''} management briefings for Salama Brewing Company Oy.
Finnish craft brewery. €2.4M revenue target 2026. Growing fast (~62% YoY). Team is small — every hour matters.
Date: ${TODAY.toISOString().slice(0,10)} — ${runType} run.
${isMonday ? 'TODAY IS MONDAY — add a "weekly" section for the team meeting.\n' : ''}
CASH SNAPSHOT:
  Open AR: €${Math.round(totalOpen).toLocaleString()} across ${open.length} invoices
  Overdue: €${Math.round(totalOverdue).toLocaleString()} across ${overdue.length} invoices
  Fixed monthly costs: €62,781 (salary + OP loan — cannot be deferred)
  Biggest cash risk this week: ${insights.weekly_cash_risk || 'n/a'}
  Urgent alerts: ${urgentAlerts}
  WC note: ${insights.wc_note || 'n/a'}

OVERDUE INVOICES (sorted by amount):
${overdueLines}

UNCLOSED ACTIONS FROM PREVIOUS BRIEFINGS:
${unclosedLines}

CUSTOMER PAYMENT PATTERNS:
  Own channels (Espoo Shop, Online, Own Bars): 3–5d — fast cash, protect
  Domestic trade (Kesko, SOK, Alko): 21–39d — generally reliable
  Bars & Pubs FI: 41d avg but slow — follow up at 35d
  Export (Brill, Systembolaget, Other): 48–57d — bulk of AR, long tail
  Bemböle: €25K/month fixed contract, ends September 2026

KEY CONTEXT:
  August = peak production. Cash from Aug shipments arrives Oct–Nov.
  Raw materials for summer must be ordered by end of April.
  China export order planned later this year (not yet in forecast).

Generate tight, role-specific briefings. Be specific: use customer names, amounts, dates.
Each briefing must be readable in under 90 seconds. Status must reflect real urgency.

Return ONLY valid JSON (no markdown, no explanation):
{
  "ceo": {
    "status": "green|amber|red",
    "headline": "<12 words max — the one thing the CEO/CFO must know>",
    "cash_position": "<current cash + what changes this week in one line>",
    "ar_summary": "<total open + overdue split + biggest exposure in one line>",
    "runway": "<at current burn, how many weeks of cash runway — be specific>",
    "narrative": "<2–3 sentences: financial situation + what's at risk + decision needed>",
    "actions": [
      {"id": "ceo-1", "text": "<specific action — financial, operational, or approval>", "urgent": true, "invoiceId": <number or null>}
    ],
    "focus": "<one sentence: CFO-level priority — what financial lever to pull today>"
  },
  "sales": {
    "status": "green|amber|red",
    "headline": "<key collection message>",
    "narrative": "<AR situation + who to call + DSO trend>",
    "actions": [
      {"id": "sales-1", "text": "<specific customer or invoice action>", "urgent": true, "invoiceId": <number or null>}
    ],
    "focus": "<one sentence>"
  },
  "production": {
    "status": "green|amber|red",
    "headline": "<funding or scheduling message>",
    "narrative": "<raw material funding gap + timing + what's at risk>",
    "actions": [
      {"id": "prod-1", "text": "<raw material, schedule, or supplier action>", "urgent": false, "invoiceId": null}
    ],
    "focus": "<one sentence>"
  },
  "marketing": {
    "status": "green|amber|red",
    "headline": "<spend vs cash position>",
    "narrative": "<what spend is safe + what to hold + campaign timing vs cash>",
    "actions": [
      {"id": "mkt-1", "text": "<spend approval or hold action>", "urgent": false, "invoiceId": null}
    ],
    "focus": "<one sentence>"
  }${isMonday ? `,
  "weekly": {
    "headline": "<week ahead in 10 words>",
    "highlights": ["<3–5 bullets: what happened last week, what changed, what's at risk>"],
    "decisions_needed": ["<2–3 decisions management must make this week>"],
    "trend": "improving|stable|worsening"
  }` : ''}
}`;
}

function extractActionsForLog(briefings) {
  const roles = ['ceo', 'sales', 'production', 'marketing'];
  const actions = [];
  roles.forEach(role => {
    const b = briefings[role];
    if (!b || !b.actions) return;
    b.actions.forEach(a => {
      actions.push({
        id:        a.id || `${role}-${Date.now()}`,
        role,
        text:      a.text,
        urgent:    a.urgent || false,
        invoiceId: a.invoiceId || null,
        status:    'open',
      });
    });
  });
  return actions;
}

// ─── ANTHROPIC API CALL ─────────────────────────────────────────────────────
function callClaude(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 700,
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

  // Load invoices
  let invoices;
  if (args.file) {
    console.log(`Loading invoices: ${args.file}`);
    invoices = parseCSV(args.file);
    console.log(`  → ${invoices.length} invoices loaded`);
  } else {
    console.log('Using demo invoice data (no --invoice-file provided)');
    invoices = DEMO_INVOICES;
  }

  // Compute actual DSO from payment history
  const actualDso = computeActualDso(invoices);
  const dsoKeys   = Object.keys(actualDso);
  console.log(`DSO patterns found: ${dsoKeys.length > 0 ? dsoKeys.join(', ') : 'none (demo or no paid invoices)'}`);

  // Call Claude
  console.log('\nCalling Claude API...');
  const prompt = buildPrompt(invoices, actualDso);
  let rawResponse;
  try {
    rawResponse = await callClaude(args.key, prompt);
  } catch(e) {
    console.error('API call failed:', e.message);
    process.exit(1);
  }

  // Parse response
  let insights;
  try {
    insights = JSON.parse(rawResponse);
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

  // Save insights
  const output = {
    generated_at:    TODAY.toISOString(),
    model:           MODEL,
    actual_dso:      actualDso,
    insights,
    invoice_count:   invoices.length,
    open_count:      invoices.filter(i => i.status !== 'PAID').length,
    overdue_count:   invoices.filter(i => i.status === 'OVERDUE').length,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log('\n✓ Insights saved to:', OUTPUT);

  // ── Generate role briefings ──────────────────────────────────────────────
  const actionLog       = loadActionLog();
  const unclosedActions = getUnclosedActions(actionLog, invoices);
  console.log(`Unclosed actions carried over: ${unclosedActions.length}`);

  const briefingPrompt = buildBriefingPrompt(invoices, insights, unclosedActions);
  console.log('\nGenerating role briefings...');
  let briefingRaw;
  try {
    briefingRaw = await callClaude(args.key, briefingPrompt);
  } catch(e) {
    console.warn('Briefing API call failed (insights already saved):', e.message);
    briefingRaw = null;
  }

  let briefings = null;
  if (briefingRaw) {
    try {
      briefings = JSON.parse(briefingRaw);
    } catch(_) {
      const match = briefingRaw.match(/\{[\s\S]*\}/);
      if (match) try { briefings = JSON.parse(match[0]); } catch(e2) { console.warn('Could not parse briefings JSON'); }
    }
  }

  if (briefings) {
    const newActions = extractActionsForLog(briefings);
    const updatedLog = updateActionLog(actionLog, newActions);

    const briefingOutput = {
      generated_at:   TODAY.toISOString(),
      is_monday:      TODAY.getDay() === 1,
      run_type:       TODAY.getUTCHours() < 12 ? 'morning' : 'evening',
      unclosed_count: unclosedActions.length,
      unclosed:       unclosedActions,
      roles:          { ceo: briefings.ceo, sales: briefings.sales, production: briefings.production, marketing: briefings.marketing },
      weekly:         briefings.weekly || null,
    };

    fs.writeFileSync(BRIEFINGS_OUT,   JSON.stringify(briefingOutput, null, 2));
    fs.writeFileSync(ACTION_LOG_PATH, JSON.stringify(updatedLog,     null, 2));
    console.log('✓ Briefings saved to:', BRIEFINGS_OUT);
    console.log('✓ Action log updated:', ACTION_LOG_PATH);

    // Print CEO headline
    const ceo = briefings.ceo || {};
    console.log(`\n─── CEO Briefing [${(ceo.status||'?').toUpperCase()}] ──────────────────────`);
    console.log(ceo.headline || '(none)');
    if (ceo.actions?.length) ceo.actions.forEach((a,i) => console.log(`  ${i+1}. ${a.urgent?'🔴 ':''}${a.text}`));
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
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(e => { console.error(e); process.exit(1); });
