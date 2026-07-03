import React, { useState } from "react";
import { Button, Card, Col, DatePicker, Form, InputNumber, Modal, Row, Select, Space, Table, Typography, message } from "antd";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import dayjs, { type Dayjs } from "dayjs";
import spyClosingData from "../assets/spy-closing.json";
import { fetchOptionOpenClose, fetchStockOpenClose } from "../api/backtest";

const { Title, Link } = Typography;

const SYMBOLS = ["SPY", "QQQ", "IWM", "DIA", "AAPL", "TSLA", "NVDA", "AMZN", "MSFT", "GOOG"];
type OptionType = "Call" | "Put";

interface SelectedOptionQuote {
  date: string;
  openPrice: number | null;
  closePrice: number | null;
  delta: number | null;
  theta: number | null;
}

interface WeeklyOptionCloseRow {
  key: string;
  date: string;
  closePrice: number | null;
  theta: number | null;
}

interface SavedWeeklyCloseRecord {
  id: string;
  label: string;
  symbol: string;
  optionType: OptionType;
  strike: number;
  startDate: string;
  expiryDate: string;
  rows: WeeklyOptionCloseRow[];
}

interface OptionPivotRow {
  key: string;
  date: string;
  [datasetKey: string]: string | number | null;
}

interface CachedOptionQuoteResponse {
  openPrice: number | null;
  closePrice: number | null;
  delta: number | null;
  theta: number | null;
}

interface TradeLink {
  label: string;
  url: (symbol: string) => string;
}

interface DefaultWeeklyRecordSeed {
  symbol: string;
  optionType: OptionType;
  strike: number;
  startDate: string;
  expiryDate: string;
}

const TRADE_LINKS: TradeLink[] = [
  {
    label: "TradingView Chart",
    url: (s) => `https://www.tradingview.com/chart/?symbol=${s}`,
  },
  {
    label: "Option Chain (Nasdaq)",
    url: (s) => `https://www.nasdaq.com/market-activity/stocks/${s.toLowerCase()}/option-chain`,
  },
  {
    label: "OptionStrat",
    url: (s) => `https://optionstrat.com/build/custom/${s}`,
  },
  {
    label: "Barchart Options",
    url: (s) => `https://www.barchart.com/stocks/quotes/${s}/options`,
  },
  {
    label: "CBOE Options",
    url: (s) => `https://www.cboe.com/delayed_quotes/${s}/options`,
  },
  {
    label: "Market Chameleon",
    url: (s) => `https://marketchameleon.com/Overview/${s}/`,
  },
  {
    label: "Unusual Whales",
    url: (s) => `https://unusualwhales.com/stock/${s}`,
  },
  {
    label: "Yahoo Finance",
    url: (s) => `https://finance.yahoo.com/quote/${s}/options/`,
  },
];

const FIXED_DEFAULT_CURRENT_DATE = dayjs("2025-01-02");
const FIXED_DEFAULT_EXPIRY_DATE = dayjs("2025-12-19");
const formatExpiryDate = (dateValue: Dayjs) => dateValue.format("YYMMDD");
const roundToNearestFive = (value: number): number => Math.round(value / 5) * 5;
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);
const toChartValue = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value !== 0 ? value : null;
const normalPdf = (x: number): number => Math.exp(-0.5 * x * x) / SQRT_TWO_PI;
const normalCdf = (x: number): number => {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * absX);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erfApprox =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
    Math.exp(-absX * absX);
  return 0.5 * (1 + sign * erfApprox);
};
const blackScholesPrice = (
  spot: number,
  strike: number,
  timeYears: number,
  sigma: number,
  optionType: OptionType
): number => {
  if (timeYears <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) {
    return optionType === "Call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }

  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * timeYears) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  if (optionType === "Call") {
    return spot * normalCdf(d1) - strike * normalCdf(d2);
  }

  return strike * normalCdf(-d2) - spot * normalCdf(-d1);
};
const estimateImpliedVolatility = (
  marketPrice: number,
  spot: number,
  strike: number,
  timeYears: number,
  optionType: OptionType
): number | null => {
  if (marketPrice <= 0 || spot <= 0 || strike <= 0 || timeYears <= 0) {
    return null;
  }

  const intrinsic =
    optionType === "Call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const targetPrice = Math.max(marketPrice, intrinsic + 1e-8);

  let low = 1e-4;
  let high = 5;

  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const modelPrice = blackScholesPrice(spot, strike, timeYears, mid, optionType);

    if (Math.abs(modelPrice - targetPrice) < 1e-5) {
      return mid;
    }

    if (modelPrice > targetPrice) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return (low + high) / 2;
};
const calculateThetaPerDay = (
  optionPrice: number | null,
  stockPrice: number | null,
  strike: number,
  asOfDate: string,
  expiryDate: string,
  optionType: OptionType
): number | null => {
  if (
    optionPrice === null ||
    stockPrice === null ||
    !Number.isFinite(optionPrice) ||
    !Number.isFinite(stockPrice) ||
    strike <= 0
  ) {
    return null;
  }

  const daysToExpiry = dayjs(expiryDate).diff(dayjs(asOfDate), "day");
  if (daysToExpiry <= 0) {
    return null;
  }

  const timeYears = daysToExpiry / 365;
  const impliedVol = estimateImpliedVolatility(optionPrice, stockPrice, strike, timeYears, optionType);
  if (impliedVol === null) {
    return null;
  }

  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(stockPrice / strike) + 0.5 * impliedVol * impliedVol * timeYears) /
    (impliedVol * sqrtT);
  const thetaPerYear = -(stockPrice * normalPdf(d1) * impliedVol) / (2 * sqrtT);

  return thetaPerYear / 365;
};
const getRollDateFromExpiry = (expiryDateIso: string): Dayjs | null => {
  const expiry = dayjs(expiryDateIso);
  if (!expiry.isValid()) {
    return null;
  }

  // Roll date must be at least one week after expiry and land on a Friday.
  const minimumDate = expiry.add(7, "day");
  const fridayIndex = 5;
  const daysUntilFriday = (fridayIndex - minimumDate.day() + 7) % 7;
  return minimumDate.add(daysUntilFriday, "day");
};
const CHARTS_LINK_DATES_STORAGE_KEY = "chartsAndLinkDates";
const CHARTS_LINK_OPTION_API_CACHE_KEY = "chartsAndLinkOptionApiCache";
const CHARTS_LINK_WEEKLY_CLOSE_STORAGE_KEY = "chartsAndLinkWeeklyCloseRecords";
const CHARTS_LINK_PAGE_SNAPSHOT_STORAGE_KEY = "chartsAndLinkPageSnapshot";
const OPTION_SERIES_COLORS = ["#1677ff", "#13c2c2", "#52c41a", "#faad14", "#fa541c", "#eb2f96", "#722ed1"];
const SPY_LOCAL_CLOSE_BY_DATE = new Map(
  spyClosingData
    .filter((entry) => typeof entry.date === "string" && typeof entry.close === "number" && Number.isFinite(entry.close))
    .map((entry) => [entry.date, entry.close] as const)
);

const DEFAULT_WEEKLY_RECORD_SEEDS: DefaultWeeklyRecordSeed[] = [
  { symbol: "SPY", optionType: "Call", strike: 600, startDate: "2025-01-02", expiryDate: "2025-06-30" },
  { symbol: "SPY", optionType: "Put", strike: 600, startDate: "2025-01-02", expiryDate: "2025-06-30" },
  { symbol: "SPY", optionType: "Call", strike: 600, startDate: "2025-01-02", expiryDate: "2025-12-19" },
  { symbol: "SPY", optionType: "Put", strike: 600, startDate: "2025-01-02", expiryDate: "2025-12-19" },
  { symbol: "SPY", optionType: "Call", strike: 600, startDate: "2025-06-30", expiryDate: "2025-12-19" },
  { symbol: "SPY", optionType: "Put", strike: 600, startDate: "2025-06-30", expiryDate: "2025-12-19" },
];

const PROBABLE_SHORT_EXPIRY_DATES = [
  "Jan-31",
  // "Feb-21",
  // "Feb-28",
  // "Mar-21",
  // "May-16",
  "Jun-30",
  // "Jul-18",
  // "Aug-15",
  // "Sep-19",

  "Dec-19",
] as const;

const MONTH_TO_NUMBER: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

const resolveProbableShortExpiryIsoDates = (fromDate: Dayjs): string[] => {
  const result = PROBABLE_SHORT_EXPIRY_DATES.map((label) => {
    const [monthAbbrev, dayPart] = label.split("-");
    const month = MONTH_TO_NUMBER[monthAbbrev];
    if (!month || !dayPart) {
      return null;
    }

    const day = dayPart.padStart(2, "0");
    const currentYear = fromDate.year();
    const currentYearCandidate = dayjs(`${currentYear}-${month}-${day}`);
    const nextYearCandidate = dayjs(`${currentYear + 1}-${month}-${day}`);

    const picked = currentYearCandidate.isBefore(fromDate, "day")
      ? nextYearCandidate
      : currentYearCandidate;

    return picked.isValid() ? picked.format("YYYY-MM-DD") : null;
  })
    .filter((value): value is string => typeof value === "string");

  return Array.from(new Set(result));
};

const buildRecordId = (seed: DefaultWeeklyRecordSeed) => {
  const side = seed.optionType === "Call" ? "C" : "P";
  return [seed.symbol, side, seed.strike, seed.startDate, seed.expiryDate].join("|");
};

const buildRecordLabel = (seed: DefaultWeeklyRecordSeed) =>
  `${seed.symbol} ${seed.optionType} ${seed.strike} (${seed.startDate} -> ${seed.expiryDate})`;

const PRELOADED_WEEKLY_RECORDS: SavedWeeklyCloseRecord[] = DEFAULT_WEEKLY_RECORD_SEEDS.map((seed) => ({
  id: buildRecordId(seed),
  label: buildRecordLabel(seed),
  symbol: seed.symbol,
  optionType: seed.optionType,
  strike: seed.strike,
  startDate: seed.startDate,
  expiryDate: seed.expiryDate,
  rows: [],
}));

const ChartsAndLink: React.FC = () => {
  type LegendEntryLike = { dataKey?: string | number | ((obj: unknown) => unknown) };

  const [selectedSymbol, setSelectedSymbol] = useState("SPY");
  const [currentDate, setCurrentDate] = useState<Dayjs | null>(FIXED_DEFAULT_CURRENT_DATE);
  const [expiryDate, setExpiryDate] = useState<Dayjs | null>(FIXED_DEFAULT_EXPIRY_DATE);
  const [optionType, setOptionType] = useState<OptionType>("Put");
  const [strikePrice, setStrikePrice] = useState<number | null>(600);
  const [previousClosePrice, setPreviousClosePrice] = useState<number | null>(null);
  const [previousCloseLoading, setPreviousCloseLoading] = useState(false);
  const [optionQuoteLoading, setOptionQuoteLoading] = useState(false);
  const [selectedOptionQuote, setSelectedOptionQuote] = useState<SelectedOptionQuote | null>(null);
  const [weeklyCloseLoading, setWeeklyCloseLoading] = useState(false);
  const [weeklyCloseRows, setWeeklyCloseRows] = useState<WeeklyOptionCloseRow[]>([]);
  const [savedWeeklyCloseRecords, setSavedWeeklyCloseRecords] = useState<SavedWeeklyCloseRecord[]>([]);
  const [activeWeeklyRecordId, setActiveWeeklyRecordId] = useState<string | null>(null);
  const [showWeeklyCloseTable, setShowWeeklyCloseTable] = useState(true);
  const [showOptionClosingChart, setShowOptionClosingChart] = useState(false);
  const [showPivotTable, setShowPivotTable] = useState(false);
  const [showPivotGridChart, setShowPivotGridChart] = useState(true);
  const [hiddenOptionSeriesKeys, setHiddenOptionSeriesKeys] = useState<string[]>([]);
  const [hiddenPivotSeriesKeys, setHiddenPivotSeriesKeys] = useState<string[]>([]);
  const [weeklyRecordsHydrated, setWeeklyRecordsHydrated] = useState(false);
  const [pivotValuePopup, setPivotValuePopup] = useState<{
    open: boolean;
    date: string;
    optionName: string;
    currentValue: number | null;
    rollDate: Dayjs | null;
    rollStrike: number | null;
    symbol: string;
    optionSide: "C" | "P" | null;
    expiryDate: string;
    fetchedOptionValue: number | null;
    netTradeResult: number | null;
  }>({
    open: false,
    date: "",
    optionName: "",
    currentValue: null,
    rollDate: null,
    rollStrike: null,
    symbol: "",
    optionSide: null,
    expiryDate: "",
    fetchedOptionValue: null,
    netTradeResult: null,
  });
  const [rollOptionValueLoading, setRollOptionValueLoading] = useState(false);
  const stockCloseCacheRef = React.useRef<Record<string, number | null>>({});
  const autoProbableShortRunRef = React.useRef<Set<string>>(new Set());
  const autoPreviousCloseRunRef = React.useRef<Set<string>>(new Set());

  const toggleHiddenSeriesKey = (
    key: string,
    setState: React.Dispatch<React.SetStateAction<string[]>>
  ) => {
    setState((previous) =>
      previous.includes(key)
        ? previous.filter((existing) => existing !== key)
        : [...previous, key]
    );
  };

  const extractStrikeFromOptionName = (optionName: string): number | null => {
    const strikeMatch = optionName.match(/\b(\d+(?:\.\d+)?)\b/);
    if (!strikeMatch) {
      return null;
    }

    const parsed = Number(strikeMatch[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const handleGetPopupOptionValue = async () => {
    if (!pivotValuePopup.symbol || !pivotValuePopup.optionSide || !pivotValuePopup.expiryDate) {
      message.warning("Missing option metadata for this row");
      return;
    }

    if (!pivotValuePopup.rollDate || !pivotValuePopup.rollDate.isValid()) {
      message.warning("Select roll date");
      return;
    }

    if (typeof pivotValuePopup.rollStrike !== "number" || !Number.isFinite(pivotValuePopup.rollStrike) || pivotValuePopup.rollStrike <= 0) {
      message.warning("Enter valid roll strike");
      return;
    }

    setRollOptionValueLoading(true);
    try {
      const response = await fetchOptionOpenCloseCached(
        pivotValuePopup.symbol,
        formatExpiryDate(dayjs(pivotValuePopup.expiryDate)),
        pivotValuePopup.rollStrike,
        pivotValuePopup.optionSide,
        pivotValuePopup.rollDate.format("YYYY-MM-DD")
      );

      const nextOptionValue = response.closePrice ?? response.openPrice;
      const netTradeResult =
        typeof nextOptionValue === "number" && Number.isFinite(nextOptionValue) &&
          typeof pivotValuePopup.currentValue === "number" && Number.isFinite(pivotValuePopup.currentValue)
          ? nextOptionValue - pivotValuePopup.currentValue
          : null;

      setPivotValuePopup((previous) => ({
        ...previous,
        fetchedOptionValue: typeof nextOptionValue === "number" && Number.isFinite(nextOptionValue) ? Number(nextOptionValue.toFixed(2)) : null,
        netTradeResult: typeof netTradeResult === "number" && Number.isFinite(netTradeResult) ? Number(netTradeResult.toFixed(2)) : null,
      }));

      if (nextOptionValue === null || !Number.isFinite(nextOptionValue)) {
        message.warning("No option value returned for roll date/strike");
      }
    } catch {
      message.error("Failed to fetch rolled option value");
    } finally {
      setRollOptionValueLoading(false);
    }
  };

  const getOptionCacheKey = (
    symbol: string,
    formattedExpiry: string,
    strike: number,
    optionSide: "C" | "P",
    quoteDate: string
  ) => `${symbol}|${formattedExpiry}|${strike}|${optionSide}|${quoteDate}`;

  const readOptionApiCache = (): Record<string, CachedOptionQuoteResponse> => {
    const rawCache = localStorage.getItem(CHARTS_LINK_OPTION_API_CACHE_KEY);
    if (!rawCache) {
      return {};
    }

    try {
      const parsed = JSON.parse(rawCache) as Record<string, CachedOptionQuoteResponse>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  const writeOptionApiCache = (cache: Record<string, CachedOptionQuoteResponse>) => {
    localStorage.setItem(CHARTS_LINK_OPTION_API_CACHE_KEY, JSON.stringify(cache));
  };

  const fetchOptionOpenCloseCached = async (
    symbol: string,
    formattedExpiry: string,
    strike: number,
    optionSide: "C" | "P",
    quoteDate: string
  ): Promise<CachedOptionQuoteResponse> => {
    const cacheKey = getOptionCacheKey(symbol, formattedExpiry, strike, optionSide, quoteDate);
    const cache = readOptionApiCache();
    const cachedResponse = cache[cacheKey];

    if (cachedResponse) {
      return cachedResponse;
    }

    const apiResponse = await fetchOptionOpenClose(symbol, formattedExpiry, strike, optionSide, quoteDate);
    const normalizedResponse: CachedOptionQuoteResponse = {
      openPrice: apiResponse.openPrice,
      closePrice: apiResponse.closePrice,
      delta: apiResponse.delta,
      theta: apiResponse.theta,
    };

    cache[cacheKey] = normalizedResponse;
    writeOptionApiCache(cache);
    return normalizedResponse;
  };

  const fetchStockCloseCached = async (symbol: string, quoteDate: string): Promise<number | null> => {
    const cacheKey = `${symbol}|${quoteDate}`;
    const cachedValue = stockCloseCacheRef.current[cacheKey];
    if (cachedValue !== undefined) {
      return cachedValue;
    }

    const normalizedSymbol = symbol.trim().toUpperCase();
    if (normalizedSymbol === "SPY") {
      const localClose = SPY_LOCAL_CLOSE_BY_DATE.get(quoteDate);
      if (typeof localClose === "number" && Number.isFinite(localClose)) {
        stockCloseCacheRef.current[cacheKey] = localClose;
        return localClose;
      }

      // For SPY, prefer local dataset only to save API calls.
      stockCloseCacheRef.current[cacheKey] = null;
      return null;
    }

    const stockResponse = await fetchStockOpenClose(symbol, quoteDate);
    const close =
      typeof stockResponse.closePrice === "number" && Number.isFinite(stockResponse.closePrice)
        ? stockResponse.closePrice
        : null;
    stockCloseCacheRef.current[cacheKey] = close;
    return close;
  };

  const sanitizeWeeklyRows = (rows: WeeklyOptionCloseRow[]) => {
    return rows
      .filter((row) => row && typeof row.date === "string")
      .map((row) => ({
        key: row.date,
        date: row.date,
        closePrice: typeof row.closePrice === "number" && Number.isFinite(row.closePrice) ? row.closePrice : null,
        theta: typeof row.theta === "number" && Number.isFinite(row.theta) ? row.theta : null,
      }));
  };

  React.useEffect(() => {
    const rawDates = localStorage.getItem(CHARTS_LINK_DATES_STORAGE_KEY);
    if (!rawDates) {
      return;
    }

    try {
      const parsed = JSON.parse(rawDates) as {
        currentDate?: string;
        expiryDate?: string;
      };

      if (parsed.currentDate) {
        const parsedCurrentDate = dayjs(parsed.currentDate);
        if (parsedCurrentDate.isValid()) {
          setCurrentDate(parsedCurrentDate);
        }
      }

      if (parsed.expiryDate) {
        const parsedExpiryDate = dayjs(parsed.expiryDate);
        if (parsedExpiryDate.isValid()) {
          setExpiryDate(parsedExpiryDate);
        }
      }
    } catch {
      // Ignore malformed date storage.
    }
  }, []);

  React.useEffect(() => {
    const rawSnapshot = localStorage.getItem(CHARTS_LINK_PAGE_SNAPSHOT_STORAGE_KEY);
    if (!rawSnapshot) {
      return;
    }

    try {
      const parsed = JSON.parse(rawSnapshot) as {
        selectedSymbol?: string;
        optionType?: OptionType;
        strikePrice?: number | null;
        currentDate?: string | null;
        expiryDate?: string | null;
        activeWeeklyRecordId?: string | null;
        showWeeklyCloseTable?: boolean;
        showOptionClosingChart?: boolean;
        showPivotTable?: boolean;
        showPivotGridChart?: boolean;
      };

      if (typeof parsed.selectedSymbol === "string" && parsed.selectedSymbol) {
        setSelectedSymbol(parsed.selectedSymbol);
      }

      if (parsed.optionType === "Call" || parsed.optionType === "Put") {
        setOptionType(parsed.optionType);
      }

      if (typeof parsed.strikePrice === "number" && Number.isFinite(parsed.strikePrice) && parsed.strikePrice > 0) {
        setStrikePrice(parsed.strikePrice);
      }

      if (parsed.currentDate) {
        const parsedCurrentDate = dayjs(parsed.currentDate);
        if (parsedCurrentDate.isValid()) {
          setCurrentDate(parsedCurrentDate);
        }
      }

      if (parsed.expiryDate) {
        const parsedExpiryDate = dayjs(parsed.expiryDate);
        if (parsedExpiryDate.isValid()) {
          setExpiryDate(parsedExpiryDate);
        }
      }

      if (typeof parsed.activeWeeklyRecordId === "string" || parsed.activeWeeklyRecordId === null) {
        setActiveWeeklyRecordId(parsed.activeWeeklyRecordId ?? null);
      }

      if (typeof parsed.showWeeklyCloseTable === "boolean") {
        setShowWeeklyCloseTable(parsed.showWeeklyCloseTable);
      }

      if (typeof parsed.showOptionClosingChart === "boolean") {
        setShowOptionClosingChart(parsed.showOptionClosingChart);
      }

      if (typeof parsed.showPivotTable === "boolean") {
        setShowPivotTable(parsed.showPivotTable);
      }

      if (typeof parsed.showPivotGridChart === "boolean") {
        setShowPivotGridChart(parsed.showPivotGridChart);
      }
    } catch {
      // Ignore malformed page snapshot.
    }
  }, []);

  React.useEffect(() => {
    const rawWeeklyRows = localStorage.getItem(CHARTS_LINK_WEEKLY_CLOSE_STORAGE_KEY);
    if (!rawWeeklyRows) {
      setSavedWeeklyCloseRecords(PRELOADED_WEEKLY_RECORDS);
      setActiveWeeklyRecordId(PRELOADED_WEEKLY_RECORDS[0]?.id ?? null);
      setWeeklyCloseRows(PRELOADED_WEEKLY_RECORDS[0]?.rows ?? []);
      setWeeklyRecordsHydrated(true);
      return;
    }

    try {
      const parsed = JSON.parse(rawWeeklyRows) as SavedWeeklyCloseRecord[] | WeeklyOptionCloseRow[];

      // Backward compatibility for older single-array storage.
      if (Array.isArray(parsed) && parsed.length > 0 && "date" in parsed[0] && !("rows" in parsed[0])) {
        const legacyRows = sanitizeWeeklyRows(parsed as WeeklyOptionCloseRow[]);
        if (legacyRows.length > 0) {
          const legacyRecord: SavedWeeklyCloseRecord = {
            id: "legacy",
            label: "Legacy Saved Data",
            symbol: selectedSymbol,
            optionType,
            strike: strikePrice ?? 0,
            startDate: legacyRows[0]?.date ?? "",
            expiryDate: legacyRows[legacyRows.length - 1]?.date ?? "",
            rows: legacyRows,
          };
          setSavedWeeklyCloseRecords([legacyRecord]);
          setActiveWeeklyRecordId(legacyRecord.id);
          setWeeklyCloseRows(legacyRows);
        }
        return;
      }

      if (Array.isArray(parsed)) {
        const sanitizedRecords = parsed
          .filter((record) => record && typeof (record as SavedWeeklyCloseRecord).id === "string")
          .map((record) => {
            const normalizedRecord = record as SavedWeeklyCloseRecord;
            return {
              ...normalizedRecord,
              rows: sanitizeWeeklyRows(normalizedRecord.rows ?? []),
            };
          });

        setSavedWeeklyCloseRecords(sanitizedRecords);
        if (sanitizedRecords.length > 0) {
          setActiveWeeklyRecordId(sanitizedRecords[0].id);
          setWeeklyCloseRows(sanitizedRecords[0].rows);
        } else {
          setSavedWeeklyCloseRecords(PRELOADED_WEEKLY_RECORDS);
          setActiveWeeklyRecordId(PRELOADED_WEEKLY_RECORDS[0]?.id ?? null);
          setWeeklyCloseRows(PRELOADED_WEEKLY_RECORDS[0]?.rows ?? []);
        }
      }
    } catch {
      // Ignore malformed weekly close storage.
      setSavedWeeklyCloseRecords(PRELOADED_WEEKLY_RECORDS);
      setActiveWeeklyRecordId(PRELOADED_WEEKLY_RECORDS[0]?.id ?? null);
      setWeeklyCloseRows(PRELOADED_WEEKLY_RECORDS[0]?.rows ?? []);
    } finally {
      setWeeklyRecordsHydrated(true);
    }
  }, []);

  React.useEffect(() => {
    if (!currentDate || !currentDate.isValid()) {
      return;
    }

    const normalizedSymbol = selectedSymbol.trim().toUpperCase();
    if (!normalizedSymbol) {
      return;
    }

    const runKey = `${normalizedSymbol}|${currentDate.format("YYYY-MM-DD")}`;
    if (autoPreviousCloseRunRef.current.has(runKey)) {
      return;
    }
    autoPreviousCloseRunRef.current.add(runKey);

    let cancelled = false;

    const loadPreviousCloseAndStrike = async () => {
      setPreviousCloseLoading(true);
      try {
        const previousClose = await findPreviousClose(normalizedSymbol, currentDate);
        if (!previousClose || cancelled) {
          return;
        }

        setPreviousClosePrice(previousClose.price);
        setStrikePrice(roundToNearestFive(previousClose.price));
      } finally {
        setPreviousCloseLoading(false);
      }
    };

    void loadPreviousCloseAndStrike();

    return () => {
      cancelled = true;
    };
  }, [currentDate, selectedSymbol]);

  React.useEffect(() => {
    if (!weeklyRecordsHydrated) {
      return;
    }

    let cancelled = false;

    const seedDefaultRecords = async () => {
      const existingById = new Map(savedWeeklyCloseRecords.map((record) => [record.id, record]));
      const missingSeeds = DEFAULT_WEEKLY_RECORD_SEEDS.filter((seed) => !existingById.has(buildRecordId(seed)));

      if (missingSeeds.length === 0) {
        return;
      }

      setWeeklyCloseLoading(true);
      try {
        const builtRecords: SavedWeeklyCloseRecord[] = [];

        for (const seed of missingSeeds) {
          const start = dayjs(seed.startDate);
          const expiry = dayjs(seed.expiryDate);
          if (!start.isValid() || !expiry.isValid() || expiry.isBefore(start, "day")) {
            continue;
          }

          const weeklyDates = buildWeeklyDatesUntilExpiry(start, expiry);
          const optionSide = seed.optionType === "Call" ? "C" : "P";
          const formattedExpiry = formatExpiryDate(expiry);

          const rows: WeeklyOptionCloseRow[] = [];
          for (const quoteDate of weeklyDates) {
            const response = await fetchOptionOpenCloseCached(
              seed.symbol,
              formattedExpiry,
              seed.strike,
              optionSide,
              quoteDate
            );

            const stockClose = await fetchStockCloseCached(seed.symbol, quoteDate);
            const thetaPerDay = calculateThetaPerDay(
              response.closePrice,
              stockClose,
              seed.strike,
              quoteDate,
              seed.expiryDate,
              seed.optionType
            );

            rows.push({
              key: quoteDate,
              date: quoteDate,
              closePrice: response.closePrice,
              theta:
                typeof response.theta === "number" && Number.isFinite(response.theta)
                  ? response.theta
                  : thetaPerDay,
            });
          }

          builtRecords.push({
            id: buildRecordId(seed),
            label: buildRecordLabel(seed),
            symbol: seed.symbol,
            optionType: seed.optionType,
            strike: seed.strike,
            startDate: seed.startDate,
            expiryDate: seed.expiryDate,
            rows,
          });
        }

        if (cancelled || builtRecords.length === 0) {
          return;
        }

        const nextRecords = [
          ...savedWeeklyCloseRecords,
          ...builtRecords,
        ].sort((left, right) => {
          const leftSeedIndex = DEFAULT_WEEKLY_RECORD_SEEDS.findIndex((seed) => buildRecordId(seed) === left.id);
          const rightSeedIndex = DEFAULT_WEEKLY_RECORD_SEEDS.findIndex((seed) => buildRecordId(seed) === right.id);

          if (leftSeedIndex >= 0 && rightSeedIndex >= 0) {
            return leftSeedIndex - rightSeedIndex;
          }
          if (leftSeedIndex >= 0) {
            return -1;
          }
          if (rightSeedIndex >= 0) {
            return 1;
          }
          return left.label.localeCompare(right.label);
        });

        setSavedWeeklyCloseRecords(nextRecords);

        if (!activeWeeklyRecordId && nextRecords.length > 0) {
          setActiveWeeklyRecordId(nextRecords[0].id);
          setWeeklyCloseRows(nextRecords[0].rows);
        }
      } catch {
        if (!cancelled) {
          message.warning("Some default SPY records could not be loaded on startup");
        }
      } finally {
        if (!cancelled) {
          setWeeklyCloseLoading(false);
        }
      }
    };

    void seedDefaultRecords();

    return () => {
      cancelled = true;
    };
  }, [activeWeeklyRecordId, savedWeeklyCloseRecords, weeklyRecordsHydrated]);

  React.useEffect(() => {
    if (!weeklyRecordsHydrated || !currentDate || !currentDate.isValid()) {
      return;
    }

    const normalizedSymbol = selectedSymbol.trim().toUpperCase();
    if (!normalizedSymbol) {
      return;
    }

    const currentDateIso = currentDate.format("YYYY-MM-DD");
    const runKey = `${normalizedSymbol}|${currentDateIso}|${strikePrice ?? "NA"}`;
    if (autoProbableShortRunRef.current.has(runKey)) {
      return;
    }
    autoProbableShortRunRef.current.add(runKey);

    let cancelled = false;

    const runAutoProbableShortSimulation = async () => {
      setWeeklyCloseLoading(true);
      try {
        let effectiveStrike =
          typeof strikePrice === "number" && Number.isFinite(strikePrice) && strikePrice > 0
            ? strikePrice
            : null;

        if (effectiveStrike === null) {
          const startStock = await fetchStockOpenClose(normalizedSymbol, currentDateIso);
          if (typeof startStock.closePrice === "number" && Number.isFinite(startStock.closePrice)) {
            effectiveStrike = roundToNearestFive(startStock.closePrice);
            if (!cancelled) {
              setStrikePrice(effectiveStrike);
            }
          }
        }

        if (effectiveStrike === null) {
          return;
        }

        const probableExpiryDates = resolveProbableShortExpiryIsoDates(currentDate)
          .filter((expiry) => {
            const expiryDateValue = dayjs(expiry);
            return (
              expiryDateValue.isSame(currentDate, "day") ||
              expiryDateValue.isAfter(currentDate, "day")
            );
          });

        if (probableExpiryDates.length === 0) {
          return;
        }

        const recordsById = new Map(savedWeeklyCloseRecords.map((record) => [record.id, record]));
        const updatedRecordIds = new Set<string>();

        for (const expiryIso of probableExpiryDates) {
          const expiryDateValue = dayjs(expiryIso);
          const formattedExpiry = formatExpiryDate(expiryDateValue);

          for (const side of ["C", "P"] as const) {
            const recordId = [
              normalizedSymbol,
              side,
              effectiveStrike,
              currentDateIso,
              expiryIso,
            ].join("|");

            // Step 1: get option price for current date using probable short expiry.
            const startQuote = await fetchOptionOpenCloseCached(
              normalizedSymbol,
              formattedExpiry,
              effectiveStrike,
              side,
              currentDateIso
            );

            if (!cancelled && !selectedOptionQuote) {
              setSelectedOptionQuote({
                date: currentDateIso,
                openPrice: startQuote.openPrice,
                closePrice: startQuote.closePrice,
                delta: startQuote.delta,
                theta: startQuote.theta,
              });
            }

            // Step 2: get weekly closing prices up to expiry.
            const weeklyDates = buildWeeklyDatesUntilExpiry(currentDate.startOf("day"), expiryDateValue.startOf("day"));
            const rows: WeeklyOptionCloseRow[] = [];

            for (const quoteDate of weeklyDates) {
              const response = await fetchOptionOpenCloseCached(
                normalizedSymbol,
                formattedExpiry,
                effectiveStrike,
                side,
                quoteDate
              );

              const stockClose = await fetchStockCloseCached(normalizedSymbol, quoteDate);
              const thetaPerDay = calculateThetaPerDay(
                response.closePrice,
                stockClose,
                effectiveStrike,
                quoteDate,
                expiryIso,
                side === "C" ? "Call" : "Put"
              );

              rows.push({
                key: quoteDate,
                date: quoteDate,
                closePrice: response.closePrice,
                theta:
                  typeof response.theta === "number" && Number.isFinite(response.theta)
                    ? response.theta
                    : thetaPerDay,
              });
            }

            recordsById.set(recordId, {
              id: recordId,
              label: `${normalizedSymbol} ${side === "C" ? "Call" : "Put"} ${effectiveStrike} (${currentDateIso} -> ${expiryIso})`,
              symbol: normalizedSymbol,
              optionType: side === "C" ? "Call" : "Put",
              strike: effectiveStrike,
              startDate: currentDateIso,
              expiryDate: expiryIso,
              rows,
            });
            updatedRecordIds.add(recordId);
          }
        }

        if (cancelled || updatedRecordIds.size === 0) {
          return;
        }

        const nextRecords = Array.from(recordsById.values())
          .sort((left, right) => {
            if (left.startDate !== right.startDate) {
              return left.startDate.localeCompare(right.startDate);
            }
            if (left.expiryDate !== right.expiryDate) {
              return left.expiryDate.localeCompare(right.expiryDate);
            }
            return left.label.localeCompare(right.label);
          });

        setSavedWeeklyCloseRecords(nextRecords);

        if (!activeWeeklyRecordId && nextRecords.length > 0) {
          setActiveWeeklyRecordId(nextRecords[0].id);
          setWeeklyCloseRows(nextRecords[0].rows);
        }
      } catch {
        if (!cancelled) {
          message.warning("Auto simulation for probable short expiries could not complete fully");
        }
      } finally {
        if (!cancelled) {
          setWeeklyCloseLoading(false);
        }
      }
    };

    void runAutoProbableShortSimulation();

    return () => {
      cancelled = true;
    };
  }, [
    activeWeeklyRecordId,
    currentDate,
    savedWeeklyCloseRecords,
    selectedOptionQuote,
    selectedSymbol,
    strikePrice,
    weeklyRecordsHydrated,
  ]);

  React.useEffect(() => {
    const payload = {
      currentDate: currentDate && currentDate.isValid() ? currentDate.format("YYYY-MM-DD") : null,
      expiryDate: expiryDate && expiryDate.isValid() ? expiryDate.format("YYYY-MM-DD") : null,
    };
    localStorage.setItem(CHARTS_LINK_DATES_STORAGE_KEY, JSON.stringify(payload));
  }, [currentDate, expiryDate]);

  React.useEffect(() => {
    localStorage.setItem(CHARTS_LINK_WEEKLY_CLOSE_STORAGE_KEY, JSON.stringify(savedWeeklyCloseRecords));
  }, [savedWeeklyCloseRecords]);

  React.useEffect(() => {
    const payload = {
      selectedSymbol,
      optionType,
      strikePrice,
      currentDate: currentDate && currentDate.isValid() ? currentDate.format("YYYY-MM-DD") : null,
      expiryDate: expiryDate && expiryDate.isValid() ? expiryDate.format("YYYY-MM-DD") : null,
      activeWeeklyRecordId,
      showWeeklyCloseTable,
      showOptionClosingChart,
      showPivotTable,
      showPivotGridChart,
    };

    localStorage.setItem(CHARTS_LINK_PAGE_SNAPSHOT_STORAGE_KEY, JSON.stringify(payload));
  }, [
    activeWeeklyRecordId,
    currentDate,
    expiryDate,
    optionType,
    selectedSymbol,
    showOptionClosingChart,
    showPivotTable,
    showPivotGridChart,
    showWeeklyCloseTable,
    strikePrice,
  ]);

  const getSelectedOptionRequest = () => {
    if (!selectedSymbol) {
      message.warning("Select ticker first");
      return null;
    }

    if (!currentDate || !currentDate.isValid()) {
      message.warning("Select current date");
      return null;
    }

    if (!expiryDate || !expiryDate.isValid()) {
      message.warning("Select expiry date");
      return null;
    }

    if (typeof strikePrice !== "number" || !Number.isFinite(strikePrice) || strikePrice <= 0) {
      message.warning("Enter valid strike price");
      return null;
    }

    return {
      symbol: selectedSymbol,
      startDate: currentDate.startOf("day"),
      expiry: expiryDate.startOf("day"),
      strike: strikePrice,
      optionSide: optionType === "Call" ? "C" as const : "P" as const,
      formattedExpiry: formatExpiryDate(expiryDate),
    };
  };

  const buildWeeklyDatesUntilExpiry = (startDate: Dayjs, expiry: Dayjs) => {
    const dates: string[] = [];
    let cursor = startDate;

    while (cursor.isBefore(expiry, "day") || cursor.isSame(expiry, "day")) {
      dates.push(cursor.format("YYYY-MM-DD"));
      cursor = cursor.add(7, "day");
    }

    const expiryIso = expiry.format("YYYY-MM-DD");
    if (dates[dates.length - 1] !== expiryIso) {
      dates.push(expiryIso);
    }

    return dates;
  };

  const findPreviousClose = async (symbol: string, referenceDate: Dayjs): Promise<{ price: number; date: string } | null> => {
    let cursor = referenceDate.subtract(1, "day");

    for (let attempt = 0; attempt < 15; attempt += 1) {
      const quoteDate = cursor.format("YYYY-MM-DD");
      const closePrice = await fetchStockCloseCached(symbol, quoteDate);

      if (typeof closePrice === "number" && Number.isFinite(closePrice)) {
        return { price: closePrice, date: quoteDate };
      }

      cursor = cursor.subtract(1, "day");
    }

    return null;
  };

  const handleGetOptionPriceForSelectedDate = async () => {
    const selectedRequest = getSelectedOptionRequest();
    if (!selectedRequest) {
      return;
    }

    setOptionQuoteLoading(true);
    try {
      const previousClose = await findPreviousClose(selectedRequest.symbol, selectedRequest.startDate);
      let strikeForQuote = selectedRequest.strike;

      if (previousClose) {
        strikeForQuote = roundToNearestFive(previousClose.price);
        setPreviousClosePrice(previousClose.price);
        setStrikePrice(strikeForQuote);
      } else {
        message.warning("Previous close not found; using current strike price");
      }

      const response = await fetchOptionOpenCloseCached(
        selectedRequest.symbol,
        selectedRequest.formattedExpiry,
        strikeForQuote,
        selectedRequest.optionSide,
        selectedRequest.startDate.format("YYYY-MM-DD")
      );

      setSelectedOptionQuote({
        date: selectedRequest.startDate.format("YYYY-MM-DD"),
        openPrice: response.openPrice,
        closePrice: response.closePrice,
        delta: response.delta,
        theta: response.theta,
      });

      if (response.openPrice === null && response.closePrice === null) {
        message.warning("No option price returned for selected values/date");
        return;
      }

      message.success("Fetched option price from Massive API");
    } catch {
      message.error("Failed to fetch option price from Massive API");
    } finally {
      setOptionQuoteLoading(false);
    }
  };

  const handleApplyDynamicStrike = (percentOffset: number) => {
    if (typeof previousClosePrice !== "number" || !Number.isFinite(previousClosePrice)) {
      message.warning("Fetch previous close first");
      return;
    }

    const directionalMultiplier =
      optionType === "Call"
        ? 1 + percentOffset / 100
        : 1 - percentOffset / 100;

    const computedStrike = roundToNearestFive(previousClosePrice * directionalMultiplier);
    setStrikePrice(computedStrike);
  };

  const handleGetPreviousCloseFromApi = async () => {
    if (!selectedSymbol) {
      message.warning("Select ticker first");
      return;
    }

    if (!currentDate || !currentDate.isValid()) {
      message.warning("Select current date");
      return;
    }

    setPreviousCloseLoading(true);
    try {
      const previousClose = await findPreviousClose(selectedSymbol, currentDate);

      if (!previousClose) {
        message.warning("No previous close found from API in recent dates");
        return;
      }

      setPreviousClosePrice(previousClose.price);
      message.success(`Previous close fetched: ${selectedSymbol} ${previousClose.date} = ${previousClose.price.toFixed(2)}`);
    } catch {
      message.error("Failed to fetch previous close from API");
    } finally {
      setPreviousCloseLoading(false);
    }
  };

  const handleGetWeeklyClosingPrices = async () => {
    const selectedRequest = getSelectedOptionRequest();
    if (!selectedRequest) {
      return;
    }

    const weeklyDates = buildWeeklyDatesUntilExpiry(selectedRequest.startDate, selectedRequest.expiry);
    setWeeklyCloseLoading(true);
    try {
      const rows: WeeklyOptionCloseRow[] = [];

      for (const quoteDate of weeklyDates) {
        const response = await fetchOptionOpenCloseCached(
          selectedRequest.symbol,
          selectedRequest.formattedExpiry,
          selectedRequest.strike,
          selectedRequest.optionSide,
          quoteDate
        );

        const stockClose = await fetchStockCloseCached(selectedRequest.symbol, quoteDate);
        const thetaPerDay = calculateThetaPerDay(
          response.closePrice,
          stockClose,
          selectedRequest.strike,
          quoteDate,
          selectedRequest.expiry.format("YYYY-MM-DD"),
          selectedRequest.optionSide === "C" ? "Call" : "Put"
        );

        rows.push({
          key: quoteDate,
          date: quoteDate,
          closePrice: response.closePrice,
          theta:
            typeof response.theta === "number" && Number.isFinite(response.theta)
              ? response.theta
              : thetaPerDay,
        });
      }

      setWeeklyCloseRows(rows);
      const recordId = [
        selectedRequest.symbol,
        selectedRequest.optionSide,
        selectedRequest.strike,
        selectedRequest.startDate.format("YYYY-MM-DD"),
        selectedRequest.expiry.format("YYYY-MM-DD"),
      ].join("|");
      const optionTypeLabel = selectedRequest.optionSide === "C" ? "Call" : "Put";
      const nextRecord: SavedWeeklyCloseRecord = {
        id: recordId,
        label: `${selectedRequest.symbol} ${optionTypeLabel} ${selectedRequest.strike} (${selectedRequest.startDate.format("YYYY-MM-DD")} -> ${selectedRequest.expiry.format("YYYY-MM-DD")})`,
        symbol: selectedRequest.symbol,
        optionType: optionTypeLabel,
        strike: selectedRequest.strike,
        startDate: selectedRequest.startDate.format("YYYY-MM-DD"),
        expiryDate: selectedRequest.expiry.format("YYYY-MM-DD"),
        rows,
      };

      setSavedWeeklyCloseRecords((previous) => {
        const withoutCurrent = previous.filter((item) => item.id !== nextRecord.id);
        return [nextRecord, ...withoutCurrent];
      });
      setActiveWeeklyRecordId(nextRecord.id);
      message.success(`Fetched weekly close prices for ${rows.length} dates`);
    } catch {
      message.error("Failed to fetch weekly close prices from Massive API");
    } finally {
      setWeeklyCloseLoading(false);
    }
  };

  const handleAnalyzePutOptions = async () => {
    if (!currentDate || !currentDate.isValid()) {
      message.warning("Select current date");
      return;
    }

    const normalizedSymbol = selectedSymbol.trim().toUpperCase();
    if (!normalizedSymbol) {
      message.warning("Select ticker first");
      return;
    }

    const currentDateIso = currentDate.format("YYYY-MM-DD");
    setWeeklyCloseLoading(true);

    try {
      const previousClose = await findPreviousClose(normalizedSymbol, currentDate);
      const strikeFromInput = typeof strikePrice === "number" && Number.isFinite(strikePrice) && strikePrice > 0
        ? strikePrice
        : null;
      const effectiveStrike = previousClose
        ? roundToNearestFive(previousClose.price)
        : strikeFromInput;

      if (previousClose) {
        setPreviousClosePrice(previousClose.price);
      }

      if (effectiveStrike === null) {
        message.warning("Could not determine strike from previous close or current input");
        return;
      }

      setStrikePrice(effectiveStrike);

      const probableExpiryDates = resolveProbableShortExpiryIsoDates(currentDate)
        .filter((expiry) => {
          const expiryDateValue = dayjs(expiry);
          return expiryDateValue.isSame(currentDate, "day") || expiryDateValue.isAfter(currentDate, "day");
        });

      if (probableExpiryDates.length === 0) {
        message.warning("No probable short expiry dates available from current date");
        return;
      }

      const recordsById = new Map(savedWeeklyCloseRecords.map((record) => [record.id, record]));
      let analyzedCount = 0;
      let firstBuiltRecordId: string | null = null;

      for (const expiryIso of probableExpiryDates) {
        const expiryDateValue = dayjs(expiryIso);
        const formattedExpiry = formatExpiryDate(expiryDateValue);
        const side = "P" as const;
        const recordId = [
          normalizedSymbol,
          side,
          effectiveStrike,
          currentDateIso,
          expiryIso,
        ].join("|");

        const startQuote = await fetchOptionOpenCloseCached(
          normalizedSymbol,
          formattedExpiry,
          effectiveStrike,
          side,
          currentDateIso
        );

        if (!selectedOptionQuote) {
          setSelectedOptionQuote({
            date: currentDateIso,
            openPrice: startQuote.openPrice,
            closePrice: startQuote.closePrice,
            delta: startQuote.delta,
            theta: startQuote.theta,
          });
        }

        const weeklyDates = buildWeeklyDatesUntilExpiry(currentDate.startOf("day"), expiryDateValue.startOf("day"));
        const rows: WeeklyOptionCloseRow[] = [];

        for (const quoteDate of weeklyDates) {
          const response = await fetchOptionOpenCloseCached(
            normalizedSymbol,
            formattedExpiry,
            effectiveStrike,
            side,
            quoteDate
          );

          const stockClose = await fetchStockCloseCached(normalizedSymbol, quoteDate);
          const thetaPerDay = calculateThetaPerDay(
            response.closePrice,
            stockClose,
            effectiveStrike,
            quoteDate,
            expiryIso,
            "Put"
          );

          rows.push({
            key: quoteDate,
            date: quoteDate,
            closePrice: response.closePrice,
            theta:
              typeof response.theta === "number" && Number.isFinite(response.theta)
                ? response.theta
                : thetaPerDay,
          });
        }

        recordsById.set(recordId, {
          id: recordId,
          label: `${normalizedSymbol} Put ${effectiveStrike} (${currentDateIso} -> ${expiryIso})`,
          symbol: normalizedSymbol,
          optionType: "Put",
          strike: effectiveStrike,
          startDate: currentDateIso,
          expiryDate: expiryIso,
          rows,
        });

        analyzedCount += 1;
        if (firstBuiltRecordId === null) {
          firstBuiltRecordId = recordId;
        }
      }

      const nextRecords = Array.from(recordsById.values())
        .sort((left, right) => {
          if (left.startDate !== right.startDate) {
            return left.startDate.localeCompare(right.startDate);
          }
          if (left.expiryDate !== right.expiryDate) {
            return left.expiryDate.localeCompare(right.expiryDate);
          }
          return left.label.localeCompare(right.label);
        });

      setSavedWeeklyCloseRecords(nextRecords);
      if (firstBuiltRecordId) {
        setActiveWeeklyRecordId(firstBuiltRecordId);
        const firstRecord = recordsById.get(firstBuiltRecordId);
        setWeeklyCloseRows(firstRecord?.rows ?? []);
      }

      message.success(`Analyzed ${analyzedCount} put option series`);
    } catch {
      message.error("Failed to analyze put options");
    } finally {
      setWeeklyCloseLoading(false);
    }
  };

  const chartData = spyClosingData.map((d) => ({
    date: d.date,
    close: toChartValue(d.close),
  }));

  const chartRecords = React.useMemo(() => {
    if (!activeWeeklyRecordId) {
      return savedWeeklyCloseRecords;
    }

    const activeRecord = savedWeeklyCloseRecords.find((record) => record.id === activeWeeklyRecordId);
    return activeRecord ? [activeRecord] : savedWeeklyCloseRecords;
  }, [activeWeeklyRecordId, savedWeeklyCloseRecords]);

  const optionChartState = React.useMemo(() => {
    const series = chartRecords.map((record, index) => ({
      id: record.id,
      key: `series_${index + 1}`,
      label: record.label,
    }));

    const dateMap = new Map<string, Record<string, string | number | null>>();

    chartRecords.forEach((record, index) => {
      const seriesKey = `series_${index + 1}`;
      record.rows.forEach((row) => {
        const existing = dateMap.get(row.date) ?? { date: row.date };
        existing[seriesKey] = toChartValue(row.closePrice);
        dateMap.set(row.date, existing);
      });
    });

    const data = Array.from(dateMap.entries())
      .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
      .map(([, row]) => row);

    return { data, series };
  }, [chartRecords]);

  const handleSelectStoredRecord = (record: SavedWeeklyCloseRecord) => {
    setActiveWeeklyRecordId(record.id);
    setWeeklyCloseRows(record.rows);

    const nextCurrentDate = dayjs(record.startDate);
    if (nextCurrentDate.isValid()) {
      setCurrentDate(nextCurrentDate);
    }

    const nextExpiryDate = dayjs(record.expiryDate);
    if (nextExpiryDate.isValid()) {
      setExpiryDate(nextExpiryDate);
    }
  };

  const pivotTableState = React.useMemo(() => {
    const recordsWithData = savedWeeklyCloseRecords
      .filter((record) => record.rows.length > 0)
      .sort((left, right) => {
        if (left.startDate !== right.startDate) {
          return left.startDate.localeCompare(right.startDate);
        }
        if (left.expiryDate !== right.expiryDate) {
          return left.expiryDate.localeCompare(right.expiryDate);
        }
        return left.label.localeCompare(right.label);
      });

    const columnMeta = recordsWithData.map((record, index) => ({
      key: `dataset_${index + 1}`,
      title: record.label,
      recordId: record.id,
      symbol: record.symbol,
      optionSide: record.optionType === "Call" ? "C" as const : "P" as const,
      startDate: record.startDate,
      expiryDate: record.expiryDate,
      defaultStrike: record.strike,
    }));

    const rowMap = new Map<string, OptionPivotRow>();

    recordsWithData.forEach((record, index) => {
      const datasetKey = `dataset_${index + 1}`;
      record.rows.forEach((row) => {
        const existing = rowMap.get(row.date) ?? { key: row.date, date: row.date };
        existing[datasetKey] = row.closePrice;
        existing[`${datasetKey}_theta`] = row.theta;
        rowMap.set(row.date, existing);
      });
    });

    const rows = Array.from(rowMap.values()).sort((left, right) => left.date.localeCompare(right.date));
    const pairedColumnMeta = Array.from({ length: Math.ceil(columnMeta.length / 2) }, (_, pairIndex) => ({
      left: columnMeta[pairIndex * 2],
      right: columnMeta[pairIndex * 2 + 1],
      key: `pair_col_${pairIndex + 1}`,
    }));

    const resultValueForRow = (row: OptionPivotRow) => {
      const col1 = Number(row.dataset_1);
      const col2 = Number(row.dataset_2);
      const col3 = Number(row.dataset_3);
      const col4 = Number(row.dataset_4);

      if ([col1, col2, col3, col4].some((value) => !Number.isFinite(value))) {
        return null;
      }

      return col4 + col3 - col2 - col1;
    };

    rows.forEach((row) => {
      row.result = resultValueForRow(row);
    });

    return {
      rows,
      seriesMeta: columnMeta,
      columns: [
        {
          title: "Date",
          dataIndex: "date",
          key: "date",
          fixed: "left" as const,
          width: 130,
        },
        ...pairedColumnMeta.map((pairMeta) => ({
          title: `${pairMeta.left?.title ?? "-"}${pairMeta.right ? " | " : ""}${pairMeta.right?.title ?? ""}`,
          key: pairMeta.key,
          align: "center" as const,
          render: (_: number | null | undefined, row: OptionPivotRow) => {
            const renderLeg = (meta?: {
              key: string;
              title: string;
              symbol: string;
              optionSide: "C" | "P";
              expiryDate: string;
              defaultStrike: number;
            }) => {
              if (!meta) {
                return null;
              }

              const rawValue = row[meta.key];
              const value = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : null;
              if (value === null) {
                return "-";
              }

              const thetaRaw = row[`${meta.key}_theta`];
              const theta =
                typeof thetaRaw === "number" && Number.isFinite(thetaRaw)
                  ? thetaRaw
                  : null;

              return (
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    setPivotValuePopup({
                      open: true,
                      date: row.date,
                      optionName: meta.title,
                      currentValue: value,
                      rollDate: getRollDateFromExpiry(meta.expiryDate),
                      rollStrike: extractStrikeFromOptionName(meta.title) ?? meta.defaultStrike,
                      symbol: meta.symbol,
                      optionSide: meta.optionSide,
                      expiryDate: meta.expiryDate,
                      fetchedOptionValue: null,
                      netTradeResult: null,
                    });
                  }}
                >
                  {`${value.toFixed(2)}${theta !== null ? ` (${theta.toFixed(4)})` : ""}`}
                </Button>
              );
            };

            return (
              <Space size={4}>
                {renderLeg(pairMeta.left)}
                {pairMeta.right ? <span>|</span> : null}
                {pairMeta.right ? renderLeg(pairMeta.right) : null}
              </Space>
            );
          },
        })),
        {
          title: "Result",
          key: "result",
          align: "center" as const,
          render: (_: unknown, row: OptionPivotRow) => {
            const resultValue = typeof row.result === "number" && Number.isFinite(row.result)
              ? row.result
              : resultValueForRow(row);
            return resultValue !== null ? resultValue.toFixed(2) : "-";
          },
        },
      ],
    };
  }, [savedWeeklyCloseRecords]);

  const pivotGridChartState = React.useMemo(() => {
    const chartEndDate = dayjs("2026-06-30");
    const excludedChartDates = new Set([
      "2025-01-09",
      "2025-02-20",
      "2025-04-24",
      "2025-06-19",
      "2025-11-27",
      "2025-12-19",
      "2025-12-25",
      "2026-01-01",
      "2026-06-11",
    ]);
    const maxDatasetColumns = Math.min(pivotTableState.seriesMeta.length, 30);
    const pairedSeries = Array.from({ length: Math.floor(maxDatasetColumns / 2) }, (_, pairIndex) => {
      const leftMeta = pivotTableState.seriesMeta[pairIndex * 2];
      const rightMeta = pivotTableState.seriesMeta[pairIndex * 2 + 1];
      const start = dayjs(leftMeta?.startDate);
      const expiry = dayjs(leftMeta?.expiryDate);
      const strikePrefix =
        typeof leftMeta?.defaultStrike === "number" && Number.isFinite(leftMeta.defaultStrike)
          ? rightMeta && typeof rightMeta.defaultStrike === "number" && Number.isFinite(rightMeta.defaultStrike)
            ? `${leftMeta.defaultStrike}/${rightMeta.defaultStrike} `
            : `${leftMeta.defaultStrike} `
          : "";
      const label =
        start.isValid() && expiry.isValid()
          ? `${strikePrefix}${start.format("MMM-DD")} -> ${expiry.format("MMM-DD")}`
          : `${strikePrefix}${leftMeta?.title ?? `Pair ${pairIndex + 1}`}${rightMeta ? " | " : ""}${rightMeta?.title ?? ""}`;

      return {
        key: `pair_${pairIndex + 1}`,
        leftKey: `dataset_${pairIndex * 2 + 1}`,
        rightKey: `dataset_${pairIndex * 2 + 2}`,
        name: label,
      };
    });

    const chartSeries = pairedSeries.map(({ key, name }) => ({ key, name }));

    const data = pivotTableState.rows
      .filter((row) => {
        const rowDate = dayjs(row.date);
        const inRange = rowDate.isValid() && (rowDate.isBefore(chartEndDate, "day") || rowDate.isSame(chartEndDate, "day"));
        return inRange && !excludedChartDates.has(row.date);
      })
      .map((row) => {
        const dataPoint: Record<string, string | number | null> = {
          date: row.date,
        };

        pairedSeries.forEach((seriesItem) => {
          const leftValueRaw = row[seriesItem.leftKey];
          const rightValueRaw = row[seriesItem.rightKey];
          const leftValue = Number(leftValueRaw);
          const rightValue = Number(rightValueRaw);

          const hasLeft = Number.isFinite(leftValue);
          const hasRight = Number.isFinite(rightValue);
          const sumValue = hasLeft && hasRight
            ? leftValue + rightValue
            : null;

          const leftThetaRaw = row[`${seriesItem.leftKey}_theta`];
          const rightThetaRaw = row[`${seriesItem.rightKey}_theta`];
          const leftTheta = typeof leftThetaRaw === "number" && Number.isFinite(leftThetaRaw) ? leftThetaRaw : null;
          const rightTheta = typeof rightThetaRaw === "number" && Number.isFinite(rightThetaRaw) ? rightThetaRaw : null;

          dataPoint[seriesItem.key] = toChartValue(sumValue);
          dataPoint[`${seriesItem.key}_theta`] =
            leftTheta !== null && rightTheta !== null
              ? leftTheta + rightTheta
              : null;
        });

        return dataPoint;
      });

    const startValues = chartSeries.reduce<Record<string, number | null>>((accumulator, seriesItem) => {
      const firstPoint = data.find((point) => {
        const rawValue = point[seriesItem.key];
        return typeof rawValue === "number" && Number.isFinite(rawValue);
      });

      const value = firstPoint?.[seriesItem.key];
      accumulator[seriesItem.key] = typeof value === "number" && Number.isFinite(value) ? value : null;
      return accumulator;
    }, {});

    return {
      data,
      series: chartSeries,
      startValues,
    };
  }, [pivotTableState.rows, pivotTableState.seriesMeta]);

  const selectedDatePivotState = React.useMemo(() => {
    if (!currentDate || !currentDate.isValid()) {
      return {
        rows: [] as OptionPivotRow[],
        columns: [] as Array<{
          title: string;
          dataIndex: string;
          key: string;
          fixed?: "left";
          width?: number;
          align?: "center";
          render?: (value: number | null | undefined) => string;
        }>,
      };
    }

    const selectedDateIso = currentDate.format("YYYY-MM-DD");
    const recordsWithData = savedWeeklyCloseRecords
      .filter((record) => record.rows.length > 0)
      .sort((left, right) => {
        if (left.startDate !== right.startDate) {
          return left.startDate.localeCompare(right.startDate);
        }
        if (left.expiryDate !== right.expiryDate) {
          return left.expiryDate.localeCompare(right.expiryDate);
        }
        return left.label.localeCompare(right.label);
      });

    const row: OptionPivotRow = { key: selectedDateIso, date: selectedDateIso };
    const resultValueForRow = (currentRow: OptionPivotRow) => {
      const col1 = Number(currentRow.dataset_1);
      const col2 = Number(currentRow.dataset_2);
      const col3 = Number(currentRow.dataset_3);
      const col4 = Number(currentRow.dataset_4);

      if ([col1, col2, col3, col4].some((value) => !Number.isFinite(value))) {
        return null;
      }

      return col4 + col3 - col2 - col1;
    };

    const columns = [
      {
        title: "Date",
        dataIndex: "date",
        key: "date",
        fixed: "left" as const,
        width: 130,
      },
      ...recordsWithData.map((record, index) => ({
        title: record.label,
        dataIndex: `dataset_${index + 1}`,
        key: `dataset_${index + 1}`,
        align: "center" as const,
        render: (value: number | null | undefined, currentRow: OptionPivotRow) => {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            return "-";
          }

          const thetaRaw = currentRow[`dataset_${index + 1}_theta`];
          const theta =
            typeof thetaRaw === "number" && Number.isFinite(thetaRaw)
              ? thetaRaw
              : null;

          return (
            <Button
              type="link"
              size="small"
              onClick={() => {
                setPivotValuePopup({
                  open: true,
                  date: currentRow.date,
                  optionName: record.label,
                  currentValue: value,
                  rollDate: getRollDateFromExpiry(record.expiryDate),
                  rollStrike: extractStrikeFromOptionName(record.label) ?? record.strike,
                  symbol: record.symbol,
                  optionSide: record.optionType === "Call" ? "C" : "P",
                  expiryDate: record.expiryDate,
                  fetchedOptionValue: null,
                  netTradeResult: null,
                });
              }}
            >
              {`${value.toFixed(2)}${theta !== null ? ` (${theta.toFixed(4)})` : ""}`}
            </Button>
          );
        },
      })),
    ];

    recordsWithData.forEach((record, index) => {
      const matchingRow = record.rows.find((entry) => entry.date === selectedDateIso);
      row[`dataset_${index + 1}`] = matchingRow?.closePrice ?? null;
      row[`dataset_${index + 1}_theta`] = matchingRow?.theta ?? null;
    });

    row.result = resultValueForRow(row);

    return {
      rows: Object.values(row).length > 2 ? [row] : [],
      columns,
    };
  }, [currentDate, savedWeeklyCloseRecords]);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Modal
        open={pivotValuePopup.open}
        title="Option Price Details"
        onCancel={() => setPivotValuePopup((previous) => ({ ...previous, open: false }))}
        footer={[
          <Button key="close" onClick={() => setPivotValuePopup((previous) => ({ ...previous, open: false }))}>
            Close
          </Button>,
        ]}
      >
        <Space direction="vertical" size={6}>
          <Typography.Text>Date: {pivotValuePopup.date || "-"}</Typography.Text>
          <Typography.Text>Option: {pivotValuePopup.optionName || "-"}</Typography.Text>
          <Typography.Text>
            Current Closing Price: {typeof pivotValuePopup.currentValue === "number" ? pivotValuePopup.currentValue.toFixed(2) : "-"}
          </Typography.Text>
          <Typography.Text strong>Rolling an Option</Typography.Text>
          <div>
            <Typography.Text type="secondary">Roll Date</Typography.Text>
            <DatePicker
              value={pivotValuePopup.rollDate}
              onChange={(value) => {
                setPivotValuePopup((previous) => ({
                  ...previous,
                  rollDate: value,
                }));
              }}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <div>
            <Typography.Text type="secondary">Roll Strike</Typography.Text>
            <InputNumber
              min={0.01}
              step={0.5}
              value={pivotValuePopup.rollStrike}
              onChange={(value) => {
                setPivotValuePopup((previous) => ({
                  ...previous,
                  rollStrike: typeof value === "number" && Number.isFinite(value) ? value : null,
                }));
              }}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <Button type="primary" onClick={() => void handleGetPopupOptionValue()} loading={rollOptionValueLoading}>
            Get Option Value
          </Button>
          <Typography.Text>
            Rolled Option Value: {typeof pivotValuePopup.fetchedOptionValue === "number" ? pivotValuePopup.fetchedOptionValue.toFixed(2) : "-"}
          </Typography.Text>
          <Typography.Text strong>
            Net Trade Result: {typeof pivotValuePopup.netTradeResult === "number" ? pivotValuePopup.netTradeResult.toFixed(2) : "-"}
          </Typography.Text>
        </Space>
      </Modal>

      <Row gutter={[16, 16]} align="middle">
        <Col>
          <Title level={4} style={{ margin: 0 }}>
            Charts &amp; Links
          </Title>
        </Col>
      </Row>

      {/* Input fields */}
      <Card size="small" title="Trade Parameters">
        <Form layout="inline" style={{ flexWrap: "wrap", gap: 8 }}>
          <Form.Item label="Ticker">
            <Select
              value={selectedSymbol}
              onChange={setSelectedSymbol}
              options={SYMBOLS.map((s) => ({ label: s, value: s }))}
              style={{ width: 120 }}
              showSearch
            />
          </Form.Item>
          <Form.Item label="Current Date">
            <DatePicker
              value={currentDate}
              onChange={setCurrentDate}
              format="YYYY-MM-DD"
              style={{ width: 150 }}
            />
          </Form.Item>
          <Form.Item label="Expiry Date">
            <DatePicker
              value={expiryDate}
              onChange={setExpiryDate}
              format="YYYY-MM-DD"
              style={{ width: 150 }}
              disabledDate={(d) => currentDate != null && d.isBefore(currentDate, "day")}
            />
          </Form.Item>
          <Form.Item label="Option Type">
            <Select
              value={optionType}
              onChange={setOptionType}
              options={[
                { label: "Call", value: "Call" },
                { label: "Put", value: "Put" },
              ]}
              style={{ width: 120 }}
            />
          </Form.Item>
          <Form.Item label="Strike Price">
            <InputNumber
              value={strikePrice}
              onChange={setStrikePrice}
              min={0}
              step={0.5}
              prefix="$"
              placeholder="e.g. 590"
              style={{ width: 140 }}
            />
          </Form.Item>
          <Form.Item label="Quick Strike">
            <Space size={6} wrap>
              <Button onClick={() => handleApplyDynamicStrike(0)}>ATM</Button>
              <Button onClick={() => handleApplyDynamicStrike(1)}>
                {optionType === "Call" ? "+1%" : "-1%"}
              </Button>
              <Button onClick={() => handleApplyDynamicStrike(5)}>
                {optionType === "Call" ? "+5%" : "-5%"}
              </Button>
              <Button onClick={() => handleApplyDynamicStrike(10)}>
                {optionType === "Call" ? "+10%" : "-10%"}
              </Button>
            </Space>
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={() => void handleGetPreviousCloseFromApi()} loading={previousCloseLoading}>
              Get Previous Close (API)
            </Button>
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={() => void handleGetOptionPriceForSelectedDate()} loading={optionQuoteLoading}>
              Get Option Price
            </Button>
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={() => void handleGetWeeklyClosingPrices()} loading={weeklyCloseLoading}>
              Get Weekly Closing Prices
            </Button>
          </Form.Item>
          <Form.Item label=" ">
            <Button type="primary" onClick={() => void handleAnalyzePutOptions()} loading={weeklyCloseLoading}>
              Analyze Put Options
            </Button>
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={() => setShowWeeklyCloseTable((previous) => !previous)}>
              {showWeeklyCloseTable ? "Hide Table" : "Show Table"}
            </Button>
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ display: "block", marginTop: 10 }}>
          Probable short expiry dates: {PROBABLE_SHORT_EXPIRY_DATES.join(", ")}
        </Typography.Text>
        {selectedOptionQuote && (
          <Space size={12} wrap style={{ marginTop: 12 }}>
            <Typography.Text type="secondary">Date: {selectedOptionQuote.date}</Typography.Text>
            <Typography.Text type="secondary">
              Open: {selectedOptionQuote.openPrice !== null ? selectedOptionQuote.openPrice.toFixed(2) : "-"}
            </Typography.Text>
            <Typography.Text type="secondary">
              Close: {selectedOptionQuote.closePrice !== null ? selectedOptionQuote.closePrice.toFixed(2) : "-"}
            </Typography.Text>
            <Typography.Text type="secondary">
              Delta: {selectedOptionQuote.delta !== null ? selectedOptionQuote.delta.toFixed(4) : "-"}
            </Typography.Text>
            <Typography.Text type="secondary">
              Theta: {selectedOptionQuote.theta !== null ? selectedOptionQuote.theta.toFixed(4) : "-"}
            </Typography.Text>
          </Space>
        )}

        {previousClosePrice !== null && (
          <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
            Previous Close (API): {previousClosePrice.toFixed(2)}
          </Typography.Text>
        )}

        {savedWeeklyCloseRecords.length > 0 && (
          <Space wrap size={8} style={{ marginTop: 12 }}>
            {savedWeeklyCloseRecords.map((record) => (
              <Button
                key={record.id}
                type={record.id === activeWeeklyRecordId ? "primary" : "default"}
                onClick={() => handleSelectStoredRecord(record)}
              >
                {record.label}
              </Button>
            ))}
          </Space>
        )}

        {showWeeklyCloseTable && (
          <Table<WeeklyOptionCloseRow>
            style={{ marginTop: 12 }}
            size="small"
            rowKey="key"
            loading={weeklyCloseLoading}
            dataSource={weeklyCloseRows}
            pagination={false}
            locale={{ emptyText: "No weekly closing prices loaded" }}
            columns={[
              {
                title: "Date",
                dataIndex: "date",
                key: "date",
              },
              {
                title: "Closing Price",
                dataIndex: "closePrice",
                key: "closePrice",
                render: (_: number | null, row: WeeklyOptionCloseRow) => {
                  const close = row.closePrice !== null ? row.closePrice.toFixed(2) : "-";
                  const theta = row.theta !== null ? row.theta.toFixed(4) : "-";
                  return `${close} | ${theta}`;
                },
              },
            ]}
          />
        )}
      </Card>

      <Card title="Option Closing Price (Saved Records)" size="small">
        <Space style={{ marginBottom: 12 }}>
          <Button onClick={() => setShowOptionClosingChart((previous) => !previous)}>
            {showOptionClosingChart ? "Hide Option Closing Chart" : "Show Option Closing Chart"}
          </Button>
        </Space>

        {showOptionClosingChart && (
          optionChartState.series.length === 0 ? (
            <Typography.Text type="secondary">No saved option records to chart yet.</Typography.Text>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={optionChartState.data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                />
                <Tooltip
                  formatter={(v) => {
                    const numericValue = typeof v === "number" ? v : Number(v);
                    const safeValue = toChartValue(Number.isFinite(numericValue) ? numericValue : null);
                    return [safeValue !== null ? `$${safeValue.toFixed(2)}` : "-", "Close"];
                  }}
                />
                <Legend
                  onClick={(entry: LegendEntryLike) => {
                    const key = typeof entry.dataKey === "string" ? entry.dataKey : "";
                    if (!key) {
                      return;
                    }
                    toggleHiddenSeriesKey(key, setHiddenOptionSeriesKeys);
                  }}
                  formatter={(value, entry: LegendEntryLike) => {
                    const key = typeof entry.dataKey === "string" ? entry.dataKey : "";
                    const hidden = key ? hiddenOptionSeriesKeys.includes(key) : false;
                    return (
                      <span style={{ color: hidden ? "#8c8c8c" : "inherit", textDecoration: hidden ? "line-through" : "none" }}>
                        {String(value)}
                      </span>
                    );
                  }}
                />
                {optionChartState.series.map((series, index) => (
                  <Line
                    key={series.id}
                    type="monotone"
                    dataKey={series.key}
                    name={series.label}
                    stroke={OPTION_SERIES_COLORS[index % OPTION_SERIES_COLORS.length]}
                    dot={false}
                    connectNulls
                    strokeWidth={series.id === activeWeeklyRecordId ? 3 : 2}
                    hide={hiddenOptionSeriesKeys.includes(series.key)}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )
        )}
      </Card>

      <Card
        title={`All Options Snapshot (${currentDate && currentDate.isValid() ? currentDate.format("YYYY-MM-DD") : "-"})`}
        size="small"
      >
        <Table<OptionPivotRow>
          size="small"
          rowKey="key"
          dataSource={selectedDatePivotState.rows}
          pagination={false}
          columns={selectedDatePivotState.columns}
          locale={{ emptyText: "No option data exists for the selected date" }}
          scroll={{ x: true }}
        />
      </Card>

      <Card title="Date / Option Names Pivot Table" size="small">
        <Space style={{ marginBottom: 12 }}>
          <Button onClick={() => setShowPivotTable((previous) => !previous)}>
            {showPivotTable ? "Hide Pivot Table" : "Show Pivot Table"}
          </Button>
          <Button onClick={() => setShowPivotGridChart((previous) => !previous)}>
            {showPivotGridChart ? "Hide Grid Date Chart" : "Show Grid Date Chart"}
          </Button>
        </Space>
        {showPivotTable && (
          <Table<OptionPivotRow>
            size="small"
            rowKey="key"
            dataSource={pivotTableState.rows}
            columns={pivotTableState.columns}
            pagination={{ pageSize: 50 }}
            scroll={{ x: true }}
            locale={{ emptyText: "No loaded option data available for pivot table" }}
          />
        )}
      </Card>

      {showPivotGridChart && (
        <Card title="Grid Date vs Result Value" size="small">
          {pivotGridChartState.data.length === 0 ? (
            <Typography.Text type="secondary">No numeric pivot result values to chart.</Typography.Text>
          ) : (
            <ResponsiveContainer width="100%" height={420}>
              <LineChart data={pivotGridChartState.data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" interval={0} tick={{ fontSize: 11 }} />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => v.toFixed(2)}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) {
                      return null;
                    }

                    const labelDate = String(label);
                    const tooltipPoint = pivotGridChartState.data.find(
                      (point) => String(point.date) === labelDate
                    );

                    return (
                      <div
                        style={{
                          background: "#fff",
                          border: "1px solid #d9d9d9",
                          padding: "8px 10px",
                          borderRadius: 6,
                          minWidth: 230,
                        }}
                      >
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>{String(label)}</div>
                        {(() => {
                          const rows = (payload as unknown as ReadonlyArray<{ dataKey?: string; value?: number | string; name?: string; color?: string }>)
                            .map((item) => {
                              const dataKey = item.dataKey ?? "";
                              const numericValue = Number(item.value);
                              const currentValue = toChartValue(Number.isFinite(numericValue) ? numericValue : null);
                              const thetaRaw = dataKey ? tooltipPoint?.[`${dataKey}_theta`] : null;
                              const thetaValue =
                                typeof thetaRaw === "number" && Number.isFinite(thetaRaw)
                                  ? thetaRaw
                                  : null;
                              const startValue = dataKey
                                ? toChartValue(pivotGridChartState.startValues[dataKey] ?? null)
                                : null;
                              const change =
                                currentValue !== null && startValue !== null
                                  ? Number((currentValue - startValue).toFixed(2))
                                  : null;
                              const percentChange =
                                change !== null && startValue !== null && startValue !== 0
                                  ? Number(((change / startValue) * 100).toFixed(2))
                                  : null;

                              return {
                                key: `${dataKey}-${item.name ?? "series"}`,
                                name: item.name ?? dataKey,
                                color: item.color ?? "#595959",
                                currentValue,
                                thetaValue,
                                startValue,
                                change,
                                percentChange,
                              };
                            })
                            .sort((left, right) => {
                              if (left.currentValue === null && right.currentValue === null) {
                                return 0;
                              }
                              if (left.currentValue === null) {
                                return 1;
                              }
                              if (right.currentValue === null) {
                                return -1;
                              }
                              return right.currentValue - left.currentValue;
                            });

                          return (
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                              <thead>
                                <tr>
                                  <th style={{ textAlign: "left", paddingBottom: 4 }}>Series</th>
                                  <th style={{ textAlign: "right", paddingBottom: 4 }}>Value</th>
                                  <th style={{ textAlign: "right", paddingBottom: 4 }}>Theta</th>
                                  <th style={{ textAlign: "right", paddingBottom: 4 }}>Start</th>
                                  <th style={{ textAlign: "right", paddingBottom: 4 }}>Change</th>
                                  <th style={{ textAlign: "right", paddingBottom: 4 }}>%</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rows.map((row) => {
                                  const changeColor =
                                    row.change === null
                                      ? "#8c8c8c"
                                      : row.change > 0
                                        ? "#389e0d"
                                        : row.change < 0
                                          ? "#cf1322"
                                          : "#595959";
                                  const signedChange = row.change === null ? "-" : `${row.change >= 0 ? "+" : ""}${row.change.toFixed(2)}`;
                                  const signedPercent =
                                    row.percentChange === null
                                      ? "-"
                                      : `${row.percentChange >= 0 ? "+" : ""}${row.percentChange.toFixed(2)}%`;

                                  return (
                                    <tr key={row.key}>
                                      <td style={{ color: row.color, padding: "2px 0" }}>{row.name}</td>
                                      <td style={{ textAlign: "right", padding: "2px 0" }}>{row.currentValue !== null ? row.currentValue.toFixed(2) : "-"}</td>
                                      <td
                                        style={{
                                          textAlign: "right",
                                          padding: "2px 0",
                                          color: "#d97706",
                                          fontFamily: "Consolas, 'Courier New', monospace",
                                          fontWeight: 600,
                                        }}
                                      >
                                        {row.thetaValue !== null ? row.thetaValue.toFixed(4) : "-"}
                                      </td>
                                      <td style={{ textAlign: "right", padding: "2px 0" }}>{row.startValue !== null ? row.startValue.toFixed(2) : "-"}</td>
                                      <td style={{ textAlign: "right", color: changeColor, padding: "2px 0" }}>{signedChange}</td>
                                      <td style={{ textAlign: "right", color: changeColor, padding: "2px 0" }}>{signedPercent}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          );
                        })()}
                      </div>
                    );
                  }}
                />
                <Legend
                  onClick={(entry: LegendEntryLike) => {
                    const key = typeof entry.dataKey === "string" ? entry.dataKey : "";
                    if (!key) {
                      return;
                    }
                    toggleHiddenSeriesKey(key, setHiddenPivotSeriesKeys);
                  }}
                  formatter={(value, entry: LegendEntryLike) => {
                    const key = typeof entry.dataKey === "string" ? entry.dataKey : "";
                    const hidden = key ? hiddenPivotSeriesKeys.includes(key) : false;
                    return (
                      <span style={{ color: hidden ? "#8c8c8c" : "inherit", textDecoration: hidden ? "line-through" : "none" }}>
                        {String(value)}
                      </span>
                    );
                  }}
                />
                {pivotGridChartState.series.map((series, index) => (
                  <Line
                    key={series.key}
                    type="monotone"
                    dataKey={series.key}
                    name={series.name}
                    stroke={OPTION_SERIES_COLORS[index % OPTION_SERIES_COLORS.length]}
                    dot={false}
                    strokeWidth={series.key === "result" ? 3 : 2}
                    connectNulls
                    hide={hiddenPivotSeriesKeys.includes(series.key)}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
      )}

      {/* SPY Price Chart */}
      <Card title="SPY Closing Price" size="small">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              interval={Math.floor(chartData.length / 12)}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            />
            <Tooltip
              formatter={(v) => {
                const numericValue = typeof v === "number" ? v : Number(v);
                const safeValue = toChartValue(Number.isFinite(numericValue) ? numericValue : null);
                return [safeValue !== null ? `$${safeValue.toFixed(2)}` : "-", "Close"];
              }}
            />
            <Line
              type="monotone"
              dataKey="close"
              stroke="#1677ff"
              dot={false}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Trading Resource Links */}
      <Card title={`Trading Links — ${selectedSymbol}`} size="small">
        <Row gutter={[12, 12]}>
          {TRADE_LINKS.map((tl) => (
            <Col key={tl.label} xs={24} sm={12} md={8} lg={6}>
              <Card
                size="small"
                hoverable
                bodyStyle={{ padding: "10px 14px" }}
              >
                <Link href={tl.url(selectedSymbol)} target="_blank" rel="noopener noreferrer">
                  {tl.label} ↗
                </Link>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>
    </Space>
  );
};

export default ChartsAndLink;