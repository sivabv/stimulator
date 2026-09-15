import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Input,
  InputNumber,
  Modal,
  Popover,
  Row,
  Space,
  Table,
  Typography,
  message,
} from "antd";
import { CloudUploadOutlined, GoogleOutlined, PlayCircleOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
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
import {
  fetchOptionOpenClose,
  fetchStockOpenClose,
  type OptionOpenClose,
} from "../api/backtest";
import {
  appendCallCalendarSimulationResult,
  isSimulationResultsApiConfigured,
} from "../api/simulationResults";
import tradingDatesJson from "../assets/trading_dates_2026.json";
import spyClosingData from "../assets/spy-closing.json";

const { Text } = Typography;

type RowStatus = "active" | "rolled" | "expired";

interface CallCalendarRow {
  key: string;
  date: string;
  closingPrice: number | null;
  stockReturn: number | null;
  stockReturnPct: number | null;
  strike: number;
  shortExpiryDate: string;
  longExpiryDate: string;
  shortCallPrice: number | null;
  longCallPrice: number | null;
  entryNetCredit: number | null;
  rollCreditDebit: number | null;
  closeNetCost: number | null;
  legPnl: number | null;
  cumulativePnl: number | null;
  cumulativeReturnPct: number | null;
  status: RowStatus;
  rollNumber: number;
}

interface CachedStockPrice {
  symbol: string;
  date: string;
  closePrice: number | null;
}

interface ManualRollInstruction {
  fromDate: string;
  shortExpiryDate: string;
  strike: number;
  rollCreditDebit: number | null;
}

interface RollPreview {
  currentShortCallPremium: number | null;
  newShortCallPremium: number | null;
  netCreditDebit: number | null;
}

interface CallLegModalData {
  legType: "Short Call" | "Long Call";
  premium: number | null;
  expiryDate: string;
  strike: number;
  tradeDate: string;
  status: RowStatus;
}

interface RollingOptionCandidate {
  key: string;
  expiryDate: string;
  strike: number;
  newShortCallPremium: number | null;
  netCreditDebit: number | null;
}

interface AutoSavedOptionCheckpoint {
  date: string;
  shortCallPrice: number | null;
  longCallPrice: number | null;
  savedAt: string;
}

interface CallCalendarSimulationRouteParams {
  tab: string | null;
  autoRun: boolean;
  ticker: string | null;
  startDate: string | null;
  shortExpiryDate: string | null;
  longExpiryDate: string | null;
  shortStrike: number | null;
  longStrike: number | null;
  useFivePercentHigherStrike: boolean;
  autoRollWeekly: boolean;
}

interface CallCalendarBatchResult {
  key: string;
  startDate: string;
  endDate: string | null;
  stockReturn: number | null;
  stockReturnPct: number | null;
  optionStrategyReturn: number | null;
  optionStrategyReturnPct: number | null;
  error: string | null;
}

interface CallCalendarSimulationSummary {
  startDate: string;
  endDate: string;
  stockStartPrice: number;
  stockEndPrice: number | null;
  optionInvestment: number | null;
  stockReturn: number | null;
  stockReturnPct: number | null;
  optionStrategyReturn: number;
  optionStrategyReturnPct: number | null;
}

type MasterStockData = Record<string, CachedStockPrice>;
type OptionCacheEntry = { data: OptionOpenClose; fetchedAt: string };
type OptionCacheData = Record<string, OptionCacheEntry>;

const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MASTER_STOCK_DATA_KEY = "masterStockData";
const OPTION_CACHE_STORAGE_KEY = "callCalendarOptionCache";
const OPTION_CACHE_MAX_ENTRIES = 2000;
const OPTION_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const CALL_CALENDAR_AUTO_SAVED_CHECKPOINT_KEY = "callCalendarSpreadRollAutoSavedCheckpoint";
const SHORT_EXPIRY_MIN_DTE_DAYS = 15;
const SHORT_EXPIRY_MAX_DTE_DAYS = 75;
const LONG_EXPIRY_MIN_DTE_DAYS = 150;
const LONG_EXPIRY_MAX_DTE_DAYS = 400;
const MIN_AUTO_ROLL_CREDIT = 0.2;
const AUTO_ROLL_POPUP_MIN_NET_CREDIT_DEBIT = -10;
const AUTO_ROLL_POPUP_MAX_NET_CREDIT_DEBIT = 10;
const AUTO_ROLL_POPUP_WINDOW_WEEKS = 6;
const AUTO_ROLL_MAX_STRIKE_STEPS = 8;
const MAX_SIMULATION_TRADING_DAYS = 50;
const OPTION_STRATEGY_PROFIT_TARGET_PCT = 10;
const DAILY_PROCESSING_DTE_THRESHOLD_DAYS = 7;
const GOOGLE_SHEETS_URL =
  import.meta.env.VITE_GOOGLE_SHEETS_URL?.trim() ||
  "https://docs.google.com/spreadsheets/d/1aAN8mmMhXhlG7jmqO62DvEothIz2ELW4JWpLSRMbX7Y/edit";

const parsePositiveNumber = (value: string | null): number | null => {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseBooleanParam = (value: string | null): boolean => value === "true" || value === "1";

const parseCallCalendarSimulationRouteParams = (
  search: string
): CallCalendarSimulationRouteParams => {
  const params = new URLSearchParams(search);
  return {
    tab: params.get("tab"),
    autoRun: parseBooleanParam(params.get("run")),
    ticker: params.get("ticker"),
    startDate: params.get("start"),
    shortExpiryDate: params.get("shortExpiry"),
    longExpiryDate: params.get("longExpiry"),
    shortStrike: parsePositiveNumber(params.get("shortStrike")),
    longStrike: parsePositiveNumber(params.get("longStrike")),
    useFivePercentHigherStrike: parseBooleanParam(params.get("fivePercentStrike")),
    autoRollWeekly: parseBooleanParam(params.get("autoRoll")),
  };
};

const fullTradingDatesFromSpy = (spyClosingData as Array<{ date?: string }>)
  .map((entry) => (typeof entry.date === "string" ? entry.date : null))
  .filter((value): value is string => Boolean(value) && dayjs(value).isValid());

const fallbackTradingDates = (tradingDatesJson as string[])
  .filter((value) => dayjs(value).isValid());

const tradingDates = Array.from(
  new Set(fullTradingDatesFromSpy.length > 0 ? fullTradingDatesFromSpy : fallbackTradingDates)
).sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const roundToNearestFive = (value: number): number => Math.round(value / 5) * 5;
const formatExpiryDate = (dateStr: string): string => dayjs(dateStr).format("YYMMDD");
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

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
  optionType: "C" | "P"
): number => {
  if (timeYears <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) {
    return optionType === "C" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }

  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * timeYears) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  if (optionType === "C") {
    return spot * normalCdf(d1) - strike * normalCdf(d2);
  }
  return strike * normalCdf(-d2) - spot * normalCdf(-d1);
};

const estimateImpliedVolatility = (
  marketPrice: number,
  spot: number,
  strike: number,
  timeYears: number,
  optionType: "C" | "P"
): number | null => {
  if (marketPrice <= 0 || spot <= 0 || strike <= 0 || timeYears <= 0) return null;

  const intrinsic = optionType === "C" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const target = Math.max(marketPrice, intrinsic + 1e-8);

  let low = 1e-4;
  let high = 5;

  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const modelPrice = blackScholesPrice(spot, strike, timeYears, mid, optionType);
    if (Math.abs(modelPrice - target) < 1e-5) {
      return mid;
    }
    if (modelPrice > target) {
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
  optionType: "C" | "P"
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
  if (daysToExpiry <= 0) return null;

  const timeYears = daysToExpiry / 365;
  const impliedVol = estimateImpliedVolatility(optionPrice, stockPrice, strike, timeYears, optionType);
  if (impliedVol === null) return null;

  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(stockPrice / strike) + 0.5 * impliedVol * impliedVol * timeYears) /
    (impliedVol * sqrtT);

  const thetaPerYear = -(stockPrice * normalPdf(d1) * impliedVol) / (2 * sqrtT);
  return thetaPerYear / 365;
};

const buildStrikeCandidates = (baseStrike: number, maxSteps: number): number[] => {
  const candidates: number[] = [roundToNearestFive(baseStrike)];
  for (let step = 1; step <= maxSteps; step += 1) {
    const offset = step * 5;
    candidates.push(roundToNearestFive(baseStrike + offset));
    candidates.push(roundToNearestFive(baseStrike - offset));
  }
  return [...new Set(candidates)].filter((strike) => strike > 0);
};

const buildNearMoneyStrikeCandidates = (closingPrice: number): number[] => {
  const lower = roundToNearestFive(closingPrice * 0.95);
  const upper = roundToNearestFive(closingPrice * 1.05);
  const minStrike = Math.min(lower, upper);
  const maxStrike = Math.max(lower, upper);

  const candidates: number[] = [];
  for (let strike = minStrike; strike <= maxStrike; strike += 5) {
    if (strike > 0) {
      candidates.push(strike);
    }
  }

  const atmStrike = roundToNearestFive(closingPrice);
  if (atmStrike > 0) {
    candidates.push(atmStrike);
  }

  return [...new Set(candidates)].sort((a, b) => a - b);
};

const formatCurrency = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
};

const formatPercent = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
};

const getFirstTradingDateOnOrAfter = (date: string): string | null =>
  tradingDates.find((d) => !dayjs(d).isBefore(dayjs(date), "day")) ?? null;

const getNextTradingDate = (date: string): string | null => {
  const index = tradingDates.findIndex((value) => dayjs(value).isSame(dayjs(date), "day"));
  if (index < 0 || index + 1 >= tradingDates.length) {
    return null;
  }
  return tradingDates[index + 1];
};

const getNextFridayTradingDate = (date: string): string | null =>
  tradingDates.find(
    (candidateDate) =>
      dayjs(candidateDate).day() === 5 &&
      dayjs(candidateDate).isAfter(dayjs(date), "day")
  ) ?? null;

const getExpiryDateCandidatesInDteWindow = (
  baseDate: string,
  minDteDays: number,
  maxDteDays: number
): string[] => {
  const start = dayjs(baseDate).add(minDteDays, "day");
  const end = dayjs(baseDate).add(maxDteDays, "day");

  return tradingDates.filter((candidateDate) => {
    const candidate = dayjs(candidateDate);
    return (
      (candidate.isAfter(start, "day") || candidate.isSame(start, "day")) &&
      (candidate.isBefore(end, "day") || candidate.isSame(end, "day"))
    );
  });
};

const getCacheKey = (symbol: string, date: string) => `${symbol}|${date}`;
const getOptionCacheKey = (
  symbol: string,
  expiryDate: string,
  strikePrice: number,
  optionType: "C" | "P",
  date: string
) => `${symbol}|${expiryDate}|${strikePrice}|${optionType}|${date}`;

const loadMasterStockData = (): MasterStockData => {
  try {
    const raw = localStorage.getItem(MASTER_STOCK_DATA_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as MasterStockData;
  } catch {
    return {};
  }
};

const saveMasterStockData = (data: MasterStockData) => {
  localStorage.setItem(MASTER_STOCK_DATA_KEY, JSON.stringify(data));
};

const loadOptionCache = (): OptionCacheData => {
  try {
    const raw = localStorage.getItem(OPTION_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as OptionCacheData;
  } catch {
    return {};
  }
};

const saveOptionCache = (data: OptionCacheData) => {
  const entries = Object.entries(data).sort(
    ([, left], [, right]) => new Date(right.fetchedAt).valueOf() - new Date(left.fetchedAt).valueOf()
  );
  localStorage.setItem(
    OPTION_CACHE_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(entries.slice(0, OPTION_CACHE_MAX_ENTRIES)))
  );
};

const loadAutoSavedCheckpoint = (): AutoSavedOptionCheckpoint | null => {
  try {
    const raw = localStorage.getItem(CALL_CALENDAR_AUTO_SAVED_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as AutoSavedOptionCheckpoint;
  } catch {
    return null;
  }
};

const saveAutoSavedCheckpoint = (checkpoint: AutoSavedOptionCheckpoint) => {
  localStorage.setItem(CALL_CALENDAR_AUTO_SAVED_CHECKPOINT_KEY, JSON.stringify(checkpoint));
};

const CallCalendarSpreadRoll: React.FC = () => {
  const routeParams = useMemo(
    () => parseCallCalendarSimulationRouteParams(window.location.search),
    []
  );
  const routeTargetsThisSimulator = !routeParams.tab || routeParams.tab === "call-calendar-spread-roll";
  const [startDate, setStartDate] = useState(
    routeTargetsThisSimulator && routeParams.startDate ? routeParams.startDate : "2026-01-02"
  );
  const [preferredShortExpiryDate, setPreferredShortExpiryDate] = useState(
    routeTargetsThisSimulator && routeParams.shortExpiryDate ? routeParams.shortExpiryDate : "2026-01-30"
  );
  const [preferredLongExpiryDate, setPreferredLongExpiryDate] = useState(
    routeTargetsThisSimulator && routeParams.longExpiryDate ? routeParams.longExpiryDate : "2026-12-18"
  );
  const [shortCallStrike, setShortCallStrike] = useState<number | null>(
    routeTargetsThisSimulator ? routeParams.shortStrike : null
  );
  const [longCallStrike, setLongCallStrike] = useState<number | null>(
    routeTargetsThisSimulator ? routeParams.longStrike : null
  );
  const [stockTicker, setStockTicker] = useState(
    routeTargetsThisSimulator && routeParams.ticker ? routeParams.ticker.trim().toUpperCase() : "MSFT"
  );
  const [useFivePercentHigherStrike, setUseFivePercentHigherStrike] = useState(
    routeTargetsThisSimulator && routeParams.useFivePercentHigherStrike
  );
  const [autoRollWeeklyEnabled, setAutoRollWeeklyEnabled] = useState(
    routeTargetsThisSimulator && routeParams.autoRollWeekly
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<CallCalendarRow[]>([]);

  const [manualRolls, setManualRolls] = useState<ManualRollInstruction[]>([]);
  const [rollModalOpen, setRollModalOpen] = useState(false);
  const [rollTargetRow, setRollTargetRow] = useState<CallCalendarRow | null>(null);
  const [rollExpiryDate, setRollExpiryDate] = useState("");
  const [rollStrike, setRollStrike] = useState<number>(0);
  const [rollPreview, setRollPreview] = useState<RollPreview | null>(null);
  const [rollPreviewLoading, setRollPreviewLoading] = useState(false);
  const [callLegModalOpen, setCallLegModalOpen] = useState(false);
  const [callLegModalData, setCallLegModalData] = useState<CallLegModalData | null>(null);
  const [rollingOptionsLoading, setRollingOptionsLoading] = useState(false);
  const [rollingOptions, setRollingOptions] = useState<RollingOptionCandidate[]>([]);
  const [autoRollPopoverRowKey, setAutoRollPopoverRowKey] = useState<string | null>(null);
  const [autoRollTargetRow, setAutoRollTargetRow] = useState<CallCalendarRow | null>(null);
  const [autoRollCandidatesLoading, setAutoRollCandidatesLoading] = useState(false);
  const [autoRollCandidates, setAutoRollCandidates] = useState<RollingOptionCandidate[]>([]);
  const [autoSavedCheckpoint, setAutoSavedCheckpoint] = useState<AutoSavedOptionCheckpoint | null>(
    loadAutoSavedCheckpoint()
  );
  const [processedSimulationCount, setProcessedSimulationCount] = useState(0);
  const [showSummary, setShowSummary] = useState(true);
  const [showChart, setShowChart] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [hiddenChartSeries, setHiddenChartSeries] = useState<Record<string, boolean>>({
    shortCallPrice: true,
    longCallPrice: true,
  });
  const [batchStartDatesText, setBatchStartDatesText] = useState("");
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [batchResults, setBatchResults] = useState<CallCalendarBatchResult[]>([]);
  const [guideModalOpen, setGuideModalOpen] = useState(false);
  const routeAutoRunStartedRef = useRef(false);
  const routeSourceUrlRef = useRef(window.location.href);
  const stockCacheRef = useRef<MasterStockData>(loadMasterStockData());
  const stockInFlightRef = useRef<Map<string, Promise<CachedStockPrice>>>(new Map());
  const optionCacheRef = useRef<OptionCacheData>(loadOptionCache());
  const optionInFlightRef = useRef<Map<string, Promise<OptionOpenClose>>>(new Map());

  const [summary, setSummary] = useState<CallCalendarSimulationSummary | null>(null);

  const fetchWithRateLimitRetry = async <T extends { statusCode: number | null }>(
    work: () => Promise<T>
  ) => {
    let response = await work();
    let attempts = 0;
    while (response.statusCode === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      attempts += 1;
      message.warning(`Rate limit hit (429). Waiting 65 seconds before retry ${attempts}.`);
      await sleep(RATE_LIMIT_WAIT_MS);
      response = await work();
    }
    return response;
  };

  const fetchStockWithCache = async (symbol: string, date: string): Promise<CachedStockPrice> => {
    const cacheKey = getCacheKey(symbol, date);
    const cached = stockCacheRef.current[cacheKey];
    if (cached) return cached;

    const pending = stockInFlightRef.current.get(cacheKey);
    if (pending) return pending;

    const request = (async () => {
      const stockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(symbol, date));
      const result: CachedStockPrice = { symbol, date, closePrice: stockData.closePrice };
      stockCacheRef.current[cacheKey] = result;
      saveMasterStockData(stockCacheRef.current);
      return result;
    })();
    stockInFlightRef.current.set(cacheKey, request);
    try {
      return await request;
    } finally {
      stockInFlightRef.current.delete(cacheKey);
    }
  };

  const fetchOptionWithCache = async (
    symbol: string,
    expiryDate: string,
    strikePrice: number,
    optionType: "C" | "P",
    date: string
  ): Promise<OptionOpenClose> => {
    const cacheKey = getOptionCacheKey(symbol, expiryDate, strikePrice, optionType, date);
    const cached = optionCacheRef.current[cacheKey];
    const cacheAgeMs = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Number.POSITIVE_INFINITY;
    if (cached && cacheAgeMs < OPTION_CACHE_TTL_MS) return cached.data;

    const pending = optionInFlightRef.current.get(cacheKey);
    if (pending) return pending;

    const request = (async () => {
      const data = await fetchWithRateLimitRetry(() =>
        fetchOptionOpenClose(symbol, expiryDate, strikePrice, optionType, date)
      );
      optionCacheRef.current[cacheKey] = { data, fetchedAt: new Date().toISOString() };
      saveOptionCache(optionCacheRef.current);
      return data;
    })();
    optionInFlightRef.current.set(cacheKey, request);
    try {
      return await request;
    } finally {
      optionInFlightRef.current.delete(cacheKey);
    }
  };

  const previewManualRoll = async (
    row: CallCalendarRow,
    nextShortExpiryDate: string,
    nextStrike: number
  ) => {
    if (!dayjs(nextShortExpiryDate).isValid()) {
      setRollPreview(null);
      return;
    }

    setRollPreviewLoading(true);
    try {
      const preview = await getRollPreview(
        row.date,
        row.shortCallPrice,
        nextShortExpiryDate,
        nextStrike
      );
      setRollPreview(preview);
    } finally {
      setRollPreviewLoading(false);
    }
  };

  const getRollPreview = async (
    currentDate: string,
    currentShortCallPremium: number | null,
    nextShortExpiryDate: string,
    nextStrike: number
  ): Promise<RollPreview> => {
    const symbol = stockTicker.trim().toUpperCase();
    const expiryFormatted = formatExpiryDate(nextShortExpiryDate);
    const newShortCallData = await fetchOptionWithCache(
      symbol,
      expiryFormatted,
      nextStrike,
      "C",
      currentDate
    );

    const newShortCallPremium = newShortCallData.closePrice;
    const netCreditDebit =
      currentShortCallPremium !== null && newShortCallPremium !== null
        ? newShortCallPremium - currentShortCallPremium
        : null;

    return { currentShortCallPremium, newShortCallPremium, netCreditDebit };
  };

  const openRollModal = (row: CallCalendarRow) => {
    const defaultRollExpiryDate = getNextTradingDate(row.shortExpiryDate) ?? row.shortExpiryDate;
    setRollTargetRow(row);
    setRollExpiryDate(defaultRollExpiryDate);
    setRollStrike(row.strike);
    setRollPreview(null);
    setRollModalOpen(true);
    void previewManualRoll(row, defaultRollExpiryDate, row.strike);
  };

  const openCallLegModal = (row: CallCalendarRow, legType: "Short Call" | "Long Call") => {
    const premium = legType === "Short Call" ? row.shortCallPrice : row.longCallPrice;
    const expiryDate = legType === "Short Call" ? row.shortExpiryDate : row.longExpiryDate;

    setCallLegModalData({
      legType,
      premium,
      expiryDate,
      strike: row.strike,
      tradeDate: row.date,
      status: row.status,
    });
    void loadRollingOptions(row);
    setCallLegModalOpen(true);
  };

  const loadRollingOptions = async (row: CallCalendarRow) => {
    setRollingOptions([]);

    if (row.shortCallPrice === null) {
      return;
    }

    setRollingOptionsLoading(true);
    try {
      const targetFromDate = getNextTradingDate(row.date) ?? dayjs(row.date).add(1, "day").format("YYYY-MM-DD");
      const candidateExpiries = tradingDates
        .filter((value) =>
          dayjs(value).isSame(dayjs(targetFromDate), "day") || dayjs(value).isAfter(dayjs(targetFromDate), "day")
        )
        .slice(0, 3);

      const strikeCandidates = [
        roundToNearestFive(row.strike - 10),
        roundToNearestFive(row.strike - 5),
        roundToNearestFive(row.strike),
        roundToNearestFive(row.strike + 5),
        roundToNearestFive(row.strike + 10),
      ].filter((strike, index, arr) => strike > 0 && arr.indexOf(strike) === index);

      const previews = await Promise.all(
        candidateExpiries.flatMap((candidateExpiry) =>
          strikeCandidates.map(async (candidateStrike) => {
            const preview = await getRollPreview(
              row.date,
              row.shortCallPrice,
              candidateExpiry,
              candidateStrike
            );

            return {
              key: `${candidateExpiry}-${candidateStrike}`,
              expiryDate: candidateExpiry,
              strike: candidateStrike,
              newShortCallPremium: preview.newShortCallPremium,
              netCreditDebit: preview.netCreditDebit,
            };
          })
        )
      );

      const sorted = previews.sort((a, b) => {
        const aValue = a.netCreditDebit ?? Number.NEGATIVE_INFINITY;
        const bValue = b.netCreditDebit ?? Number.NEGATIVE_INFINITY;
        return bValue - aValue;
      });

      setRollingOptions(sorted);
    } finally {
      setRollingOptionsLoading(false);
    }
  };

  const applyDynamicRollStrike = (row: CallCalendarRow, percentOffset: number) => {
    if (typeof row.closingPrice !== "number" || !Number.isFinite(row.closingPrice)) {
      message.warning("No closing price available to calculate strike");
      return;
    }

    const computedStrike = roundToNearestFive(row.closingPrice * (1 + percentOffset / 100));
    setRollStrike(computedStrike);

    if (rollExpiryDate) {
      void previewManualRoll(row, rollExpiryDate, computedStrike);
    }
  };

  const closeAutoRollPopover = () => {
    setAutoRollPopoverRowKey(null);
    setAutoRollCandidates([]);
    setAutoRollCandidatesLoading(false);
  };

  const handleAutoRollOneWeek = async (row: CallCalendarRow) => {
    setAutoRollTargetRow(row);
    setAutoRollCandidates([]);
    setAutoRollPopoverRowKey(row.key);

    if (row.shortCallPrice === null || row.closingPrice === null) {
      return;
    }

    setAutoRollCandidatesLoading(true);
    try {
      const targetFromDate = row.date;
      const targetEndDate = dayjs(targetFromDate).add(AUTO_ROLL_POPUP_WINDOW_WEEKS, "week").format("YYYY-MM-DD");
      const candidateExpiries = tradingDates.filter((value) => {
        const day = dayjs(value);
        return (
          (day.isSame(dayjs(targetFromDate), "day") || day.isAfter(dayjs(targetFromDate), "day")) &&
          (day.isSame(dayjs(targetEndDate), "day") || day.isBefore(dayjs(targetEndDate), "day"))
        );
      });

      const strikeCandidates = buildNearMoneyStrikeCandidates(row.closingPrice);
      const previews = await Promise.all(
        candidateExpiries.flatMap((candidateExpiry) =>
          strikeCandidates.map(async (candidateStrike) => {
            const preview = await getRollPreview(
              row.date,
              row.shortCallPrice,
              candidateExpiry,
              candidateStrike
            );

            return {
              key: `${candidateExpiry}-${candidateStrike}`,
              expiryDate: candidateExpiry,
              strike: candidateStrike,
              newShortCallPremium: preview.newShortCallPremium,
              netCreditDebit: preview.netCreditDebit,
            };
          })
        )
      );

      const validCandidates = previews
        .filter(
          (item) =>
            item.newShortCallPremium !== null &&
            item.netCreditDebit !== null
        )
        .sort((a, b) => (b.netCreditDebit ?? Number.NEGATIVE_INFINITY) - (a.netCreditDebit ?? Number.NEGATIVE_INFINITY));

      const rangedCandidates = validCandidates.filter(
        (item) =>
          (item.netCreditDebit ?? Number.NEGATIVE_INFINITY) >= AUTO_ROLL_POPUP_MIN_NET_CREDIT_DEBIT &&
          (item.netCreditDebit ?? Number.NEGATIVE_INFINITY) <= AUTO_ROLL_POPUP_MAX_NET_CREDIT_DEBIT
      );

      const isAfterShortExpiry = (item: RollingOptionCandidate) =>
        dayjs(item.expiryDate).isAfter(dayjs(row.shortExpiryDate), "day");

      const rangedAfterShortExpiry = rangedCandidates.filter(isAfterShortExpiry);
      const baseCandidates = rangedCandidates.length > 0 ? rangedCandidates : validCandidates;
      const supplementalAfterShortExpiry = validCandidates
        .filter((item) => isAfterShortExpiry(item) && !baseCandidates.some((candidate) => candidate.key === item.key))
        .slice(0, Math.max(0, 3 - rangedAfterShortExpiry.length));

      const finalCandidates = [...baseCandidates, ...supplementalAfterShortExpiry]
        .sort((a, b) => (b.netCreditDebit ?? Number.NEGATIVE_INFINITY) - (a.netCreditDebit ?? Number.NEGATIVE_INFINITY));

      if (rangedCandidates.length === 0 && validCandidates.length > 0) {
        message.info(
          `No candidates found within ${formatCurrency(AUTO_ROLL_POPUP_MIN_NET_CREDIT_DEBIT)} to ${formatCurrency(AUTO_ROLL_POPUP_MAX_NET_CREDIT_DEBIT)}. Showing closest available options.`
        );
      }

      setAutoRollCandidates(finalCandidates);
    } finally {
      setAutoRollCandidatesLoading(false);
    }
  };

  const applyAutoRollCandidate = async (candidate: RollingOptionCandidate) => {
    if (!autoRollTargetRow) {
      return;
    }

    const nextTradingDate = getNextFridayTradingDate(autoRollTargetRow.date);
    if (!nextTradingDate) {
      message.error("No next trading date available for this auto roll");
      return;
    }

    const updated = [
      ...manualRolls.filter((roll) => !dayjs(roll.fromDate).isSame(dayjs(nextTradingDate), "day")),
      {
        fromDate: nextTradingDate,
        shortExpiryDate: candidate.expiryDate,
        strike: candidate.strike,
        rollCreditDebit: candidate.netCreditDebit,
      },
    ].sort((a, b) => dayjs(a.fromDate).valueOf() - dayjs(b.fromDate).valueOf());

    setManualRolls(updated);
    setAutoRollPopoverRowKey(null);
    await runSimulation(updated);
    message.success(
      `Auto roll scheduled to ${candidate.expiryDate} @ ${candidate.strike} (credit ${formatCurrency(candidate.netCreditDebit)})`
    );
  };

  const runSimulation = async (
    activeManualRolls: ManualRollInstruction[],
    publishRouteResult = false,
    overrideStartDate?: string,
    overrideShortExpiryDate?: string,
    overrideLongExpiryDate?: string
  ): Promise<{ summary: CallCalendarSimulationSummary | null; error: string | null }> => {
    const effectiveStartDate = overrideStartDate ?? startDate;
    const effectiveShortExpiryDate = overrideShortExpiryDate ?? preferredShortExpiryDate;
    const effectiveLongExpiryDate = overrideLongExpiryDate ?? preferredLongExpiryDate;
    setError(null);
    setSummary(null);
    setLoading(true);
    setProcessedSimulationCount(0);

    try {
      const symbol = stockTicker.trim().toUpperCase();
      if (!symbol) throw new Error("Stock ticker is required");
      if (!dayjs(effectiveStartDate).isValid()) throw new Error("Start date is invalid");
      if (effectiveShortExpiryDate && !dayjs(effectiveShortExpiryDate).isValid()) {
        throw new Error("Short expiry date is invalid");
      }
      if (effectiveLongExpiryDate && !dayjs(effectiveLongExpiryDate).isValid()) {
        throw new Error("Long expiry date is invalid");
      }

      const firstDate = getFirstTradingDateOnOrAfter(effectiveStartDate);
      if (!firstDate) throw new Error("No trading date found on or after the start date");

      const openingStockResult = await fetchStockWithCache(symbol, firstDate);
      const openingClosePrice = openingStockResult.closePrice;
      if (openingClosePrice === null) {
        throw new Error(`No stock close price found for ${symbol} on ${firstDate}`);
      }
      const openingStrike = roundToNearestFive(
        openingClosePrice * (useFivePercentHigherStrike ? 1.05 : 1)
      );
      const openingShortCallStrike = shortCallStrike !== null
        ? roundToNearestFive(shortCallStrike)
        : openingStrike;
      const openingLongCallStrike = longCallStrike !== null
        ? roundToNearestFive(longCallStrike)
        : openingStrike;

      if (openingShortCallStrike <= 0 || openingLongCallStrike <= 0) {
        throw new Error("Call strikes must be greater than zero");
      }

      const hasCallData = async (expiryDate: string, strike: number): Promise<boolean> => {
        const expiryFormatted = formatExpiryDate(expiryDate);
        const ceData = await fetchOptionWithCache(symbol, expiryFormatted, strike, "C", firstDate);
        return ceData.statusCode === 200 && ceData.closePrice !== null;
      };

      const resolveExpiryDate = async (
        preferredExpiryDate: string,
        minDteDays: number,
        maxDteDays: number,
        label: "short" | "long",
        strike: number
      ): Promise<string> => {
        if (preferredExpiryDate) {
          const preferredDteDays = dayjs(preferredExpiryDate).diff(dayjs(firstDate), "day");
          if (preferredDteDays < minDteDays || preferredDteDays > maxDteDays) {
            throw new Error(
              `${label === "short" ? "Short" : "Long"} expiry must be ${minDteDays}-${maxDteDays} DTE from ${firstDate}`
            );
          }
          const preferredHasData = await hasCallData(preferredExpiryDate, strike);
          if (!preferredHasData) {
            throw new Error(
              `${label === "short" ? "Short" : "Long"} expiry has no call option data for ${symbol} on ${firstDate} at strike ${openingStrike}`
            );
          }
          return preferredExpiryDate;
        }

        const candidates = getExpiryDateCandidatesInDteWindow(firstDate, minDteDays, maxDteDays);
        for (const candidate of candidates) {
          if (await hasCallData(candidate, strike)) {
            return candidate;
          }
        }

        throw new Error(
          `No ${label} expiry date found in the ${minDteDays}-${maxDteDays} DTE window with call option data`
        );
      };

      const initialShortExpiryDate = await resolveExpiryDate(
        effectiveShortExpiryDate,
        SHORT_EXPIRY_MIN_DTE_DAYS,
        SHORT_EXPIRY_MAX_DTE_DAYS,
        "short",
        openingShortCallStrike
      );
      const longExpiryDate = await resolveExpiryDate(
        effectiveLongExpiryDate,
        LONG_EXPIRY_MIN_DTE_DAYS,
        LONG_EXPIRY_MAX_DTE_DAYS,
        "long",
        openingLongCallStrike
      );

      const relevantRolls = [...activeManualRolls]
        .filter((roll) =>
          dayjs(roll.fromDate).isAfter(dayjs(firstDate), "day") ||
          dayjs(roll.fromDate).isSame(dayjs(firstDate), "day")
        )
        .sort((a, b) => dayjs(a.fromDate).valueOf() - dayjs(b.fromDate).valueOf());

      const simulationEndDate = autoRollWeeklyEnabled
        ? longExpiryDate
        : relevantRolls.reduce((maxDate, roll) => {
            return dayjs(roll.shortExpiryDate).isAfter(dayjs(maxDate), "day")
              ? roll.shortExpiryDate
              : maxDate;
          }, initialShortExpiryDate);

      if (dayjs(longExpiryDate).isBefore(dayjs(simulationEndDate), "day")) {
        throw new Error("Long expiry date must be after the latest short expiry date");
      }

      const dates = tradingDates.filter((candidateDate) => {
        const day = dayjs(candidateDate);
        return (
          (day.isAfter(dayjs(firstDate), "day") || day.isSame(dayjs(firstDate), "day")) &&
          (day.isBefore(dayjs(simulationEndDate), "day") || day.isSame(dayjs(simulationEndDate), "day"))
        );
      }).slice(0, MAX_SIMULATION_TRADING_DAYS);

      if (dates.length === 0) {
        throw new Error(`No trading dates found between ${firstDate} and ${simulationEndDate}`);
      }

      const allRows: CallCalendarRow[] = [];
      let activeShortExpiryDate = initialShortExpiryDate;
      let activeStrike = openingShortCallStrike;
      let rollNumber = 0;
      let entryNetCredit: number | null = null;
      let simulationStartShortCallPrice: number | null = null;
      let realisedPnl = 0;
      let pendingRollCreditDebit: number | null = null;
      let autoRollStoppedReason: string | null = null;
      let initialOptionInvestment: number | null = null;

      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const rollForToday = relevantRolls.find((roll) => dayjs(roll.fromDate).isSame(dayjs(date), "day"));
        const rolledToday = Boolean(rollForToday);
        const rollCreditDebit = rollForToday?.rollCreditDebit ?? null;
        const previousCumulativePnl =
          allRows.length > 0 ? (allRows[allRows.length - 1].cumulativePnl ?? realisedPnl) : realisedPnl;

        if (rollForToday) {
          activeShortExpiryDate = rollForToday.shortExpiryDate;
          activeStrike = roundToNearestFive(rollForToday.strike);
          entryNetCredit = null;
          rollNumber += 1;
          pendingRollCreditDebit = rollForToday.rollCreditDebit ?? null;
          realisedPnl = previousCumulativePnl + (rollForToday.rollCreditDebit ?? 0);
        }

        const daysUntilActiveShortExpiry = dayjs(activeShortExpiryDate).diff(dayjs(date), "day");
        const shouldProcessDate =
          dayjs(date).day() === 5 ||
          (daysUntilActiveShortExpiry >= 0 && daysUntilActiveShortExpiry < DAILY_PROCESSING_DTE_THRESHOLD_DAYS);
        if (!shouldProcessDate) continue;

        const stockResult = await fetchStockWithCache(symbol, date);
        const closePrice = stockResult.closePrice;
        if (closePrice === null) {
          continue;
        }

        const shortExpFmt = formatExpiryDate(activeShortExpiryDate);
        const longExpFmt = formatExpiryDate(longExpiryDate);

        const [shortCallData, longCallData] = await Promise.all([
          fetchOptionWithCache(symbol, shortExpFmt, activeStrike, "C", date),
          fetchOptionWithCache(symbol, longExpFmt, openingLongCallStrike, "C", date),
        ]);

        const shortCallPrice = shortCallData.closePrice;
        const longCallPrice = longCallData.closePrice;
        const currentNetCloseCost =
          shortCallPrice !== null && longCallPrice !== null ? shortCallPrice - longCallPrice : null;

        const checkpoint: AutoSavedOptionCheckpoint = {
          date,
          shortCallPrice,
          longCallPrice,
          savedAt: new Date().toISOString(),
        };
        saveAutoSavedCheckpoint(checkpoint);
        setAutoSavedCheckpoint(checkpoint);

        if (entryNetCredit === null) {
          entryNetCredit = currentNetCloseCost;
        }
        if (initialOptionInvestment === null && entryNetCredit !== null) {
          initialOptionInvestment = Math.abs(entryNetCredit);
        }
        if (simulationStartShortCallPrice === null) {
          simulationStartShortCallPrice = shortCallPrice;
        }

        const isExpiry = dayjs(date).isSame(dayjs(activeShortExpiryDate), "day");
        const reachesSimulationLimit = allRows.length + 1 >= MAX_SIMULATION_TRADING_DAYS;
        const isLastDate = i === dates.length - 1 || reachesSimulationLimit;

        let status: RowStatus;
        let closeNetCost: number | null = null;
        let legPnl: number | null = null;

        if (rolledToday) {
          status = "rolled";
        } else if (isExpiry || isLastDate) {
          status = "expired";
          closeNetCost = currentNetCloseCost;
          legPnl =
            entryNetCredit !== null && closeNetCost !== null ? entryNetCredit - closeNetCost : null;
          if (legPnl !== null) realisedPnl += legPnl;
        } else {
          status = "active";
        }

        const unrealisedPnl =
          status === "active" && entryNetCredit !== null && currentNetCloseCost !== null
            ? entryNetCredit - currentNetCloseCost
            : 0;

        const rowRollCreditDebit = rollCreditDebit ?? pendingRollCreditDebit;
        const cumulativePnl = realisedPnl + unrealisedPnl;
        const cumulativeReturnPct =
          initialOptionInvestment !== null && initialOptionInvestment !== 0
            ? (cumulativePnl / initialOptionInvestment) * 100
            : null;

        allRows.push({
          key: `${rollNumber}-${date}`,
          date,
          closingPrice: closePrice,
          stockReturn: closePrice - openingClosePrice,
          stockReturnPct:
            openingClosePrice !== 0
              ? ((closePrice - openingClosePrice) / openingClosePrice) * 100
              : null,
          strike: activeStrike,
          shortExpiryDate: activeShortExpiryDate,
          longExpiryDate,
          shortCallPrice,
          longCallPrice,
          entryNetCredit,
          rollCreditDebit: rowRollCreditDebit,
          closeNetCost: status !== "active" ? closeNetCost : null,
          legPnl: status !== "active" ? legPnl : null,
          cumulativePnl,
          cumulativeReturnPct,
          status,
          rollNumber,
        });

        if (rowRollCreditDebit !== null) {
          pendingRollCreditDebit = null;
        }

        setProcessedSimulationCount(allRows.length);

        if (cumulativeReturnPct !== null && cumulativeReturnPct >= OPTION_STRATEGY_PROFIT_TARGET_PCT) {
          realisedPnl = cumulativePnl;
          autoRollStoppedReason =
            `Simulation stopped on ${date}: option strategy reached ${cumulativeReturnPct.toFixed(2)}% return.`;
          break;
        }

        if (isExpiry) {
          autoRollStoppedReason = `Simulation stopped at short expiry ${activeShortExpiryDate} on ${date}.`;
          break;
        }

        if (reachesSimulationLimit) {
          autoRollStoppedReason = `Simulation stopped after ${MAX_SIMULATION_TRADING_DAYS} processed simulation days.`;
          break;
        }

        if (autoRollWeeklyEnabled) {
          const meetsAutoRollDecayCondition =
            simulationStartShortCallPrice !== null &&
            shortCallPrice !== null &&
            shortCallPrice <= simulationStartShortCallPrice * 0.5;

          const daysUntilExpiry = dayjs(activeShortExpiryDate).diff(dayjs(date), "day");
          const isNearExpiry = daysUntilExpiry >= 0 && daysUntilExpiry < 10;

          if (!meetsAutoRollDecayCondition && !isNearExpiry) {
            continue;
          }

          const nextTradingDate = getNextFridayTradingDate(date);
          if (!nextTradingDate) {
            autoRollStoppedReason = `Auto roll stopped after ${date}: no next trading date available.`;
            break;
          }

          const hasExistingRollForNextTradingDate = relevantRolls.some((roll) =>
            dayjs(roll.fromDate).isSame(dayjs(nextTradingDate), "day")
          );

          if (!hasExistingRollForNextTradingDate) {
            const targetFromDate =
              getNextTradingDate(activeShortExpiryDate) ??
              dayjs(activeShortExpiryDate).add(1, "day").format("YYYY-MM-DD");
            const candidateExpiries = tradingDates.filter((value) =>
              dayjs(value).isSame(dayjs(targetFromDate), "day") ||
              dayjs(value).isAfter(dayjs(targetFromDate), "day")
            );

            let autoRollExpiryDate: string | null = null;
            let autoRollStrike: number | null = null;
            let autoPreview: RollPreview | null = null;
            const strikeCandidates = buildStrikeCandidates(activeStrike, AUTO_ROLL_MAX_STRIKE_STEPS);

            for (const candidate of candidateExpiries) {
              for (const candidateStrike of strikeCandidates) {
                const candidatePreview = await getRollPreview(
                  date,
                  shortCallPrice,
                  candidate,
                  candidateStrike
                );
                if (
                  candidatePreview.newShortCallPremium !== null &&
                  candidatePreview.netCreditDebit !== null &&
                  candidatePreview.netCreditDebit >= MIN_AUTO_ROLL_CREDIT
                ) {
                  autoRollExpiryDate = candidate;
                  autoRollStrike = candidateStrike;
                  autoPreview = candidatePreview;
                  break;
                }
              }
              if (autoRollExpiryDate && autoRollStrike !== null && autoPreview) {
                break;
              }
            }

            if (!autoRollExpiryDate || autoRollStrike === null || !autoPreview) {
              autoRollStoppedReason =
                `Auto roll stopped after ${date}: no target met minimum credit ` +
                `${MIN_AUTO_ROLL_CREDIT.toFixed(2)} on/after ${targetFromDate}.`;
              break;
            }

            relevantRolls.push({
              fromDate: nextTradingDate,
              shortExpiryDate: autoRollExpiryDate,
              strike: autoRollStrike,
              rollCreditDebit: autoPreview.netCreditDebit,
            });
            relevantRolls.sort((a, b) => dayjs(a.fromDate).valueOf() - dayjs(b.fromDate).valueOf());
          }
        }
      }

      setRows(allRows);

      if (autoRollStoppedReason) {
        message.warning(autoRollStoppedReason);
      }

      const initialOptionEntry = allRows.find((row) => row.entryNetCredit !== null)?.entryNetCredit ?? null;
      const endingClosePrice = allRows.length > 0 ? allRows[allRows.length - 1].closingPrice : null;
      const stockReturn =
        endingClosePrice !== null ? endingClosePrice - openingClosePrice : null;
      const stockReturnPct =
        endingClosePrice !== null && openingClosePrice !== 0
          ? ((endingClosePrice - openingClosePrice) / openingClosePrice) * 100
          : null;
      const optionStrategyReturnPct =
        initialOptionEntry !== null && initialOptionEntry !== 0
          ? (realisedPnl / Math.abs(initialOptionEntry)) * 100
          : null;
      const actualEndDate = allRows.length > 0 ? allRows[allRows.length - 1].date : firstDate;

      const simulationSummary: CallCalendarSimulationSummary = {
        startDate: firstDate,
        endDate: actualEndDate,
        stockStartPrice: openingClosePrice,
        stockEndPrice: endingClosePrice,
        optionInvestment: initialOptionEntry !== null ? Math.abs(initialOptionEntry) : null,
        stockReturn,
        stockReturnPct,
        optionStrategyReturn: realisedPnl,
        optionStrategyReturnPct,
      };
      setSummary(simulationSummary);

      if (publishRouteResult || Boolean(autoRollStoppedReason)) {
        if (!isSimulationResultsApiConfigured()) {
          message.warning("Simulation completed, but the Google Sheets results API is not configured.");
        } else {
          try {
            await appendCallCalendarSimulationResult({
              recordedAt: new Date().toISOString(),
              strategy: "Call Calendar Spread Roll",
              ticker: symbol,
              requestedStartDate: effectiveStartDate,
              actualStartDate: firstDate,
              endDate: actualEndDate,
              shortExpiryDate: initialShortExpiryDate,
              sellExpiryDate: null,
              longExpiryDate,
              shortStrike: openingShortCallStrike,
              sellStrike: null,
              longStrike: openingLongCallStrike,
              fivePercentStrike: useFivePercentHigherStrike,
              autoRoll: autoRollWeeklyEnabled,
              processedDays: allRows.length,
              stockStartPrice: simulationSummary.stockStartPrice,
              stockEndPrice: simulationSummary.stockEndPrice,
              stockReturn: simulationSummary.stockReturn,
              stockReturnPct: simulationSummary.stockReturnPct,
              optionInvestment: simulationSummary.optionInvestment,
              optionStrategyReturn: simulationSummary.optionStrategyReturn,
              optionStrategyReturnPct: simulationSummary.optionStrategyReturnPct,
              stopReason: autoRollStoppedReason,
              sourceUrl: routeSourceUrlRef.current,
              inputParams: Object.fromEntries(new URL(routeSourceUrlRef.current).searchParams.entries()),
              gridData: {
                rows: allRows.map((row) => ({
                  date: row.date,
                  closingPrice: row.closingPrice,
                  strike: row.strike,
                  longStrike: openingLongCallStrike,
                  shortExpiryDate: row.shortExpiryDate,
                  longExpiryDate: row.longExpiryDate,
                  dte: dayjs(row.shortExpiryDate).diff(dayjs(row.date), "day"),
                  shortCallPrice: row.shortCallPrice,
                  longCallPrice: row.longCallPrice,
                  stockReturn: row.stockReturn,
                  stockReturnPct: row.stockReturnPct,
                  cumulativePnl: row.cumulativePnl,
                  cumulativeReturnPct: row.cumulativeReturnPct,
                  status: row.status,
                  rollNumber: row.rollNumber,
                })),
              },
              resultSummary: simulationSummary,
            });
            message.success("Simulation result sent to Google Sheets.");
          } catch (publishError) {
            const publishMessage = publishError instanceof Error ? publishError.message : "Unknown results API error";
            message.warning(`Simulation completed, but the result was not sent: ${publishMessage}`);
          }
        }
      }

      return { summary: simulationSummary, error: null };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to run call calendar spread simulation";
      setError(errorMessage);
      return { summary: null, error: errorMessage };
    } finally {
      setLoading(false);
    }
  };

  const handleRun = async () => {
    setManualRolls([]);
    await runSimulation([]);
  };

  const handlePublish = async () => {
    await runSimulation(manualRolls, true);
  };

  const parseBatchStartDates = (raw: string): string[] => Array.from(new Set(
    raw
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && dayjs(value).isValid())
      .map((value) => dayjs(value).format("YYYY-MM-DD"))
  )).sort((left, right) => dayjs(left).valueOf() - dayjs(right).valueOf());

  const runBatch = async () => {
    const dates = parseBatchStartDates(batchStartDatesText);
    if (dates.length === 0) {
      message.warning("Enter at least one valid start date to run sequentially");
      return;
    }
    setBatchRunning(true);
    setBatchResults([]);
    setBatchProgress({ current: 0, total: dates.length });
    for (let i = 0; i < dates.length; i += 1) {
      const result = await runSimulation([], true, dates[i], "", "");
      setBatchResults((previous) => [...previous, {
        key: dates[i],
        startDate: dates[i],
        endDate: result.summary?.endDate ?? null,
        stockReturn: result.summary?.stockReturn ?? null,
        stockReturnPct: result.summary?.stockReturnPct ?? null,
        optionStrategyReturn: result.summary?.optionStrategyReturn ?? null,
        optionStrategyReturnPct: result.summary?.optionStrategyReturnPct ?? null,
        error: result.error,
      }]);
      setBatchProgress({ current: i + 1, total: dates.length });
    }
    setBatchRunning(false);
    message.success(`Batch run complete: ${dates.length} simulation(s) processed`);
  };

  const runSimulationEvent = useEffectEvent(runSimulation);

  useEffect(() => {
    if (!routeTargetsThisSimulator || !routeParams.autoRun || routeAutoRunStartedRef.current) return;
    routeAutoRunStartedRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("run");
    window.history.replaceState({}, "", url);
    void runSimulationEvent([], true);
  }, [routeParams.autoRun, routeTargetsThisSimulator]);

  const confirmManualRoll = async () => {
    if (!rollTargetRow) return;
    if (!dayjs(rollExpiryDate).isValid()) {
      message.error("Please choose a valid short expiry date");
      return;
    }
    if (!Number.isFinite(rollStrike) || rollStrike <= 0) {
      message.error("Please choose a valid strike price");
      return;
    }

    const nextTradingDate = getNextTradingDate(rollTargetRow.date);
    if (!nextTradingDate) {
      message.error("No next trading date available for this roll");
      return;
    }

    const updated = [
      ...manualRolls.filter((roll) => !dayjs(roll.fromDate).isSame(dayjs(nextTradingDate), "day")),
      {
        fromDate: nextTradingDate,
        shortExpiryDate: rollExpiryDate,
        strike: roundToNearestFive(rollStrike),
        rollCreditDebit: rollPreview?.netCreditDebit ?? null,
      },
    ].sort((a, b) => dayjs(a.fromDate).valueOf() - dayjs(b.fromDate).valueOf());

    setManualRolls(updated);
    setRollModalOpen(false);
    await runSimulation(updated);
  };

  const optionPriceChartData = useMemo(
    () =>
      rows.map((row) => ({
        date: row.date,
        shortCallPrice: row.shortCallPrice,
        longCallPrice: row.longCallPrice,
        stockReturn: row.stockReturn,
        stockReturnPct: row.stockReturnPct,
        cumulativePnl: row.cumulativePnl,
        cumulativeReturnPct: row.cumulativeReturnPct,
      })),
    [rows]
  );

  const toggleChartSeries = (dataKey: unknown) => {
    if (typeof dataKey !== "string") return;
    setHiddenChartSeries((previous) => ({ ...previous, [dataKey]: !previous[dataKey] }));
  };

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card title="Call Calendar Spread (Roll)">
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12} lg={6}>
            <Text>Start Date</Text>
            <DatePicker
              value={dayjs(startDate)}
              onChange={(v) => setStartDate(v ? v.format("YYYY-MM-DD") : "")}
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>Short Expiry Date (optional)</Text>
            <DatePicker
              value={preferredShortExpiryDate ? dayjs(preferredShortExpiryDate) : null}
              onChange={(v) => setPreferredShortExpiryDate(v ? v.format("YYYY-MM-DD") : "")}
              style={{ width: "100%", marginTop: 8 }}
              placeholder="Auto 15-75 DTE"
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>Long Expiry Date (optional)</Text>
            <DatePicker
              value={preferredLongExpiryDate ? dayjs(preferredLongExpiryDate) : null}
              onChange={(v) => setPreferredLongExpiryDate(v ? v.format("YYYY-MM-DD") : "")}
              style={{ width: "100%", marginTop: 8 }}
              placeholder="Auto 150-400 DTE"
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>Stock ticker</Text>
            <Input
              value={stockTicker}
              onChange={(e) => setStockTicker(e.target.value.toUpperCase())}
              style={{ marginTop: 8 }}
              placeholder="SPY"
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>Short Call Strike</Text>
            <InputNumber<number>
              value={shortCallStrike}
              onChange={setShortCallStrike}
              min={5}
              step={5}
              placeholder="Auto ATM"
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>Long Call Strike</Text>
            <InputNumber<number>
              value={longCallStrike}
              onChange={setLongCallStrike}
              min={5}
              step={5}
              placeholder="Auto ATM"
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
        </Row>

        <Space style={{ marginTop: 16 }} wrap>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={loading}>
            Run Call Calendar Spread
          </Button>
          <Button icon={<CloudUploadOutlined />} onClick={handlePublish} disabled={loading}>
            Publish
          </Button>
          <Button icon={<GoogleOutlined />} href={GOOGLE_SHEETS_URL} target="_blank" rel="noopener noreferrer">
            Google Sheets
          </Button>
          <Button
            type={autoRollWeeklyEnabled ? "primary" : "default"}
            onClick={() => setAutoRollWeeklyEnabled((previous) => !previous)}
            disabled={loading}
          >
            Auto Roll Weekly: {autoRollWeeklyEnabled ? "ON" : "OFF"}
          </Button>
          <Button
            type={useFivePercentHigherStrike ? "primary" : "default"}
            onClick={() => setUseFivePercentHigherStrike((previous) => !previous)}
            disabled={loading}
          >
            +5% Strike: {useFivePercentHigherStrike ? "ON" : "OFF"}
          </Button>
          <Button onClick={() => setGuideModalOpen(true)} disabled={loading}>
            User Guide
          </Button>
        </Space>
        <Space style={{ marginTop: 12 }} wrap>
          <Button onClick={() => setShowSummary((previous) => !previous)}>
            {showSummary ? "Hide Summary" : "Show Summary"}
          </Button>
          <Button onClick={() => setShowChart((previous) => !previous)}>
            {showChart ? "Hide Chart" : "Show Chart"}
          </Button>
          <Button onClick={() => setShowGrid((previous) => !previous)}>
            {showGrid ? "Hide Grid" : "Show Grid"}
          </Button>
        </Space>
        <Text type="secondary" style={{ display: "block", marginTop: 8 }}>
          Processed simulations: {processedSimulationCount}
        </Text>
        <Text type="secondary" style={{ display: "block", marginTop: 4 }}>
          Auto-saved checkpoint: {autoSavedCheckpoint?.date ?? "-"} | Short Call {formatCurrency(autoSavedCheckpoint?.shortCallPrice ?? null)} | Long Call {formatCurrency(autoSavedCheckpoint?.longCallPrice ?? null)}
        </Text>
        <Space direction="vertical" size={8} style={{ width: "100%", marginTop: 16 }}>
          <Text strong>Batch Run (Sequential)</Text>
          <Input.TextArea
            value={batchStartDatesText}
            onChange={(event) => setBatchStartDatesText(event.target.value)}
            placeholder={"One start date per line, e.g.\n2025-01-03\n2025-01-10"}
            autoSize={{ minRows: 3, maxRows: 6 }}
            disabled={batchRunning}
          />
          <Space wrap>
            <Button icon={<PlayCircleOutlined />} onClick={() => void runBatch()} loading={batchRunning} disabled={loading}>
              Run Sequentially
            </Button>
            {batchProgress && <Text type="secondary">Batch progress: {batchProgress.current}/{batchProgress.total}</Text>}
          </Space>
        </Space>
      </Card>

      {error && <Alert type="error" showIcon message="Call Calendar Spread Error" description={error} />}

      {batchResults.length > 0 && (
        <Card title="Batch Results">
          <Table<CallCalendarBatchResult>
            rowKey="key"
            dataSource={batchResults}
            pagination={{ pageSize: 20 }}
            scroll={{ x: 760 }}
            columns={[
              { title: "Start Date", dataIndex: "startDate", key: "startDate", width: 110 },
              { title: "End Date", dataIndex: "endDate", key: "endDate", width: 110, render: (value: string | null) => value ?? "-" },
              {
                title: "Stock Return ($ | %)",
                key: "stockReturn",
                width: 170,
                render: (_: unknown, row: CallCalendarBatchResult) => <Space size={2}><Text>{formatCurrency(row.stockReturn)}</Text><Text>|</Text><Text>{formatPercent(row.stockReturnPct)}</Text></Space>,
              },
              {
                title: "Option Strategy Return ($ | %)",
                key: "optionStrategyReturn",
                width: 210,
                render: (_: unknown, row: CallCalendarBatchResult) => <Space size={2}><Text style={{ color: (row.optionStrategyReturn ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>{formatCurrency(row.optionStrategyReturn)}</Text><Text>|</Text><Text>{formatPercent(row.optionStrategyReturnPct)}</Text></Space>,
              },
              { title: "Status", key: "status", render: (_: unknown, row: CallCalendarBatchResult) => row.error ? <Text type="danger">{row.error}</Text> : <Text type="success">Success</Text> },
            ]}
          />
        </Card>
      )}

      {summary && showSummary && (
        <Card title="Summary">
          <Row gutter={[24, 8]}>
            <Col xs={24} sm={8}>
              <Text strong>Start Date: </Text>
              <Text>{summary.startDate}</Text>
            </Col>
            <Col xs={24} sm={8}>
              <Text strong>End Date: </Text>
              <Text>{summary.endDate}</Text>
            </Col>
            <Col xs={24} sm={8}>
              <Text strong>Stock Start Price: </Text>
              <Text>{formatCurrency(summary.stockStartPrice)}</Text>
            </Col>
            <Col xs={24} sm={8}>
              <Text strong>Stock End Price: </Text>
              <Text>{formatCurrency(summary.stockEndPrice)}</Text>
            </Col>
            <Col xs={24} sm={8}>
              <Text strong>Option Investment: </Text>
              <Text>{formatCurrency(summary.optionInvestment)}</Text>
            </Col>
            <Col xs={24} sm={8}>
              <Text strong>Stock Return: </Text>
              <Text style={{ color: (summary.stockReturn ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                {`${formatCurrency(summary.stockReturn)} (${formatPercent(summary.stockReturnPct)})`}
              </Text>
            </Col>
            <Col xs={24} sm={8}>
              <Text strong>Option Strategy Return: </Text>
              <Text style={{ color: summary.optionStrategyReturn >= 0 ? "#3f8600" : "#cf1322" }}>
                {`${formatCurrency(summary.optionStrategyReturn)} (${formatPercent(summary.optionStrategyReturnPct)})`}
              </Text>
            </Col>
          </Row>
        </Card>
      )}

      {showChart && (
        <Card title="Option Price and Return Chart">
          {optionPriceChartData.length === 0 ? (
            <Text type="secondary">Run the simulation to view option prices by date.</Text>
          ) : (
            <div style={{ width: "100%", height: 380 }}>
              <ResponsiveContainer>
                <LineChart data={optionPriceChartData} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis yAxisId="dollars" tickFormatter={(value: number) => `$${value}`} />
                  <YAxis yAxisId="percent" orientation="right" tickFormatter={(value: number) => `${value}%`} />
                  <Tooltip />
                  <Legend
                    onClick={(entry) => toggleChartSeries(entry.dataKey)}
                    formatter={(value, entry) => <span style={{ color: hiddenChartSeries[String(entry.dataKey)] ? "#8c8c8c" : undefined, textDecoration: hiddenChartSeries[String(entry.dataKey)] ? "line-through" : undefined, cursor: "pointer" }}>{value}</span>}
                  />
                  <Line
                    yAxisId="dollars"
                    type="monotone"
                    dataKey="shortCallPrice"
                    name="Short Call Price"
                    hide={Boolean(hiddenChartSeries.shortCallPrice)}
                    stroke="#cf1322"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                  <Line
                    yAxisId="dollars"
                    type="monotone"
                    dataKey="longCallPrice"
                    name="Long Call Price"
                    hide={Boolean(hiddenChartSeries.longCallPrice)}
                    stroke="#0958d9"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                  <Line yAxisId="dollars" type="monotone" dataKey="stockReturn" name="Stock Return ($)" hide={Boolean(hiddenChartSeries.stockReturn)} stroke="#3f8600" strokeWidth={2} dot={false} connectNulls={false} />
                  <Line yAxisId="percent" type="monotone" dataKey="stockReturnPct" name="Stock Return (%)" hide={Boolean(hiddenChartSeries.stockReturnPct)} stroke="#08979c" strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls={false} />
                  <Line yAxisId="dollars" type="monotone" dataKey="cumulativePnl" name="Cumulative P&amp;L ($)" hide={Boolean(hiddenChartSeries.cumulativePnl)} stroke="#d46b08" strokeWidth={2} dot={false} connectNulls={false} />
                  <Line yAxisId="percent" type="monotone" dataKey="cumulativeReturnPct" name="Cumulative Return (%)" hide={Boolean(hiddenChartSeries.cumulativeReturnPct)} stroke="#531dab" strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      )}

      {showGrid && (
        <Card title="Records">
          <style>{`
            .call-calendar-compact-grid .ant-table-thead > tr > th,
            .call-calendar-compact-grid .ant-table-tbody > tr > td { padding: 6px 8px; }
            .call-calendar-compact-grid .ant-table-tbody > tr.call-calendar-profit-row > td { background: #f6ffed; }
            .call-calendar-compact-grid .ant-table-tbody > tr.call-calendar-profit-row:hover > td { background: #d9f7be; }
          `}</style>
          <Table<CallCalendarRow>
            className="call-calendar-compact-grid"
            rowKey="key"
            loading={loading}
            dataSource={rows}
            rowClassName={(row) =>
              (row.cumulativeReturnPct ?? Number.NEGATIVE_INFINITY) > 10
                ? "call-calendar-profit-row"
                : ""
            }
            pagination={{ pageSize: 50, showSizeChanger: true }}
            scroll={{ x: "max-content" }}
            columns={[
            { title: "Roll #", dataIndex: "rollNumber", key: "rollNumber", width: 70 },
            // { title: "Date", dataIndex: "date", key: "date", width: 110 },
            {
              title: "Closing Price | Short Expiry | Strike | DTE",
              key: "closeExpiryStrike",
              width: 460,
              render: (_: number | null, row: CallCalendarRow) => {
                const dte = dayjs(row.shortExpiryDate).diff(dayjs(row.date), "day");
                const dteLabel = Number.isFinite(dte) ? `${dte}d` : "-";

                return (
                  <Space size={4}>
                    <Text>{formatCurrency(row.closingPrice)}</Text>
                    <Text>|</Text>
                    <Text>{row.shortExpiryDate || "-"}</Text>
                    <Text>|</Text>
                    <Text>{formatCurrency(row.strike)}</Text>
                    <Text>|</Text>
                    <Text>{dteLabel}</Text>
                  </Space>
                );
              },
            },
            // { title: "Long Expiry", dataIndex: "longExpiryDate", key: "longExpiryDate", width: 120 },
            {
              title: "Call Price (Short | Long)",
              key: "callPriceCombined",
              width: 260,
              render: (_: number | null, row: CallCalendarRow) => {
                const shortCall =
                  row.shortCallPrice !== null ? (
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0 }}
                      onClick={() => openCallLegModal(row, "Short Call")}
                    >
                      {formatCurrency(row.shortCallPrice)}
                    </Button>
                  ) : (
                    "-"
                  );

                const longCall =
                  row.longCallPrice !== null ? (
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0 }}
                      onClick={() => openCallLegModal(row, "Long Call")}
                    >
                      {formatCurrency(row.longCallPrice)}
                    </Button>
                  ) : (
                    "-"
                  );

                return (
                  <Space size={4}>
                    {shortCall}
                    <Text>|</Text>
                    {longCall}
                  </Space>
                );
              },
            },
            {
              title: "Stock Return ($ | %)",
              key: "stockReturn",
              width: 180,
              render: (_: unknown, row: CallCalendarRow) => (
                <Space size={2}>
                  <Text style={{ color: (row.stockReturn ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                    {formatCurrency(row.stockReturn)}
                  </Text>
                  <Text>|</Text>
                  <Text>{formatPercent(row.stockReturnPct)}</Text>
                </Space>
              ),
            },
            {
              title: "Theta/Day (Short | Long)",
              key: "thetaPerDay",
              width: 320,
              render: (_: number | null, row: CallCalendarRow) => {
                const shortTheta = calculateThetaPerDay(
                  row.shortCallPrice,
                  row.closingPrice,
                  row.strike,
                  row.date,
                  row.shortExpiryDate,
                  "C"
                );

                const longTheta = calculateThetaPerDay(
                  row.longCallPrice,
                  row.closingPrice,
                  row.strike,
                  row.date,
                  row.longExpiryDate,
                  "C"
                );

                const netTheta =
                  shortTheta !== null && longTheta !== null
                    ? longTheta - shortTheta
                    : null;

                const getColor = (value: number | null) => {
                  if (value === null || !Number.isFinite(value)) {
                    return undefined;
                  }
                  return value >= 0 ? "#3f8600" : "#cf1322";
                };

                return (
                  <Space size={4} wrap>
                    <Text >{formatCurrency(shortTheta)}</Text>
                    <Text>|</Text>
                    <Text >{formatCurrency(longTheta)}</Text>
                    <Text>(</Text>
                    <Text style={{ color: getColor(netTheta) }}>
                      {formatCurrency(netTheta)}
                    </Text>
                    <Text>)</Text>
                  </Space>
                );
              },
            },
            // {
            //   title: "Entry Net Credit",
            //   dataIndex: "entryNetCredit",
            //   key: "entryNetCredit",
            //   width: 140,
            //   render: (v: number | null) => formatCurrency(v),
            // },
            // {
            //   title: "Close Net Cost",
            //   dataIndex: "closeNetCost",
            //   key: "closeNetCost",
            //   width: 130,
            //   render: (v: number | null) => (v !== null ? formatCurrency(v) : "-"),
            // },
            // {
            //   title: "Leg P&L",
            //   dataIndex: "legPnl",
            //   key: "legPnl",
            //   width: 110,
            //   render: (v: number | null) =>
            //     v !== null ? (
            //       <Text style={{ color: v >= 0 ? "#3f8600" : "#cf1322" }}>{formatCurrency(v)}</Text>
            //     ) : (
            //       "-"
            //     ),
            // },
            {
              title: "Cumulative P&L ($ | % | Roll Credit/Debit)",
              key: "cumulativeWithRoll",
              width: 260,
              render: (_: number | null, row: CallCalendarRow) => {
                const cumulative = row.cumulativePnl;
                const cumulativeReturnPct = row.cumulativeReturnPct;
                const roll = row.rollCreditDebit;

                const cumulativeNode =
                  cumulative !== null ? (
                    <Text style={{ color: cumulative >= 0 ? "#3f8600" : "#cf1322" }}>
                      {formatCurrency(cumulative)}
                    </Text>
                  ) : (
                    "-"
                  );

                const hasRoll = roll !== null;

                const rollNode = hasRoll ? (
                  <Text style={{ color: (roll ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                    {formatCurrency(roll)}
                  </Text>
                ) : null;

                return (
                  <Space size={4} wrap>
                    {cumulativeNode}
                    <Text>|</Text>
                    <Text style={{ color: (cumulativeReturnPct ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>{formatPercent(cumulativeReturnPct)}</Text>
                    {hasRoll ? <Text>(</Text> : null}
                    {rollNode}
                    {hasRoll ? <Text>)</Text> : null}
                  </Space>
                );
              },
            },
            // {
            //   title: "Status",
            //   dataIndex: "status",
            //   key: "status",
            //   width: 100,
            //   render: (v: RowStatus) => statusTag(v),
            //   filters: [
            //     { text: "Active", value: "active" },
            //     { text: "Rolled", value: "rolled" },
            //     { text: "Expired", value: "expired" },
            //   ],
            //   onFilter: (value, record) => record.status === value,
            // },
            {
              title: "Action",
              key: "action",
              width: 220,
              render: (_: unknown, row: CallCalendarRow) => (
                <Space size={8}>
                  <Button size="small" onClick={() => openRollModal(row)} disabled={loading}>
                    Roll
                  </Button>
                  <Popover
                    trigger="click"
                    placement="leftTop"
                    title="Auto Roll Candidates"
                    overlayStyle={{ maxWidth: 1150 }}
                    open={autoRollPopoverRowKey === row.key}
                    onOpenChange={(open) => {
                      if (open) {
                        void handleAutoRollOneWeek(row);
                        return;
                      }
                      if (autoRollPopoverRowKey === row.key) {
                        closeAutoRollPopover();
                      }
                    }}
                    content={(
                      <Space direction="vertical" size={8} style={{ width: 1050 }}>
                        <Text type="secondary">
                          Probable rolling options for {row.date}. Minimum credit target: {formatCurrency(MIN_AUTO_ROLL_CREDIT)}
                        </Text>
                        <Table<RollingOptionCandidate>
                          size="small"
                          rowKey="key"
                          loading={autoRollCandidatesLoading && autoRollPopoverRowKey === row.key}
                          pagination={{ pageSize: 15 }}
                          scroll={{ x: "max-content" }}
                          dataSource={autoRollPopoverRowKey === row.key ? autoRollCandidates : []}
                          locale={{ emptyText: "No probable auto roll options found." }}
                          columns={[
                            {
                              title: "New Short Expiry",
                              dataIndex: "expiryDate",
                              key: "expiryDate",
                              width: 130,
                            },
                            {
                              title: "New DTE",
                              key: "newDte",
                              width: 100,
                              render: (_: unknown, candidate: RollingOptionCandidate) => {
                                const dte = dayjs(candidate.expiryDate).diff(dayjs(row.date), "day");
                                return Number.isFinite(dte) ? `${dte}d` : "-";
                              },
                            },
                            {
                              title: "Strike",
                              dataIndex: "strike",
                              key: "strike",
                              width: 100,
                              render: (value: number) => formatCurrency(value),
                            },
                            {
                              title: "New Premium",
                              dataIndex: "newShortCallPremium",
                              key: "newShortCallPremium",
                              width: 120,
                              render: (value: number | null) => formatCurrency(value),
                            },
                            {
                              title: "Net Credit/Debit",
                              dataIndex: "netCreditDebit",
                              key: "netCreditDebit",
                              render: (value: number | null) => (
                                <Text style={{ color: (value ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                                  {formatCurrency(value)}
                                </Text>
                              ),
                            },
                            {
                              title: "Action",
                              key: "action",
                              width: 110,
                              render: (_: unknown, candidate: RollingOptionCandidate) => (
                                <Button
                                  size="small"
                                  type="primary"
                                  disabled={(candidate.netCreditDebit ?? Number.NEGATIVE_INFINITY) < MIN_AUTO_ROLL_CREDIT}
                                  onClick={() => void applyAutoRollCandidate(candidate)}
                                >
                                  Apply
                                </Button>
                              ),
                            },
                          ]}
                        />
                      </Space>
                    )}
                  >
                    <Button size="small" disabled={loading}>
                      Auto Roll 1W
                    </Button>
                  </Popover>
                </Space>
              ),
            },
            ]}
          />
        </Card>
      )}

      <Modal
        title="Roll Short Call"
        open={rollModalOpen}
        onCancel={() => setRollModalOpen(false)}
        onOk={() => void confirmManualRoll()}
        okText="Confirm Roll"
        confirmLoading={loading}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <div>
            <Text strong>Current Row Date: </Text>
            <Text>{rollTargetRow?.date ?? "-"}</Text>
          </div>
          <div>
            <Text strong>New Short Expiry</Text>
            <DatePicker
              value={rollExpiryDate ? dayjs(rollExpiryDate) : null}
              onChange={(v) => {
                const nextValue = v ? v.format("YYYY-MM-DD") : "";
                setRollExpiryDate(nextValue);
                if (rollTargetRow && nextValue && rollStrike > 0) {
                  void previewManualRoll(rollTargetRow, nextValue, rollStrike);
                }
              }}
              style={{ width: "100%", marginTop: 8 }}
            />
          </div>
          <div>
            <Text strong>New Strike</Text>
            <InputNumber<number>
              value={rollStrike}
              onChange={(v) => {
                const nextStrike = v ?? 0;
                setRollStrike(nextStrike);
                if (rollTargetRow && rollExpiryDate && nextStrike > 0) {
                  void previewManualRoll(rollTargetRow, rollExpiryDate, nextStrike);
                }
              }}
              style={{ width: "100%", marginTop: 8 }}
              step={5}
            />
            <Space size={8} wrap style={{ marginTop: 8 }}>
              <Button size="small" onClick={() => rollTargetRow && applyDynamicRollStrike(rollTargetRow, 0)}>
                ATM
              </Button>
              <Button size="small" onClick={() => rollTargetRow && applyDynamicRollStrike(rollTargetRow, 1)}>
                +1%
              </Button>
              <Button size="small" onClick={() => rollTargetRow && applyDynamicRollStrike(rollTargetRow, 5)}>
                +5%
              </Button>
              <Button size="small" onClick={() => rollTargetRow && applyDynamicRollStrike(rollTargetRow, 10)}>
                +10%
              </Button>
            </Space>
          </div>

          <Card size="small" title="Roll Preview" loading={rollPreviewLoading}>
            <Row gutter={[8, 8]}>
              <Col span={24}>
                <Text strong>Current Short Call Premium: </Text>
                <Text>{formatCurrency(rollPreview?.currentShortCallPremium ?? null)}</Text>
              </Col>
              <Col span={24}>
                <Text strong>New Short Call Premium: </Text>
                <Text>{formatCurrency(rollPreview?.newShortCallPremium ?? null)}</Text>
              </Col>
              <Col span={24}>
                <Text strong>Net Roll (Credit/Debit): </Text>
                <Text
                  style={{
                    color: (rollPreview?.netCreditDebit ?? 0) >= 0 ? "#3f8600" : "#cf1322",
                  }}
                >
                  {formatCurrency(rollPreview?.netCreditDebit ?? null)}
                </Text>
              </Col>
            </Row>
          </Card>
        </Space>
      </Modal>

      <Modal
        title={callLegModalData ? `${callLegModalData.legType} Details` : "Call Leg Details"}
        open={callLegModalOpen}
        footer={null}
        onCancel={() => {
          setCallLegModalOpen(false);
          setCallLegModalData(null);
          setRollingOptions([]);
          setRollingOptionsLoading(false);
        }}
      >
        {callLegModalData ? (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <div>
              <Text strong>Trade Date: </Text>
              <Text>{callLegModalData.tradeDate}</Text>
            </div>
            <div>
              <Text strong>Leg Type: </Text>
              <Text>{callLegModalData.legType}</Text>
            </div>
            <div>
              <Text strong>Premium: </Text>
              <Text>{formatCurrency(callLegModalData.premium)}</Text>
            </div>
            <div>
              <Text strong>Expiry Date: </Text>
              <Text>{callLegModalData.expiryDate}</Text>
            </div>
            <div>
              <Text strong>Strike: </Text>
              <Text>{formatCurrency(callLegModalData.strike)}</Text>
            </div>
            <div>
              <Text strong>Status: </Text>
              <Text>{callLegModalData.status}</Text>
            </div>

            <Card size="small" title="Rolling Options" loading={rollingOptionsLoading}>
              {rollingOptions.length === 0 ? (
                <Text type="secondary">No rolling options available for this row.</Text>
              ) : (
                <Table<RollingOptionCandidate>
                  size="small"
                  rowKey="key"
                  pagination={false}
                  dataSource={rollingOptions}
                  columns={[
                    {
                      title: "New Short Expiry",
                      dataIndex: "expiryDate",
                      key: "expiryDate",
                      width: 130,
                    },
                    {
                      title: "Strike",
                      dataIndex: "strike",
                      key: "strike",
                      width: 100,
                      render: (value: number) => formatCurrency(value),
                    },
                    {
                      title: "New Premium",
                      dataIndex: "newShortCallPremium",
                      key: "newShortCallPremium",
                      width: 120,
                      render: (value: number | null) => formatCurrency(value),
                    },
                    {
                      title: "Net Credit/Debit",
                      dataIndex: "netCreditDebit",
                      key: "netCreditDebit",
                      render: (value: number | null) => (
                        <Text style={{ color: (value ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                          {formatCurrency(value)}
                        </Text>
                      ),
                    },
                  ]}
                />
              )}
            </Card>
          </Space>
        ) : null}
      </Modal>

      <Modal
        title="Call Calendar Spread User Guide"
        open={guideModalOpen}
        onCancel={() => setGuideModalOpen(false)}
        footer={null}
        width={820}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Text>This simulator models a call calendar spread with manual and automatic rolling.</Text>
          <div>
            <Text strong>Main Inputs</Text>
            <ul>
              <li><Text>Start Date: first simulation date, aligned to a trading date.</Text></li>
              <li><Text>Short Expiry: optional 15-75 DTE call expiry.</Text></li>
              <li><Text>Long Expiry: optional 150-400 DTE call expiry.</Text></li>
              <li><Text>Short and Long Call Strike: blank uses automatic ATM selection.</Text></li>
            </ul>
          </div>
          <div>
            <Text strong>Rolling and Outputs</Text>
            <ul>
              <li><Text>Roll: choose a new short expiry and strike with a credit/debit preview.</Text></li>
              <li><Text>Auto Roll 1W: review candidate expiries, strikes, premiums, and credits.</Text></li>
              <li><Text>Auto Roll Weekly: automatically rolls after premium decay or near expiry.</Text></li>
              <li><Text>Summary, chart, records, theta, batch results, and Google Sheets publishing are available below the controls.</Text></li>
            </ul>
          </div>
          <div>
            <Text strong>Warnings</Text>
            <ul>
              <li><Text>Invalid dates, unavailable call data, invalid strikes, rate limits, and missing roll candidates are reported in the UI.</Text></li>
              <li><Text>Simulations stop at expiry, the 10% strategy-return target, or the 50-row processing limit.</Text></li>
            </ul>
          </div>
        </Space>
      </Modal>

    </Space>
  );
};

export default CallCalendarSpreadRoll;
