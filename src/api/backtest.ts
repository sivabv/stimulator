/**
 * API client for communicating with the FastAPI backend.
 * All backtest and price endpoints are defined here.
 */

import type { BacktestRequest, BacktestResponse, PricePoint } from "../types";

export interface OptionOpenClose {
  openPrice: number | null;
  closePrice: number | null;
  delta: number | null;
  theta: number | null;
  soldPrice?: number | null;
  costPrice?: number | null;
  statusCode: number | null;
}

// Base URL defaults to the FastAPI dev server; override via env var if needed
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

// Massive.com API configuration
const MASSIVE_API_KEY = "ZMR7fChWbrDYWqvT41rU_rE28HUEkQuS";
const MASSIVE_BASE_URL = "https://api.massive.com/v1/open-close";

/**
 * Fetch historical prices for a symbol within a date range.
 * Calls GET /api/prices?symbol=...&from=...&to=...
 */
export async function fetchPrices(
  symbol: string,
  from: string,
  to: string
): Promise<PricePoint[]> {
  const params = new URLSearchParams({ symbol, from, to });
  const res = await fetch(`${BASE_URL}/api/prices?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Failed to fetch prices (${res.status})`);
  }
  return res.json();
}

/**
 * Run a full backtest simulation.
 * Calls POST /api/backtest with the provided parameters.
 */
export async function runBacktest(
  request: BacktestRequest
): Promise<BacktestResponse> {
  const res = await fetch(`${BASE_URL}/api/backtest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Backtest failed (${res.status})`);
  }
  return res.json();
}

/**
 * Fetch open-close price data for a specific option from Massive.com API
 * @param symbol - Stock symbol (e.g., "SPY")
 * @param expiryDate - Option expiry date in YYMMDD format (e.g., "260618")
 * @param strikePrice - Strike price (e.g., 750)
 * @param optionType - "C" for call or "P" for put
 * @param date - Date for the price data in YYYY-MM-DD format
 */
export async function fetchOptionPrice(
  symbol: string,
  expiryDate: string,
  strikePrice: number,
  optionType: "C" | "P",
  date: string
): Promise<number | null> {
  const result = await fetchOptionOpenClose(symbol, expiryDate, strikePrice, optionType, date);
  return result.closePrice;
}

/**
 * Fetch open and close price data for a specific option from Massive.com API
 */
export async function fetchOptionOpenClose(
  symbol: string,
  expiryDate: string,
  strikePrice: number,
  optionType: "C" | "P",
  date: string
): Promise<OptionOpenClose> {
  try {
    // Format the option symbol: O:SPY260618C00750000 (only 750 gets replaced with CE/PE strike)
    const optionSymbol = `O:${symbol}${expiryDate}${optionType}00${strikePrice}000`;
    
    // Build the API URL
    const url = `${MASSIVE_BASE_URL}/${optionSymbol}/${date}?adjusted=true&apiKey=${MASSIVE_API_KEY}`;
    
    const res = await fetch(url);
    
    if (!res.ok) {
      console.warn(`Failed to fetch option price for ${optionSymbol} on ${date}: ${res.status}`);
      return {
        openPrice: null,
        closePrice: null,
        delta: null,
        theta: null,
        statusCode: res.status,
      };
    }
    
    const data = await res.json();

    const greeks = data.greeks ?? data.results?.greeks ?? null;
    
    return {
      openPrice: data.open ?? data.o ?? null,
      closePrice: data.close ?? data.c ?? null,
      delta: greeks?.delta ?? data.delta ?? null,
      theta: greeks?.theta ?? data.theta ?? null,
      statusCode: res.status,
    };
  } catch (error) {
    console.error(`Error fetching option price:`, error);
    return {
      openPrice: null,
      closePrice: null,
      delta: null,
      theta: null,
      statusCode: null,
    };
  }
}

/**
 * Fetch open and close price data for a stock symbol from Massive.com API.
 */
export async function fetchStockOpenClose(
  symbol: string,
  date: string
): Promise<OptionOpenClose> {
  try {
    const url = `${MASSIVE_BASE_URL}/${symbol}/${date}?adjusted=true&apiKey=${MASSIVE_API_KEY}`;

    const res = await fetch(url);

    if (!res.ok) {
      console.warn(`Failed to fetch stock price for ${symbol} on ${date}: ${res.status}`);
      return {
        openPrice: null,
        closePrice: null,
        delta: null,
        theta: null,
        statusCode: res.status,
      };
    }

    const data = await res.json();

    return {
      openPrice: data.open ?? data.o ?? null,
      closePrice: data.close ?? data.c ?? null,
      delta: null,
      theta: null,
      statusCode: res.status,
    };
  } catch (error) {
    console.error(`Error fetching stock price:`, error);
    return {
      openPrice: null,
      closePrice: null,
      delta: null,
      theta: null,
      statusCode: null,
    };
  }
}
