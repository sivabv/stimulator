/**
 * OptionsAnalyzer — screen for analyzing option premiums over a date range
 * Accepts JSON input with array of objects, calls Massive.com API, and displays results
 */

import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Select,
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
import dataJson from "../assets/data.json";
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

interface PhaseGridResult {
  phaseNumber: number;
  startDate: string;
  endDate: string;
  analysis: AnalysisResult;
}

interface PhaseSummaryRow {
  key: string;
  phaseLabel: string;
  startDate: string;
  endDate: string;
  startStockPrice: number | null;
  endStockPrice: number | null;
  stockPercentageChange: number | null;
  startNetValue: number | null;
  endPhaseNetValue: number | null;
  totalNetValue: number | null;
  cumulativeTotalNetValue: number | null;
  totalNetValue12L10S: number | null;
  cumulativeTotalNetValue12L10S: number | null;
}

interface SelectedOptionContext {
  symbol: string;
  date: string;
  expiryDate: string;
  longExpiryDate: string;
  shortGivenExpiryDate: string;
  shortCalculatedExpiryDate: string;
  longGivenExpiryDate: string;
  longCalculatedExpiryDate: string;
  shortStrikePrice: number;
  longStrikePrice: number;
  optionType: "P";
}

interface RowStrikeEntry {
  date: string;
  shortStrikePrice: number;
  longStrikePrice: number;
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
const parsedDataJson =
  dataJson && typeof dataJson === "object" && !Array.isArray(dataJson)
    ? (dataJson as {
      masterOptionData?: Record<string, Partial<CachedOptionResponse>>;
      masterStockData?: Record<string, Partial<CachedStockResponse>>;
    })
    : {};

const DATA_FILE_OPTION_DATA: MasterOptionData = Object.fromEntries(
  Object.entries(parsedDataJson.masterOptionData ?? {}).map(([key, entry]) => [
    key,
    {
      symbol: entry.symbol ?? "",
      expiryDate: entry.expiryDate ?? "",
      strikePrice: Number.isFinite(entry.strikePrice) ? entry.strikePrice as number : Number.NaN,
      optionType: entry.optionType === "C" ? "C" : "P",
      date: entry.date ?? "",
      openPrice: entry.openPrice ?? null,
      closePrice: entry.closePrice ?? null,
      delta: entry.delta ?? null,
      theta: entry.theta ?? null,
      soldPrice: entry.soldPrice ?? null,
      costPrice: entry.costPrice ?? null,
      statusCode: entry.statusCode ?? null,
      skipFuture: entry.skipFuture ?? false,
    } satisfies CachedOptionResponse,
  ])
);

const DATA_FILE_STOCK_DATA: MasterStockData = Object.fromEntries(
  Object.entries(parsedDataJson.masterStockData ?? {}).map(([key, entry]) => [
    key,
    {
      symbol: entry.symbol ?? "",
      date: entry.date ?? "",
      openPrice: entry.openPrice ?? null,
      closePrice: entry.closePrice ?? null,
      statusCode: entry.statusCode ?? null,
    } satisfies CachedStockResponse,
  ])
);
const tradingDates2026 = new Set<string>(tradingDates2026Json as string[]);
const RATE_LIMIT_WAIT_MS = 2_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const NET_VALUE_MULTIPLIER = 10;
const LONG_EXPIRY_MIN_DTE_DAYS = 70;
const LONG_EXPIRY_MAX_DTE_DAYS = 120;
const DEFAULT_INPUT: OptionsInputV2 = {
  expiryDate: "",
  longExpiryDate: "",
  date: "2026-01-01",
  strikePrice: 700,
  symbol: "SPY",
};

const PutCalendar: React.FC = () => {
  const [formInput, setFormInput] = useState<OptionsInputV2>(DEFAULT_INPUT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [isInputPopupOpen, setIsInputPopupOpen] = useState(false);
  const [selectedStrikeLabel, setSelectedStrikeLabel] = useState<string>("Put Strike");
  const [selectedOptionContext, setSelectedOptionContext] = useState<SelectedOptionContext | null>(null);
  const [rowStrikeEntries, setRowStrikeEntries] = useState<RowStrikeEntry[]>([]);
  const [optionDetailsLoading, setOptionDetailsLoading] = useState(false);
  const dateChangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [optionDetails, setOptionDetails] = useState<{
    openPrice: number | null;
    closePrice: number | null;
    delta: number | null;
    theta: number | null;
    statusCode: number | null;
  } | null>(null);

  // Additional phases (Phase 2, Phase 3, ...) generated after Phase 1
  const [phaseResults, setPhaseResults] = useState<PhaseGridResult[]>([]);
  const [phaseLoading, setPhaseLoading] = useState(false);
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [phaseSplitInfo, setPhaseSplitInfo] = useState<{
    phase1StartDate: string;
    phase1EndDate: string;
    phase2StartDate: string;
  } | null>(null);

  // Chart visibility toggles
  const [showChart1, setShowChart1] = useState(false);
  const [phaseChartVisibility, setPhaseChartVisibility] = useState<Record<number, boolean>>({});
  const [phase1SelectedRowKeys, setPhase1SelectedRowKeys] = useState<React.Key[]>([]);
  const [phaseSelectedRowKeys, setPhaseSelectedRowKeys] = useState<Record<number, React.Key[]>>({});

  useEffect(() => {
    return () => {
      if (dateChangeTimeoutRef.current) {
        clearTimeout(dateChangeTimeoutRef.current);
      }
    };
  }, []);

  const openInputPopup = (strikeLabel: string, record: OptionsAnalysisRowV2) => {
    const existingRowStrike = rowStrikeEntries.find((entry) => entry.date === record.apiDate);
    const shortGivenExpiryDate = formInput.expiryDate && dayjs(formInput.expiryDate).isValid()
      ? formInput.expiryDate
      : "";
    const shortCalculatedExpiryDate =
      getExpiryCandidates30To45Days(record.apiDate, formInput.expiryDate)[0] ?? record.apiDate;
    const longGivenExpiryDate = formInput.longExpiryDate && dayjs(formInput.longExpiryDate).isValid()
      ? formInput.longExpiryDate
      : "";
    const longCalculatedExpiryDate =
      getExpiryCandidates70To120Days(record.apiDate, formInput.longExpiryDate)[0] ?? record.apiDate;

    const nextOptionContext: SelectedOptionContext = {
      symbol: formInput.symbol.trim().toUpperCase(),
      date: record.apiDate,
      expiryDate: shortGivenExpiryDate || shortCalculatedExpiryDate,
      longExpiryDate: longGivenExpiryDate || longCalculatedExpiryDate,
      shortGivenExpiryDate,
      shortCalculatedExpiryDate,
      longGivenExpiryDate,
      longCalculatedExpiryDate,
      shortStrikePrice: existingRowStrike?.shortStrikePrice ?? record.peStrike,
      longStrikePrice:
        existingRowStrike?.longStrikePrice ??
        record.longPePremiumData?.strike ??
        (record.peStrike - 5),
      optionType: "P",
    };

    console.log("PutCalendar modal opened", nextOptionContext);
    setSelectedStrikeLabel(strikeLabel);
    setSelectedOptionContext(nextOptionContext);
    setOptionDetails(null);
    setIsInputPopupOpen(true);
  };

  const closeInputPopup = () => {
    setIsInputPopupOpen(false);
  };

  const updatePopupStrikePrice = (value: string, strikeType: "short" | "long") => {
    const nextStrikePrice = value === "" ? 0 : Number(value);
    setOptionDetails(null);
    setSelectedOptionContext((previous) =>
      previous
        ? {
            ...previous,
            shortStrikePrice:
              strikeType === "short" ? nextStrikePrice : previous.shortStrikePrice,
            longStrikePrice:
              strikeType === "long" ? nextStrikePrice : previous.longStrikePrice,
          }
        : previous
    );
  };

  const updatePopupDate = (value: string, field: "date" | "expiryDate" | "longExpiryDate") => {
    setOptionDetails(null);
    setSelectedOptionContext((previous) =>
      previous
        ? {
            ...previous,
            [field]: value,
          }
        : previous
    );
  };

  const getPreviousTradingDate = (date: string): string | null => {
    for (let daysBack = 1; daysBack <= 5; daysBack += 1) {
      const candidate = dayjs(date).subtract(daysBack, "day").format("YYYY-MM-DD");
      if (tradingDates2026.has(candidate)) {
        return candidate;
      }
    }

    return null;
  };

  const loadOrFetchOptionData = async (
    masterOptionData: MasterOptionData,
    symbol: string,
    expiryDate: string,
    strikePrice: number,
    optionType: "C" | "P",
    date: string
  ): Promise<CachedOptionResponse> => {
    const cacheKey = getCacheKey(symbol, expiryDate, strikePrice, optionType, date);
    const cached = masterOptionData[cacheKey];

    if (cached) {
      return cached;
    }

    const response = await fetchOptionWithRateLimitRetry(symbol, expiryDate, strikePrice, optionType, date);
    const normalizedResponse: CachedOptionResponse = {
      symbol,
      expiryDate,
      strikePrice,
      optionType,
      date,
      openPrice: response.openPrice,
      closePrice: response.closePrice,
      delta: response.delta,
      theta: response.theta,
      soldPrice: response.soldPrice ?? null,
      costPrice: response.costPrice ?? null,
      statusCode: response.statusCode,
      skipFuture: response.statusCode === 404,
    };

    masterOptionData[cacheKey] = normalizedResponse;
    return normalizedResponse;
  };

  const updateStrikePriceAndRefreshRow = async (
    optionContextOverride?: SelectedOptionContext,
    rerunAnalysisAfterUpdate = false
  ) => {
    const activeOptionContext = optionContextOverride ?? selectedOptionContext;
    if (!activeOptionContext || !result) return;

    const nextShortStrikePrice = Number(activeOptionContext.shortStrikePrice);
    const nextLongStrikePrice = Number(activeOptionContext.longStrikePrice);
    if (
      !Number.isFinite(nextShortStrikePrice) ||
      !Number.isFinite(nextLongStrikePrice) ||
      nextShortStrikePrice < 0 ||
      nextLongStrikePrice < 0
    ) {
      message.error("Short and long strike prices must be valid non-negative numbers");
      return;
    }

    if (
      !dayjs(activeOptionContext.date).isValid() ||
      !dayjs(activeOptionContext.longExpiryDate).isValid()
    ) {
      message.error("Date and long expiry date must be valid");
      return;
    }

    if (!isLongExpiryInRange(activeOptionContext.date, activeOptionContext.longExpiryDate)) {
      message.error("Long expiry date must be 70 to 120 days from date");
      return;
    }

    setOptionDetailsLoading(true);

    try {
      const symbol = activeOptionContext.symbol.trim().toUpperCase();
      const date = activeOptionContext.date;
      const shortExpiryDate = formatExpiryDate(activeOptionContext.expiryDate);
      const longExpiryDate = formatExpiryDate(activeOptionContext.longExpiryDate);
      const masterOptionData = loadMasterOptionData();

      const targetDates = result.rows
        .map((row) => row.apiDate)
        .filter((rowDate) => rowDate >= date);

      const updatesByDate: Record<
        string,
        {
          peData: CachedOptionResponse;
          longPeData: CachedOptionResponse;
          previousPeData: CachedOptionResponse | null;
        }
      > = {};

      for (const targetDate of targetDates) {
        const previousDate = getPreviousTradingDate(targetDate);
        const [peData, longPeData, previousPeData] = await Promise.all([
          loadOrFetchOptionData(masterOptionData, symbol, shortExpiryDate, nextShortStrikePrice, "P", targetDate),
          loadOrFetchOptionData(masterOptionData, symbol, longExpiryDate, nextLongStrikePrice, "P", targetDate),
          previousDate
            ? loadOrFetchOptionData(masterOptionData, symbol, shortExpiryDate, nextShortStrikePrice, "P", previousDate)
            : Promise.resolve(null),
        ]);

        updatesByDate[targetDate] = {
          peData,
          longPeData,
          previousPeData,
        };
      }

      saveMasterOptionData(masterOptionData);
      const selectedDateUpdate = updatesByDate[date];
      if (selectedDateUpdate) {
        setOptionDetails(selectedDateUpdate.peData);
      }

      const nextFormInput: OptionsInputV2 = {
        ...formInput,
        symbol,
        date,
        expiryDate: activeOptionContext.expiryDate,
        longExpiryDate: activeOptionContext.longExpiryDate,
        strikePrice: nextShortStrikePrice,
      };

      setFormInput(nextFormInput);
      setResult((previous) => {
        if (!previous) {
          return previous;
        }

        const updatedRows = previous.rows.map((row) => {
          if (row.apiDate < date) {
            return row;
          }

          const dateUpdate = updatesByDate[row.apiDate];
          if (!dateUpdate) {
            return row;
          }

          const peData = dateUpdate.peData;
          const longPeData = dateUpdate.longPeData;
          const previousPeData = dateUpdate.previousPeData;

          const existingShortPremium = row.pePremiumData;
          const existingLongPremium = row.longPePremiumData;
          const nextShortClosePrice = peData.closePrice;
          const nextLongClosePrice = longPeData.closePrice;

          return {
            ...row,
            peStrike: nextShortStrikePrice,
            pePremiumData:
              nextShortClosePrice !== null
                ? {
                    expiryDate: formatDisplayDate(activeOptionContext.expiryDate),
                    strike: nextShortStrikePrice,
                    closePrice: nextShortClosePrice,
                    delta: peData.delta,
                    theta: peData.theta,
                    soldPrice: peData.soldPrice ?? existingShortPremium?.soldPrice ?? nextShortClosePrice,
                    costPrice: peData.costPrice ?? existingShortPremium?.costPrice ?? null,
                  }
                : null,
            longPePremiumData:
              nextLongClosePrice !== null
                ? {
                    expiryDate: formatDisplayDate(activeOptionContext.longExpiryDate),
                    strike: nextLongStrikePrice,
                    closePrice: nextLongClosePrice,
                    delta: longPeData.delta,
                    theta: longPeData.theta,
                    soldPrice: longPeData.soldPrice ?? existingLongPremium?.soldPrice ?? null,
                    costPrice: longPeData.costPrice ?? existingLongPremium?.costPrice ?? nextLongClosePrice,
                  }
                : null,
            markChangePut:
              nextShortClosePrice !== null && previousPeData !== null && previousPeData.closePrice !== null
                ? nextShortClosePrice - previousPeData.closePrice
                : null,
          };
        });

        return {
          ...previous,
          rows: updatedRows,
        };
      });

      setRowStrikeEntries((previous) => {
        const existingDates = new Set(previous.map((entry) => entry.date));
        const updated = previous.map((entry) =>
          entry.date >= date
            ? {
                ...entry,
                shortStrikePrice: nextShortStrikePrice,
                longStrikePrice: nextLongStrikePrice,
              }
            : entry
        );

        for (const targetDate of targetDates) {
          if (!existingDates.has(targetDate)) {
            updated.push({
              date: targetDate,
              shortStrikePrice: nextShortStrikePrice,
              longStrikePrice: nextLongStrikePrice,
            });
          }
        }

        updated.sort((a, b) => a.date.localeCompare(b.date));
        return updated;
      });

      if (rerunAnalysisAfterUpdate) {
        console.log("PutCalendar popup open triggered analysis rerun", nextFormInput);
        await handleAnalyze(nextFormInput);
      }

      message.success(
        `Updated short strike ${nextShortStrikePrice} and long strike ${nextLongStrikePrice} for selected row and subsequent rows`
      );
    } catch {
      message.error("Failed to update strike price");
    } finally {
      setOptionDetailsLoading(false);
    }
  };

  const handleFetchOptionDetails = async () => {
    if (!selectedOptionContext) return;

    setOptionDetailsLoading(true);
    try {
      const response = await fetchOptionWithRateLimitRetry(
        selectedOptionContext.symbol,
        formatExpiryDate(selectedOptionContext.expiryDate),
        selectedOptionContext.shortStrikePrice,
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
    const fileCacheKey = getCacheKey(symbol, expiryDate, strikePrice, optionType, date);
    const optionDataFromFile = DATA_FILE_OPTION_DATA[fileCacheKey];
    const hasOptionDataInFile =
      Boolean(optionDataFromFile) &&
      optionDataFromFile.statusCode !== 404 &&
      (
        optionDataFromFile.openPrice !== null ||
        optionDataFromFile.closePrice !== null ||
        optionDataFromFile.soldPrice !== null ||
        optionDataFromFile.costPrice !== null
      );

    if (hasOptionDataInFile && optionDataFromFile) {
      return {
        openPrice: optionDataFromFile.openPrice,
        closePrice: optionDataFromFile.closePrice,
        delta: optionDataFromFile.delta,
        theta: optionDataFromFile.theta,
        soldPrice: optionDataFromFile.soldPrice,
        costPrice: optionDataFromFile.costPrice,
        statusCode: optionDataFromFile.statusCode,
      };
    }

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
    const stockCacheKey = `${symbol}|${date}`;
    const stockDataFromFile = DATA_FILE_STOCK_DATA[stockCacheKey];
    const hasStockDataInFile =
      Boolean(stockDataFromFile) &&
      stockDataFromFile.statusCode !== 404 &&
      (stockDataFromFile.openPrice !== null || stockDataFromFile.closePrice !== null);

    if (hasStockDataInFile && stockDataFromFile) {
      return {
        openPrice: stockDataFromFile.openPrice,
        closePrice: stockDataFromFile.closePrice,
        delta: null,
        theta: null,
        statusCode: stockDataFromFile.statusCode,
      };
    }

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

  const roundToNearestFive = (value: number): number => {
    return Math.round(value / 5) * 5;
  };

  const getLongExpiryDteDays = (baseDate: string, longExpiryDate: string): number => {
    return dayjs(longExpiryDate).startOf("day").diff(dayjs(baseDate).startOf("day"), "day");
  };

  const isLongExpiryInRange = (baseDate: string, longExpiryDate: string): boolean => {
    const dteDays = getLongExpiryDteDays(baseDate, longExpiryDate);
    return dteDays >= LONG_EXPIRY_MIN_DTE_DAYS && dteDays <= LONG_EXPIRY_MAX_DTE_DAYS;
  };

  const isProvidedStrikePrice = (value: number): boolean => {
    return Number.isFinite(value) && value > 0;
  };

  const confirmStrikeChoice = (
    providedStrikePrice: number,
    calculatedStrikePrice: number,
    tradeDate: string
  ): Promise<"provided" | "calculated"> => {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (choice: "provided" | "calculated") => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };

      Modal.confirm({
        title: "Strike Price Confirmation",
        content: `Date ${tradeDate}: provided strike ${providedStrikePrice} differs by more than 3% from calculated strike ${calculatedStrikePrice}.`,
        okText: `Use Provided (${providedStrikePrice})`,
        cancelText: `Use Calculated (${calculatedStrikePrice})`,
        onOk: () => settle("provided"),
        onCancel: () => settle("calculated"),
      });
    });
  };

  const getStrikeCandidatesFromClose = (closePrice: number): number[] => {
    const baseCandidates = [0.02, 0.0175, 0.015].map((discountPct) =>
      roundToNearestFive(closePrice * (1 - discountPct))
    );
    const expanded = baseCandidates.flatMap((strike) => [strike - 5, strike, strike + 5]);
    return Array.from(new Set(expanded.filter((strike) => strike > 0)));
  };

  const getExpiryCandidates30To45Days = (baseDate: string, preferredExpiryDate: string): string[] => {
    const start = dayjs(baseDate).add(30, "day");
    const end = dayjs(baseDate).add(45, "day");

    const candidates = Array.from(tradingDates2026)
      .filter((candidateDate) => {
        const candidate = dayjs(candidateDate);
        return (
          candidate.isValid() &&
          (candidate.isAfter(start, "day") || candidate.isSame(start, "day")) &&
          (candidate.isBefore(end, "day") || candidate.isSame(end, "day"))
        );
      })
      .sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());

    if (candidates.length === 0) {
      return preferredExpiryDate ? [preferredExpiryDate] : [];
    }

    if (preferredExpiryDate && candidates.includes(preferredExpiryDate)) {
      return [preferredExpiryDate, ...candidates.filter((candidate) => candidate !== preferredExpiryDate)];
    }

    return candidates;
  };

  const getExpiryCandidates70To120Days = (baseDate: string, preferredExpiryDate: string): string[] => {
    const start = dayjs(baseDate).add(LONG_EXPIRY_MIN_DTE_DAYS, "day");
    const end = dayjs(baseDate).add(LONG_EXPIRY_MAX_DTE_DAYS, "day");

    const candidates = Array.from(tradingDates2026)
      .filter((candidateDate) => {
        const candidate = dayjs(candidateDate);
        return (
          candidate.isValid() &&
          (candidate.isAfter(start, "day") || candidate.isSame(start, "day")) &&
          (candidate.isBefore(end, "day") || candidate.isSame(end, "day"))
        );
      })
      .sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());

    if (candidates.length === 0) {
      return preferredExpiryDate ? [preferredExpiryDate] : [];
    }

    if (preferredExpiryDate && candidates.includes(preferredExpiryDate)) {
      return [preferredExpiryDate, ...candidates.filter((candidate) => candidate !== preferredExpiryDate)];
    }

    return candidates;
  };

  const getLongPutRetryStrikeCandidatesFromClose = (closePrice: number): number[] => {
    const pctSteps = [-0.05, -0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05];
    const strikes = pctSteps.map((pct) => roundToNearestFive(closePrice * (1 + pct)));
    return Array.from(new Set(strikes.filter((strike) => Number.isFinite(strike) && strike > 0)));
  };

  const handleDateChangeAndRunSimulation = async (nextDate: string) => {
    const normalizedDate = dayjs(nextDate).isValid() ? dayjs(nextDate).format("YYYY-MM-DD") : nextDate;

    setFormInput((previous) => ({
      ...previous,
      date: normalizedDate,
    }));

    if (!dayjs(normalizedDate).isValid()) {
      return;
    }

    const symbol = formInput.symbol.trim().toUpperCase();
    if (!symbol) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const stockResponse = await fetchStockWithRateLimitRetry(symbol, normalizedDate);
      const closePrice = stockResponse.closePrice;

      if (closePrice === null) {
        throw new Error("Unable to fetch close price for selected date");
      }

      const strikeCandidates = getStrikeCandidatesFromClose(closePrice);
      const expiryCandidates = getExpiryCandidates30To45Days(normalizedDate, formInput.expiryDate);
      const longExpiryCandidates = getExpiryCandidates70To120Days(normalizedDate, formInput.longExpiryDate).slice(0, 4);
      const longStrikeCandidatesFromClose = getLongPutRetryStrikeCandidatesFromClose(closePrice);

      let resolvedStrikePrice = strikeCandidates[0] ?? formInput.strikePrice;
      let resolvedExpiryDate = expiryCandidates[0] ?? (formInput.expiryDate || normalizedDate);
      let resolvedLongExpiryDate = longExpiryCandidates[0] ?? formInput.longExpiryDate;

      let foundValidCombination = false;
      for (const expiryCandidate of expiryCandidates) {
        const formattedExpiryCandidate = formatExpiryDate(expiryCandidate);

        for (const strikeCandidate of strikeCandidates) {
          const shortOption = await fetchOptionWithRateLimitRetry(
            symbol,
            formattedExpiryCandidate,
            strikeCandidate,
            "P",
            normalizedDate
          );

          const shortValid = shortOption.statusCode !== 404 && shortOption.closePrice !== null;
          if (!shortValid) {
            continue;
          }

          let longValid = false;
          for (const longExpiryCandidate of longExpiryCandidates) {
            const formattedLongExpiry = formatExpiryDate(longExpiryCandidate);
            const computedLongStrike = strikeCandidate - 5;
            const longStrikeCandidates = Array.from(
              new Set([computedLongStrike, ...longStrikeCandidatesFromClose])
            );
            for (const longStrikeCandidate of longStrikeCandidates) {
              const longOption = await fetchOptionWithRateLimitRetry(
                symbol,
                formattedLongExpiry,
                longStrikeCandidate,
                "P",
                normalizedDate
              );

              if (longOption.statusCode !== 404 && longOption.closePrice !== null) {
                resolvedLongExpiryDate = longExpiryCandidate;
                longValid = true;
                break;
              }
            }

            if (longValid) {
              break;
            }
          }

          if (shortValid && longValid) {
            resolvedStrikePrice = strikeCandidate;
            resolvedExpiryDate = expiryCandidate;
            foundValidCombination = true;
            break;
          }
        }

        if (foundValidCombination) {
          break;
        }
      }

      const providedStrikePrice = isProvidedStrikePrice(formInput.strikePrice)
        ? roundToNearestFive(formInput.strikePrice)
        : null;
      if (providedStrikePrice !== null) {
        const diffPercent =
          resolvedStrikePrice !== 0
            ? (Math.abs(providedStrikePrice - resolvedStrikePrice) / Math.abs(resolvedStrikePrice)) * 100
            : 0;

        if (diffPercent > 3) {
          const choice = await confirmStrikeChoice(providedStrikePrice, resolvedStrikePrice, normalizedDate);
          if (choice === "provided") {
            resolvedStrikePrice = providedStrikePrice;
          }
        } else {
          resolvedStrikePrice = providedStrikePrice;
        }
      }

      const nextInput: OptionsInputV2 = {
        ...formInput,
        symbol,
        date: normalizedDate,
        strikePrice: resolvedStrikePrice,
        expiryDate: resolvedExpiryDate,
        longExpiryDate: resolvedLongExpiryDate,
      };

      setFormInput(nextInput);
      await handleAnalyze(nextInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update simulation for selected date";
      setError(msg);
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Parse form input and validate structure
   */
  const parseInput = (inputOverride?: OptionsInputV2): OptionsInputV2[] => {
    const sourceInput = inputOverride ?? formInput;
    const normalizedInput: OptionsInputV2 = {
      expiryDate: sourceInput.expiryDate,
      longExpiryDate: sourceInput.longExpiryDate,
      date: sourceInput.date,
      strikePrice: sourceInput.strikePrice,
      symbol: sourceInput.symbol.trim(),
    };

    if (
      !normalizedInput.date ||
      !normalizedInput.symbol
    ) {
      throw new Error("Symbol and date are required");
    }

    if (
      normalizedInput.expiryDate && !dayjs(normalizedInput.expiryDate).isValid()
    ) {
      throw new Error("Expiry date must be in YYYY-MM-DD format");
    }

    if (
      normalizedInput.longExpiryDate &&
      !dayjs(normalizedInput.longExpiryDate).isValid()
    ) {
      throw new Error("Long expiry date must be in YYYY-MM-DD format");
    }

    if (!dayjs(normalizedInput.date).isValid()) {
      throw new Error("Date must be in YYYY-MM-DD format");
    }

    if (normalizedInput.longExpiryDate) {
      const dteDays = getLongExpiryDteDays(normalizedInput.date, normalizedInput.longExpiryDate);
      if (dteDays < LONG_EXPIRY_MIN_DTE_DAYS || dteDays > LONG_EXPIRY_MAX_DTE_DAYS) {
        // Fall back to auto-selected long expiry in the configured DTE window.
        normalizedInput.longExpiryDate = "";
      }
    }

    return [normalizedInput];
  };

  const expandInputData = (inputs: OptionsInputV2[]): OptionsInputV2[] => {
    const expanded: OptionsInputV2[] = [];
    const today = dayjs().startOf("day");

    for (const input of inputs) {
      const start = dayjs(input.date);
      const hasValidExpiryDate = Boolean(input.expiryDate && dayjs(input.expiryDate).isValid());
      const end = hasValidExpiryDate ? dayjs(input.expiryDate) : dayjs(input.date).add(45, "day");

      if (hasValidExpiryDate && start.isAfter(end)) {
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
  const handleAnalyze = async (inputOverride?: OptionsInputV2) => {
    setError(null);
    setResult(null);
    setPhaseResults([]);
    setPhaseError(null);
    setShowChart1(false);
    setPhaseChartVisibility({});
    setPhase1SelectedRowKeys([]);
    setPhaseSelectedRowKeys({});
    setPhaseSplitInfo(null);
    setLoading(true);
    setCancelRequested(false);

    try {
      const inputData = parseInput(inputOverride);
      const expandedInputData = expandInputData(inputData);
      const masterOptionData = loadMasterOptionData();
      const masterStockData = loadMasterStockData();
      let cacheUpdated = false;
      let stockCacheUpdated = false;
      let sawRateLimit = false;
      let activeStrikePrice: number | null = null;
      let activeExpiryDate: string | null = null;
      let phase1CutoffShortExpiryDate: string | null = null;
      let activeLongExpiryDate: string | null = null;
      let activeLongStrikePrice: number | null = null;

      const rows: OptionsAnalysisRowV2[] = [];
      setResult({ rows: [], inputData });
      setRowStrikeEntries([]);

      // Process each input row independently so each row keeps its own strike/symbol/expiry/date
      for (const input of expandedInputData) {
        if (cancelRequested) {
          message.info("Analysis cancelled");
          break;
        }
        const date = input.date;
        const symbol = input.symbol.toUpperCase();

        if (activeExpiryDate === null) {
          const providedExpiryDate = input.expiryDate;
          if (providedExpiryDate && dayjs(providedExpiryDate).isValid()) {
            activeExpiryDate = providedExpiryDate;
          } else {
            const candidates = getExpiryCandidates30To45Days(date, "");
            if (candidates.length > 0) {
              activeExpiryDate = candidates[0];
            } else {
              // No trading dates in the 30-45 day window — walk forward from +30 days
              // to find the nearest available trading date
              let fallback: string | null = null;
              for (let daysAhead = 30; daysAhead <= 90; daysAhead++) {
                const candidate = dayjs(date).add(daysAhead, "day").format("YYYY-MM-DD");
                if (tradingDates2026.has(candidate)) {
                  fallback = candidate;
                  break;
                }
              }
              if (!fallback) {
                throw new Error(`No trading date found for short expiry (30-90 days from ${date})`);
              }
              activeExpiryDate = fallback;
            }
          }

          phase1CutoffShortExpiryDate = activeExpiryDate;
        }

        if (
          phase1CutoffShortExpiryDate &&
          dayjs(date).isAfter(dayjs(phase1CutoffShortExpiryDate), "day")
        ) {
          break;
        }

        const expiryDate = formatExpiryDate(activeExpiryDate);
        const stockKey = `${symbol}|${date}`;
        const stockCached = masterStockData[stockKey];

        const stockCanUseCache = Boolean(
          stockCached &&
          (stockCached.openPrice !== null || stockCached.closePrice !== null)
        );

        const stockData = stockCanUseCache
          ? {
              openPrice: stockCached?.openPrice ?? null,
              closePrice: stockCached?.closePrice ?? null,
              statusCode: stockCached?.statusCode ?? null,
            }
          : await fetchStockWithRateLimitRetry(symbol, date);

        if (stockData.statusCode === 429) {
          sawRateLimit = true;
        }

        const stockClosePrice = stockData.closePrice;

        if (activeStrikePrice === null) {
          const calculatedStrikePrice = stockClosePrice !== null
            ? roundToNearestFive(stockClosePrice * (1 - 0.0175))
            : null;

          if (calculatedStrikePrice === null || !Number.isFinite(calculatedStrikePrice) || calculatedStrikePrice <= 0) {
            throw new Error("Unable to determine strike price from close price on first row");
          }

          activeStrikePrice = calculatedStrikePrice;
        }

        const peStrike = activeStrikePrice;
        const ceStrike = peStrike;

        if (activeLongExpiryDate === null || activeLongStrikePrice === null) {
          const longExpiryCandidates = getExpiryCandidates70To120Days(date, input.longExpiryDate).slice(0, 4);
          const longStrikeCandidates = [peStrike - 5];

          let longFound = false;
          for (const longExpiryCandidate of longExpiryCandidates) {
            const formattedLongExpiryCandidate = formatExpiryDate(longExpiryCandidate);
            for (const longStrikeCandidate of longStrikeCandidates) {
              const longOptionCandidate = await fetchOptionWithRateLimitRetry(
                symbol,
                formattedLongExpiryCandidate,
                longStrikeCandidate,
                "P",
                date
              );

              if (longOptionCandidate.statusCode !== 404 && longOptionCandidate.closePrice !== null) {
                activeLongExpiryDate = longExpiryCandidate;
                activeLongStrikePrice = longStrikeCandidate;
                longFound = true;
                break;
              }
            }

            if (longFound) {
              break;
            }
          }

          if (!longFound) {
            activeLongExpiryDate =
              longExpiryCandidates[0] ??
              (input.longExpiryDate && dayjs(input.longExpiryDate).isValid() ? input.longExpiryDate : date);
            activeLongStrikePrice = peStrike - 5;
          }
        }

        const resolvedLongExpiryDate = activeLongExpiryDate ?? date;
        const resolvedLongPeStrike = activeLongStrikePrice ?? peStrike;
        const longExpiryDate = formatExpiryDate(resolvedLongExpiryDate);
        const longPeStrike = resolvedLongPeStrike;

        const ceKey = getCacheKey(symbol, expiryDate, ceStrike, "C", date);
        const peKey = getCacheKey(symbol, expiryDate, peStrike, "P", date);
        const longCeKey = getCacheKey(symbol, longExpiryDate, ceStrike, "C", date);
        const longPeKey = getCacheKey(symbol, longExpiryDate, longPeStrike, "P", date);

        const ceCached = masterOptionData[ceKey];
        const peCached = masterOptionData[peKey];
        const longCeCached = masterOptionData[longCeKey];
        const longPeCached = masterOptionData[longPeKey];

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

        const ceCanUseCache = true;
        const peCanUseCache = Boolean(
          peCached &&
          ((peCached.skipFuture && peCached.statusCode === 404) ||
            peCached.openPrice !== null ||
            peCached.closePrice !== null)
        );
        const longCeCanUseCache = true;
        const longPeCanUseCache = Boolean(
          longPeCached &&
          ((longPeCached.skipFuture && longPeCached.statusCode === 404) ||
            longPeCached.openPrice !== null ||
            longPeCached.closePrice !== null)
        );
        // Check localStorage cache first and call API only for misses.
        // V2 makes two additional API calls per row for long call/put values.
        const [ceData, peData, longCeData, longPeData] = await Promise.all([
          Promise.resolve({
            openPrice: null,
            closePrice: null,
            delta: null,
            theta: null,
            statusCode: null,
          }),
          peCanUseCache
            ? Promise.resolve({
              openPrice: peCached?.openPrice ?? null,
              closePrice: peCached?.closePrice ?? null,
              delta: peCached?.delta ?? null,
              theta: peCached?.theta ?? null,
              soldPrice: peCached?.soldPrice ?? null,
              costPrice: peCached?.costPrice ?? null,
              statusCode: peCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, expiryDate, peStrike, "P", date),
          Promise.resolve({
            openPrice: null,
            closePrice: null,
            delta: null,
            theta: null,
            statusCode: null,
          }),
          longPeCanUseCache
            ? Promise.resolve({
              openPrice: longPeCached?.openPrice ?? null,
              closePrice: longPeCached?.closePrice ?? null,
              delta: longPeCached?.delta ?? null,
              theta: longPeCached?.theta ?? null,
              soldPrice: longPeCached?.soldPrice ?? null,
              costPrice: longPeCached?.costPrice ?? null,
              statusCode: longPeCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, longExpiryDate, longPeStrike, "P", date),
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
            soldPrice: ceCached?.soldPrice ?? null,
            costPrice: ceCached?.costPrice ?? null,
            statusCode: ceData.statusCode,
            skipFuture: shouldSkipCe,
          };
          cacheUpdated = true;
        }

        if (!peCanUseCache) {
          const shouldSkipPe = peData.statusCode === 404;
          const shortSoldPrice = peCached?.soldPrice ?? pePrice;
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
            soldPrice: shortSoldPrice,
            costPrice: peData.costPrice ?? null,
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
            soldPrice: longCeCached?.soldPrice ?? null,
            costPrice: longCeCached?.costPrice ?? null,
            statusCode: longCeData.statusCode,
            skipFuture: shouldSkipLongCe,
          };
          cacheUpdated = true;
        }

        if (!longPeCanUseCache) {
          const shouldSkipLongPe = longPeData.statusCode === 404;
          const longCostPrice = longPeCached?.costPrice ?? longPePrice;
          masterOptionData[longPeKey] = {
            symbol,
            expiryDate: longExpiryDate,
            strikePrice: longPeStrike,
            optionType: "P",
            date,
            openPrice: longPeData.openPrice,
            closePrice: longPePrice,
            delta: longPeData.delta,
            theta: longPeData.theta,
            soldPrice: longPeData.soldPrice ?? null,
            costPrice: longCostPrice,
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
              expiryDate: formatDisplayDate(activeExpiryDate),
              strike: ceStrike,
              closePrice: cePrice,
              delta: ceData.delta,
              theta: ceData.theta,
            }
            : null,
          markChangeCall,
          pePremiumData: pePrice !== null
            ? {
              expiryDate: formatDisplayDate(activeExpiryDate),
              strike: peStrike,
              closePrice: pePrice,
              delta: peData.delta,
              theta: peData.theta,
              soldPrice: peData.soldPrice ?? peCached?.soldPrice ?? pePrice,
              costPrice: peData.costPrice ?? peCached?.costPrice ?? null,
            }
            : null,
          markChangePut,
          longCePremiumData: longCePrice !== null
            ? {
              expiryDate: formatDisplayDate(resolvedLongExpiryDate),
              strike: ceStrike,
              closePrice: longCePrice,
              delta: longCeData.delta,
              theta: longCeData.theta,
            }
            : null,
          longPePremiumData: longPePrice !== null
            ? {
              expiryDate: formatDisplayDate(resolvedLongExpiryDate),
              strike: longPeStrike,
              closePrice: longPePrice,
              delta: longPeData.delta,
              theta: longPeData.theta,
              soldPrice: longPeData.soldPrice ?? longPeCached?.soldPrice ?? null,
              costPrice: longPeData.costPrice ?? longPeCached?.costPrice ?? longPePrice,
            }
            : null,
        };

        rows.push(row);

        setRowStrikeEntries((previous) => {
          if (previous.some((entry) => entry.date === row.apiDate)) {
            return previous;
          }

          return [
            ...previous,
            {
              date: row.apiDate,
              shortStrikePrice: row.peStrike,
              longStrikePrice: row.longPePremiumData?.strike ?? longPeStrike,
            },
          ];
        });

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
        // Auto-trigger Phase 2 from the Phase 1 cutoff short-expiry date.
        if (phase1CutoffShortExpiryDate) {
          setPhaseSplitInfo({
            phase1StartDate: inputData[0].date,
            phase1EndDate: phase1CutoffShortExpiryDate,
            phase2StartDate: phase1CutoffShortExpiryDate,
          });
          void runPhase2Analysis(
            phase1CutoffShortExpiryDate,
            inputData[0].symbol,
            inputData[0].longExpiryDate
          );
        }
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

  /**
   * Phase 2 simulation: uses lastShortExpiryDate as the new start date,
   * re-calculates strike/expiry with the same logic and runs through to the
   * last available trading date in the window.
   */
  const runPhase2Analysis = async (
    phase1ShortExpiryDate: string,
    symbolInput: string,
    longExpiryDateInput: string
  ) => {
    const symbol = symbolInput.trim().toUpperCase();
    let phase2StartDate = phase1ShortExpiryDate;

    if (!symbol || !dayjs(phase2StartDate).isValid()) return;
    if (!tradingDates2026.has(phase2StartDate)) {
      let next = dayjs(phase2StartDate).add(1, "day");
      let found = false;
      for (let i = 0; i < 10; i++) {
        if (tradingDates2026.has(next.format("YYYY-MM-DD"))) {
          found = true;
          break;
        }
        next = next.add(1, "day");
      }
      if (!found) return;
      phase2StartDate = next.format("YYYY-MM-DD");
    }

    setPhaseLoading(true);
    setPhaseError(null);
    setPhaseResults([]);
    setPhaseChartVisibility({});
    setPhaseSelectedRowKeys({});

    try {
      const masterOptionData = loadMasterOptionData();
      const masterStockData = loadMasterStockData();
      let cacheUpdated = false;
      let stockCacheUpdated = false;
      const today = dayjs().startOf("day");

      const getNextTradingDate = (date: string): string | null => {
        let next = dayjs(date).add(1, "day");
        for (let i = 0; i < 30; i += 1) {
          const candidate = next.format("YYYY-MM-DD");
          if (tradingDates2026.has(candidate)) {
            return candidate;
          }
          next = next.add(1, "day");
        }

        return null;
      };

      const phaseCards: PhaseGridResult[] = [];

      // Loop phase windows continuously until we run out of trading days.
      let currentPhaseStartDate: string | null = phase2StartDate;
      let phaseNumber = 2;
      let cycleGuard = 0;
      while (currentPhaseStartDate && !dayjs(currentPhaseStartDate).isAfter(today, "day") && cycleGuard < 24) {
        cycleGuard += 1;

        let p2ActiveExpiryDate: string | null = null;
        let p2ActiveLongExpiryDate: string | null = null;
        let p2ActiveStrikePrice: number | null = null;
        let p2ActiveLongStrikePrice: number | null = null;

        const shortExpiryCandidates = getExpiryCandidates30To45Days(currentPhaseStartDate, "");
        p2ActiveExpiryDate = shortExpiryCandidates[0] ?? currentPhaseStartDate;
        const phaseEnd = dayjs(p2ActiveExpiryDate).isAfter(today, "day") ? today.format("YYYY-MM-DD") : p2ActiveExpiryDate;

        const phase2Dates: string[] = [];
        let cur = dayjs(currentPhaseStartDate);
        while (!cur.isAfter(dayjs(phaseEnd), "day")) {
          const d = cur.format("YYYY-MM-DD");
          if (tradingDates2026.has(d)) {
            phase2Dates.push(d);
          }
          cur = cur.add(1, "day");
        }

        if (phase2Dates.length === 0) {
          currentPhaseStartDate = getNextTradingDate(phaseEnd);
          continue;
        }

        const currentPhaseRows: OptionsAnalysisRowV2[] = [];

        for (const date of phase2Dates) {
          const stockKey = `${symbol}|${date}`;
          const stockCached = masterStockData[stockKey];
          const stockCanUseCache = Boolean(
            stockCached && (stockCached.openPrice !== null || stockCached.closePrice !== null)
          );
          const stockData = stockCanUseCache
            ? { openPrice: stockCached!.openPrice, closePrice: stockCached!.closePrice, statusCode: stockCached!.statusCode }
            : await fetchStockWithRateLimitRetry(symbol, date);

          const stockClosePrice = stockData.closePrice;

          if (p2ActiveStrikePrice === null) {
            p2ActiveStrikePrice = stockClosePrice !== null
              ? roundToNearestFive(stockClosePrice * (1 - 0.0175))
              : 0;
          }

          if (p2ActiveLongExpiryDate === null || p2ActiveLongStrikePrice === null) {
            const longCandidates = getExpiryCandidates70To120Days(date, longExpiryDateInput).slice(0, 4);
            const longStrikeCandidates = [(p2ActiveStrikePrice ?? 0) - 5];
            let found = false;
            for (const lExpiry of longCandidates) {
              for (const lStrike of longStrikeCandidates) {
                const r = await fetchOptionWithRateLimitRetry(symbol, formatExpiryDate(lExpiry), lStrike, "P", date);
                if (r.statusCode !== 404 && r.closePrice !== null) {
                  p2ActiveLongExpiryDate = lExpiry;
                  p2ActiveLongStrikePrice = lStrike;
                  found = true;
                  break;
                }
              }
              if (found) break;
            }
            if (!found) {
              p2ActiveLongExpiryDate = longCandidates[0] ?? (longExpiryDateInput || date);
              p2ActiveLongStrikePrice = (p2ActiveStrikePrice ?? 0) - 5;
            }
          }

          const expiryDateFmt = formatExpiryDate(p2ActiveExpiryDate);
          const resolvedLongExpiryFmt = p2ActiveLongExpiryDate ?? p2ActiveExpiryDate;
          const longExpiryDateFmt = formatExpiryDate(resolvedLongExpiryFmt);
          const peStrike = p2ActiveStrikePrice ?? 0;
          const longPeStrike = p2ActiveLongStrikePrice ?? peStrike;

          const peKey = getCacheKey(symbol, expiryDateFmt, peStrike, "P", date);
          const longPeKey = getCacheKey(symbol, longExpiryDateFmt, longPeStrike, "P", date);
          const peCached = masterOptionData[peKey];
          const longPeCached = masterOptionData[longPeKey];

          const peCanUseCache = Boolean(
            peCached && ((peCached.skipFuture && peCached.statusCode === 404) ||
              peCached.openPrice !== null || peCached.closePrice !== null)
          );
          const longPeCanUseCache = Boolean(
            longPeCached && ((longPeCached.skipFuture && longPeCached.statusCode === 404) ||
              longPeCached.openPrice !== null || longPeCached.closePrice !== null)
          );

          const [peData, longPeData] = await Promise.all([
            peCanUseCache
              ? Promise.resolve({ openPrice: peCached!.openPrice, closePrice: peCached!.closePrice, delta: peCached!.delta, theta: peCached!.theta, soldPrice: peCached!.soldPrice, costPrice: peCached!.costPrice, statusCode: peCached!.statusCode })
              : fetchOptionWithRateLimitRetry(symbol, expiryDateFmt, peStrike, "P", date),
            longPeCanUseCache
              ? Promise.resolve({ openPrice: longPeCached!.openPrice, closePrice: longPeCached!.closePrice, delta: longPeCached!.delta, theta: longPeCached!.theta, soldPrice: longPeCached!.soldPrice, costPrice: longPeCached!.costPrice, statusCode: longPeCached!.statusCode })
              : fetchOptionWithRateLimitRetry(symbol, longExpiryDateFmt, longPeStrike, "P", date),
          ]);

          if (!peCanUseCache && peData.statusCode !== 429) {
            masterOptionData[peKey] = { symbol, expiryDate: expiryDateFmt, strikePrice: peStrike, optionType: "P", date, openPrice: peData.openPrice, closePrice: peData.closePrice, delta: peData.delta, theta: peData.theta, soldPrice: peData.soldPrice ?? peCached?.soldPrice ?? null, costPrice: peData.costPrice ?? null, statusCode: peData.statusCode, skipFuture: peData.statusCode === 404 };
            cacheUpdated = true;
          }
          if (!longPeCanUseCache && longPeData.statusCode !== 429) {
            masterOptionData[longPeKey] = { symbol, expiryDate: longExpiryDateFmt, strikePrice: longPeStrike, optionType: "P", date, openPrice: longPeData.openPrice, closePrice: longPeData.closePrice, delta: longPeData.delta, theta: longPeData.theta, soldPrice: longPeData.soldPrice ?? longPeCached?.soldPrice ?? null, costPrice: longPeData.costPrice ?? longPeCached?.costPrice ?? longPeData.closePrice, statusCode: longPeData.statusCode, skipFuture: longPeData.statusCode === 404 };
            cacheUpdated = true;
          }
          if (!stockCanUseCache) {
            masterStockData[stockKey] = { symbol, date, openPrice: stockData.openPrice, closePrice: stockData.closePrice, statusCode: stockData.statusCode };
            stockCacheUpdated = true;
          }

          let previousDate: string | null = null;
          for (let daysBack = 1; daysBack <= 5; daysBack++) {
            const candidate = dayjs(date).subtract(daysBack, "day").format("YYYY-MM-DD");
            if (tradingDates2026.has(candidate)) { previousDate = candidate; break; }
          }
          const previousPeClose = previousDate
            ? masterOptionData[getCacheKey(symbol, expiryDateFmt, peStrike, "P", previousDate)]?.closePrice ?? null
            : null;

          const p2Row: OptionsAnalysisRowV2 = {
            date: formatDisplayDate(date),
            apiDate: date,
            closingPrice: stockClosePrice,
            ceStrike: peStrike,
            peStrike,
            cePremiumData: null,
            markChangeCall: null,
            pePremiumData: peData.closePrice !== null
              ? { expiryDate: formatDisplayDate(p2ActiveExpiryDate), strike: peStrike, closePrice: peData.closePrice, delta: peData.delta, theta: peData.theta, soldPrice: peData.soldPrice ?? peCached?.soldPrice ?? peData.closePrice, costPrice: peData.costPrice ?? null }
              : null,
            markChangePut: peData.closePrice !== null && previousPeClose !== null ? peData.closePrice - previousPeClose : null,
            longCePremiumData: null,
            longPePremiumData: longPeData.closePrice !== null
              ? { expiryDate: formatDisplayDate(resolvedLongExpiryFmt), strike: longPeStrike, closePrice: longPeData.closePrice, delta: longPeData.delta, theta: longPeData.theta, soldPrice: longPeData.soldPrice ?? longPeCached?.soldPrice ?? null, costPrice: longPeData.costPrice ?? longPeCached?.costPrice ?? longPeData.closePrice }
              : null,
          };

          currentPhaseRows.push(p2Row);
        }

        if (currentPhaseRows.length > 0) {
          const p2InputData: OptionsInputV2[] = [{
            symbol,
            date: currentPhaseStartDate,
            expiryDate: p2ActiveExpiryDate ?? "",
            longExpiryDate: p2ActiveLongExpiryDate ?? (longExpiryDateInput ?? ""),
            strikePrice: p2ActiveStrikePrice ?? Number.NaN,
          }];

          phaseCards.push({
            phaseNumber,
            startDate: currentPhaseStartDate,
            endDate: phaseEnd,
            analysis: {
              rows: currentPhaseRows,
              inputData: p2InputData,
            },
          });
          setPhaseResults([...phaseCards]);
          phaseNumber += 1;
        }

        currentPhaseStartDate = getNextTradingDate(phaseEnd);
      }

      if (phaseCards.length === 0) {
        setPhaseError("No trading dates available for additional phases.");
        return;
      }

      if (cacheUpdated) saveMasterOptionData(masterOptionData);
      if (stockCacheUpdated) saveMasterStockData(masterStockData);
      const totalRows = phaseCards.reduce((count, phase) => count + phase.analysis.rows.length, 0);
      message.success(
        `Additional phases completed: ${phaseCards.length} phases, ${totalRows} dates`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Additional phase analysis failed";
      setPhaseError(msg);
      message.error(msg);
    } finally {
      setPhaseLoading(false);
    }
  };

  const handleCancel = () => {
    setCancelRequested(true);
  };

  const handleReset = () => {
    setFormInput(DEFAULT_INPUT);
    setResult(null);
    setPhaseResults([]);
    setPhaseError(null);
    setShowChart1(false);
    setPhaseChartVisibility({});
    setPhase1SelectedRowKeys([]);
    setPhaseSelectedRowKeys({});
    setPhaseSplitInfo(null);
    setRowStrikeEntries([]);
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
    message.success("Option cache cleared");
  };

  const downloadLocalStorageJson = () => {
    try {
      const masterOptionData = loadMasterOptionData();
      const masterStockData = loadMasterStockData();

      const filteredOptionEntries = Object.entries(masterOptionData).filter(([, entry]) => {
        const hasFoundPrice =
          entry.openPrice !== null ||
          entry.closePrice !== null ||
          entry.soldPrice !== null ||
          entry.costPrice !== null;
        return hasFoundPrice && entry.statusCode !== 404;
      });

      const filteredStockEntries = Object.entries(masterStockData).filter(([, entry]) => {
        const hasFoundPrice = entry.openPrice !== null || entry.closePrice !== null;
        return hasFoundPrice && entry.statusCode !== 404;
      });

      if (filteredOptionEntries.length === 0 && filteredStockEntries.length === 0) {
        message.warning("No stock or option prices found in local cache to export");
        return;
      }

      const payload = {
        generatedAt: dayjs().toISOString(),
        storageFormat: "localStorage",
        [MASTER_OPTION_DATA_KEY]: Object.fromEntries(filteredOptionEntries),
        [MASTER_STOCK_DATA_KEY]: Object.fromEntries(filteredStockEntries),
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const timestamp = dayjs().format("YYYYMMDD-HHmmss");
      link.href = url;
      link.download = `local-cache-price-data-${timestamp}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      message.success(
        `Exported ${filteredStockEntries.length} stock and ${filteredOptionEntries.length} option cache records`
      );
    } catch {
      message.error("Failed to export local cache JSON");
    }
  };

  const buildNetValueChartData = (rows: OptionsAnalysisRowV2[]) =>
    rows
      .map((row, index) => {
        if (!row.pePremiumData || !row.longPePremiumData) {
          return null;
        }

        const netValue = NET_VALUE_MULTIPLIER * (
          row.longPePremiumData.closePrice - row.pePremiumData.closePrice
        );

        const firstRow = rows[0];
        if (!firstRow?.pePremiumData || !firstRow.longPePremiumData) {
          return {
            date: row.date,
            netValue,
            percentageChange: null,
          };
        }

        const firstNetValue = NET_VALUE_MULTIPLIER * (
          firstRow.longPePremiumData.closePrice - firstRow.pePremiumData.closePrice
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
      );

  const getRowNetValue = (row: OptionsAnalysisRowV2): number | null => {
    if (!row.pePremiumData || !row.longPePremiumData) {
      return null;
    }

    return NET_VALUE_MULTIPLIER * (row.longPePremiumData.closePrice - row.pePremiumData.closePrice);
  };

  const getRowNetValue12L10S = (row: OptionsAnalysisRowV2): number | null => {
    if (!row.pePremiumData || !row.longPePremiumData) {
      return null;
    }

    return 12 * row.longPePremiumData.closePrice - 10 * row.pePremiumData.closePrice;
  };

  const buildPhaseSummaryRow = (
    phaseLabel: string,
    rows: OptionsAnalysisRowV2[],
    startDate: string,
    endDate: string
  ): PhaseSummaryRow => {
    const firstStockRow = rows.find((row) => row.closingPrice !== null) ?? null;
    const lastStockRow = [...rows].reverse().find((row) => row.closingPrice !== null) ?? null;
    const firstNetValueRow = rows.find((row) => getRowNetValue(row) !== null) ?? null;
    const lastNetValueRow = [...rows].reverse().find((row) => getRowNetValue(row) !== null) ?? null;
    const firstNetValue12L10SRow = rows.find((row) => getRowNetValue12L10S(row) !== null) ?? null;
    const lastNetValue12L10SRow = [...rows].reverse().find((row) => getRowNetValue12L10S(row) !== null) ?? null;
    const startStockPrice = firstStockRow?.closingPrice ?? null;
    const endStockPrice = lastStockRow?.closingPrice ?? null;
    const startNetValue = firstNetValueRow ? getRowNetValue(firstNetValueRow) : null;
    const endPhaseNetValue = lastNetValueRow ? getRowNetValue(lastNetValueRow) : null;
    const startNetValue12L10S = firstNetValue12L10SRow ? getRowNetValue12L10S(firstNetValue12L10SRow) : null;
    const endPhaseNetValue12L10S = lastNetValue12L10SRow ? getRowNetValue12L10S(lastNetValue12L10SRow) : null;
    const stockPercentageChange =
      startStockPrice !== null && endStockPrice !== null && startStockPrice !== 0
        ? ((endStockPrice - startStockPrice) / startStockPrice) * 100
        : null;
    const totalNetValue =
      startNetValue !== null && endPhaseNetValue !== null
        ? endPhaseNetValue - startNetValue
        : null;
    const totalNetValue12L10S =
      startNetValue12L10S !== null && endPhaseNetValue12L10S !== null
        ? endPhaseNetValue12L10S - startNetValue12L10S
        : null;

    return {
      key: phaseLabel,
      phaseLabel,
      startDate,
      endDate,
      startStockPrice,
      endStockPrice,
      stockPercentageChange,
      startNetValue,
      endPhaseNetValue,
      totalNetValue,
      cumulativeTotalNetValue: null,
      totalNetValue12L10S,
      cumulativeTotalNetValue12L10S: null,
    };
  };

  const phaseSummaryRows: PhaseSummaryRow[] = [];
  if (result && result.rows.length > 0) {
    phaseSummaryRows.push(
      buildPhaseSummaryRow(
        "Phase 1",
        result.rows,
        result.rows[0]?.apiDate ?? result.inputData[0]?.date ?? "",
        result.rows[result.rows.length - 1]?.apiDate ?? result.inputData[0]?.date ?? ""
      )
    );
  }

  for (const phase of phaseResults) {
    if (phase.analysis.rows.length === 0) {
      continue;
    }
    phaseSummaryRows.push(
      buildPhaseSummaryRow(
        `Phase ${phase.phaseNumber}`,
        phase.analysis.rows,
        phase.startDate,
        phase.endDate
      )
    );
  }

  let cumulativeNetValue = 0;
  let cumulativeNetValue12L10S = 0;
  const phaseSummaryRowsWithCumulative: PhaseSummaryRow[] = phaseSummaryRows.map((row) => {
    const nextCumulative = row.totalNetValue !== null
      ? (cumulativeNetValue += row.totalNetValue, cumulativeNetValue)
      : null;
    const nextCumulative12L10S = row.totalNetValue12L10S !== null
      ? (cumulativeNetValue12L10S += row.totalNetValue12L10S, cumulativeNetValue12L10S)
      : null;
    return {
      ...row,
      cumulativeTotalNetValue: nextCumulative,
      cumulativeTotalNetValue12L10S: nextCumulative12L10S,
    };
  });

  const sumNullableValues = (values: Array<number | null>): number | null => {
    const numericValues = values.filter((value): value is number => value !== null);
    if (numericValues.length === 0) {
      return null;
    }
    return numericValues.reduce((sum, value) => sum + value, 0);
  };

  const phaseSummaryTotalsRow: PhaseSummaryRow = {
    key: "phase-summary-total",
    phaseLabel: "Total",
    startDate: "",
    endDate: "",
    startStockPrice: null,
    endStockPrice: null,
    stockPercentageChange: sumNullableValues(
      phaseSummaryRowsWithCumulative.map((row) => row.stockPercentageChange)
    ),
    startNetValue: sumNullableValues(
      phaseSummaryRowsWithCumulative.map((row) => row.startNetValue)
    ),
    endPhaseNetValue: sumNullableValues(
      phaseSummaryRowsWithCumulative.map((row) => row.endPhaseNetValue)
    ),
    totalNetValue: sumNullableValues(
      phaseSummaryRowsWithCumulative.map((row) => row.totalNetValue)
    ),
    cumulativeTotalNetValue: null,
    totalNetValue12L10S: null,
    cumulativeTotalNetValue12L10S: null,
  };

  const phaseSummaryRowsForTable: PhaseSummaryRow[] = [
    ...phaseSummaryRowsWithCumulative,
    phaseSummaryTotalsRow,
  ];

  const phaseSummaryColumns = [
    {
      title: "Phase",
      dataIndex: "phaseLabel",
      key: "phaseLabel",
      width: 110,
    },
    {
      title: "Start Date",
      dataIndex: "startDate",
      key: "startDate",
      width: 120,
      render: (value: string) => (value ? formatDisplayDate(value) : "—"),
    },
    {
      title: "End Date",
      dataIndex: "endDate",
      key: "endDate",
      width: 120,
      render: (value: string) => (value ? formatDisplayDate(value) : "—"),
    },
    {
      title: "Start Stock",
      dataIndex: "startStockPrice",
      key: "startStockPrice",
      width: 130,
      render: (value: number | null) => (value === null ? "—" : value.toFixed(2)),
    },
    {
      title: "End Stock",
      dataIndex: "endStockPrice",
      key: "endStockPrice",
      width: 130,
      render: (value: number | null) => (value === null ? "—" : value.toFixed(2)),
    },
    {
      title: "Stock % Change",
      dataIndex: "stockPercentageChange",
      key: "stockPercentageChange",
      width: 150,
      render: (value: number | null) => {
        if (value === null) {
          return "—";
        }
        const color = value >= 0 ? "#52c41a" : "#ff4d4f";
        return <span style={{ color }}>{`${value > 0 ? "+" : ""}${value.toFixed(2)}%`}</span>;
      },
    },
    {
      title: "Start Net Value",
      dataIndex: "startNetValue",
      key: "startNetValue",
      width: 170,
      render: (value: number | null) => {
        if (value === null) {
          return "—";
        }
        const color = value >= 0 ? "#52c41a" : "#ff4d4f";
        return <span style={{ color }}>{value.toFixed(2)}</span>;
      },
    },
    {
      title: "End Phase Net Value",
      dataIndex: "endPhaseNetValue",
      key: "endPhaseNetValue",
      width: 190,
      render: (value: number | null) => {
        if (value === null) {
          return "—";
        }
        const color = value >= 0 ? "#52c41a" : "#ff4d4f";
        return <span style={{ color }}>{value.toFixed(2)}</span>;
      },
    },
    {
      title: "Total Net Value",
      dataIndex: "totalNetValue",
      key: "totalNetValue",
      width: 170,
      render: (value: number | null) => {
        if (value === null) {
          return "—";
        }
        const color = value >= 0 ? "#52c41a" : "#ff4d4f";
        return <span style={{ color }}>{value.toFixed(2)}</span>;
      },
    },
    {
      title: "Cumulative Total Net Value",
      dataIndex: "cumulativeTotalNetValue",
      key: "cumulativeTotalNetValue",
      width: 240,
      render: (value: number | null) => {
        if (value === null) {
          return "—";
        }
        const color = value >= 0 ? "#52c41a" : "#ff4d4f";
        return <span style={{ color }}>{value.toFixed(2)}</span>;
      },
    },
    {
      title: "Total Net Value (12L-10S)",
      dataIndex: "totalNetValue12L10S",
      key: "totalNetValue12L10S",
      width: 220,
      render: (value: number | null) => {
        if (value === null) {
          return "—";
        }
        const color = value >= 0 ? "#52c41a" : "#ff4d4f";
        return <span style={{ color }}>{value.toFixed(2)}</span>;
      },
    },
    {
      title: "Cumulative Net Value (12L-10S)",
      dataIndex: "cumulativeTotalNetValue12L10S",
      key: "cumulativeTotalNetValue12L10S",
      width: 260,
      render: (value: number | null) => {
        if (value === null) {
          return "—";
        }
        const color = value >= 0 ? "#52c41a" : "#ff4d4f";
        return <span style={{ color }}>{value.toFixed(2)}</span>;
      },
    },
  ];

  const netValueChartData = result ? buildNetValueChartData(result.rows) : [];

  const downloadCurrentViewAsExcel = () => {
    if (!result || result.rows.length === 0) {
      message.warning("No rows available to export");
      return;
    }

    try {
      const exportRows = result.rows.map((row) => ({
        Date: row.date,
        "Closing/Stock Price": row.closingPrice !== null ? row.closingPrice.toFixed(2) : "—",
        "PE Strike": row.peStrike.toFixed(0),
        "Put Premium": row.pePremiumData
          ? `${row.pePremiumData.expiryDate}-${row.pePremiumData.strike}`

          : "—",
        "PE Price": row.pePremiumData ? row.pePremiumData.closePrice.toFixed(2) : "—",
        "Put Value": row.pePremiumData !== null ? row.pePremiumData.closePrice.toFixed(2) : "—",
        "Long Put Price": row.longPePremiumData ? row.longPePremiumData.closePrice.toFixed(2) : "—",
        "Long Put Value": row.longPePremiumData !== null ? row.longPePremiumData.closePrice.toFixed(2) : "—",
        "Net Value":
          row.pePremiumData !== null &&
          row.longPePremiumData !== null
            ? (
                NET_VALUE_MULTIPLIER * (
                  row.longPePremiumData.closePrice -
                  row.pePremiumData.closePrice
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

  const getColumns = (gridRows: OptionsAnalysisRowV2[]) => [
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
        if (gridRows.length > 0 && index !== 0) {
          const firstRow = gridRows[0];
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
      title: "Put Strike",
      dataIndex: "peStrike",
      key: "peStrike",
      width: 120,
      render: (value: number, record: OptionsAnalysisRowV2) => (
        <Button
          type="link"
          style={{ padding: 0, height: "auto" }}
          onClick={() => openInputPopup("Put Strike", record)}
        >
          {value.toFixed(0)}
        </Button>
      ),
    },
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
    
    {
      title: "Sold/Short Put Price",
      dataIndex: "pePremiumData",
      key: "pePrice",
      width: 200,
      render: (value: StrikePremium | null, _record: OptionsAnalysisRowV2, index: number) => {
        if (!value) return "—";

        let percentageChange: number | null = null;
        if (gridRows.length > 0 && index !== 0) {
          const firstRow = gridRows[0];
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
    {
      title: "Short Put Expiry Date",
      dataIndex: "pePremiumData",
      key: "shortPutExpiryDate",
      width: 190,
      render: (value: StrikePremium | null) => {
        if (!value) return "—";
        return value.expiryDate;
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
      title: "Bought/Long Put Price",
      dataIndex: "longPePremiumData",
      key: "longPePrice",
      width: 200,
      render: (value: StrikePremium | null, _record: OptionsAnalysisRowV2, index: number) => {
        if (!value) return "—";

        let percentageChange: number | null = null;
        if (gridRows.length > 0 && index !== 0) {
          const firstRow = gridRows[0];
          const firstLongPutPrice = firstRow.longPePremiumData?.closePrice ?? null;
          if (firstLongPutPrice !== null && firstLongPutPrice !== 0) {
            percentageChange = ((value.closePrice - firstLongPutPrice) / firstLongPutPrice) * 100;
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
    {
      title: "Long Put Expiry Date",
      dataIndex: "longPePremiumData",
      key: "longPutExpiryDate",
      width: 190,
      render: (value: StrikePremium | null) => {
        if (!value) return "—";
        return `${value.expiryDate}-${value.strike}`;
      },
    },
    {
      title: "Net Value",
      key: "netValue",
      width: 180,
      render: (_value: unknown, record: OptionsAnalysisRowV2, index: number) => {
        if (
          !record.pePremiumData ||
          !record.longPePremiumData
        ) {
          return "—";
        }

        const netValue = NET_VALUE_MULTIPLIER * (
          record.longPePremiumData.closePrice - record.pePremiumData.closePrice
        );

        // Calculate percentage change from start date (first row)
        let percentageChange: number | null = null;
        if (gridRows.length > 0 && index !== 0) {
          const firstRow = gridRows[0];
          if (
            firstRow.pePremiumData &&
            firstRow.longPePremiumData
          ) {
            const firstNetValue =
              NET_VALUE_MULTIPLIER * (
                firstRow.longPePremiumData.closePrice - firstRow.pePremiumData.closePrice
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
          !record.pePremiumData ||
          !record.longPePremiumData
        ) {
          return "—";
        }

        const netValue =
          12 * record.longPePremiumData.closePrice - 10 * record.pePremiumData.closePrice;

        // Calculate percentage change from start date (first row)
        let percentageChange: number | null = null;
        if (gridRows.length > 0 && index !== 0) {
          const firstRow = gridRows[0];
          if (
            firstRow.pePremiumData &&
            firstRow.longPePremiumData
          ) {
            const firstNetValue =
              12 * firstRow.longPePremiumData.closePrice - 10 * firstRow.pePremiumData.closePrice;

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
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", gap: "8px", flex: 1, minHeight: 0 }}>
        <Card title="Put Calendar" style={{ width: 260, flex: "0 0 260px" }}>
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <div>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                Date
              </label>
              <Input
                type="date"
                value={formInput.date}
                onChange={(e) => {
                  const nextDate = e.target.value;
                  setFormInput((previous) => ({
                    ...previous,
                    date: nextDate,
                  }));

                  if (dateChangeTimeoutRef.current) {
                    clearTimeout(dateChangeTimeoutRef.current);
                  }

                  dateChangeTimeoutRef.current = setTimeout(() => {
                    void handleDateChangeAndRunSimulation(nextDate);
                  }, 3000);
                }}
                style={{ width: "100%" }}
                aria-label="Date"
              />
            </div>
            <div>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                Ticker
              </label>
              <Select
                value={formInput.symbol}
                onChange={(value) => {
                  setFormInput((previous) => ({
                    ...previous,
                    symbol: value,
                  }));
                }}
                placeholder="Select ticker"
                options={[
                  { label: "SPY", value: "SPY" },
                  { label: "QQQ", value: "QQQ" },
                  { label: "MSFT", value: "MSFT" },
                  { label: "META", value: "META" },
                  { label: "AAPL", value: "AAPL" },
                  { label: "GLD", value: "GLD" },
                  { label: "UVXY", value: "UVXY" },
                  { label: "TSLA", value: "TSLA" },
                  { label: "NVID", value: "NVID" },
                ]}
                style={{ width: "100%" }}
                aria-label="Ticker"
              />
            </div>

            <Space wrap>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => {
                  void handleAnalyze();
                }}
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

        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            overflowY: "auto",
          }}
        >
          {phaseSummaryRows.length > 0 && (
            <Card title="Phase Summary" style={{ width: "100%" }}>
              <Table
                columns={phaseSummaryColumns}
                dataSource={phaseSummaryRowsForTable}
                pagination={false}
                size="small"
                scroll={{ x: "max-content" }}
              />
            </Card>
          )}

          {result ? (
            <Card
              title="Phase 1"
              style={{
                width: "100%",
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
                <Button onClick={() => setShowChart1((v) => !v)}>
                  {showChart1 ? "Hide Chart" : "Show Chart"}
                </Button>
              </Space>

              {phaseSplitInfo && (
                <div style={{ marginBottom: 12, fontSize: 12, color: "#595959" }}>
                  Phase 1 Range: {formatDisplayDate(phaseSplitInfo.phase1StartDate)} to {formatDisplayDate(phaseSplitInfo.phase1EndDate)}
                </div>
              )}

              {showChart1 && <NetValueChart data={netValueChartData} title="Put Net Value Trend" />}

              {result.rows.length === 0 ? (
                <Empty description="No data to display" />
              ) : (
                <div style={{ width: "100%" }}>
                  <Table
                    columns={getColumns(result.rows)}
                    dataSource={result.rows.map((row, idx) => ({
                      ...row,
                      key: idx,
                    }))}
                    rowSelection={{
                      type: "radio",
                      selectedRowKeys: phase1SelectedRowKeys,
                      onChange: (selectedRowKeys) => {
                        setPhase1SelectedRowKeys(selectedRowKeys);
                      },
                    }}
                    pagination={{ pageSize: 50 }}
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

          {/* Additional phase grids — one card per phase cycle */}
          {(phaseLoading || phaseError || phaseResults.length > 0) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
              {phaseError && (
                <Alert
                  message="Additional Phase Error"
                  description={phaseError}
                  type="error"
                  showIcon
                />
              )}
              {phaseResults.map((phase) => {
                const phaseChartData = buildNetValueChartData(phase.analysis.rows);
                const isPhaseChartVisible = phaseChartVisibility[phase.phaseNumber] ?? false;
                return (
                  <Card
                    key={`phase-${phase.phaseNumber}`}
                    title={`Phase ${phase.phaseNumber}`}
                    style={{ width: "100%" }}
                    bodyStyle={{ display: "flex", flexDirection: "column" }}
                  >
                    <Space style={{ marginBottom: 12 }}>
                      <Button
                        onClick={() =>
                          setPhaseChartVisibility((previous) => ({
                            ...previous,
                            [phase.phaseNumber]: !isPhaseChartVisible,
                          }))
                        }
                      >
                        {isPhaseChartVisible ? "Hide Chart" : "Show Chart"}
                      </Button>
                    </Space>
                    <div style={{ marginBottom: 12, fontSize: 12, color: "#595959" }}>
                      Range: {formatDisplayDate(phase.startDate)} to {formatDisplayDate(phase.endDate)}
                    </div>
                    {isPhaseChartVisible && (
                      <NetValueChart
                        data={phaseChartData}
                        title={`Phase ${phase.phaseNumber} – Put Net Value Trend`}
                      />
                    )}
                    {phase.analysis.rows.length === 0 ? (
                      <Empty description={`No data for Phase ${phase.phaseNumber}`} />
                    ) : (
                      <div style={{ width: "100%", overflowX: "auto", overflowY: "visible" }}>
                        <Table
                          columns={getColumns(phase.analysis.rows)}
                          dataSource={phase.analysis.rows.map((row, idx) => ({
                            ...row,
                            key: `${phase.phaseNumber}-${idx}`,
                          }))}
                          rowSelection={{
                            type: "radio",
                            selectedRowKeys: phaseSelectedRowKeys[phase.phaseNumber] ?? [],
                            onChange: (selectedRowKeys) => {
                              setPhaseSelectedRowKeys((previous) => ({
                                ...previous,
                                [phase.phaseNumber]: selectedRowKeys,
                              }));
                            },
                          }}
                          pagination={{ pageSize: 50 }}
                          scroll={{ x: "max-content" }}
                          size="small"
                        />
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          position: "fixed",
          left: "50%",
          bottom: 20,
          transform: "translateX(-50%)",
          zIndex: 1100,
        }}
      >
        {(loading || phaseLoading) && (
          <div
            style={{
              background: "rgba(255, 255, 255, 0.95)",
              border: "1px solid #f0f0f0",
              borderRadius: 8,
              padding: "8px 14px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            }}
          >
            <Spin size="large" tip={loading ? "Fetching option prices..." : "Running additional phases..."} />
          </div>
        )}
      </div>

      <div
        style={{
          position: "fixed",
          right: 24,
          bottom: 24,
          zIndex: 1000,
        }}
      >
        <Space direction="vertical" size="small">
          <Button icon={<DownloadOutlined />} onClick={downloadLocalStorageJson}>
            Download Local Cache JSON
          </Button>
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
        </Space>
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
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Short Put Strike Price</label>
            <Input
              type="number"
              min={0}
              placeholder="Edit short strike price"
              value={selectedOptionContext ? String(selectedOptionContext.shortStrikePrice) : ""}
              onChange={(event) => updatePopupStrikePrice(event.target.value, "short")}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Long Put Strike Price</label>
            <Input
              type="number"
              min={0}
              placeholder="Edit long strike price"
              value={selectedOptionContext ? String(selectedOptionContext.longStrikePrice) : ""}
              onChange={(event) => updatePopupStrikePrice(event.target.value, "long")}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Date</label>
            <Input type="date" value={selectedOptionContext?.date ?? ""} onChange={(event) => updatePopupDate(event.target.value, 'date')} />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Short Expiry Date</label>
            <Select
              style={{ width: "100%", marginBottom: 8 }}
              value={selectedOptionContext?.expiryDate}
              onChange={(value) => updatePopupDate(value, "expiryDate")}
              options={[
                {
                  label: `Given: ${selectedOptionContext?.shortGivenExpiryDate || "N/A"}`,
                  value: selectedOptionContext?.shortGivenExpiryDate || selectedOptionContext?.shortCalculatedExpiryDate || "",
                  disabled: !selectedOptionContext?.shortGivenExpiryDate,
                },
                {
                  label: `Calculated: ${selectedOptionContext?.shortCalculatedExpiryDate || "N/A"}`,
                  value: selectedOptionContext?.shortCalculatedExpiryDate || "",
                  disabled: !selectedOptionContext?.shortCalculatedExpiryDate,
                },
              ]}
            />
            <div style={{ marginBottom: 8, fontSize: "12px", color: "#666" }}>
              <div>Selected: {selectedOptionContext?.expiryDate || "N/A"}</div>
              <div>Given: {selectedOptionContext?.shortGivenExpiryDate || "N/A"}</div>
              <div>Calculated: {selectedOptionContext?.shortCalculatedExpiryDate || "N/A"}</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                Given Short Expiry Date Value
              </label>
              <Input value={selectedOptionContext?.shortGivenExpiryDate || "N/A"} readOnly />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>
                Calculated Short Expiry Date Value
              </label>
              <Input value={selectedOptionContext?.shortCalculatedExpiryDate || "N/A"} readOnly />
            </div>
            <Input type="date" value={selectedOptionContext?.expiryDate ?? ""} onChange={(event) => updatePopupDate(event.target.value, 'expiryDate')} />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Long Expiry Date</label>
            <Select
              style={{ width: "100%", marginBottom: 8 }}
              value={selectedOptionContext?.longExpiryDate}
              onChange={(value) => updatePopupDate(value, "longExpiryDate")}
              options={[
                {
                  label: `Given: ${selectedOptionContext?.longGivenExpiryDate || "N/A"}`,
                  value: selectedOptionContext?.longGivenExpiryDate || selectedOptionContext?.longCalculatedExpiryDate || "",
                  disabled: !selectedOptionContext?.longGivenExpiryDate,
                },
                {
                  label: `Calculated: ${selectedOptionContext?.longCalculatedExpiryDate || "N/A"}`,
                  value: selectedOptionContext?.longCalculatedExpiryDate || "",
                  disabled: !selectedOptionContext?.longCalculatedExpiryDate,
                },
              ]}
            />
            <div style={{ marginBottom: 8, fontSize: "12px", color: "#666" }}>
              <div>Selected: {selectedOptionContext?.longExpiryDate || "N/A"}</div>
              <div>Given: {selectedOptionContext?.longGivenExpiryDate || "N/A"}</div>
              <div>Calculated: {selectedOptionContext?.longCalculatedExpiryDate || "N/A"}</div>
            </div>
            <Input type="date" value={selectedOptionContext?.longExpiryDate ?? ""} onChange={(event) => updatePopupDate(event.target.value, 'longExpiryDate')} />
          </div>
          <div>
            <Space>
              <Button
                type="primary"
                onClick={handleFetchOptionDetails}
                loading={optionDetailsLoading}
                disabled={!selectedOptionContext}
              >
                Get Option Details
              </Button>
              <Button
                onClick={() => {
                  void updateStrikePriceAndRefreshRow();
                }}
                loading={optionDetailsLoading}
                disabled={!selectedOptionContext || !result}
              >
                Update Strike
              </Button>
            </Space>
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
          {/* <div> */}
            {/* <label style={{ display: "block", marginBottom: "6px", fontSize: "12px" }}>Long Expiry Date</label> */}
            {/* <Input value={formInput.longExpiryDate} readOnly /> */}
          {/* </div> */}
        </Space>
      </Modal>
    </div>
  );
};

export default PutCalendar;


