/**
 * OptionsAnalyzer — screen for analyzing option premiums over a date range
 * Accepts JSON input with array of objects, calls Massive.com API, and displays results
 */

import React, { useState } from "react";
import {
  Button,
  Input,
  Space,
  Table,
  Alert,
  Spin,
  Card,
  message,
  Empty,
  Popconfirm,
} from "antd";
import {
  PlayCircleOutlined,
  CopyOutlined,
  CheckOutlined,
  DownloadOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import * as XLSX from "xlsx";
import { fetchOptionOpenClose, fetchStockOpenClose } from "../api/backtest";
import tradingDates2026Json from "../assets/trading_dates_2026.json";
import NetValueChart from "./NetValueChart";
import type {
  OptionsInput,
  OptionsAnalysisRow,
  StrikePremium,
} from "../types";

interface OptionsInputV2 extends OptionsInput {
  longExpiryDate: string;
}

interface OptionsAnalysisRowV2 extends Omit<OptionsAnalysisRow, "closingPrice"> {
  closingPrice: number | null;
  longCePremiumData: StrikePremium | null;
  longPePremiumData: StrikePremium | null;
}

interface AnalysisResult {
  rows: OptionsAnalysisRowV2[];
  inputData: OptionsInputV2[];
}

interface CachedOptionResponse {
  symbol: string;
  expiryDate: string;
  strikePrice: number;
  optionType: "C" | "P";
  date: string;
  openPrice: number | null;
  closePrice: number | null;
  delta: number | null;
  theta: number | null;
  statusCode: number | null;
  skipFuture: boolean;
}

type MasterOptionData = Record<string, CachedOptionResponse>;

interface CachedStockResponse {
  symbol: string;
  date: string;
  openPrice: number | null;
  closePrice: number | null;
  statusCode: number | null;
}

type MasterStockData = Record<string, CachedStockResponse>;

const MASTER_OPTION_DATA_KEY = "masterOptionData";
const MASTER_STOCK_DATA_KEY = "masterStockData";
const tradingDates2026 = new Set<string>(tradingDates2026Json as string[]);
const RATE_LIMIT_WAIT_MS = 2_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const NET_VALUE_MULTIPLIER = 10;
const DEFAULT_INPUT: OptionsInputV2 = {
  expiryDate: "2026-06-30",
  longExpiryDate: "2026-12-31",
  date: "2026-01-01",
  strikePrice: 700,
  symbol: "SPY",
};

const OptionsAnalyzerV2: React.FC = () => {
  const [formInput, setFormInput] = useState<OptionsInputV2>(DEFAULT_INPUT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);

  const getCacheKey = (
    symbol: string,
    expiryDate: string,
    strikePrice: number,
    optionType: "C" | "P",
    date: string
  ): string => {
    return `${symbol}|${expiryDate}|${strikePrice}|${optionType}|${date}`;
  };

  const loadMasterOptionData = (): MasterOptionData => {
    try {
      const raw = localStorage.getItem(MASTER_OPTION_DATA_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as MasterOptionData;
    } catch {
      return {};
    }
  };

  const saveMasterOptionData = (data: MasterOptionData) => {
    localStorage.setItem(MASTER_OPTION_DATA_KEY, JSON.stringify(data));
  };

  const loadMasterStockData = (): MasterStockData => {
    try {
      const raw = localStorage.getItem(MASTER_STOCK_DATA_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as MasterStockData;
    } catch {
      return {};
    }
  };

  const saveMasterStockData = (data: MasterStockData) => {
    localStorage.setItem(MASTER_STOCK_DATA_KEY, JSON.stringify(data));
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const fetchOptionWithRateLimitRetry = async (
    symbol: string,
    expiryDate: string,
    strikePrice: number,
    optionType: "C" | "P",
    date: string
  ) => {
    let response = await fetchOptionOpenClose(symbol, expiryDate, strikePrice, optionType, date);
    let attempts = 0;

    while (response.statusCode === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      attempts += 1;
      message.warning(`Rate limit hit (429). Waiting 2 seconds before retry ${attempts}.`);
      await sleep(RATE_LIMIT_WAIT_MS);
      response = await fetchOptionOpenClose(symbol, expiryDate, strikePrice, optionType, date);
    }

    return response;
  };

  const fetchStockWithRateLimitRetry = async (symbol: string, date: string) => {
    let response = await fetchStockOpenClose(symbol, date);
    let attempts = 0;

    while (response.statusCode === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      attempts += 1;
      message.warning(`Rate limit hit (429). Waiting 2 seconds before retry ${attempts}.`);
      await sleep(RATE_LIMIT_WAIT_MS);
      response = await fetchStockOpenClose(symbol, date);
    }

    return response;
  };

  /**
   * Format date from YYYY-MM-DD to YYMMDD
   */
  const formatExpiryDate = (dateStr: string): string => {
    return dayjs(dateStr).format("YYMMDD");
  };

  /**
   * Format date from YYYY-MM-DD to MM/DD/YY for display
   */
  const formatDisplayDate = (dateStr: string): string => {
    return dayjs(dateStr).format("MM/DD/YY");
  };

  /**
   * Parse form input and validate structure
   */
  const parseInput = (): OptionsInputV2[] => {
    const normalizedInput: OptionsInputV2 = {
      expiryDate: formInput.expiryDate,
      longExpiryDate: formInput.longExpiryDate,
      date: formInput.date,
      strikePrice: formInput.strikePrice,
      symbol: formInput.symbol.trim(),
    };

    if (
      !normalizedInput.expiryDate ||
      !normalizedInput.longExpiryDate ||
      !normalizedInput.date ||
      !normalizedInput.symbol
    ) {
      throw new Error("All five input fields are required");
    }

    if (!Number.isFinite(normalizedInput.strikePrice)) {
      throw new Error("Strike price must be a finite number");
    }

    if (
      !dayjs(normalizedInput.expiryDate).isValid() ||
      !dayjs(normalizedInput.longExpiryDate).isValid() ||
      !dayjs(normalizedInput.date).isValid()
    ) {
      throw new Error("Expiry date, long expiry date, and date must be in YYYY-MM-DD format");
    }

    return [normalizedInput];
  };

  const expandInputData = (inputs: OptionsInputV2[]): OptionsInputV2[] => {
    const expanded: OptionsInputV2[] = [];
    const today = dayjs().startOf("day");

    for (const input of inputs) {
      const start = dayjs(input.date);
      const end = dayjs(input.expiryDate);

      if (start.isAfter(end)) {
        throw new Error(
          `Invalid range for ${input.symbol}: date (${input.date}) cannot be after expiryDate (${input.expiryDate})`
        );
      }

      if (start.isAfter(today, "day")) {
        throw new Error(
          `Invalid date for ${input.symbol}: date (${input.date}) cannot be in the future`
        );
      }

      // expiryDate can be future, but API date requests should not exceed today.
      const effectiveEnd = end.isAfter(today, "day") ? today : end;

      let current = start;
      while (!current.isAfter(effectiveEnd, "day")) {
        // skip dates that are not in the trading_dates_2026 set to reduce API calls for non-trading days
        if (!tradingDates2026.has(current.format("YYYY-MM-DD"))) {
          current = current.add(1, "day");
          continue;
        }

        expanded.push({
          ...input,
          date: current.format("YYYY-MM-DD"),
        });
        current = current.add(1, "day");
      }
    }

    return expanded;
  };

  /**
   * Main analysis function
   */
  const handleAnalyze = async () => {
    setError(null);
    setResult(null);
    setLoading(true);
    setCancelRequested(false);

    try {
      const inputData = parseInput();
      const expandedInputData = expandInputData(inputData);
      const masterOptionData = loadMasterOptionData();
      const masterStockData = loadMasterStockData();
      let cacheUpdated = false;
      let stockCacheUpdated = false;
      let sawRateLimit = false;

      const rows: OptionsAnalysisRowV2[] = [];
      setResult({ rows: [], inputData });

      // Process each input row independently so each row keeps its own strike/symbol/expiry/date
      for (const input of expandedInputData) {
        if (cancelRequested) {
          message.info("Analysis cancelled");
          break;
        }
        const date = input.date;
        const strikePrice = input.strikePrice;
        const symbol = input.symbol.toUpperCase();
        const expiryDate = formatExpiryDate(input.expiryDate);
        const longExpiryDate = formatExpiryDate(input.longExpiryDate);
        const ceStrike = strikePrice + 0;//temp 0
        const peStrike = strikePrice - 0;// temp 0 

        const ceKey = getCacheKey(symbol, expiryDate, ceStrike, "C", date);
        const peKey = getCacheKey(symbol, expiryDate, peStrike, "P", date);
        const longCeKey = getCacheKey(symbol, longExpiryDate, ceStrike, "C", date);
        const longPeKey = getCacheKey(symbol, longExpiryDate, peStrike, "P", date);
        const stockKey = `${symbol}|${date}`;

        const ceCached = masterOptionData[ceKey];
        const peCached = masterOptionData[peKey];
        const longCeCached = masterOptionData[longCeKey];
        const longPeCached = masterOptionData[longPeKey];
        const stockCached = masterStockData[stockKey];

        // Backfill old cache entries that predate status metadata.
        if (ceCached && (typeof ceCached.skipFuture === "undefined" || typeof ceCached.statusCode === "undefined")) {
          ceCached.skipFuture = false;
          ceCached.statusCode = null;
          cacheUpdated = true;
        }
        if (peCached && (typeof peCached.skipFuture === "undefined" || typeof peCached.statusCode === "undefined")) {
          peCached.skipFuture = false;
          peCached.statusCode = null;
          cacheUpdated = true;
        }
        if (longCeCached && (typeof longCeCached.skipFuture === "undefined" || typeof longCeCached.statusCode === "undefined")) {
          longCeCached.skipFuture = false;
          longCeCached.statusCode = null;
          cacheUpdated = true;
        }
        if (longPeCached && (typeof longPeCached.skipFuture === "undefined" || typeof longPeCached.statusCode === "undefined")) {
          longPeCached.skipFuture = false;
          longPeCached.statusCode = null;
          cacheUpdated = true;
        }

        // Migrate old entries that used 429 as permanent skip so retries can happen.
        if (ceCached?.statusCode === 429 && ceCached.skipFuture) {
          ceCached.skipFuture = false;
          cacheUpdated = true;
        }
        if (peCached?.statusCode === 429 && peCached.skipFuture) {
          peCached.skipFuture = false;
          cacheUpdated = true;
        }
        if (longCeCached?.statusCode === 429 && longCeCached.skipFuture) {
          longCeCached.skipFuture = false;
          cacheUpdated = true;
        }
        if (longPeCached?.statusCode === 429 && longPeCached.skipFuture) {
          longPeCached.skipFuture = false;
          cacheUpdated = true;
        }

        const ceCanUseCache = Boolean(
          ceCached &&
          ((ceCached.skipFuture && ceCached.statusCode === 404) ||
            ceCached.openPrice !== null ||
            ceCached.closePrice !== null)
        );
        const peCanUseCache = Boolean(
          peCached &&
          ((peCached.skipFuture && peCached.statusCode === 404) ||
            peCached.openPrice !== null ||
            peCached.closePrice !== null)
        );
        const longCeCanUseCache = Boolean(
          longCeCached &&
          ((longCeCached.skipFuture && longCeCached.statusCode === 404) ||
            longCeCached.openPrice !== null ||
            longCeCached.closePrice !== null)
        );
        const longPeCanUseCache = Boolean(
          longPeCached &&
          ((longPeCached.skipFuture && longPeCached.statusCode === 404) ||
            longPeCached.openPrice !== null ||
            longPeCached.closePrice !== null)
        );
        const stockCanUseCache = Boolean(
          stockCached &&
          (stockCached.openPrice !== null || stockCached.closePrice !== null)
        );

        // Check localStorage cache first and call API only for misses.
        // V2 makes two additional API calls per row for long call/put values.
        const [stockData, ceData, peData, longCeData, longPeData] = await Promise.all([
          stockCanUseCache
            ? Promise.resolve({
              openPrice: stockCached?.openPrice ?? null,
              closePrice: stockCached?.closePrice ?? null,
              statusCode: stockCached?.statusCode ?? null,
            })
            : fetchStockWithRateLimitRetry(symbol, date),
          ceCanUseCache
            ? Promise.resolve({
              openPrice: ceCached?.openPrice ?? null,
              closePrice: ceCached?.closePrice ?? null,
              delta: ceCached?.delta ?? null,
              theta: ceCached?.theta ?? null,
              statusCode: ceCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, expiryDate, ceStrike, "C", date),
          peCanUseCache
            ? Promise.resolve({
              openPrice: peCached?.openPrice ?? null,
              closePrice: peCached?.closePrice ?? null,
              delta: peCached?.delta ?? null,
              theta: peCached?.theta ?? null,
              statusCode: peCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, expiryDate, peStrike, "P", date),
          longCeCanUseCache
            ? Promise.resolve({
              openPrice: longCeCached?.openPrice ?? null,
              closePrice: longCeCached?.closePrice ?? null,
              delta: longCeCached?.delta ?? null,
              theta: longCeCached?.theta ?? null,
              statusCode: longCeCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, longExpiryDate, ceStrike, "C", date),
          longPeCanUseCache
            ? Promise.resolve({
              openPrice: longPeCached?.openPrice ?? null,
              closePrice: longPeCached?.closePrice ?? null,
              delta: longPeCached?.delta ?? null,
              theta: longPeCached?.theta ?? null,
              statusCode: longPeCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, longExpiryDate, peStrike, "P", date),
        ]);

        if (
          stockData.statusCode === 429 ||
          ceData.statusCode === 429 ||
          peData.statusCode === 429 ||
          longCeData.statusCode === 429 ||
          longPeData.statusCode === 429
        ) {
          sawRateLimit = true;
        }

        const stockClosePrice = stockData.closePrice;
        const cePrice = ceData.closePrice;
        const pePrice = peData.closePrice;
        const longCePrice = longCeData.closePrice;
        const longPePrice = longPeData.closePrice;

        if (!ceCanUseCache) {
          const shouldSkipCe = ceData.statusCode === 404;
          masterOptionData[ceKey] = {
            symbol,
            expiryDate,
            strikePrice: ceStrike,
            optionType: "C",
            date,
            openPrice: ceData.openPrice,
            closePrice: cePrice,
            delta: ceData.delta,
            theta: ceData.theta,
            statusCode: ceData.statusCode,
            skipFuture: shouldSkipCe,
          };
          cacheUpdated = true;
        }

        if (!peCanUseCache) {
          const shouldSkipPe = peData.statusCode === 404;
          masterOptionData[peKey] = {
            symbol,
            expiryDate,
            strikePrice: peStrike,
            optionType: "P",
            date,
            openPrice: peData.openPrice,
            closePrice: pePrice,
            delta: peData.delta,
            theta: peData.theta,
            statusCode: peData.statusCode,
            skipFuture: shouldSkipPe,
          };
          cacheUpdated = true;
        }
        if (!longCeCanUseCache) {
          const shouldSkipLongCe = longCeData.statusCode === 404;
          masterOptionData[longCeKey] = {
            symbol,
            expiryDate: longExpiryDate,
            strikePrice: ceStrike,
            optionType: "C",
            date,
            openPrice: longCeData.openPrice,
            closePrice: longCePrice,
            delta: longCeData.delta,
            theta: longCeData.theta,
            statusCode: longCeData.statusCode,
            skipFuture: shouldSkipLongCe,
          };
          cacheUpdated = true;
        }

        if (!longPeCanUseCache) {
          const shouldSkipLongPe = longPeData.statusCode === 404;
          masterOptionData[longPeKey] = {
            symbol,
            expiryDate: longExpiryDate,
            strikePrice: peStrike,
            optionType: "P",
            date,
            openPrice: longPeData.openPrice,
            closePrice: longPePrice,
            delta: longPeData.delta,
            theta: longPeData.theta,
            statusCode: longPeData.statusCode,
            skipFuture: shouldSkipLongPe,
          };
          cacheUpdated = true;
        }

        let previousDate: string | null = null;
        for (let daysBack = 1; daysBack <= 5; daysBack += 1) {
          const candidate = dayjs(date).subtract(daysBack, "day").format("YYYY-MM-DD");
          if (tradingDates2026.has(candidate)) {
            previousDate = candidate;
            break;
          }
        }
        const previousCeClose = previousDate
          ? masterOptionData[getCacheKey(symbol, expiryDate, ceStrike, "C", previousDate)]
            ?.closePrice ?? null
          : null;
        const previousPeClose = previousDate
          ? masterOptionData[getCacheKey(symbol, expiryDate, peStrike, "P", previousDate)]
            ?.closePrice ?? null
          : null;

        const markChangeCall =
          cePrice !== null && previousCeClose !== null ? cePrice - previousCeClose : null;
        const markChangePut =
          pePrice !== null && previousPeClose !== null ? pePrice - previousPeClose : null;

        const row: OptionsAnalysisRowV2 = {
          date: formatDisplayDate(date),
          closingPrice: stockClosePrice,
          ceStrike,
          peStrike,
          cePremiumData: cePrice !== null
            ? {
              expiryDate: formatDisplayDate(input.expiryDate),
              strike: ceStrike,
              closePrice: cePrice,
              delta: ceData.delta,
              theta: ceData.theta,
            }
            : null,
          markChangeCall,
          pePremiumData: pePrice !== null
            ? {
              expiryDate: formatDisplayDate(input.expiryDate),
              strike: peStrike,
              closePrice: pePrice,
              delta: peData.delta,
              theta: peData.theta,
            }
            : null,
          markChangePut,
          longCePremiumData: longCePrice !== null
            ? {
              expiryDate: formatDisplayDate(input.longExpiryDate),
              strike: ceStrike,
              closePrice: longCePrice,
              delta: longCeData.delta,
              theta: longCeData.theta,
            }
            : null,
          longPePremiumData: longPePrice !== null
            ? {
              expiryDate: formatDisplayDate(input.longExpiryDate),
              strike: peStrike,
              closePrice: longPePrice,
              delta: longPeData.delta,
              theta: longPeData.theta,
            }
            : null,
        };

        rows.push(row);
        // Stream rows to the table as each API response completes.
        setResult({ rows: [...rows], inputData });

        if (!stockCanUseCache) {
          masterStockData[stockKey] = {
            symbol,
            date,
            openPrice: stockData.openPrice,
            closePrice: stockData.closePrice,
            statusCode: stockData.statusCode,
          };
          stockCacheUpdated = true;
        }
      }

      if (cacheUpdated) {
        saveMasterOptionData(masterOptionData);
      }
      if (stockCacheUpdated) {
        saveMasterStockData(masterStockData);
      }

      if (sawRateLimit) {
        message.warning("Some requests returned 429 after retries; processing continued.");
      }
      if (!cancelRequested) {
        message.success(`Analysis completed for ${rows.length} dates`);
      }
    } catch (err) {
      if (!cancelRequested) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(msg);
        message.error(msg);
      }
    } finally {
      setLoading(false);
      setCancelRequested(false);
    }
  };

  const handleCancel = () => {
    setCancelRequested(true);
  };

  const handleReset = () => {
    setFormInput(DEFAULT_INPUT);
    setResult(null);
    setError(null);
    setCancelRequested(false);
    message.success("Form reset");
  };

  /**
   * Copy results to clipboard as JSON
   */
  const copyToClipboard = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.rows, null, 2));
      setCopied(true);
      message.success("Results copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      message.error("Failed to copy");
    }
  };

  const clearLocalStorageCache = () => {
    localStorage.removeItem(MASTER_OPTION_DATA_KEY);
    localStorage.removeItem(MASTER_STOCK_DATA_KEY);
    message.success("Local cache cleared");
  };

  const netValueChartData = result
    ? result.rows
        .map((row, index) => {
          if (
            !row.cePremiumData ||
            !row.pePremiumData ||
            !row.longCePremiumData ||
            !row.longPePremiumData
          ) {
            return null;
          }

          const totalValue = row.cePremiumData.closePrice + row.pePremiumData.closePrice;
          const longTotalValue =
            row.longCePremiumData.closePrice + row.longPePremiumData.closePrice;
          const netValue = NET_VALUE_MULTIPLIER * (longTotalValue - totalValue);

          const firstRow = result.rows[0];
          if (
            !firstRow?.cePremiumData ||
            !firstRow.pePremiumData ||
            !firstRow.longCePremiumData ||
            !firstRow.longPePremiumData
          ) {
            return {
              date: row.date,
              netValue,
              percentageChange: null,
            };
          }

          const firstTotalValue = firstRow.cePremiumData.closePrice + firstRow.pePremiumData.closePrice;
          const firstLongTotalValue =
            firstRow.longCePremiumData.closePrice + firstRow.longPePremiumData.closePrice;
          const firstNetValue = NET_VALUE_MULTIPLIER * (firstLongTotalValue - firstTotalValue);

          const percentageChange =
            index === 0 || firstNetValue === 0
              ? 0
              : ((netValue - firstNetValue) / firstNetValue) * 100;

          return {
            date: row.date,
            netValue,
            percentageChange,
          };
        })
        .filter(
          (value): value is { date: string; netValue: number; percentageChange: number | null } =>
            value !== null
        )
    : [];

  const handleFieldChange = <K extends keyof OptionsInputV2>(field: K, value: OptionsInputV2[K]) => {
    setFormInput((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const downloadCurrentViewAsExcel = () => {
    if (!result || result.rows.length === 0) {
      message.warning("No rows available to export");
      return;
    }

    try {
      const exportRows = result.rows.map((row) => ({
        Date: row.date,
        "Closing/Stock Price": row.closingPrice !== null ? row.closingPrice.toFixed(2) : "—",
        "CE Strike": row.ceStrike.toFixed(0),
        "PE Strike": row.peStrike.toFixed(0),
        "CE Call Premium": row.cePremiumData
          ? `${row.cePremiumData.expiryDate}-${row.cePremiumData.strike}`
          : "—",
        "Call Price": row.cePremiumData ? row.cePremiumData.closePrice.toFixed(2) : "—",
        "Mark change - Call": row.markChangeCall !== null ? row.markChangeCall.toFixed(2) : "—",
        "Put Premium": row.pePremiumData
          ? `${row.pePremiumData.expiryDate}-${row.pePremiumData.strike}`

          : "—",
        "PE Price": row.pePremiumData ? row.pePremiumData.closePrice.toFixed(2) : "—",
        "Total Value":
          row.cePremiumData !== null && row.pePremiumData !== null
            ? (row.cePremiumData.closePrice + row.pePremiumData.closePrice).toFixed(2)
            : "—",
        "Long Call Price": row.longCePremiumData ? row.longCePremiumData.closePrice.toFixed(2) : "—",
        "Long Put Price": row.longPePremiumData ? row.longPePremiumData.closePrice.toFixed(2) : "—",
        "Long Total Value":
          row.longCePremiumData !== null && row.longPePremiumData !== null
            ? (row.longCePremiumData.closePrice + row.longPePremiumData.closePrice).toFixed(2)
            : "—",
        "Net Value":
          row.cePremiumData !== null &&
          row.pePremiumData !== null &&
          row.longCePremiumData !== null &&
          row.longPePremiumData !== null
            ? (
                NET_VALUE_MULTIPLIER * (
                  row.longCePremiumData.closePrice +
                  row.longPePremiumData.closePrice -
                  (row.cePremiumData.closePrice + row.pePremiumData.closePrice)
                )
              ).toFixed(2)
            : "—",
        "Mark change - Put": row.markChangePut !== null ? row.markChangePut.toFixed(2) : "—",
      }));

      const worksheet = XLSX.utils.json_to_sheet(exportRows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Analysis Results");

      const timestamp = dayjs().format("YYYYMMDD-HHmmss");
      XLSX.writeFile(workbook, `options-analysis-${timestamp}.xlsx`);
    } catch {
      message.error("Failed to export Excel file");
    }
  };

  const columns = [
    {
      title: "Date",
      dataIndex: "date",
      key: "date",
      width: 100,
    },
    {
      title: "Closing/Stock Price",
      dataIndex: "closingPrice",
      key: "closingPrice",
      width: 220,
      render: (value: number | null, _record: OptionsAnalysisRowV2, index: number) => {
        if (value === null) return "—";

        let percentageChange: number | null = null;
        if (result && result.rows.length > 0 && index !== 0) {
          const firstRow = result.rows[0];
          const firstClosePrice = firstRow.closingPrice;
          if (firstClosePrice !== null && firstClosePrice !== 0) {
            percentageChange = ((value - firstClosePrice) / firstClosePrice) * 100;
          }
        }

        const percentageDisplay =
          percentageChange !== null
            ? ` (${percentageChange > 0 ? "+" : ""}${percentageChange.toFixed(2)}%)`
            : "";
        const percentageColor =
          percentageChange !== null ? (percentageChange >= 0 ? "#52c41a" : "#ff4d4f") : "inherit";

        return (
          <div style={{ color: percentageColor }}>
            {value.toFixed(2)}
            {percentageDisplay}
          </div>
        );
      },
    },
    // {
    //   title: "Call Strike",
    //   dataIndex: "ceStrike",
    //   key: "ceStrike",
    //   width: 120,
    //   render: (value: number) => value.toFixed(0),
    // },
    // {
    //   title: "Put Strike",
    //   dataIndex: "peStrike",
    //   key: "peStrike",
    //   width: 120,
    //   render: (value: number) => value.toFixed(0),
    // },
    // {
    //   title: "Call Premium",
    //   dataIndex: "cePremiumData",
    //   key: "cePremium",
    //   width: 200,
    //   render: (value: StrikePremium | null) => {
    //     if (!value) return "—";
    //     return `${value.expiryDate}-${value.strike}`;
    //   },
    // },
    {
      title: "Call Price",
      dataIndex: "cePremiumData",
      key: "cePrice",
      width: 200,
      render: (value: StrikePremium | null, _record: OptionsAnalysisRowV2, index: number) => {
        if (!value) return "—";

        let percentageChange: number | null = null;
        if (result && result.rows.length > 0 && index !== 0) {
          const firstRow = result.rows[0];
          const firstCallPrice = firstRow.cePremiumData?.closePrice ?? null;
          if (firstCallPrice !== null && firstCallPrice !== 0) {
            percentageChange = ((value.closePrice - firstCallPrice) / firstCallPrice) * 100;
          }
        }

        const percentageDisplay =
          percentageChange !== null
            ? ` (${percentageChange > 0 ? "+" : ""}${percentageChange.toFixed(2)}%)`
            : "";
        const percentageColor =
          percentageChange !== null ? (percentageChange >= 0 ? "#52c41a" : "#ff4d4f") : "inherit";

        return (
          <div style={{ color: percentageColor }}>
            {value.closePrice.toFixed(2)}
            {percentageDisplay}
          </div>
        );
      },
    },
    // {
    //   title: "Mark change - Call",
    //   dataIndex: "markChangeCall",
    //   key: "markChangeCall",
    //   width: 170,
    //   render: (value: number | null) => {
    //     if (value === null) return "—";
    //     return value.toFixed(2);
    //   },
    // },
    // {
    //   title: "Put Premium",
    //   dataIndex: "pePremiumData",
    //   key: "pePremium",
    //   width: 200,
    //   render: (value: StrikePremium | null) => {
    //     if (!value) return "—";
    //     return `${value.expiryDate}-${value.strike}`;
    //   },
    // },
    {
      title: "Put Price",
      dataIndex: "pePremiumData",
      key: "pePrice",
      width: 200,
      render: (value: StrikePremium | null, _record: OptionsAnalysisRowV2, index: number) => {
        if (!value) return "—";

        let percentageChange: number | null = null;
        if (result && result.rows.length > 0 && index !== 0) {
          const firstRow = result.rows[0];
          const firstPutPrice = firstRow.pePremiumData?.closePrice ?? null;
          if (firstPutPrice !== null && firstPutPrice !== 0) {
            percentageChange = ((value.closePrice - firstPutPrice) / firstPutPrice) * 100;
          }
        }

        const percentageDisplay =
          percentageChange !== null
            ? ` (${percentageChange > 0 ? "+" : ""}${percentageChange.toFixed(2)}%)`
            : "";
        const percentageColor =
          percentageChange !== null ? (percentageChange >= 0 ? "#52c41a" : "#ff4d4f") : "inherit";

        return (
          <div style={{ color: percentageColor }}>
            {value.closePrice.toFixed(2)}
            {percentageDisplay}
          </div>
        );
      },
    },
    // {
    //   title: "Mark change - Put",
    //   dataIndex: "markChangePut",
    //   key: "markChangePut",
    //   width: 170,
    //   render: (value: number | null) => {
    //     if (value === null) return "—";
    //     return value.toFixed(2);
    //   },
    // },
    {
      title: "Total Value",
      key: "totalValue",
      width: 130,
      render: (_value: unknown, record: OptionsAnalysisRowV2) => {
        if (!record.cePremiumData || !record.pePremiumData) return "—";
        return (record.cePremiumData.closePrice + record.pePremiumData.closePrice).toFixed(2);
      },
    },
    {
      title: "Long Call Price",
      dataIndex: "longCePremiumData",
      key: "longCePrice",
      width: 140,
      render: (value: StrikePremium | null) => {
        if (!value) return "—";
        return value.closePrice.toFixed(2);
      },
    },
    {
      title: "Long Put Price",
      dataIndex: "longPePremiumData",
      key: "longPePrice",
      width: 140,
      render: (value: StrikePremium | null) => {
        if (!value) return "—";
        return value.closePrice.toFixed(2);
      },
    },
    {
      title: "Long Total Value",
      key: "longTotalValue",
      width: 150,
      render: (_value: unknown, record: OptionsAnalysisRowV2) => {
        if (!record.longCePremiumData || !record.longPePremiumData) return "—";
        return (record.longCePremiumData.closePrice + record.longPePremiumData.closePrice).toFixed(2);
      },
    },
    {
      title: "Net Value",
      key: "netValue",
      width: 180,
      render: (_value: unknown, record: OptionsAnalysisRowV2, index: number) => {
        if (
          !record.cePremiumData ||
          !record.pePremiumData ||
          !record.longCePremiumData ||
          !record.longPePremiumData
        ) {
          return "—";
        }

        const totalValue = record.cePremiumData.closePrice + record.pePremiumData.closePrice;
        const longTotalValue =
          record.longCePremiumData.closePrice + record.longPePremiumData.closePrice;
        const netValue = NET_VALUE_MULTIPLIER * (longTotalValue - totalValue);

        // Calculate percentage change from start date (first row)
        let percentageChange: number | null = null;
        if (result && result.rows.length > 0 && index !== 0) {
          const firstRow = result.rows[0];
          if (
            firstRow.cePremiumData &&
            firstRow.pePremiumData &&
            firstRow.longCePremiumData &&
            firstRow.longPePremiumData
          ) {
            const firstTotalValue =
              firstRow.cePremiumData.closePrice + firstRow.pePremiumData.closePrice;
            const firstLongTotalValue =
              firstRow.longCePremiumData.closePrice + firstRow.longPePremiumData.closePrice;
            const firstNetValue = NET_VALUE_MULTIPLIER * (firstLongTotalValue - firstTotalValue);

            if (firstNetValue !== 0) {
              percentageChange = ((netValue - firstNetValue) / firstNetValue) * 100;
            }
          }
        }

        const percentageDisplay =
          percentageChange !== null
            ? ` (${percentageChange > 0 ? "+" : ""}${percentageChange.toFixed(2)}%)`
            : "";
        const percentageColor = percentageChange !== null ? (percentageChange >= 0 ? "#52c41a" : "#ff4d4f") : "inherit";

        return (
          <div style={{ color: percentageColor }}>
            {netValue.toFixed(2)}
            {percentageDisplay}
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ padding: "24px" }}>
      <Card title="Options Chain Analyzer" style={{ marginBottom: "24px" }}>
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <div>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "500" }}>
              Input Parameters:
            </label>
            <Space wrap style={{ width: "100%" }} size="middle" align="start">
              <div>
                <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                  Symbol
                </label>
                <Input
                  value={formInput.symbol}
                  onChange={(e) => handleFieldChange("symbol", e.target.value.toUpperCase())}
                  placeholder="Symbol"
                  style={{ width: 140 }}
                  aria-label="Symbol"
                />
              </div>
              <div>
                <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                  Strike Price
                </label>
                <Input
                  type="number"
                  value={String(formInput.strikePrice)}
                  onChange={(e) => handleFieldChange("strikePrice", Number(e.target.value))}
                  placeholder="Strike Price"
                  style={{ width: 140 }}
                  aria-label="Strike Price"
                />
              </div>
              <div>
                <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                  Date
                </label>
                <Input
                  type="date"
                  value={formInput.date}
                  onChange={(e) => handleFieldChange("date", e.target.value)}
                  style={{ width: 170 }}
                  aria-label="Date"
                />
              </div>
              <div>
                <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                  Expiry Date
                </label>
                <Input
                  type="date"
                  value={formInput.expiryDate}
                  onChange={(e) => handleFieldChange("expiryDate", e.target.value)}
                  style={{ width: 170 }}
                  aria-label="Expiry Date"
                />
              </div>
              <div>
                <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                  Long Expiry Date
                </label>
                <Input
                  type="date"
                  value={formInput.longExpiryDate}
                  onChange={(e) => handleFieldChange("longExpiryDate", e.target.value)}
                  style={{ width: 170 }}
                  aria-label="Long Expiry Date"
                />
              </div>
            </Space>
            <p style={{ fontSize: "12px", color: "#666", marginTop: "8px" }}>
              Fields: expiry date, long expiry date, date, strike price, and symbol.
              Dates should be in YYYY-MM-DD format.
            </p>
          </div>

          <Space>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleAnalyze}
              loading={loading}
              size="large"
              disabled={cancelRequested}
            >
              Analyze
            </Button>
            <Button
              danger
              onClick={handleCancel}
              disabled={!loading}
              size="large"
            >
              Cancel
            </Button>
            <Button
              onClick={handleReset}
              size="large"
            >
              Reset
            </Button>
          </Space>

          {error && <Alert message="Error" description={error} type="error" showIcon />}
        </Space>
      </Card>

      {loading && (
        <Card style={{ textAlign: "center" }}>
          <Spin size="large" tip="Fetching option prices..." />
        </Card>
      )}

      {result && (
        <Card title="Analysis Results" style={{ marginBottom: "24px" }}>
          <Space style={{ marginBottom: "16px" }}>
            <Button
              icon={copied ? <CheckOutlined /> : <CopyOutlined />}
              onClick={copyToClipboard}
            >
              {copied ? "Copied!" : "Copy Results"}
            </Button>
            <Button icon={<DownloadOutlined />} onClick={downloadCurrentViewAsExcel}>
              Download Excel
            </Button>
          </Space>

          <NetValueChart data={netValueChartData} />

          {result.rows.length === 0 ? (
            <Empty description="No data to display" />
          ) : (
            <Table
              columns={columns}
              dataSource={result.rows.map((row, idx) => ({
                ...row,
                key: idx,
              }))}
              pagination={{ pageSize: 50 }}
              scroll={{ x: 2200 }}
              size="small"
            />
          )}

          <div style={{ marginTop: "24px" }}>
            <p style={{ fontWeight: "500", marginBottom: "8px" }}>Input Data:</p>
            <pre
              style={{
                backgroundColor: "#f5f5f5",
                padding: "12px",
                borderRadius: "4px",
                overflow: "auto",
              }}
            >
              {JSON.stringify(result.inputData, null, 2)}
            </pre>
          </div>
        </Card>
      )}

      <div
        style={{
          position: "fixed",
          right: 24,
          bottom: 24,
          zIndex: 1000,
        }}
      >
        <Popconfirm
          title="Clear local cache?"
          description="This will remove saved option data from local storage."
          okText="Clear"
          cancelText="Cancel"
          onConfirm={clearLocalStorageCache}
        >
          <Button danger icon={<DeleteOutlined />}>
            Clear Local Cache
          </Button>
        </Popconfirm>
      </div>
    </div>
  );
};

export default OptionsAnalyzerV2;


