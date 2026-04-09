# Salama Brewing — Project Handoff for Claude Code

## What This Is
Cash flow management system for Salama Brewing Company Oy (Finnish craft brewery). Rene Kromhof (Cloudberry VC board member) is building tools to prevent the company from running out of cash.

## Current State: Two Things Built

### 1. Scenario Planner (DONE)
**File:** `/Claude Cowork--Salama/Salama_Cash_Flow_Planner.html` (~93KB)
Interactive HTML dashboard with 6 tabs: Scenario, People, Costs, Bemböle, Stress Test, Top 10 Offenders. Models Original vs Pessimistic LivePlan scenarios, personnel cuts with Finnish TES notice periods, cost cutting, Bemböle brewery closure analysis.

**Key constants hardcoded in the HTML:**
- Starting cash: €24,439 (Feb 2026 close)
- Loan: €14,357/mo (OP bank) — NOTE: Procountor shows €15,356, discrepancy needs resolving
- Junior debt: converting to equity (no August repayment)
- Personnel: €47,425/mo total, 11 headcount
- Revenue source: LivePlan export 23 Mar 2026

### 2. Scenario Analysis Excel (DONE)
**File:** `/Claude Cowork--Salama/Salama_Scenario_Analysis.xlsx`
Three sheets: "Decision Framework" (month-by-month cash for Original/Mid/Pessimistic with relaxed glide path), "Already Planned Cuts" (what's baked into LivePlan Original vs Jan-Feb actuals), "Personnel" (who to cut, notice periods, effective dates).

**Key findings:**
- Original plan: needs only €374/mo additional cuts with relaxed targets (Mar≥€0, Apr≥€5K, May≥€15K, Jun+≥€20K)
- Mid-case (-7.5% revenue): needs €12,168/mo non-personnel cuts, no layoffs
- Pessimistic (-15% revenue): needs ALL non-personnel cuts + 6 layoffs + €42K bridge financing
- Decision trigger: March revenue. >€160K = fine, <€145K = emergency. Deadline: April 7.

### 3. Dashboard Spec (DONE)
**File:** `/Claude Cowork--Salama/Salama_Procountor_Dashboard_Spec.docx`
Full technical specification for the next phase: real-time cash dashboard powered by Procountor API.

## What Needs Building Next: Procountor Integration

### The Problem
LivePlan showed March ending at +€10K. Procountor bank forecast (received Mar 25) shows -€64K on March 31. The €74K gap is working capital timing that LivePlan can't model. We need daily cash visibility.

### Architecture
```
Procountor API (€15.39/mo) → Python sync script → JSON data → HTML Dashboard
                                                              → Haiku chat interface
```
- Private GitHub repo
- GitHub Actions cron for daily sync
- Cloudflare Pages for hosting (free, supports private repos, email-based access control)
- Claude Haiku for natural language queries ("can we make payroll Friday?")

### Procountor API Details
- **Auth:** OAuth2, M2M authentication
- **Base URL:** `https://api.procountor.com/api/`
- **Key endpoints:**
  - `GET /invoices` — all sales & purchase invoices (with due dates, amounts, status, payment info)
  - `GET /bankstatements` — bank statement list
  - `GET /bankstatements/{id}/events` — individual bank transactions
  - `GET /ledgerreceipts` — accounting vouchers
  - `POST /reports/accounting` — income statement, balance sheet, cash flow
  - `GET /businesspartners` — customer/supplier master data
- **Rate limit:** 60 req/sec (generous)
- **Pricing:** €12.90/mo + €2.49/mo per integration + 25.5% VAT = ~€19.30/mo
- **Docs:** https://dev.procountor.com/api-reference/
- **Test environment:** Free, provided on developer registration

### What to Build (Priority Order)

**P0 — Core (days 1-5):**
1. `sync.py` — OAuth2 auth, pull invoices + bank statements + payments, write to JSON
2. Working capital engine — calculate DSO per customer, DPO per supplier, from 12-18 months of invoice history
3. 13-week rolling cash forecast:
   - Weeks 1-4: actual invoices from Procountor (high accuracy)
   - Weeks 5-13: blend into LivePlan scenario forecasts (directional)
   - Fixed outflows on exact dates: loan (€15,356 on ~31st), salary (2x/mo), tax, rent
4. Three new dashboard tabs: Cash Position, Receivables, Payables

**P1 — Analytics (days 6-8):**
5. Working Capital tab — DSO/DPO/CCC trends, seasonal patterns, aging buckets (0-30, 31-60, 61-90, 90+)
6. Connect scenario overlay (existing Original/Mid/Pessimistic) to live actuals

**P2 — AI Chat (days 8-10):**
7. Haiku integration — chat widget in dashboard + optionally Slack bot
8. System prompt with current cash position, receivables, payables, DSO data, scenario analysis
9. CEO can ask: "can we pay the invoice due Friday?", "what if Kesko pays 10 days late?", "when do we next go below €20K?"

**P3 — Alerts:**
10. Automatic notifications when projected cash drops below threshold (Slack webhook or email)

### Blocking: Needs from Salama
Someone with Procountor admin access needs to:
1. Enable API: Management → Company info → Usage settings → Integration settings → tick "Allow invoiceable API clients"
2. Create API user: Management → Users and privileges → new user "Salama-CashDashboard" with Management/Auditor role
3. Generate API key: person icon → API client keys → New API key (need Client ID from developer registration first)

## Source Data Files (all in `/Claude Cowork--Salama/`)
- `Projected Profit & Loss 2026.xlsx` — Two sheets: Original and Pessimistic P&L, Jan-Feb are actuals, Mar-Dec forecast
- `Revenue-2026-03-23T14_48_19.846Z.csv` — 23 revenue channels, monthly Jan-Dec
- `Direct Costs-2026-03-23T14_48_25.000Z.csv` — 31 cost lines including Bemböle contract brewing (€25K/mo)
- `Personnel-2026-03-23T14_48_29.274Z.csv` — 11 headcount, €47,425/mo
- `Expenses-2026-03-23T14_48_33.558Z.csv` — 14 expense categories
- `Loans & Investments-2026-03-23T14_48_53.990Z.csv` — OP loan details

## Key Business Context
- Salama Brewing is a Finnish craft brewery (Kerava production, Bemböle contract brewing + shop in Espoo)
- Highly seasonal: Aug peak €282K revenue, Dec trough €154K
- Bemböle contract brewing brings €25K/mo — do NOT close Bemböle
- Finnish TES notice periods: 1-month (Wang, Laitila), 2-month (most), 3-month (Honkonen/brewmaster, Ailio/sales dir), 6-month (CEO)
- Gross margin ~58%
- OP bank loan: ~€15,356/mo principal repayment
- Junior/convertible debt (€140K): converting to equity, confirmed

## People
- **Rene Kromhof** — Cloudberry VC, board member, driving this project
- **Salama CEO** — Honkonen (6-month notice period)
- **Salama finance** — sends Procountor data, needs to activate API
