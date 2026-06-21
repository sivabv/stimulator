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
  Modal,
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
  apiDate: string;
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
  soldPrice: number | null;
  costPrice: number | null;
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

const CallCalendar: React.FC = () => {
  const [formInput, setFormInput] = useState<OptionsInputV2>(DEFAULT_INPUT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [showChart, setShowChart] = useState(true);
  const [copied, setCopied] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [isInputPopupOpen, setIsInputPopupOpen] = useState(false);
  const [selectedStrikeLabel, setSelectedStrikeLabel] = useState<string>("Call Strike");
  const [selectedOptionContext, setSelectedOptionContext] = useState<{
    symbol: string;
    date: string;
    expiryDate: string;
    strikePrice: number;
    optionType: "C";
  } | null>(null);
  const [optionDetailsLoading, setOptionDetailsLoading] = useState(false);
  const [optionDetails, setOptionDetails] = useState<{
    openPrice: number | null;
    closePrice: number | null;
    delta: number | null;
    theta: number | null;
    statusCode: number | null;
  } | null>(null);

  const openInputPopup = (strikeLabel: string, record: OptionsAnalysisRowV2) => {
    setSelectedStrikeLabel(strikeLabel);
    setSelectedOptionContext({
      symbol: formInput.symbol.trim().toUpperCase(),
      date: record.apiDate,
      expiryDate: formInput.expiryDate,
      strikePrice: record.ceStrike,
      optionType: "C",
    });
    setOptionDetails(null);
    setIsInputPopupOpen(true);
  };

  const closeInputPopup = () => {
    setIsInputPopupOpen(false);
  };

  const updatePopupStrikePrice = (value: string) => {
    const nextStrikePrice = value === "" ? 0 : Number(value);
    setSelectedOptionContext((previous) =>
      previous
        ? {
            ...previous,
            strikePrice: nextStrikePrice,
          }
        : previous
    );
  };

  const handleFetchOptionDetails = async () => {
    if (!selectedOptionContext) return;

    setOptionDetailsLoading(true);
    try {
      const response = await fetchOptionWithRateLimitRetry(
        selectedOptionContext.symbol,
        formatExpiryDate(selectedOptionContext.expiryDate),
        selectedOptionContext.strikePrice,
        selectedOptionContext.optionType,
        selectedOptionContext.date
      );
      setOptionDetails(response);
    } catch {
      message.error("Failed to fetch option details");
    } finally {
      setOptionDetailsLoading(false);
    }
  };

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
        const peCanUseCache = true;
        const longCeCanUseCache = Boolean(
          longCeCached &&
          ((longCeCached.skipFuture && longCeCached.statusCode === 404) ||
            longCeCached.openPrice !== null ||
            longCeCached.closePrice !== null)
        );
        const longPeCanUseCache = true;
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
              soldPrice: ceCached?.soldPrice ?? null,
              costPrice: ceCached?.costPrice ?? null,
              statusCode: ceCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, expiryDate, ceStrike, "C", date),
          Promise.resolve({
            openPrice: null,
            closePrice: null,
            delta: null,
            theta: null,
            statusCode: null,
          }),
          longCeCanUseCache
            ? Promise.resolve({
              openPrice: longCeCached?.openPrice ?? null,
              closePrice: longCeCached?.closePrice ?? null,
              delta: longCeCached?.delta ?? null,
              theta: longCeCached?.theta ?? null,
              soldPrice: longCeCached?.soldPrice ?? null,
              costPrice: longCeCached?.costPrice ?? null,
              statusCode: longCeCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, longExpiryDate, ceStrike, "C", date),
          Promise.resolve({
            openPrice: null,
            closePrice: null,
            delta: null,
            theta: null,
            statusCode: null,
          }),
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
          const shortSoldPrice = ceCached?.soldPrice ?? cePrice;
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
            soldPrice: shortSoldPrice,
            costPrice: ceData.costPrice ?? null,
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
            soldPrice: peCached?.soldPrice ?? null,
            costPrice: peCached?.costPrice ?? null,
            statusCode: peData.statusCode,
            skipFuture: shouldSkipPe,
          };
          cacheUpdated = true;
        }
        if (!longCeCanUseCache) {
          const shouldSkipLongCe = longCeData.statusCode === 404;
          const longCostPrice = longCeCached?.costPrice ?? longCePrice;
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
            soldPrice: longCeData.soldPrice ?? null,
            costPrice: longCostPrice,
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
            soldPrice: longPeCached?.soldPrice ?? null,
            costPrice: longPeCached?.costPrice ?? null,
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
          apiDate: date,
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
              soldPrice: ceData.soldPrice ?? ceCached?.soldPrice ?? cePrice,
              costPrice: ceData.costPrice ?? ceCached?.costPrice ?? null,
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
              soldPrice: longCeData.soldPrice ?? longCeCached?.soldPrice ?? null,
              costPrice: longCeData.costPrice ?? longCeCached?.costPrice ?? longCePrice,
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
    setShowChart(true);
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
    message.success("Option cache cleared");
  };

  const netValueChartData = result
    ? result.rows
        .map((row, index) => {
          if (!row.cePremiumData || !row.longCePremiumData) {
            return null;
          }

          const netValue = NET_VALUE_MULTIPLIER * (
            row.longCePremiumData.closePrice - row.cePremiumData.closePrice
          );

          const firstRow = result.rows[0];
          if (!firstRow?.cePremiumData || !firstRow.longCePremiumData) {
            return {
              date: row.date,
              netValue,
              percentageChange: null,
            };
          }

          const firstNetValue = NET_VALUE_MULTIPLIER * (
            firstRow.longCePremiumData.closePrice - firstRow.cePremiumData.closePrice
          );

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

  const tableScrollY = showChart ? "calc(100vh - 420px)" : "calc(100vh - 300px)";

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
        "Call Premium": row.cePremiumData
          ? `${row.cePremiumData.expiryDate}-${row.cePremiumData.strike}`

          : "—",
        "CE Price": row.cePremiumData ? row.cePremiumData.closePrice.toFixed(2) : "—",
        "Call Value": row.cePremiumData !== null ? row.cePremiumData.closePrice.toFixed(2) : "—",
        "Long Call Price": row.longCePremiumData ? row.longCePremiumData.closePrice.toFixed(2) : "—",
        "Long Call Value": row.longCePremiumData !== null ? row.longCePremiumData.closePrice.toFixed(2) : "—",
        "Net Value":
          row.cePremiumData !== null &&
          row.longCePremiumData !== null
            ? (
                NET_VALUE_MULTIPLIER * (
                  row.longCePremiumData.closePrice -
                  row.cePremiumData.closePrice
                )
              ).toFixed(2)
            : "—",
        "Mark change - Call": row.markChangeCall !== null ? row.markChangeCall.toFixed(2) : "—",
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
    {
      title: "Call Strike",
      dataIndex: "ceStrike",
      key: "ceStrike",
      width: 120,
      render: (value: number, record: OptionsAnalysisRowV2) => (
        <Button
          type="link"
          style={{ padding: 0, height: "auto" }}
          onClick={() => openInputPopup("Call Strike", record)}
        >
          {value.toFixed(0)}
        </Button>
      ),
    },
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
      title: "Net Value",
      key: "netValue",
      width: 180,
      render: (_value: unknown, record: OptionsAnalysisRowV2, index: number) => {
        if (
          !record.cePremiumData ||
          !record.longCePremiumData
        ) {
          return "—";
        }

        const netValue = NET_VALUE_MULTIPLIER * (
          record.longCePremiumData.closePrice - record.cePremiumData.closePrice
        );

        // Calculate percentage change from start date (first row)
        let percentageChange: number | null = null;
        if (result && result.rows.length > 0 && index !== 0) {
          const firstRow = result.rows[0];
          if (
            firstRow.cePremiumData &&
            firstRow.longCePremiumData
          ) {
            const firstNetValue =
              NET_VALUE_MULTIPLIER * (
                firstRow.longCePremiumData.closePrice - firstRow.cePremiumData.closePrice
              );

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
    }, {
      title: "Net Value- 12L-10S",
      key: "netValue12L10S",
      width: 180,
      render: (_value: unknown, record: OptionsAnalysisRowV2, index: number) => {
        if (
          !record.cePremiumData ||
          !record.longCePremiumData
        ) {
          return "—";
        }

        const netValue =
          12 * record.longCePremiumData.closePrice - 10 * record.cePremiumData.closePrice;

        // Calculate percentage change from start date (first row)
        let percentageChange: number | null = null;
        if (result && result.rows.length > 0 && index !== 0) {
          const firstRow = result.rows[0];
          if (
            firstRow.cePremiumData &&
            firstRow.longCePremiumData
          ) {
            const firstNetValue =
              12 * firstRow.longCePremiumData.closePrice - 10 * firstRow.cePremiumData.closePrice;

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
    <div
      style={{
        width: "100%",
        maxWidth: "none",
        margin: "0 auto",
        padding: "16px clamp(5px, 1.2vw, 10px)",
        boxSizing: "border-box",
        height: "calc(100vh - 140px)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", gap: "8px", flex: 1, minHeight: 0 }}>
        <Card title="Call Calendar" style={{ width: 260, flex: "0 0 260px" }}>
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <div>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                Symbol
              </label>
              <Input
                value={formInput.symbol}
                onChange={(e) => handleFieldChange("symbol", e.target.value.toUpperCase())}
                placeholder="Symbol"
                style={{ width: "100%" }}
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
                style={{ width: "100%" }}
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
                style={{ width: "100%" }}
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
                style={{ width: "100%" }}
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
                style={{ width: "100%" }}
                aria-label="Long Expiry Date"
              />
            </div>

            <Space wrap>
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
              <Button onClick={handleReset} size="large">
                Reset
              </Button>
            </Space>

            {error && <Alert message="Error" description={error} type="error" showIcon />}

            {result && (
              <div>
                <p style={{ fontWeight: "500", marginBottom: "8px" }}>Input Data:</p>
                <pre
                  style={{
                    backgroundColor: "#f5f5f5",
                    padding: "12px",
                    borderRadius: "4px",
                    overflow: "auto",
                    maxHeight: "180px",
                    margin: 0,
                  }}
                >
                  {JSON.stringify(result.inputData, null, 2)}
                </pre>
              </div>
            )}
          </Space>
        </Card>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
          {loading && (
            <Card style={{ textAlign: "center", flex: "0 0 auto" }}>
              <Spin size="large" tip="Fetching option prices..." />
            </Card>
          )}

          {result ? (
            <Card
              title="Analysis Results"
              style={{
                width: "100%",
                flex: "1 1 auto",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
              bodyStyle={{
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
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
                <Button onClick={() => setShowChart((previous) => !previous)}>
                  {showChart ? "Hide Chart" : "Show Chart"}
                </Button>
              </Space>

              {showChart && <NetValueChart data={netValueChartData} title="Call Net Value Trend" />}

              {result.rows.length === 0 ? (
                <Empty description="No data to display" />
              ) : (
                <div style={{ width: "100%", flex: 1, minHeight: 0, overflow: "hidden" }}>
                  <Table
                    columns={columns}
                    dataSource={result.rows.map((row, idx) => ({
                      ...row,
                      key: idx,
                    }))}
                    pagination={{ pageSize: 50 }}
                    scroll={{ x: "max-content", y: tableScrollY }}
                    size="small"
                  />
                </div>
              )}
            </Card>
          ) : (
            <Card style={{ flex: 1, minHeight: 0 }}>
              <Empty description="Run analysis to view grid" />
            </Card>
          )}
        </div>
      </div>

      <div
        style={{
          position: "fixed",
          right: 24,
          bottom: 24,
          zIndex: 1000,
        }}
      >
        <Popconfirm
          title="Clear option cache?"
          description="This will remove only saved option data from local storage. Stock cache will be kept."
          okText="Clear"
          cancelText="Cancel"
          onConfirm={clearLocalStorageCache}
        >
          <Button danger icon={<DeleteOutlined />}>
            Clear Local Cache
          </Button>
        </Popconfirm>
      </div>

      <Modal
        title={`${selectedStrikeLabel} - Input Details`}
        open={isInputPopupOpen}
        onCancel={closeInputPopup}
        footer={null}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Symbol</label>
            <Input value={selectedOptionContext?.symbol ?? ""} readOnly />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Strike Price</label>
            <Input
              type="number"
              min={0}
              placeholder="Edit strike price"
              value={selectedOptionContext ? String(selectedOptionContext.strikePrice) : ""}
              onChange={(event) => updatePopupStrikePrice(event.target.value)}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Date</label>
            <Input type="date" value={selectedOptionContext?.date ?? ""} readOnly />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Expiry Date</label>
            <Input type="date" value={selectedOptionContext?.expiryDate ?? ""} readOnly />
          </div>
          <div>
            <Button
              type="primary"
              onClick={handleFetchOptionDetails}
              loading={optionDetailsLoading}
              disabled={!selectedOptionContext}
            >
              Get Option Details
            </Button>
          </div>
          {optionDetails && (
            <div style={{ backgroundColor: "#f5f5f5", borderRadius: "4px", padding: "10px" }}>
              <div>Status: {optionDetails.statusCode ?? "N/A"}</div>
              <div>Open: {optionDetails.openPrice !== null ? optionDetails.openPrice.toFixed(2) : "—"}</div>
              <div>Close: {optionDetails.closePrice !== null ? optionDetails.closePrice.toFixed(2) : "—"}</div>
              <div>Delta: {optionDetails.delta !== null ? optionDetails.delta.toFixed(4) : "—"}</div>
              <div>Theta: {optionDetails.theta !== null ? optionDetails.theta.toFixed(4) : "—"}</div>
            </div>
          )}
          {!optionDetails && !optionDetailsLoading && (
            <div style={{ color: "#888", fontSize: "12px" }}>
              Click "Get Option Details" to load option open/close and greeks.
            </div>
          )}
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Long Expiry Date</label>
            <Input value={formInput.longExpiryDate} readOnly />
          </div>
        </Space>
      </Modal>
    </div>
  );
};

export default CallCalendar;


