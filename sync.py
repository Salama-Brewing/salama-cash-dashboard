#!/usr/bin/env python3
"""
Salama Brewing — Procountor Cash Flow Sync
============================================
Fetches invoice + bank data from Procountor API, calculates working capital
metrics (DSO/DPO/CCC), builds a 13-week rolling cash forecast, and writes
everything to data/cash_data.json for the dashboard to consume.

Usage:
  python sync.py              # pull live data from Procountor API
  python sync.py --demo       # generate realistic demo data (no API needed)
  python sync.py --demo --out data/cash_data_demo.json
"""

import os
import json
import sys
import argparse
import random
from datetime import datetime, date, timedelta
from calendar import monthrange
from collections import defaultdict
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False


# ── Configuration ─────────────────────────────────────────────────────────────

PROCOUNTOR_PROD = "https://api.procountor.com/api"
PROCOUNTOR_TEST = "https://api-test.procountor.com/api"

DEFAULT_OUT = Path(__file__).parent / "data" / "cash_data.json"

# Fixed monthly outflows — amounts and timing from Procountor actuals + handoff doc
FIXED_OUTFLOWS = [
    {"name": "OP Bank Loan",    "amount": 15356, "rule": "last_day",  "category": "debt"},
    {"name": "Salary (1st)",    "amount": 23713, "rule": "day", "day": 15, "category": "payroll"},
    {"name": "Salary (2nd)",    "amount": 23712, "rule": "day", "day": 28, "category": "payroll"},
    {"name": "Rent – Kerava",   "amount": 12350, "rule": "day", "day": 5,  "category": "rent"},
    {"name": "Rent – Espoo",    "amount": 2406,  "rule": "day", "day": 5,  "category": "rent"},
    {"name": "Lease (cold/car)","amount": 2200,  "rule": "day", "day": 10, "category": "lease"},
    {"name": "ICT",             "amount": 1700,  "rule": "day", "day": 15, "category": "opex"},
]

# LivePlan Original scenario — revenue + cost forecasts from CSVs (2026)
LIVEPLAN = {
    1:  {"revenue": 116575, "direct_costs": 49424, "expenses": 49773},
    2:  {"revenue": 167111, "direct_costs": 71516, "expenses": 48273},
    3:  {"revenue": 174194, "direct_costs": 73158, "expenses": 53302},
    4:  {"revenue": 201863, "direct_costs": 84585, "expenses": 54567},
    5:  {"revenue": 204761, "direct_costs": 85188, "expenses": 54831},
    6:  {"revenue": 209750, "direct_costs": 85911, "expenses": 57831},
    7:  {"revenue": 229261, "direct_costs": 97265, "expenses": 61831},
    8:  {"revenue": 281684, "direct_costs": 115769,"expenses": 62331},
    9:  {"revenue": 234374, "direct_costs": 96969, "expenses": 62861},
    10: {"revenue": 188881, "direct_costs": 77412, "expenses": 58861},
    11: {"revenue": 209865, "direct_costs": 85794, "expenses": 59125},
    12: {"revenue": 154095, "direct_costs": 61371, "expenses": 59125},
}

# Customer revenue mix and historical DSO (days to pay after invoice date)
CUSTOMERS = [
    {"name": "Kesko (direct)",  "share": 0.163, "dso": 25, "type": "retail"},
    {"name": "SOK Central",     "share": 0.112, "dso": 35, "type": "retail"},
    {"name": "SOK Bars",        "share": 0.027, "dso": 35, "type": "on_trade"},
    {"name": "Alko",            "share": 0.031, "dso": 20, "type": "retail"},
    {"name": "Espoo Shop",      "share": 0.090, "dso": 0,  "type": "direct"},
    {"name": "Online Shop",     "share": 0.082, "dso": 3,  "type": "direct"},
    {"name": "Bars & Pubs FI",  "share": 0.161, "dso": 40, "type": "on_trade"},
    {"name": "Export (Brill)",  "share": 0.099, "dso": 50, "type": "export"},
    {"name": "Systembolaget",   "share": 0.030, "dso": 45, "type": "export"},
    {"name": "Salama Own Bars", "share": 0.054, "dso": 0,  "type": "direct"},
    {"name": "Other Export",    "share": 0.151, "dso": 55, "type": "export"},
]

# Supplier payment terms (DPO)
SUPPLIERS = [
    {"name": "Malt & grain",     "share": 0.30, "dpo": 30, "category": "materials"},
    {"name": "Hops",             "share": 0.08, "dpo": 21, "category": "materials"},
    {"name": "Cans & packaging", "share": 0.25, "dpo": 14, "category": "packaging"},
    {"name": "Alko excise tax",  "share": 0.20, "dpo": 10, "category": "tax"},
    {"name": "Logistics",        "share": 0.10, "dpo": 21, "category": "logistics"},
    {"name": "Other suppliers",  "share": 0.07, "dpo": 30, "category": "other"},
]

# Seasonal DSO adjustment by month (days above/below customer base DSO)
# Finnish hospitality: customers pay slowest in summer peak (Aug pubs very busy, admin backlog)
SEASONAL_DSO_FACTOR = {
    1: -2, 2: -3, 3: -1, 4:  1, 5:  4,
    6:  6, 7:  9, 8: 11, 9:  5, 10:  1, 11: -1, 12:  3,
}


# ── Procountor API Client ─────────────────────────────────────────────────────

class ProcountorClient:
    """OAuth2 client for the Procountor API."""

    def __init__(self, client_id, client_secret, username, password, test_env=False):
        self.base = PROCOUNTOR_TEST if test_env else PROCOUNTOR_PROD
        self.token_url = f"{self.base}/oauth/token"
        self.client_id = client_id
        self.client_secret = client_secret
        self.username = username
        self.password = password
        self._token = None
        self._token_expiry = None

    def _get_token(self):
        """Fetch OAuth2 access token using Resource Owner Password Credentials grant."""
        if not HAS_REQUESTS:
            raise RuntimeError("pip install requests")
        resp = requests.post(self.token_url, data={
            "grant_type":    "password",
            "client_id":     self.client_id,
            "client_secret": self.client_secret,
            "username":      self.username,
            "password":      self.password,
        }, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self._token_expiry = datetime.now().timestamp() + data.get("expires_in", 3600) - 60
        return self._token

    def _auth_header(self):
        if not self._token or datetime.now().timestamp() > (self._token_expiry or 0):
            self._get_token()
        return {"Authorization": f"Bearer {self._token}"}

    def get(self, path, params=None):
        url = f"{self.base}/{path.lstrip('/')}"
        resp = requests.get(url, headers=self._auth_header(), params=params, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def post(self, path, body):
        url = f"{self.base}/{path.lstrip('/')}"
        resp = requests.post(url, headers={**self._auth_header(), "Content-Type": "application/json"},
                             json=body, timeout=30)
        resp.raise_for_status()
        return resp.json()

    # ── Data fetchers ──────────────────────────────────────────────────────

    def get_all_invoices(self, months_back=18):
        """Fetch all sales and purchase invoices for working capital analysis."""
        since = (date.today() - timedelta(days=months_back * 30)).isoformat()
        invoices = []
        page = 0
        while True:
            batch = self.get("/invoices", params={
                "startDate": since,
                "page": page,
                "size": 100,
            })
            items = batch.get("results", batch) if isinstance(batch, dict) else batch
            if not items:
                break
            invoices.extend(items)
            if len(items) < 100:
                break
            page += 1
        return invoices

    def get_bank_balance(self):
        """Get the latest bank statement balance."""
        statements = self.get("/bankstatements")
        if not statements:
            return None
        # Most recent statement first
        latest = sorted(statements, key=lambda s: s.get("endDate", ""), reverse=True)[0]
        stmt_id = latest.get("id")
        events = self.get(f"/bankstatements/{stmt_id}/events")
        return {
            "balance": latest.get("endBalance", 0),
            "balance_date": latest.get("endDate"),
            "statement_id": stmt_id,
            "recent_transactions": events[:20] if events else [],
        }

    def get_open_receivables(self):
        """Get unpaid sales invoices."""
        return self.get("/invoices", params={"invoiceType": "SALES_INVOICE", "status": "UNPAID"})

    def get_open_payables(self):
        """Get unpaid purchase invoices."""
        return self.get("/invoices", params={"invoiceType": "PURCHASE_INVOICE", "status": "UNPAID"})


# ── Working Capital Engine ────────────────────────────────────────────────────

class WorkingCapitalEngine:
    """
    Calculates DSO, DPO, CCC, and aging buckets from historical invoice data.
    DSO = average days from invoice date to payment date, per customer.
    DPO = average days from invoice date to payment date, per supplier.
    """

    def __init__(self, invoices):
        self.invoices = invoices
        self.sales = [i for i in invoices if i.get("type") in ("SALES_INVOICE", "sales")]
        self.purchases = [i for i in invoices if i.get("type") in ("PURCHASE_INVOICE", "purchase")]

    def _parse_date(self, d):
        if not d:
            return None
        if isinstance(d, date):
            return d
        try:
            return date.fromisoformat(str(d)[:10])
        except ValueError:
            return None

    def _days_to_pay(self, invoice):
        inv_date = self._parse_date(invoice.get("date") or invoice.get("invoiceDate"))
        pay_date = self._parse_date(invoice.get("paymentDate") or invoice.get("paidDate"))
        if inv_date and pay_date and pay_date >= inv_date:
            return (pay_date - inv_date).days
        return None

    def dso_by_customer(self):
        """DSO per customer from paid invoices (trailing 12 months)."""
        cutoff = date.today() - timedelta(days=365)
        buckets = defaultdict(list)
        for inv in self.sales:
            inv_date = self._parse_date(inv.get("date") or inv.get("invoiceDate"))
            if inv_date and inv_date >= cutoff:
                days = self._days_to_pay(inv)
                if days is not None:
                    name = inv.get("counterpartyName") or inv.get("partnerName") or "Unknown"
                    buckets[name].append(days)
        return {k: round(sum(v) / len(v), 1) for k, v in buckets.items() if v}

    def dso_overall(self):
        """Overall DSO (revenue-weighted average)."""
        cutoff = date.today() - timedelta(days=365)
        days_list = []
        for inv in self.sales:
            inv_date = self._parse_date(inv.get("date") or inv.get("invoiceDate"))
            if inv_date and inv_date >= cutoff:
                days = self._days_to_pay(inv)
                if days is not None:
                    days_list.append(days)
        return round(sum(days_list) / len(days_list), 1) if days_list else None

    def dpo_by_supplier(self):
        """DPO per supplier from paid purchase invoices (trailing 12 months)."""
        cutoff = date.today() - timedelta(days=365)
        buckets = defaultdict(list)
        for inv in self.purchases:
            inv_date = self._parse_date(inv.get("date") or inv.get("invoiceDate"))
            if inv_date and inv_date >= cutoff:
                days = self._days_to_pay(inv)
                if days is not None:
                    name = inv.get("counterpartyName") or inv.get("partnerName") or "Unknown"
                    buckets[name].append(days)
        return {k: round(sum(v) / len(v), 1) for k, v in buckets.items() if v}

    def dpo_overall(self):
        cutoff = date.today() - timedelta(days=365)
        days_list = []
        for inv in self.purchases:
            inv_date = self._parse_date(inv.get("date") or inv.get("invoiceDate"))
            if inv_date and inv_date >= cutoff:
                days = self._days_to_pay(inv)
                if days is not None:
                    days_list.append(days)
        return round(sum(days_list) / len(days_list), 1) if days_list else None

    def ar_aging(self, as_of=None):
        """Accounts receivable aging buckets for all open/unpaid sales invoices."""
        today = as_of or date.today()
        buckets = {"0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0}
        for inv in self.sales:
            if inv.get("status") in ("UNPAID", "OVERDUE", "open"):
                due = self._parse_date(inv.get("dueDate"))
                amount = float(inv.get("totalAmount") or inv.get("amount") or 0)
                if due:
                    overdue_days = (today - due).days
                    if overdue_days <= 0:
                        buckets["0_30"] += amount
                    elif overdue_days <= 30:
                        buckets["0_30"] += amount
                    elif overdue_days <= 60:
                        buckets["31_60"] += amount
                    elif overdue_days <= 90:
                        buckets["61_90"] += amount
                    else:
                        buckets["90_plus"] += amount
        return {k: round(v, 2) for k, v in buckets.items()}

    def ap_aging(self, as_of=None):
        """Accounts payable aging buckets for all open purchase invoices."""
        today = as_of or date.today()
        buckets = {"0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0}
        for inv in self.purchases:
            if inv.get("status") in ("UNPAID", "OVERDUE", "open"):
                due = self._parse_date(inv.get("dueDate"))
                amount = float(inv.get("totalAmount") or inv.get("amount") or 0)
                if due:
                    overdue_days = (today - due).days
                    if overdue_days <= 0:
                        buckets["0_30"] += amount
                    elif overdue_days <= 30:
                        buckets["0_30"] += amount
                    elif overdue_days <= 60:
                        buckets["31_60"] += amount
                    elif overdue_days <= 90:
                        buckets["61_90"] += amount
                    else:
                        buckets["90_plus"] += amount
        return {k: round(v, 2) for k, v in buckets.items()}

    def monthly_wc_trends(self, months=18):
        """
        Monthly DSO/DPO/CCC/revenue trends for Working Capital tab.
        Shows seasonal patterns over trailing months.
        """
        today = date.today()
        trends = []
        for i in range(months - 1, -1, -1):
            # Calculate month N months ago
            m = (today.month - 1 - i) % 12 + 1
            y = today.year + ((today.month - 1 - i) // 12)
            month_start = date(y, m, 1)
            month_end = date(y, m, monthrange(y, m)[1])
            label = month_start.strftime('%b %Y')

            paid_sales = [
                inv for inv in self.sales
                if inv.get('status') == 'PAID'
                and self._parse_date(inv.get('date') or inv.get('invoiceDate'))
                and month_start <= self._parse_date(inv.get('date') or inv.get('invoiceDate')) <= month_end
            ]
            dso_vals = [d for d in (self._days_to_pay(inv) for inv in paid_sales) if d is not None]
            dso = round(sum(dso_vals) / len(dso_vals), 1) if dso_vals else None
            revenue_billed = sum(float(inv.get('totalAmount', 0)) for inv in paid_sales)

            paid_purch = [
                inv for inv in self.purchases
                if inv.get('status') == 'PAID'
                and self._parse_date(inv.get('date') or inv.get('invoiceDate'))
                and month_start <= self._parse_date(inv.get('date') or inv.get('invoiceDate')) <= month_end
            ]
            dpo_vals = [d for d in (self._days_to_pay(inv) for inv in paid_purch) if d is not None]
            dpo = round(sum(dpo_vals) / len(dpo_vals), 1) if dpo_vals else None
            costs_billed = sum(float(inv.get('totalAmount', 0)) for inv in paid_purch)

            days_in_month = monthrange(y, m)[1]
            ar_at_eom = round(revenue_billed * (dso or 30) / days_in_month, 0) if revenue_billed else 0
            ap_at_eom = round(costs_billed * (dpo or 21) / days_in_month, 0) if costs_billed else 0

            trends.append({
                'month': month_start.strftime('%Y-%m'),
                'label': label,
                'month_num': m,
                'revenue_billed': round(revenue_billed, 0),
                'costs_billed': round(costs_billed, 0),
                'dso': dso,
                'dpo': dpo,
                'ccc': round((dso or 0) - (dpo or 0), 1) if dso and dpo else None,
                'ar_at_eom': ar_at_eom,
                'ap_at_eom': ap_at_eom,
                'wc_need': round(ar_at_eom - ap_at_eom, 0),
                'ar_pct_revenue': round(ar_at_eom / revenue_billed, 3) if revenue_billed > 0 else None,
                'data_type': 'actual',
            })
        return trends

    def monthly_trend(self, months=12):
        """DSO/DPO trend by month for the Working Capital tab."""
        trend = []
        for i in range(months - 1, -1, -1):
            month_end = date.today().replace(day=1) - timedelta(days=1) - timedelta(days=30 * i)
            month_start = month_end.replace(day=1)
            label = month_start.strftime("%b %Y")
            sales_days = []
            for inv in self.sales:
                inv_date = self._parse_date(inv.get("date") or inv.get("invoiceDate"))
                if inv_date and month_start <= inv_date <= month_end:
                    days = self._days_to_pay(inv)
                    if days is not None:
                        sales_days.append(days)
            purch_days = []
            for inv in self.purchases:
                inv_date = self._parse_date(inv.get("date") or inv.get("invoiceDate"))
                if inv_date and month_start <= inv_date <= month_end:
                    days = self._days_to_pay(inv)
                    if days is not None:
                        purch_days.append(days)
            trend.append({
                "month": label,
                "dso": round(sum(sales_days) / len(sales_days), 1) if sales_days else None,
                "dpo": round(sum(purch_days) / len(purch_days), 1) if purch_days else None,
            })
        return trend


# ── 13-Week Rolling Forecast ──────────────────────────────────────────────────

class ForecastBuilder:
    """
    Builds a 13-week (91-day) rolling cash forecast.

    Weeks 1-4:  Driven by actual open invoices from Procountor (high accuracy).
    Weeks 5-13: Blends into LivePlan scenario revenue forecasts (directional).

    Fixed outflows (loan, salary, rent) are placed on their exact calendar dates.
    Customer-specific DSO is used to predict actual payment dates from due dates.
    """

    def __init__(self, opening_balance, open_receivables, open_payables,
                 dso_by_customer=None, dpo_by_supplier=None, scenario="original"):
        self.opening_balance = opening_balance
        self.open_receivables = open_receivables  # unpaid sales invoices
        self.open_payables = open_payables          # unpaid purchase invoices
        self.dso_by_customer = dso_by_customer or {}
        self.dpo_by_supplier = dpo_by_supplier or {}
        self.scenario = scenario
        self.today = date.today()

    def _parse_date(self, d):
        if not d:
            return None
        if isinstance(d, date):
            return d
        try:
            return date.fromisoformat(str(d)[:10])
        except ValueError:
            return None

    def _last_day_of_month(self, y, m):
        return date(y, m, monthrange(y, m)[1])

    def _fixed_outflow_dates(self, start, end):
        """Generate all fixed outflow events between start and end dates."""
        events = []
        current = start.replace(day=1)
        while current <= end:
            y, m = current.year, current.month
            for outflow in FIXED_OUTFLOWS:
                if outflow["rule"] == "last_day":
                    d = self._last_day_of_month(y, m)
                elif outflow["rule"] == "day":
                    day = min(outflow["day"], monthrange(y, m)[1])
                    d = date(y, m, day)
                else:
                    continue
                if start <= d <= end:
                    events.append({
                        "date": d.isoformat(),
                        "amount": -outflow["amount"],
                        "description": outflow["name"],
                        "type": "fixed_outflow",
                        "category": outflow.get("category", "fixed"),
                    })
            # Advance to next month
            if m == 12:
                current = date(y + 1, 1, 1)
            else:
                current = date(y, m + 1, 1)
        return events

    def _invoice_cash_events(self):
        """
        Convert open invoices into expected cash events.
        Payment date = due_date + DSO adjustment (how many days past due this customer typically pays).
        """
        events = []
        end = self.today + timedelta(days=91)

        for inv in self.open_receivables:
            due = self._parse_date(inv.get("dueDate"))
            if not due:
                continue
            customer = inv.get("counterpartyName") or inv.get("partnerName") or "Unknown"
            dso = self.dso_by_customer.get(customer, 30)
            # Expected payment = due date + (dso - typical terms, roughly due-date lag)
            # Simplified: if dso > 0 we expect payment on the due date in best case,
            # or dso days after invoice date if that's later
            inv_date = self._parse_date(inv.get("date") or inv.get("invoiceDate")) or due - timedelta(days=30)
            expected_pay = inv_date + timedelta(days=dso)
            if expected_pay < self.today:
                expected_pay = self.today + timedelta(days=3)  # overdue — expect soon
            if expected_pay > end:
                continue
            amount = float(inv.get("totalAmount") or inv.get("amount") or 0)
            events.append({
                "date": expected_pay.isoformat(),
                "amount": round(amount, 2),
                "description": f"Receivable: {customer}",
                "type": "receivable",
                "category": "revenue",
                "invoice_id": inv.get("id"),
                "customer": customer,
                "confidence": "high" if (expected_pay - self.today).days <= 28 else "medium",
            })

        for inv in self.open_payables:
            due = self._parse_date(inv.get("dueDate"))
            if not due:
                continue
            supplier = inv.get("counterpartyName") or inv.get("partnerName") or "Unknown"
            expected_pay = max(due, self.today)
            if expected_pay > end:
                continue
            amount = float(inv.get("totalAmount") or inv.get("amount") or 0)
            events.append({
                "date": expected_pay.isoformat(),
                "amount": -round(amount, 2),
                "description": f"Payable: {supplier}",
                "type": "payable",
                "category": "purchase",
                "invoice_id": inv.get("id"),
                "supplier": supplier,
                "confidence": "high",
            })

        return events

    def _liveplan_cash_events(self, week_start, week_end):
        """
        For weeks 5-13, use LivePlan revenue/cost data to estimate weekly cash flows.
        Apply customer DSO mix to spread revenue over collection timing.
        """
        events = []
        m = week_start.month
        plan = LIVEPLAN.get(m, LIVEPLAN.get(12))
        days_in_month = monthrange(week_start.year, m)[1]

        # Weekly share of monthly revenue/costs
        week_days = (week_end - week_start).days + 1
        week_fraction = week_days / days_in_month

        # Revenue: apply customer DSO mix to spread cash-in timing
        for customer in CUSTOMERS:
            cust_revenue = plan["revenue"] * customer["share"] * week_fraction
            dso = self.dso_by_customer.get(customer["name"], customer["dso"])
            # Cash arrives dso days after invoicing (mid-week)
            cash_date = week_start + timedelta(days=dso % 7 + 1)
            if cash_date > week_end:
                cash_date = week_end
            events.append({
                "date": cash_date.isoformat(),
                "amount": round(cust_revenue, 2),
                "description": f"Revenue forecast: {customer['name']}",
                "type": "liveplan_revenue",
                "category": "revenue",
                "confidence": "low",
            })

        # Direct costs outflow (spread across week)
        cost_outflow = (plan["direct_costs"] + plan["expenses"]) * week_fraction
        events.append({
            "date": (week_start + timedelta(days=2)).isoformat(),
            "amount": -round(cost_outflow, 2),
            "description": "Operating costs (LivePlan forecast)",
            "type": "liveplan_costs",
            "category": "costs",
            "confidence": "low",
        })

        return events

    def build(self):
        """Build the full 13-week daily forecast."""
        end = self.today + timedelta(days=90)

        # Gather all cash events
        events = []
        events.extend(self._fixed_outflow_dates(self.today, end))
        events.extend(self._invoice_cash_events())

        # Add LivePlan events for weeks 5-13 (day 29+)
        liveplan_start = self.today + timedelta(days=28)
        week = liveplan_start
        while week <= end:
            week_end = min(week + timedelta(days=6), end)
            events.extend(self._liveplan_cash_events(week, week_end))
            week += timedelta(days=7)

        # Build day-by-day forecast
        events_by_date = defaultdict(list)
        for ev in events:
            events_by_date[ev["date"]].append(ev)

        daily = []
        balance = self.opening_balance
        for i in range(91):
            d = self.today + timedelta(days=i)
            d_str = d.isoformat()
            day_events = events_by_date.get(d_str, [])
            cash_in = sum(e["amount"] for e in day_events if e["amount"] > 0)
            cash_out = sum(e["amount"] for e in day_events if e["amount"] < 0)
            closing = balance + cash_in + cash_out
            daily.append({
                "date": d_str,
                "opening": round(balance, 2),
                "cash_in": round(cash_in, 2),
                "cash_out": round(cash_out, 2),
                "closing": round(closing, 2),
                "events": day_events,
            })
            balance = closing

        # Aggregate into 13 weeks
        weeks = []
        for w in range(13):
            start_i = w * 7
            end_i = min(start_i + 6, 90)
            week_days = daily[start_i:end_i + 1]
            week_in = sum(d["cash_in"] for d in week_days)
            week_out = sum(d["cash_out"] for d in week_days)
            # Confidence: weeks 1-4 = high (actual invoices), 5-13 = low (LivePlan)
            conf = "high" if w < 4 else ("medium" if w < 7 else "low")
            weeks.append({
                "week": w + 1,
                "label": f"W{w + 1}: {week_days[0]['date']} – {week_days[-1]['date']}",
                "start_date": week_days[0]["date"],
                "end_date": week_days[-1]["date"],
                "opening_balance": week_days[0]["opening"],
                "cash_in": round(week_in, 2),
                "cash_out": round(week_out, 2),
                "net": round(week_in + week_out, 2),
                "closing_balance": week_days[-1]["closing"],
                "confidence": conf,
            })

        return {"weeks": weeks, "daily": daily}


def build_wc_revenue_forecast(dso_by_month, dpo_by_month, months_forward=9):
    """
    Forward-looking working capital forecast using LivePlan REVENUES (not cash).

    Key insight: LivePlan cash flow is wrong (doesn't model WC timing).
    Instead we take LivePlan revenues and apply seasonal DSO to get actual cash timing.
    This converts "€202K April revenue" into a week-by-week cash collection schedule.
    """
    today = date.today()
    forecast = []
    prev_ar = 0.0

    for i in range(months_forward):
        m = (today.month + i - 1) % 12 + 1
        y = today.year + (today.month + i - 1) // 12
        plan = LIVEPLAN.get(m, LIVEPLAN.get(12, {}))
        revenue = plan.get('revenue', 0)
        days_in_month = monthrange(y, m)[1]

        # Seasonal DSO for this month (from historical averages or base customer DSO)
        dso = dso_by_month.get(m, 30 + SEASONAL_DSO_FACTOR.get(m, 0))
        dpo = dpo_by_month.get(m, 22)

        # Cash collected this month = previous AR × collection_rate + current revenue × same-month collection
        # collection_rate = fraction of DSO cycle that completes within the month
        same_month_collection = max(0, revenue * (1 - dso / days_in_month)) if dso < days_in_month else 0
        from_prior_ar = prev_ar * min(1.0, days_in_month / max(dso, 1))
        cash_in_from_revenue = round(same_month_collection + from_prior_ar, 0)

        ar_at_eom = round(revenue - same_month_collection, 0)
        costs = plan.get('direct_costs', 0) + plan.get('expenses', 0)
        ap_at_eom = round(costs * dpo / days_in_month, 0)
        wc_need = round(ar_at_eom - ap_at_eom, 0)

        forecast.append({
            'month': date(y, m, 1).strftime('%Y-%m'),
            'label': date(y, m, 1).strftime('%b %Y'),
            'month_num': m,
            'liveplan_revenue': revenue,
            'projected_dso': dso,
            'projected_dpo': dpo,
            'cash_in_from_revenue': cash_in_from_revenue,
            'ar_at_eom': ar_at_eom,
            'ap_at_eom': ap_at_eom,
            'wc_need': wc_need,
            'ar_pct_revenue': round(ar_at_eom / revenue, 3) if revenue > 0 else 0,
            'data_type': 'forecast',
            'note': f'LivePlan revenue €{revenue:,.0f}, DSO {dso}d → €{cash_in_from_revenue:,.0f} cash collected',
        })
        prev_ar = ar_at_eom

    return forecast


# ── Demo Data Generator ───────────────────────────────────────────────────────

def generate_demo_data(base_date=None):
    """
    Generate realistic demo data based on LivePlan forecasts + typical payment patterns.
    Uses March 2026 as the base period. No API credentials needed.
    """
    rng = random.Random(42)  # fixed seed for reproducibility
    today = base_date or date.today()

    # Bank balance: March has been rough (tax payment hit today)
    # Procountor shows -€64K by March 31; we're heading there
    bank_balance = -5200  # approximate today's balance after tax payment
    bank_date = today.isoformat()

    # ── Open Sales Invoices (receivables) ────────────────────────────────
    sales_invoices = []
    inv_id = 1000

    # March invoices — most not yet paid (sent ~Mar 1-15, due in 14-30 days)
    march_revenue = LIVEPLAN[3]["revenue"]
    for customer in CUSTOMERS:
        cust_rev = march_revenue * customer["share"]
        if cust_rev < 500:
            continue
        # 1-3 invoices per customer depending on size
        n_invoices = 3 if cust_rev > 20000 else (2 if cust_rev > 8000 else 1)
        for j in range(n_invoices):
            inv_amount = cust_rev / n_invoices * rng.uniform(0.85, 1.15)
            inv_day = rng.randint(1, 20)
            inv_date = date(2026, 3, inv_day)
            due_date = inv_date + timedelta(days=rng.randint(14, 30))
            dso = customer["dso"]
            expected_pay = inv_date + timedelta(days=dso)
            status = "OVERDUE" if due_date < today else "UNPAID"
            sales_invoices.append({
                "id": inv_id,
                "type": "SALES_INVOICE",
                "date": inv_date.isoformat(),
                "dueDate": due_date.isoformat(),
                "counterpartyName": customer["name"],
                "totalAmount": round(inv_amount, 2),
                "status": status,
                "currency": "EUR",
                "expectedPaymentDate": expected_pay.isoformat(),
            })
            inv_id += 1

    # Some February invoices still unpaid (overdue — slow payers)
    feb_overdue_customers = ["Bars & Pubs FI", "Other Export", "Export (Brill)"]
    for cust_name in feb_overdue_customers:
        cust = next(c for c in CUSTOMERS if c["name"] == cust_name)
        inv_amount = LIVEPLAN[2]["revenue"] * cust["share"] * rng.uniform(0.4, 0.7)
        inv_date = date(2026, 2, rng.randint(10, 25))
        due_date = inv_date + timedelta(days=21)
        sales_invoices.append({
            "id": inv_id,
            "type": "SALES_INVOICE",
            "date": inv_date.isoformat(),
            "dueDate": due_date.isoformat(),
            "counterpartyName": cust_name,
            "totalAmount": round(inv_amount, 2),
            "status": "OVERDUE",
            "currency": "EUR",
            "expectedPaymentDate": (today + timedelta(days=rng.randint(3, 14))).isoformat(),
        })
        inv_id += 1

    # ── Open Purchase Invoices (payables) ─────────────────────────────────
    purchase_invoices = []
    pinv_id = 5000

    march_costs = LIVEPLAN[3]["direct_costs"]
    for supplier in SUPPLIERS:
        sup_cost = march_costs * supplier["share"]
        n_invoices = 2 if sup_cost > 15000 else 1
        for j in range(n_invoices):
            inv_amount = sup_cost / n_invoices * rng.uniform(0.9, 1.1)
            inv_day = rng.randint(1, 15)
            inv_date = date(2026, 3, inv_day)
            due_date = inv_date + timedelta(days=supplier["dpo"])
            status = "OVERDUE" if due_date < today else "UNPAID"
            purchase_invoices.append({
                "id": pinv_id,
                "type": "PURCHASE_INVOICE",
                "date": inv_date.isoformat(),
                "dueDate": due_date.isoformat(),
                "counterpartyName": supplier["name"],
                "totalAmount": round(inv_amount, 2),
                "status": status,
                "currency": "EUR",
            })
            pinv_id += 1

    # ── Historical invoices for WC analytics (18 months of seasonal paid history) ──
    historical = []
    for months_back in range(1, 19):  # 18 months of history
        # Calculate the month date
        mb = months_back
        hist_m = (today.month - mb - 1) % 12 + 1
        hist_y = today.year + (today.month - mb - 1) // 12
        hist_date = date(hist_y, hist_m, 1)
        hist_month = hist_date.month
        hist_year = hist_date.year

        # Revenue scaling: 2025 = ~84% of 2026 plan, 2024 = ~70%
        year_scale = 0.84 if months_back <= 12 else 0.70
        plan = LIVEPLAN.get(hist_month, LIVEPLAN.get(12, {}))
        plan_revenue = plan.get('revenue', 150000) * year_scale
        plan_costs = plan.get('direct_costs', 60000) * year_scale

        days_in_month = monthrange(hist_year, hist_month)[1]
        seasonal_adj = SEASONAL_DSO_FACTOR.get(hist_month, 0)

        for customer in CUSTOMERS:
            cust_rev = plan_revenue * customer['share']
            if cust_rev < 300:
                continue
            inv_day = rng.randint(1, min(20, days_in_month))
            inv_date = date(hist_year, hist_month, inv_day)
            # DSO with seasonal adjustment + small random variance
            dso = max(customer['dso'] + seasonal_adj + rng.randint(-4, 6), 3)
            pay_date = inv_date + timedelta(days=dso)
            historical.append({
                'id': inv_id,
                'type': 'SALES_INVOICE',
                'date': inv_date.isoformat(),
                'dueDate': (inv_date + timedelta(days=21)).isoformat(),
                'paymentDate': pay_date.isoformat(),
                'counterpartyName': customer['name'],
                'totalAmount': round(cust_rev * rng.uniform(0.88, 1.12), 2),
                'status': 'PAID',
                'currency': 'EUR',
            })
            inv_id += 1

        for supplier in SUPPLIERS:
            sup_cost = plan_costs * supplier['share']
            inv_day = rng.randint(1, min(15, days_in_month))
            inv_date = date(hist_year, hist_month, inv_day)
            dpo = max(supplier['dpo'] + rng.randint(-3, 5), 5)
            pay_date = inv_date + timedelta(days=dpo)
            historical.append({
                'id': pinv_id,
                'type': 'PURCHASE_INVOICE',
                'date': inv_date.isoformat(),
                'dueDate': (inv_date + timedelta(days=supplier['dpo'])).isoformat(),
                'paymentDate': pay_date.isoformat(),
                'counterpartyName': supplier['name'],
                'totalAmount': round(sup_cost * rng.uniform(0.88, 1.12), 2),
                'status': 'PAID',
                'currency': 'EUR',
            })
            pinv_id += 1

    all_invoices = historical + sales_invoices + purchase_invoices

    # ── Working Capital Analytics ──────────────────────────────────────────
    wc = WorkingCapitalEngine(all_invoices)
    dso_customers = wc.dso_by_customer()
    dso_overall = wc.dso_overall()
    dpo_suppliers = wc.dpo_by_supplier()
    dpo_overall = wc.dpo_overall()
    ar_aging = wc.ar_aging(today)
    ap_aging = wc.ap_aging(today)
    monthly_trend = wc.monthly_trend(12)
    monthly_wc_trends = wc.monthly_wc_trends(18)

    # Build seasonal DSO/DPO averages by month number for WC revenue forecast
    dso_by_month = {}
    dpo_by_month = {}
    for t in monthly_wc_trends:
        m = t['month_num']
        if t['dso']:
            dso_by_month.setdefault(m, []).append(t['dso'])
        if t['dpo']:
            dpo_by_month.setdefault(m, []).append(t['dpo'])
    dso_by_month_avg = {m: round(sum(v)/len(v), 1) for m, v in dso_by_month.items()}
    dpo_by_month_avg = {m: round(sum(v)/len(v), 1) for m, v in dpo_by_month.items()}
    wc_revenue_forecast = build_wc_revenue_forecast(dso_by_month_avg, dpo_by_month_avg, months_forward=9)

    # ── 13-Week Forecast ────────────────────────────────────────────────────
    forecast = ForecastBuilder(
        opening_balance=bank_balance,
        open_receivables=sales_invoices,
        open_payables=purchase_invoices,
        dso_by_customer=dso_customers,
        dpo_by_supplier=dpo_suppliers,
    ).build()

    # ── Assemble output ────────────────────────────────────────────────────
    total_ar = sum(i["totalAmount"] for i in sales_invoices)
    total_ap = sum(i["totalAmount"] for i in purchase_invoices)

    # Top receivables by customer
    ar_by_customer = defaultdict(float)
    for inv in sales_invoices:
        ar_by_customer[inv["counterpartyName"]] += inv["totalAmount"]

    ap_by_supplier = defaultdict(float)
    for inv in purchase_invoices:
        ap_by_supplier[inv["counterpartyName"]] += inv["totalAmount"]

    return {
        "meta": {
            "generated_at": datetime.now().isoformat(),
            "mode": "demo",
            "base_date": today.isoformat(),
            "company": "Salama Brewing Company Oy",
            "scenario": "original",
        },
        "bank": {
            "balance": bank_balance,
            "balance_date": bank_date,
            "note": "Demo data — approximate balance after Mar 25 tax payment of €30,060",
            "procountor_eom_forecast": -64138,
            "liveplan_eom_forecast": 10391,
            "gap_explanation": "€74K gap = working capital timing LivePlan cannot model",
        },
        "receivables": {
            "total_open": round(total_ar, 2),
            "invoice_count": len(sales_invoices),
            "aging": ar_aging,
            "by_customer": [
                {"name": k, "amount": round(v, 2)}
                for k, v in sorted(ar_by_customer.items(), key=lambda x: -x[1])
            ],
            "invoices": sales_invoices,
        },
        "payables": {
            "total_open": round(total_ap, 2),
            "invoice_count": len(purchase_invoices),
            "aging": ap_aging,
            "by_supplier": [
                {"name": k, "amount": round(v, 2)}
                for k, v in sorted(ap_by_supplier.items(), key=lambda x: -x[1])
            ],
            "invoices": purchase_invoices,
        },
        "working_capital": {
            "dso_overall": dso_overall,
            "dpo_overall": dpo_overall,
            "ccc": round((dso_overall or 0) - (dpo_overall or 0), 1),
            "by_customer": dso_customers,
            "by_supplier": dpo_suppliers,
            "ar_aging": ar_aging,
            "ap_aging": ap_aging,
            "monthly_trend": monthly_trend,
            "monthly_wc_trends": monthly_wc_trends,
            "wc_revenue_forecast": wc_revenue_forecast,
            "dso_by_month": dso_by_month_avg,
            "dpo_by_month": dpo_by_month_avg,
        },
        "forecast": forecast,
        "liveplan": {m: v for m, v in LIVEPLAN.items()},
    }


# ── Live Sync ─────────────────────────────────────────────────────────────────

def sync_live(args):
    """Pull real data from Procountor and build the output JSON."""
    client_id     = os.getenv("PROCOUNTOR_CLIENT_ID")
    client_secret = os.getenv("PROCOUNTOR_CLIENT_SECRET")
    username      = os.getenv("PROCOUNTOR_USERNAME")
    password      = os.getenv("PROCOUNTOR_PASSWORD")
    test_env      = os.getenv("PROCOUNTOR_ENV", "").lower() == "test"

    missing = [k for k, v in {
        "PROCOUNTOR_CLIENT_ID": client_id,
        "PROCOUNTOR_CLIENT_SECRET": client_secret,
        "PROCOUNTOR_USERNAME": username,
        "PROCOUNTOR_PASSWORD": password,
    }.items() if not v]

    if missing:
        print(f"ERROR: Missing environment variables: {', '.join(missing)}")
        print("Copy .env.example to .env and fill in your Procountor credentials.")
        print("Or run with --demo to use demo data.")
        sys.exit(1)

    if not HAS_REQUESTS:
        print("ERROR: pip install requests")
        sys.exit(1)

    print("Connecting to Procountor API...")
    client = ProcountorClient(client_id, client_secret, username, password, test_env)

    print("Fetching bank balance...")
    bank = client.get_bank_balance()

    print("Fetching open receivables...")
    open_ar = client.get_open_receivables()

    print("Fetching open payables...")
    open_ap = client.get_open_payables()

    print("Fetching 18 months of invoice history for WC analytics...")
    all_invoices = client.get_all_invoices(months_back=18)
    print(f"  {len(all_invoices)} invoices fetched")

    # Working capital analytics
    wc = WorkingCapitalEngine(all_invoices)
    dso_customers = wc.dso_by_customer()
    dpo_suppliers = wc.dpo_by_supplier()

    # Forecast
    print("Building 13-week rolling forecast...")
    forecast = ForecastBuilder(
        opening_balance=bank["balance"],
        open_receivables=open_ar,
        open_payables=open_ap,
        dso_by_customer=dso_customers,
        dpo_by_supplier=dpo_suppliers,
    ).build()

    total_ar = sum(float(i.get("totalAmount", 0)) for i in open_ar)
    total_ap = sum(float(i.get("totalAmount", 0)) for i in open_ap)

    ar_by_customer = defaultdict(float)
    for inv in open_ar:
        ar_by_customer[inv.get("counterpartyName", "Unknown")] += float(inv.get("totalAmount", 0))
    ap_by_supplier = defaultdict(float)
    for inv in open_ap:
        ap_by_supplier[inv.get("counterpartyName", "Unknown")] += float(inv.get("totalAmount", 0))

    return {
        "meta": {
            "generated_at": datetime.now().isoformat(),
            "mode": "live",
            "base_date": date.today().isoformat(),
            "company": "Salama Brewing Company Oy",
            "scenario": "original",
        },
        "bank": bank,
        "receivables": {
            "total_open": round(total_ar, 2),
            "invoice_count": len(open_ar),
            "aging": wc.ar_aging(),
            "by_customer": [
                {"name": k, "amount": round(v, 2)}
                for k, v in sorted(ar_by_customer.items(), key=lambda x: -x[1])
            ],
            "invoices": open_ar,
        },
        "payables": {
            "total_open": round(total_ap, 2),
            "invoice_count": len(open_ap),
            "aging": wc.ap_aging(),
            "by_supplier": [
                {"name": k, "amount": round(v, 2)}
                for k, v in sorted(ap_by_supplier.items(), key=lambda x: -x[1])
            ],
            "invoices": open_ap,
        },
        "working_capital": {
            "dso_overall": wc.dso_overall(),
            "dpo_overall": wc.dpo_overall(),
            "ccc": round((wc.dso_overall() or 0) - (wc.dpo_overall() or 0), 1),
            "by_customer": dso_customers,
            "by_supplier": dpo_suppliers,
            "ar_aging": wc.ar_aging(),
            "ap_aging": wc.ap_aging(),
            "monthly_trend": wc.monthly_trend(12),
        },
        "forecast": forecast,
        "liveplan": {m: v for m, v in LIVEPLAN.items()},
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Salama Procountor Cash Flow Sync")
    parser.add_argument("--demo", action="store_true",
                        help="Generate demo data without API credentials")
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help=f"Output JSON path (default: {DEFAULT_OUT})")
    args = parser.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if args.demo:
        print("Generating demo data...")
        data = generate_demo_data()
    else:
        data = sync_live(args)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    balance = data["bank"]["balance"]
    ar = data["receivables"]["total_open"]
    ap = data["payables"]["total_open"]
    mode = data["meta"]["mode"].upper()
    print(f"\n[{mode}] {data['meta']['generated_at'][:16]}")
    print(f"  Bank balance:   €{balance:,.0f}")
    print(f"  Open AR:        €{ar:,.0f}")
    print(f"  Open AP:        €{ap:,.0f}")
    wc = data["working_capital"]
    print(f"  DSO (overall):  {wc['dso_overall']} days")
    print(f"  DPO (overall):  {wc['dpo_overall']} days")
    print(f"  CCC:            {wc['ccc']} days")
    low_weeks = [w for w in data["forecast"]["weeks"] if w["closing_balance"] < 20000]
    if low_weeks:
        print(f"\n  ⚠  Cash below €20K in {len(low_weeks)} forecast week(s):")
        for w in low_weeks[:3]:
            print(f"     {w['label']}: €{w['closing_balance']:,.0f}")
    print(f"\nWritten to: {out_path}")


if __name__ == "__main__":
    main()
