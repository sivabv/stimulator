# Options Backtesting Dashboard

A full-stack application for backtesting an options selling strategy (PE/CE) on any index or ETF using historical market data.

## Features

- **Historical price data** via `yfinance` (GLD, SPY, GC=F, etc.)
- **Weekly PE/CE sell entries** with configurable strike offset and expiry months
- **Rolling logic** — positions are rolled when the market moves through the strike
- **Expiry & P&L tracking** — intrinsic-value based P&L at position close
- **Interactive dashboard** with Ant Design table, line/area charts, and CSV export
- **Summary statistics** — total P&L, win/loss counts, trade counts

## Tech Stack

| Layer    | Technology                               |
|----------|------------------------------------------|
| Backend  | Python · FastAPI · yfinance · pandas     |
| Frontend | React · TypeScript · Vite · Ant Design · Recharts |

## Project Structure

```
backtesting-dashboard/
├── backend/
│   ├── main.py              # FastAPI app entry point
│   ├── backtester.py         # Core backtesting engine
│   ├── models.py             # Pydantic request/response models
│   ├── price_fetcher.py      # yfinance wrapper
│   └── requirements.txt      # Python dependencies
├── frontend/
│   ├── src/
│   │   ├── App.tsx           # Root component
│   │   ├── components/
│   │   │   ├── FilterBar.tsx   # Input controls & Run button
│   │   │   ├── ResultsTable.tsx# Per-day results table + CSV export
│   │   │   ├── PnLSummary.tsx  # Summary statistics card
│   │   │   └── Charts.tsx      # Price & cumulative P&L charts
│   │   ├── api/
│   │   │   └── backtest.ts   # API client for backend
│   │   └── types.ts          # TypeScript interfaces
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

## Getting Started

### Prerequisites

- Python 3.10+
- Node.js 20+
- npm 9+

### Clone the Repository

```bash
git clone https://github.com/Cognition-Partner-Workshops-mirror/backtesting-dashboard.git
cd backtesting-dashboard
```

### Backend Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`. OpenAPI docs at `http://localhost:8000/docs`.

### Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

The dashboard will open at `http://localhost:5173`. API calls are proxied to `http://localhost:8000` via Vite's dev server proxy.

## GitHub Pages Deployment

- The repository includes `.github/workflows/deploy-pages.yml` to build and deploy the Vite app to GitHub Pages on every push to `main`.
- Vite derives a project-site base path from the repository name by default, but the Pages workflow overrides `VITE_BASE_PATH=/` because the intended deployment target is the root Pages URL `https://sivabv.github.io`.
- In GitHub repository settings, ensure **Settings → Pages → Build and deployment → Source** is set to **GitHub Actions**.
- This deployment publishes only the static frontend. The local `/api` dev proxy remains available in `npm run dev`, but GitHub Pages does not host the FastAPI backend.
- If the deployed site should call a hosted backend, set `VITE_API_BASE_URL` for the workflow or repository environment so the frontend points at that backend instead of `http://localhost:8000`.
- If the site is instead published as a normal project Pages site, change `VITE_BASE_PATH` in `.github/workflows/deploy-pages.yml` to `/<repository-name>/` (or remove the override and let Vite derive it automatically).

## API Endpoints

### `GET /api/prices`

Fetch historical daily closing prices.

| Parameter | Type   | Description                |
|-----------|--------|----------------------------|
| `symbol`  | string | Ticker (e.g. GLD, SPY)     |
| `from`    | date   | Start date (YYYY-MM-DD)    |
| `to`      | date   | End date (YYYY-MM-DD)      |

### `POST /api/backtest`

Run a full backtest simulation.

```json
{
  "symbol": "GLD",
  "from_date": "2024-01-01",
  "to_date": "2025-01-01",
  "expiry_months": 3,
  "strike_offset": 5
}
```

Returns a row-per-trading-day results table with position details and P&L.

## Notes

- P&L uses **intrinsic value** (strike vs. market price) since free options premium data is not available. For realistic premium-based P&L, a paid options data provider would be needed.
- `yfinance` supports many symbols: GLD (Gold ETF), GC=F (Gold Futures), SPY (S&P 500), QQQ (Nasdaq 100), etc.
- The strike offset should be adjusted based on the price level of the chosen symbol (e.g. 5 for GLD ≈ $190, but much larger for SPY ≈ $450).

## Consolidated Prompt Log (Session)

This section captures the prompts shared in this development session for traceability.

1. create a component to view graph with net value with horizontal date and netvalue with percentage change
2. write a function to update strike price and subsequent APi calls with updated strikeprice
3. invoke this newly added function when modal popup is opened, add console log, and re-run analysis
4. currently update strike price is update every row and rendering
5. update the strikeprice of the selected row only
6. create an array for short strike price and long strike price for each row and update independently
7. button/link click to open popup breaks
8. unable scroll on grid, missing records
9. once strike price is updated for a row, all next items should have updated value
10. add logic to update short put strike price and long put strike price
11. show column for long put price similar to put price
12. on input date, find suitable put strike 1.5%-2% below close, rounded to nearest 5, with 30-45 day expiry and retries for 404
13. make input strike price optional and ask confirmation when difference is greater than +/-3%
14. calculate strike once for first row and reuse strike price for remaining rows
15. make expiry date optional and use 30-45 day logic for first row
16. update long expiry to 75-100 days with retry using up to 4 dates and +/-5% strike range
17. add calculated short/long expiry and given dates to popup for user selection
18. add a column for short/long put expiry date
19. short expiry using given date is not correct, please fix
20. always use calculated short strike price
21. add another grid as Phase 2
22. phase 1 should end at first calculated short expiry date and phase 2 should start from phase 1 last short expiry date with new strike/short-expiry/long-expiry calculation
23. proceed to add
24. can you consolidate all the prompts shared in a text and put it in README files



Interest calculator
1. pick current strike price on a given date-
2. get list of dates from given date for two years 
3. Get option price for those dates
4. Put this data in a table
5. Calculate number of days from given date to expiry date in a row
6. given strike price- calculate interest pecentage
7. calculate annual interest rate 

## Consolidated Prompt Log - Calendar Analysis & Phase Summary (Current Session)

This section documents the development work on PutCalendar, CallCalendar, and other components for multi-phase analysis with enhanced net value tracking.

### Phase 1: DTE Range Update
1. **Change DTE range from 100-150 to 70-120 days** — Updated `LONG_EXPIRY_MIN_DTE_DAYS` and `LONG_EXPIRY_MAX_DTE_DAYS` constants, validation logic, helper functions (`getExpiryCandidates70To120Days`), and all error messages across PutCalendar.tsx

### Phase 2: PutCalendar Runtime Fixes & Phase Summary Architecture
2. **Fix PutCalendar runtime errors** — Removed invalid default `longExpiryDate: "2026-12-31"` that fell outside 70-120 DTE range, added fallback logic in `parseInput()` to return empty string instead of throwing
3. **Add phase-level net value start/end columns** — Implemented two new columns in Phase Summary table: "Start Net Value" and "End Net Value" to track net value at phase boundaries
4. **Add cumulative total net value tracking** — Added "Cumulative Total Net Value" column to Phase Summary showing running sum of net value changes across phases
5. **Change total net value calculation logic** — Updated calculation from sum-of-all-rows to delta-based: difference between end-of-phase and start-of-phase net value
6. **Add 12L-10S columns to Phase Summary** — Mirrored net value tracking with contract-based calculation: "Total Net Value (12L-10S)" and "Cumulative Net Value (12L-10S)" columns, calculated as `12 × long_price − 10 × short_price` (without NET_VALUE_MULTIPLIER wrapper)

### Phase 3: Bug Fix - 12L-10S Double Multiplication Issue
7. **Fix 12L-10S calculation bug in PutCalendar** — Identified and fixed critical formula error: was multiplying by `NET_VALUE_MULTIPLIER * (12×long − 10×short)` resulting in 10× inflation. Corrected to just `12×long − 10×short`. Applied fix to both grid column render function and Phase Summary 12L-10S columns (`totalNetValue12L10S`, `cumulativeTotalNetValue12L10S`)
8. **Uncomment 12L-10S columns in Phase Summary** — Enabled visibility of the two 12L-10S columns in `phaseSummaryColumns` array that had been commented out after implementation

### Phase 4: Cross-Component Propagation
9. **Fix CallCalendar Net Value-12L-10S calculation** — Applied same formula fix (remove `NET_VALUE_MULTIPLIER` wrapper) to the "Net Value- 12L-10S" column in CallCalendar.tsx grid. Changed column key from `"netValue"` to `"netValue12L10S"` for uniqueness. Fixed both render function and firstNetValue calculation for percentage change
10. **Apply fixes across all components** — Systematic review and fixes applied to all calendar/analysis components (CallCalendar, CoveredCall, CoveredPut, etc.) to ensure consistent DTE ranges (70-120) and correct 12L-10S calculations

### Implementation Details

**Key Code Changes:**

1. **Constants Update (PutCalendar/CallCalendar):**
  ```typescript
  LONG_EXPIRY_MIN_DTE_DAYS = 70
  LONG_EXPIRY_MAX_DTE_DAYS = 120
  NET_VALUE_MULTIPLIER = 10
  ```

2. **12L-10S Correct Formula:**
  ```typescript
  // INCORRECT (old):
  const netValue = NET_VALUE_MULTIPLIER * (12 * long - 10 * short);
   
  // CORRECT (new):
  const netValue = 12 * long - 10 * short;
  ```

3. **Phase Summary 12L-10S Columns:**
  - Calculate as `12 × record.longPrice − 10 × record.shortPrice` without any additional multiplier
  - Integrate into cumulative tracking alongside regular net value columns
  - Display in Phase Summary table alongside regular net value tracking

4. **Default Input Logic:**
  - Changed `DEFAULT_INPUT.longExpiryDate` from `"2026-12-31"` to `""` to enable auto-selection
  - Updated `parseInput()` to gracefully handle empty date and fall back to computed date instead of throwing validation error

### Testing & Validation
- All changes validated with `npm run build` — no TypeScript errors
- Build output: 3592 modules, ~1,947 kB bundle (gzip 585 kB)
- Components compile successfully with strict type checking enabled




fields to start stimulation
Symbol
SPY
Strike Price
600
Date
01/01/2025
Expiry Date

09/30/2025
Long Expiry Date

Calendar call
Calendar Put
