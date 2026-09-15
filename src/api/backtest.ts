/**
 * API client for communicating with the FastAPI backend.
 * All backtest and price endpoints are defined here.
 */

import type { BacktestRequest, BacktestResponse, PricePoint } from "../types";
import qqqClosingData from "../assets/qqq-closing.json";
import spyClosingData from "../assets/spy-closing.json";
import { getSqliteItem } from "../utils/sqliteStorage";

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

// Alpha Vantage API configuration
const ALPHA_VANTAGE_API_KEY = "0MFMXNIBW0OFI75Q";
const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

export interface AlphaVantageOptionContract {
  contractID: string;
  symbol: string;
  expiration: string;
  strike: string;
  type: "call" | "put";
  last: string;
  mark: string;
  bid: string;
  bid_size: string;
  ask: string;
  ask_size: string;
  volume: string;
  open_interest: string;
  date: string;
  implied_volatility: string;
  delta: string;
  gamma: string;
  theta: string;
  vega: string;
  rho: string;
}

export interface AlphaVantageHistoricalOptionsResponse {
  endpoint: string;
  message: string;
  data: AlphaVantageOptionContract[];
}
const MASTER_STOCK_DATA_KEY = "masterStockData";
const SPY_CLOSING_SERIES: Array<{ date: string; close: number | null }> = spyClosingData;
const QQQ_CLOSING_SERIES: Array<{ date: string; close: number | null }> = qqqClosingData;
const LOCAL_SPY_CLOSING_BY_DATE = new Map(
  SPY_CLOSING_SERIES.map((point) => [point.date, point.close])
);
const LOCAL_QQQ_CLOSING_BY_DATE = new Map(
  QQQ_CLOSING_SERIES.map((point) => [point.date, point.close])
);

interface CachedStockResponse {
  symbol: string;
  date: string;
  openPrice: number | null;
  closePrice: number | null;
  statusCode: number | null;
}

type MasterStockData = Record<string, CachedStockResponse>;

const getBundledClose = (symbol: string, date: string): number | null | undefined => {
  if (symbol === "SPY") return LOCAL_SPY_CLOSING_BY_DATE.get(date);
  if (symbol === "QQQ") return LOCAL_QQQ_CLOSING_BY_DATE.get(date);
  return undefined;
};

const normalizeFlatStockCache = (parsed: Record<string, unknown>): MasterStockData => {
  const normalized: MasterStockData = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (key.includes("|")) {
      normalized[key] = value as CachedStockResponse;
      continue;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    for (const [dateKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
        continue;
      }

      const entry = entryValue as Partial<CachedStockResponse>;
      normalized[`${key}|${dateKey}`] = {
        symbol: entry.symbol ?? key,
        date: entry.date ?? dateKey,
        openPrice: entry.openPrice ?? null,
        closePrice: entry.closePrice ?? null,
        statusCode: entry.statusCode ?? null,
      };
    }
  }

  return normalized;
};

const parseMasterStockData = (raw: string | null): MasterStockData | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return normalizeFlatStockCache(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
};

const loadMasterStockData = async (): Promise<MasterStockData | null> => {
  if (typeof window !== "undefined") {
    const fromLocalStorage = parseMasterStockData(window.localStorage.getItem(MASTER_STOCK_DATA_KEY));
    if (fromLocalStorage) {
      return fromLocalStorage;
    }
  }

  const fromSqlite = parseMasterStockData(await getSqliteItem(MASTER_STOCK_DATA_KEY));
  return fromSqlite;
};

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
 * Fetch historical options chain data for a symbol from Alpha Vantage's
 * HISTORICAL_OPTIONS endpoint. If `date` is omitted, Alpha Vantage returns
 * the most recent trading day's chain.
 */
export async function fetchHistoricalOptions(
  symbol: string,
  date?: string
): Promise<AlphaVantageHistoricalOptionsResponse> {
  const params = new URLSearchParams({
    function: "HISTORICAL_OPTIONS",
    symbol,
    apikey: ALPHA_VANTAGE_API_KEY,
  });
  if (date) {
    params.set("date", date);
  }

  const res = await fetch(`${ALPHA_VANTAGE_BASE_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch historical options for ${symbol} (${res.status})`);
  }

  const data = await res.json();
  if (data?.Information || data?.["Error Message"] || data?.Note) {
    throw new Error(
      data.Information ?? data["Error Message"] ?? data.Note ?? "Alpha Vantage request failed"
    );
  }

  return data as AlphaVantageHistoricalOptionsResponse;
}

/**
 * Fetch open and close price data for a stock symbol from Massive.com API.
 */
export async function fetchStockOpenClose(
  symbol: string,
  date: string
): Promise<OptionOpenClose> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const bundledClose = getBundledClose(normalizedSymbol, date);
  if (bundledClose !== undefined) {
    return {
      openPrice: null,
      closePrice: bundledClose,
      delta: null,
      theta: null,
      statusCode: 200,
    };
  }

  const localMasterStockData = await loadMasterStockData();
  const stockCacheKey = `${normalizedSymbol}|${date}`;
  const cachedStock = localMasterStockData?.[stockCacheKey];

  if (cachedStock) {
    return {
      openPrice: cachedStock.openPrice ?? null,
      closePrice: cachedStock.closePrice ?? null,
      delta: null,
      theta: null,
      statusCode: cachedStock.statusCode ?? 200,
    };
  }

  try {
    const params = new URLSearchParams({ adjusted: "true", apiKey: MASSIVE_API_KEY });
    const response = await fetch(
      `${MASSIVE_BASE_URL}/${encodeURIComponent(normalizedSymbol)}/${date}?${params}`
    );

    if (!response.ok) {
      console.warn(
        `Failed to fetch stock price for ${normalizedSymbol} on ${date}: ${response.status}`
      );
      return {
        openPrice: null,
        closePrice: null,
        delta: null,
        theta: null,
        statusCode: response.status,
      };
    }

    const data = await response.json();
    return {
      openPrice: data.open ?? data.o ?? null,
      closePrice: data.close ?? data.c ?? null,
      delta: null,
      theta: null,
      statusCode: response.status,
    };
  } catch (error) {
    console.error(`Error fetching stock price for ${normalizedSymbol} on ${date}:`, error);
    return {
      openPrice: null,
      closePrice: null,
      delta: null,
      theta: null,
      statusCode: null,
    };
  }
}
