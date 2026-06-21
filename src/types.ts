/**
 * TypeScript interfaces mirroring the backend Pydantic models.
 * Shared across all frontend components and the API client.
 */

/** Request body for the POST /api/backtest endpoint */
export interface BacktestRequest {
  symbol: string;
  from_date: string; // ISO date string YYYY-MM-DD
  to_date: string;
  expiry_months: number;
  strike_offset: number;
}

/** A position that was rolled (closed and re-opened at a new strike) */
export interface RolledPosition {
  type: "PE" | "CE";
  old_strike: number;
  new_strike: number;
  pnl: number;
}

/** A position that expired or was closed */
export interface ClosedPosition {
  type: "PE" | "CE";
  strike: number;
  entry_date: string;
  pnl: number;
}

/** One row in the backtest results table — one per trading day */
export interface BacktestRow {
  date: string;
  price: number;
  new_pe: number | null;
  open_pes: number;
  new_ce: number | null;
  open_ces: number;
  rolled_today: RolledPosition[];
  closed_today: ClosedPosition[];
  pnl: number;
}

/** Full backtest response from the API */
export interface BacktestResponse {
  symbol: string;
  from_date: string;
  to_date: string;
  expiry_months: number;
  strike_offset: number;
  total_pnl: number;
  rows: BacktestRow[];
}

/** Historical price data point from GET /api/prices */
export interface PricePoint {
  date: string;
  close_price: number;
}

/** Input object for options analyzer */
export interface OptionsInput {
  expiryDate: string; // YYYY-MM-DD format
  date: string; // YYYY-MM-DD format (start date)
  strikePrice: number;
  symbol: string;
}

/** Premium data for a specific strike and date */
export interface StrikePremium {
  expiryDate: string;
  strike: number;
  closePrice: number;
  delta?: number | null;
  theta?: number | null;
  soldPrice?: number | null;
  costPrice?: number | null;
}

/** Result row for options analyzer table */
export interface OptionsAnalysisRow {
  date: string;
  closingPrice: number;
  ceStrike: number;
  peStrike: number;
  cePremiumData: StrikePremium | null; // Expiry date, strike, close price
  markChangeCall: number | null; // CE close - CE open
  pePremiumData: StrikePremium | null;
  markChangePut: number | null; // PE close - PE open
}
