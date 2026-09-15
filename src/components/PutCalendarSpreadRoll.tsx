import React, { useEffect, useMemo, useRef, useState } from "react";
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
  Tag,
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
  appendPutCalendarSimulationResult,
  findExistingPutCalendarSimulation,
  isSimulationResultsApiConfigured,
} from "../api/simulationResults";
import tradingDatesJson from "../assets/trading_dates_2026.json";
import spyClosingData from "../assets/spy-closing.json";
import guideStep1Image from "../../docs/images/put-calendar-guide/step-1-open-put-calendar-tab.png";
import guideStep2Image from "../../docs/images/put-calendar-guide/step-2-set-spy-ticker.png";
import guideStep3Image from "../../docs/images/put-calendar-guide/step-3-run-simulation.png";
import guideStep4Image from "../../docs/images/put-calendar-guide/step-4-review-summary.png";
import guideStep5Image from "../../docs/images/put-calendar-guide/step-5-chart-and-records.png";

const { Text } = Typography;

type RowStatus = "active" | "rolled" | "expired";

interface PutCalendarSpreadRollProps {
  enableSecondShortPut?: boolean;
  title?: string;
}

export interface PutCalendarSimulationRouteParams {
  tab: string | null;
  autoRun: boolean;
  ticker: string | null;
  startDate: string | null;
  firstExpiryDate: string | null;
  sellExpiryDate: string | null;
  longExpiryDate: string | null;
  firstStrike: number | null;
  sellStrike: number | null;
  longStrike: number | null;
  useFivePercentLowerStrike: boolean;
  autoRollWeekly: boolean;
}

const parsePositiveNumber = (value: string | null): number | null => {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseBooleanParam = (value: string | null): boolean =>
  value === "true" || value === "1";

export const parsePutCalendarSimulationRouteParams = (
  search: string
): PutCalendarSimulationRouteParams => {
  const params = new URLSearchParams(search);
  return {
    tab: params.get("tab"),
    autoRun: parseBooleanParam(params.get("run")),
    ticker: params.get("ticker"),
    startDate: params.get("start"),
    firstExpiryDate: params.get("firstExpiry") ?? params.get("shortExpiry"),
    sellExpiryDate: params.get("sellExpiry"),
    longExpiryDate: params.get("longExpiry"),
    firstStrike: parsePositiveNumber(params.get("firstStrike") ?? params.get("shortStrike")),
    sellStrike: parsePositiveNumber(params.get("sellStrike")),
    longStrike: parsePositiveNumber(params.get("longStrike")),
    useFivePercentLowerStrike: parseBooleanParam(params.get("fivePercentStrike")),
    autoRollWeekly: parseBooleanParam(params.get("autoRoll")),
  };
};

interface PutCalendarRow {
  key: string;
  date: string;
  closingPrice: number | null;
  stockReturn: number | null;
  stockReturnPct: number | null;
  strike: number;
  secondShortStrike: number | null;
  longStrike: number;
  shortExpiryDate: string;
  secondShortExpiryDate: string | null;
  longExpiryDate: string;
  shortPutPrice: number | null;
  secondShortPutPrice: number | null;
  longPutPrice: number | null;
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
  currentShortPutPremium: number | null;
  newShortPutPremium: number | null;
  netCreditDebit: number | null;
}

interface PutLegModalData {
  legType: "Short Put" | "Long Put";
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
  newShortPutPremium: number | null;
  netCreditDebit: number | null;
}

interface AutoSavedOptionCheckpoint {
  date: string;
  shortPutPrice: number | null;
  longPutPrice: number | null;
  savedAt: string;
}

interface PutCalendarSimulationSummary {
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

interface PutCalendarBatchResult {
  key: string;
  startDate: string;
  endDate: string | null;
  stockReturn: number | null;
  stockReturnPct: number | null;
  optionStrategyReturn: number | null;
  optionStrategyReturnPct: number | null;
  error: string | null;
}

type MasterStockData = Record<string, CachedStockPrice>;
type OptionCacheEntry = {
  data: OptionOpenClose;
  fetchedAt: string;
};
type OptionCacheData = Record<string, OptionCacheEntry>;

const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MASTER_STOCK_DATA_KEY = "masterStockData";
const OPTION_CACHE_STORAGE_KEY = "putCalendarOptionCache";
const OPTION_CACHE_MAX_ENTRIES = 2000;
const OPTION_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PUT_CALENDAR_AUTO_SAVED_CHECKPOINT_KEY = "putCalendarSpreadRollAutoSavedCheckpoint";
const SHORT_EXPIRY_MIN_DTE_DAYS = 15;
const SHORT_EXPIRY_MAX_DTE_DAYS = 75;
const LONG_EXPIRY_MIN_DTE_DAYS = 15;
const LONG_EXPIRY_MAX_DTE_DAYS = 45;
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

const fullTradingDatesFromSpy = (spyClosingData as Array<{ date?: string }>)
  .map((entry) => (typeof entry.date === "string" ? entry.date : null))
  .filter((value): value is string => Boolean(value) && dayjs(value).isValid());

const fallbackTradingDates = (tradingDatesJson as string[])
  .filter((value) => dayjs(value).isValid());

const tradingDates = Array.from(
  new Set([...fallbackTradingDates, ...fullTradingDatesFromSpy])
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

const getFridayWeeksAfter = (date: string, weeks: number): string => {
  const targetDate = dayjs(date).add(weeks, "week");
  const daysUntilFriday = (5 - targetDate.day() + 7) % 7;
  return targetDate.add(daysUntilFriday, "day").format("YYYY-MM-DD");
};

const getFirstTradingDateOnOrAfter = (date: string): string | null =>
  tradingDates.find((d) => !dayjs(d).isBefore(dayjs(date), "day")) ?? null;

const getFirstFridayTradingDateOnOrAfter = (date: string): string | null =>
  tradingDates.find(
    (candidateDate) =>
      dayjs(candidateDate).day() === 5 &&
      !dayjs(candidateDate).isBefore(dayjs(date), "day")
  ) ?? null;

const getNextFridayTradingDate = (date: string): string | null =>
  tradingDates.find(
    (candidateDate) =>
      dayjs(candidateDate).day() === 5 &&
      dayjs(candidateDate).isAfter(dayjs(date), "day")
  ) ?? null;

const getNextTradingDate = (date: string): string | null => {
  const index = tradingDates.findIndex((value) => dayjs(value).isSame(dayjs(date), "day"));
  if (index < 0 || index + 1 >= tradingDates.length) {
    return null;
  }
  return tradingDates[index + 1];
};

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

    const normalized: OptionCacheData = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }

      const entry = value as Partial<OptionCacheEntry>;
      if (!entry.data || typeof entry.data !== "object") {
        continue;
      }

      normalized[key] = {
        data: entry.data as OptionOpenClose,
        fetchedAt: typeof entry.fetchedAt === "string" ? entry.fetchedAt : new Date().toISOString(),
      };
    }

    return normalized;
  } catch {
    return {};
  }
};

const saveOptionCache = (data: OptionCacheData) => {
  const entries = Object.entries(data).sort(
    ([, a], [, b]) => new Date(b.fetchedAt).valueOf() - new Date(a.fetchedAt).valueOf()
  );

  const trimmed = Object.fromEntries(entries.slice(0, OPTION_CACHE_MAX_ENTRIES));
  localStorage.setItem(OPTION_CACHE_STORAGE_KEY, JSON.stringify(trimmed));
};

const loadAutoSavedCheckpoint = (): AutoSavedOptionCheckpoint | null => {
  try {
    const raw = localStorage.getItem(PUT_CALENDAR_AUTO_SAVED_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as AutoSavedOptionCheckpoint;
  } catch {
    return null;
  }
};

const saveAutoSavedCheckpoint = (checkpoint: AutoSavedOptionCheckpoint) => {
  localStorage.setItem(PUT_CALENDAR_AUTO_SAVED_CHECKPOINT_KEY, JSON.stringify(checkpoint));
};

const PutCalendarSpreadRoll: React.FC<PutCalendarSpreadRollProps> = ({
  enableSecondShortPut = false,
  title = "Put Calendar Spread (Roll)",
}) => {
  const routeParams = useMemo(
    () => parsePutCalendarSimulationRouteParams(window.location.search),
    []
  );
  const routeTab = routeParams.tab ?? "three-tier";
  const routeTargetsThisSimulator = enableSecondShortPut
    ? routeTab === "three-tier"
    : routeTab === "put-calendar-spread-roll";
  const initialStartDate = routeTargetsThisSimulator && routeParams.startDate
    ? routeParams.startDate
    : "2026-01-02";
  const initialFirstTradingDate = getFirstTradingDateOnOrAfter(initialStartDate) ?? initialStartDate;
  const initialNextTradingDate = getNextTradingDate(initialFirstTradingDate) ?? "";

  const [startDate, setStartDate] = useState(initialStartDate);
  const [preferredShortExpiryDate, setPreferredShortExpiryDate] = useState(
    routeTargetsThisSimulator && routeParams.firstExpiryDate
      ? routeParams.firstExpiryDate
      : enableSecondShortPut
        ? initialFirstTradingDate
        : getFridayWeeksAfter(initialFirstTradingDate, 4)
  );
  const [preferredSecondShortExpiryDate, setPreferredSecondShortExpiryDate] = useState(
    routeTargetsThisSimulator && routeParams.sellExpiryDate
      ? routeParams.sellExpiryDate
      : enableSecondShortPut
        ? initialNextTradingDate
        : "2026-02-13"
  );
  const [preferredLongExpiryDate, setPreferredLongExpiryDate] = useState(() => {
    if (routeTargetsThisSimulator && routeParams.longExpiryDate) {
      return routeParams.longExpiryDate;
    }
    if (!enableSecondShortPut) return getFridayWeeksAfter(initialFirstTradingDate, 8);
    return initialNextTradingDate ? (getNextTradingDate(initialNextTradingDate) ?? "") : "";
  });
  const [firstPutStrike, setFirstPutStrike] = useState<number | null>(
    routeTargetsThisSimulator ? routeParams.firstStrike : null
  );
  const [sellPutStrike, setSellPutStrike] = useState<number | null>(
    routeTargetsThisSimulator ? routeParams.sellStrike : null
  );
  const [longPutStrike, setLongPutStrike] = useState<number | null>(
    routeTargetsThisSimulator ? routeParams.longStrike : null
  );
  const [stockTicker, setStockTicker] = useState(
    routeTargetsThisSimulator && routeParams.ticker
      ? routeParams.ticker.trim().toUpperCase()
      : "SPY"
  );
  const [useFivePercentLowerStrike, setUseFivePercentLowerStrike] = useState(
    routeTargetsThisSimulator && routeParams.useFivePercentLowerStrike
  );
  const [autoRollWeeklyEnabled, setAutoRollWeeklyEnabled] = useState(
    routeTargetsThisSimulator && routeParams.autoRollWeekly
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PutCalendarRow[]>([]);

  const [manualRolls, setManualRolls] = useState<ManualRollInstruction[]>([]);
  const [rollModalOpen, setRollModalOpen] = useState(false);
  const [rollTargetRow, setRollTargetRow] = useState<PutCalendarRow | null>(null);
  const [rollExpiryDate, setRollExpiryDate] = useState("");
  const [rollStrike, setRollStrike] = useState<number>(0);
  const [rollPreview, setRollPreview] = useState<RollPreview | null>(null);
  const [rollPreviewLoading, setRollPreviewLoading] = useState(false);
  const [putLegModalOpen, setPutLegModalOpen] = useState(false);
  const [putLegModalData, setPutLegModalData] = useState<PutLegModalData | null>(null);
  const [rollingOptionsLoading, setRollingOptionsLoading] = useState(false);
  const [rollingOptions, setRollingOptions] = useState<RollingOptionCandidate[]>([]);
  const [autoRollPopoverRowKey, setAutoRollPopoverRowKey] = useState<string | null>(null);
  const [autoRollTargetRow, setAutoRollTargetRow] = useState<PutCalendarRow | null>(null);
  const [autoRollCandidatesLoading, setAutoRollCandidatesLoading] = useState(false);
  const [autoRollCandidates, setAutoRollCandidates] = useState<RollingOptionCandidate[]>([]);
  const [processedSimulationCount, setProcessedSimulationCount] = useState(0);
  const [autoSavedCheckpoint, setAutoSavedCheckpoint] = useState<AutoSavedOptionCheckpoint | null>(
    loadAutoSavedCheckpoint()
  );
  const [showSummary, setShowSummary] = useState(true);
  const [showChart, setShowChart] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [hiddenChartSeries, setHiddenChartSeries] = useState<Record<string, boolean>>({
    shortPutPrice: true,
    secondShortPutPrice: true,
    longPutPrice: true,
  });
  const [guideModalOpen, setGuideModalOpen] = useState(false);

  const [summary, setSummary] = useState<PutCalendarSimulationSummary | null>(null);

  const [batchStartDatesText, setBatchStartDatesText] = useState("");
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [batchResults, setBatchResults] = useState<PutCalendarBatchResult[]>([]);

  const stockCacheRef = useRef<MasterStockData>(loadMasterStockData());
  const stockInFlightRef = useRef<Map<string, Promise<CachedStockPrice>>>(new Map());
  const optionCacheRef = useRef<OptionCacheData>(loadOptionCache());
  const optionInFlightRef = useRef<Map<string, Promise<OptionOpenClose>>>(new Map());
  const routeAutoRunStartedRef = useRef(false);
  const routeSourceUrlRef = useRef(window.location.href);

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
    if (cached && cached.closePrice !== null && Number.isFinite(cached.closePrice)) return cached;

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

  const fetchStockPriceInDateWindow = async (
    symbol: string,
    targetDate: string,
    windowDays: number
  ): Promise<number | null> => {
    const targetDay = dayjs(targetDate);
    const candidates = tradingDates.filter((date) => {
      const diffDays = Math.abs(dayjs(date).diff(targetDay, "day"));
      return diffDays <= windowDays;
    });

    const prices = (
      await Promise.all(
        candidates.map(async (date) => {
          const stockData = await fetchStockWithCache(symbol, date);
          return stockData.closePrice;
        })
      )
    ).filter((value): value is number => value !== null && Number.isFinite(value));

    if (prices.length === 0) {
      return null;
    }

    const sorted = [...prices].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
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

    if (cached && cacheAgeMs < OPTION_CACHE_TTL_MS) {
      return cached.data;
    }

    const pending = optionInFlightRef.current.get(cacheKey);
    if (pending) return pending;

    const request = (async () => {
      const data = await fetchWithRateLimitRetry(() =>
        fetchOptionOpenClose(symbol, expiryDate, strikePrice, optionType, date)
      );

      optionCacheRef.current[cacheKey] = {
        data,
        fetchedAt: new Date().toISOString(),
      };
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
    row: PutCalendarRow,
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
        row.shortPutPrice,
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
    currentShortPutPremium: number | null,
    nextShortExpiryDate: string,
    nextStrike: number
  ): Promise<RollPreview> => {
    const symbol = stockTicker.trim().toUpperCase();
    const expiryFormatted = formatExpiryDate(nextShortExpiryDate);
    const newShortPutData = await fetchOptionWithCache(
      symbol,
      expiryFormatted,
      nextStrike,
      "P",
      currentDate
    );

    const newShortPutPremium = newShortPutData.closePrice;
    const netCreditDebit =
      currentShortPutPremium !== null && newShortPutPremium !== null
        ? newShortPutPremium - currentShortPutPremium
        : null;

    return { currentShortPutPremium, newShortPutPremium, netCreditDebit };
  };

  const openRollModal = (row: PutCalendarRow) => {
    const defaultRollExpiryDate = getNextTradingDate(row.shortExpiryDate) ?? row.shortExpiryDate;
    setRollTargetRow(row);
    setRollExpiryDate(defaultRollExpiryDate);
    setRollStrike(row.strike);
    setRollPreview(null);
    setRollModalOpen(true);
    void previewManualRoll(row, defaultRollExpiryDate, row.strike);
  };

  const applyDynamicRollStrike = (row: PutCalendarRow, percentOffset: number) => {
    if (typeof row.closingPrice !== "number" || !Number.isFinite(row.closingPrice)) {
      message.warning("No closing price available to calculate strike");
      return;
    }

    const computedStrike = roundToNearestFive(row.closingPrice * (1 - percentOffset / 100));
    setRollStrike(computedStrike);

    if (rollExpiryDate) {
      void previewManualRoll(row, rollExpiryDate, computedStrike);
    }
  };

  const openPutLegModal = (row: PutCalendarRow, legType: "Short Put" | "Long Put") => {
    const premium = legType === "Short Put" ? row.shortPutPrice : row.longPutPrice;
    const expiryDate = legType === "Short Put" ? row.shortExpiryDate : row.longExpiryDate;
    const strike = legType === "Short Put" ? row.strike : row.longStrike;

    setPutLegModalData({
      legType,
      premium,
      expiryDate,
      strike,
      tradeDate: row.date,
      status: row.status,
    });
    void loadRollingOptions(row);
    setPutLegModalOpen(true);
  };

  const loadRollingOptions = async (row: PutCalendarRow) => {
    setRollingOptions([]);

    if (row.shortPutPrice === null) {
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
              row.shortPutPrice,
              candidateExpiry,
              candidateStrike
            );

            return {
              key: `${candidateExpiry}-${candidateStrike}`,
              expiryDate: candidateExpiry,
              strike: candidateStrike,
              newShortPutPremium: preview.newShortPutPremium,
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

  const closeAutoRollPopover = () => {
    setAutoRollPopoverRowKey(null);
    setAutoRollCandidates([]);
    setAutoRollCandidatesLoading(false);
  };

  const handleAutoRollOneWeek = async (row: PutCalendarRow) => {
    setAutoRollTargetRow(row);
    setAutoRollCandidates([]);
    setAutoRollPopoverRowKey(row.key);

    if (row.shortPutPrice === null || row.closingPrice === null) {
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
              row.shortPutPrice,
              candidateExpiry,
              candidateStrike
            );

            return {
              key: `${candidateExpiry}-${candidateStrike}`,
              expiryDate: candidateExpiry,
              strike: candidateStrike,
              newShortPutPremium: preview.newShortPutPremium,
              netCreditDebit: preview.netCreditDebit,
            };
          })
        )
      );

      const validCandidates = previews
        .filter(
          (item) =>
            item.newShortPutPremium !== null &&
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
      message.error("No next Friday trading date available for this auto roll");
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
    overrideSecondShortExpiryDate?: string,
    overrideLongExpiryDate?: string
  ): Promise<{ summary: PutCalendarSimulationSummary | null; error: string | null }> => {
    const effectiveStartDate = overrideStartDate ?? startDate;
    const effectiveShortExpiryDate = overrideShortExpiryDate ?? preferredShortExpiryDate;
    const effectiveSecondShortExpiryDate = overrideSecondShortExpiryDate ?? preferredSecondShortExpiryDate;
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
      if (
        enableSecondShortPut &&
        (!effectiveSecondShortExpiryDate || !dayjs(effectiveSecondShortExpiryDate).isValid())
      ) {
        throw new Error("Second short expiry date is invalid");
      }
      if (effectiveLongExpiryDate && !dayjs(effectiveLongExpiryDate).isValid()) {
        throw new Error("Long expiry date is invalid");
      }

      const firstDate = getFirstFridayTradingDateOnOrAfter(effectiveStartDate);
      if (!firstDate) throw new Error("No Friday trading date found on or after the start date");

      const openingClosePrice =
        (await fetchStockPriceInDateWindow(symbol, firstDate, 5)) ??
        (await fetchStockWithCache(symbol, firstDate)).closePrice;
      if (openingClosePrice === null) {
        throw new Error(`No stock close price found for ${symbol} around ${firstDate} in the +/- 5 day window`);
      }
      const openingStrike = roundToNearestFive(
        openingClosePrice * (useFivePercentLowerStrike ? 0.95 : 1)
      );
      const openingFirstPutStrike = firstPutStrike !== null
        ? roundToNearestFive(firstPutStrike)
        : openingStrike;
      const openingSellPutStrike = enableSecondShortPut && sellPutStrike !== null
        ? roundToNearestFive(sellPutStrike)
        : openingStrike;
      const openingLongPutStrike = longPutStrike !== null
        ? roundToNearestFive(longPutStrike)
        : openingStrike;

      if (
        openingFirstPutStrike <= 0 ||
        openingSellPutStrike <= 0 ||
        openingLongPutStrike <= 0
      ) {
        throw new Error("All put strikes must be greater than zero");
      }

      const hasPutData = async (expiryDate: string, strike: number): Promise<boolean> => {
        const expiryFormatted = formatExpiryDate(expiryDate);
        const peData = await fetchOptionWithCache(symbol, expiryFormatted, strike, "P", firstDate);

        return peData.statusCode === 200 && peData.closePrice !== null;
      };

      const resolveExpiryDate = async (
        baseDate: string,
        preferredExpiryDate: string,
        minDteDays: number,
        maxDteDays: number,
        label: "short" | "long",
        strike: number
      ): Promise<string> => {
        if (preferredExpiryDate) {
          const preferredDteDays = dayjs(preferredExpiryDate).diff(dayjs(baseDate), "day");
          if (preferredDteDays < minDteDays || preferredDteDays > maxDteDays) {
            throw new Error(
              `${label === "short" ? "Short" : "Long"} expiry must be ${minDteDays}-${maxDteDays} DTE from ${baseDate}`
            );
          }

          const maxWindowDate = dayjs(baseDate).add(maxDteDays, "day");
          let candidateDate = dayjs(preferredExpiryDate);

          while (
            candidateDate.isAfter(dayjs(baseDate), "day") ||
            candidateDate.isSame(dayjs(baseDate), "day")
          ) {
            const formattedCandidateDate = candidateDate.format("YYYY-MM-DD");
            const preferredHasData = await hasPutData(formattedCandidateDate, strike);
            if (preferredHasData) {
              return formattedCandidateDate;
            }

            const nextWeekDate = candidateDate.add(7, "day");
            if (nextWeekDate.isAfter(maxWindowDate, "day") || nextWeekDate.isSame(maxWindowDate, "day")) {
              break;
            }
            candidateDate = nextWeekDate;
          }

          throw new Error(
            `${label === "short" ? "Short" : "Long"} expiry has no put option data for ${symbol} on ${preferredExpiryDate} at strike ${strike}`
          );
        }

        const candidates = getExpiryDateCandidatesInDteWindow(baseDate, minDteDays, maxDteDays);
        for (const candidate of candidates) {
          if (await hasPutData(candidate, strike)) {
            return candidate;
          }
        }

        throw new Error(
          `No ${label} expiry date found in the ${minDteDays}-${maxDteDays} DTE window with put option data`
        );
      };

      const initialShortExpiryDate = await resolveExpiryDate(
        firstDate,
        effectiveShortExpiryDate,
        SHORT_EXPIRY_MIN_DTE_DAYS,
        SHORT_EXPIRY_MAX_DTE_DAYS,
        "short",
        openingFirstPutStrike
      );
      const longExpiryDate = await resolveExpiryDate(
        initialShortExpiryDate,
        effectiveLongExpiryDate,
        LONG_EXPIRY_MIN_DTE_DAYS,
        LONG_EXPIRY_MAX_DTE_DAYS,
        "long",
        openingLongPutStrike
      );
      const secondShortExpiryDate = enableSecondShortPut
        ? effectiveSecondShortExpiryDate
        : null;

      if (secondShortExpiryDate) {
        if (!(await hasPutData(secondShortExpiryDate, openingSellPutStrike))) {
          throw new Error(
            `Sell put expiry has no option data for ${symbol} on ${firstDate} at strike ${openingSellPutStrike}`
          );
        }
        if (!dayjs(secondShortExpiryDate).isAfter(dayjs(initialShortExpiryDate), "day")) {
          throw new Error("Second short expiry date must be after the first short expiry date");
        }
        if (!dayjs(secondShortExpiryDate).isBefore(dayjs(longExpiryDate), "day")) {
          throw new Error("Second short expiry date must be before the long expiry date");
        }
      }

      if (isSimulationResultsApiConfigured()) {
        const existingSimulation = await findExistingPutCalendarSimulation({
          strategy: enableSecondShortPut ? "3 Tier" : "Put Calendar Spread Roll",
          ticker: symbol,
          requestedStartDate: effectiveStartDate,
          shortExpiryDate: initialShortExpiryDate,
          sellExpiryDate: secondShortExpiryDate,
          longExpiryDate,
          shortStrike: openingFirstPutStrike,
          sellStrike: enableSecondShortPut ? openingSellPutStrike : null,
          longStrike: openingLongPutStrike,
        });

        if (existingSimulation) {
          const recordedAt = existingSimulation.recordedAt
            ? ` (recorded ${existingSimulation.recordedAt.slice(0, 10)})`
            : "";
          throw new Error(
            `This simulation configuration already exists in Google Sheets${recordedAt}. ` +
            "Change the start date, expiry, strike, or ticker before running it again."
          );
        }
      }

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
      });

      if (dates.length === 0) {
        throw new Error(`No trading dates found between ${firstDate} and ${simulationEndDate}`);
      }

      const allRows: PutCalendarRow[] = [];
      let activeShortExpiryDate = initialShortExpiryDate;
      let activeStrike = openingFirstPutStrike;
      let rollNumber = 0;
      let entryNetCredit: number | null = null;
      let initialOptionInvestment: number | null = null;
      let simulationStartShortPutPrice: number | null = null;
      let realisedPnl = 0;
      let pendingRollCreditDebit: number | null = null;
      let autoRollStoppedReason: string | null = null;

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
          (daysUntilActiveShortExpiry >= 0 &&
            daysUntilActiveShortExpiry < DAILY_PROCESSING_DTE_THRESHOLD_DAYS);
        if (!shouldProcessDate) {
          continue;
        }

        const stockResult = await fetchStockWithCache(symbol, date);
        const closePrice = stockResult.closePrice;
        if (closePrice === null) {
          continue;
        }

        const shortExpFmt = formatExpiryDate(activeShortExpiryDate);
        const secondShortExpFmt = secondShortExpiryDate
          ? formatExpiryDate(secondShortExpiryDate)
          : null;
        const longExpFmt = formatExpiryDate(longExpiryDate);

        const [shortPutData, secondShortPutData, longPutData] = await Promise.all([
          fetchOptionWithCache(symbol, shortExpFmt, activeStrike, "P", date),
          secondShortExpFmt
            ? fetchOptionWithCache(symbol, secondShortExpFmt, openingSellPutStrike, "P", date)
            : Promise.resolve(null),
          fetchOptionWithCache(symbol, longExpFmt, openingLongPutStrike, "P", date),
        ]);

        const shortPutPrice = shortPutData.closePrice;
        const secondShortPutPrice = secondShortPutData?.closePrice ?? null;
        const longPutPrice = longPutData.closePrice;
        const currentNetCloseCost = enableSecondShortPut
          ? shortPutPrice !== null && secondShortPutPrice !== null && longPutPrice !== null
            ? secondShortPutPrice - shortPutPrice - longPutPrice
            : null
          : shortPutPrice !== null && longPutPrice !== null
            ? shortPutPrice - longPutPrice
            : null;

        const checkpoint: AutoSavedOptionCheckpoint = {
          date,
          shortPutPrice,
          longPutPrice,
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
        if (simulationStartShortPutPrice === null) {
          simulationStartShortPutPrice = shortPutPrice;
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
          secondShortStrike: enableSecondShortPut ? openingSellPutStrike : null,
          longStrike: openingLongPutStrike,
          shortExpiryDate: activeShortExpiryDate,
          secondShortExpiryDate,
          longExpiryDate,
          shortPutPrice,
          secondShortPutPrice,
          longPutPrice,
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

        const processedCount = allRows.length;
        setProcessedSimulationCount(processedCount);

        if (
          cumulativeReturnPct !== null &&
          cumulativeReturnPct >= OPTION_STRATEGY_PROFIT_TARGET_PCT
        ) {
          realisedPnl = cumulativePnl;
          autoRollStoppedReason =
            `Simulation stopped on ${date}: option strategy reached ` +
            `${cumulativeReturnPct.toFixed(2)}% return.`;
          break;
        }

        if (isExpiry) {
          autoRollStoppedReason =
            `Simulation stopped at short expiry ${activeShortExpiryDate} on ${date}.`;
          break;
        }

        if (reachesSimulationLimit) {
          autoRollStoppedReason =
            `Simulation stopped after ${MAX_SIMULATION_TRADING_DAYS} processed simulation days.`;
          break;
        }

        if (autoRollWeeklyEnabled) {
          const meetsAutoRollDecayCondition =
            simulationStartShortPutPrice !== null &&
            shortPutPrice !== null &&
            shortPutPrice <= simulationStartShortPutPrice * 0.5;

          const daysUntilExpiry = dayjs(activeShortExpiryDate).diff(dayjs(date), "day");
          const isNearExpiry = daysUntilExpiry >= 0 && daysUntilExpiry < 10;

          if (!meetsAutoRollDecayCondition && !isNearExpiry) {
            continue;
          }

          const nextTradingDate = getNextFridayTradingDate(date);
          if (!nextTradingDate) {
            autoRollStoppedReason = `Auto roll stopped after ${date}: no next Friday trading date available.`;
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
                  shortPutPrice,
                  candidate,
                  candidateStrike
                );
                if (
                  candidatePreview.newShortPutPremium !== null &&
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

      const simulationSummary = {
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

      const shouldAutoPublish = publishRouteResult || Boolean(autoRollStoppedReason);

      if (shouldAutoPublish) {
        if (!isSimulationResultsApiConfigured()) {
          message.warning("Simulation completed, but the Google Sheets results API is not configured.");
        } else {
          try {
            await appendPutCalendarSimulationResult({
              recordedAt: new Date().toISOString(),
              strategy: enableSecondShortPut ? "3 Tier" : "Put Calendar Spread Roll",
              ticker: symbol,
              requestedStartDate: effectiveStartDate,
              actualStartDate: firstDate,
              endDate: actualEndDate,
              shortExpiryDate: initialShortExpiryDate,
              sellExpiryDate: secondShortExpiryDate,
              longExpiryDate,
              shortStrike: openingFirstPutStrike,
              sellStrike: enableSecondShortPut ? openingSellPutStrike : null,
              longStrike: openingLongPutStrike,
              fivePercentStrike: useFivePercentLowerStrike,
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
              inputParams: Object.fromEntries(
                new URL(routeSourceUrlRef.current).searchParams.entries()
              ),
              gridData: {
                rows: allRows.map((row) => ({
                  date: row.date,
                  closingPrice: row.closingPrice,
                  strike: row.strike,
                  secondShortStrike: row.secondShortStrike,
                  longStrike: row.longStrike,
                  shortExpiryDate: row.shortExpiryDate,
                  secondShortExpiryDate: row.secondShortExpiryDate,
                  longExpiryDate: row.longExpiryDate,
                  dte: dayjs(row.shortExpiryDate).diff(dayjs(row.date), "day"),
                  shortPutPrice: row.shortPutPrice,
                  secondShortPutPrice: row.secondShortPutPrice,
                  longPutPrice: row.longPutPrice,
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
            const publishMessage = publishError instanceof Error
              ? publishError.message
              : "Unknown results API error";
            message.warning(`Simulation completed, but the result was not sent: ${publishMessage}`);
          }
        }
      }

      return { summary: simulationSummary, error: null };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to run put calendar spread simulation";
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

  const parseBatchStartDates = (raw: string): string[] => {
    const candidates = raw
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && dayjs(value).isValid())
      .map((value) => dayjs(value).format("YYYY-MM-DD"));
    return Array.from(new Set(candidates)).sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());
  };

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
      const date = dates[i];
      try {
        // fresh manual rolls + auto-calculated expiries per date, run one at a time
        const result = await runSimulation([], true, date, "", "", "");
        setBatchResults((previous) => [
          ...previous,
          {
            key: date,
            startDate: date,
            endDate: result.summary?.endDate ?? null,
            stockReturn: result.summary?.stockReturn ?? null,
            stockReturnPct: result.summary?.stockReturnPct ?? null,
            optionStrategyReturn: result.summary?.optionStrategyReturn ?? null,
            optionStrategyReturnPct: result.summary?.optionStrategyReturnPct ?? null,
            error: result.error,
          },
        ]);
      } catch (err) {
        setBatchResults((previous) => [
          ...previous,
          {
            key: date,
            startDate: date,
            endDate: null,
            stockReturn: null,
            stockReturnPct: null,
            optionStrategyReturn: null,
            optionStrategyReturnPct: null,
            error: err instanceof Error ? err.message : "Unknown batch run error",
          },
        ]);
      } finally {
        setBatchProgress({ current: i + 1, total: dates.length });
      }
    }

    setBatchRunning(false);
    message.success(`Batch run complete: ${dates.length} simulation(s) processed`);
  };

  useEffect(() => {
    if (
      !routeTargetsThisSimulator ||
      !routeParams.autoRun ||
      routeAutoRunStartedRef.current
    ) {
      return;
    }

    routeAutoRunStartedRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("run");
    window.history.replaceState({}, "", url);
    void runSimulation([], true);
  }, []);

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

    const nextTradingDate = getNextFridayTradingDate(rollTargetRow.date);
    if (!nextTradingDate) {
      message.error("No next Friday trading date available for this roll");
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

  const statusTag = (status: RowStatus) => {
    if (status === "rolled") return <Tag color="orange">Rolled</Tag>;
    if (status === "expired") return <Tag color="red">Expired</Tag>;
    return <Tag color="green">Active</Tag>;
  };

  const optionPriceChartData = useMemo(
    () =>
      rows.map((row) => ({
        date: row.date,
        shortPutPrice: row.shortPutPrice,
        secondShortPutPrice: row.secondShortPutPrice,
        longPutPrice: row.longPutPrice,
        stockReturn: row.stockReturn,
        stockReturnPct: row.stockReturnPct,
        cumulativePnl: row.cumulativePnl,
        cumulativeReturnPct: row.cumulativeReturnPct,
      })),
    [rows]
  );

  const toggleChartSeries = (dataKey: unknown) => {
    if (typeof dataKey !== "string") return;
    setHiddenChartSeries((previous) => ({
      ...previous,
      [dataKey]: !previous[dataKey],
    }));
  };

  const shouldShowGrid = showGrid || rows.length > 0;

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card title={title}>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12} lg={6}>
            <Text>Start Date</Text>
            <DatePicker
              value={dayjs(startDate)}
              onChange={(v) => {
                const nextStartDate = v ? v.format("YYYY-MM-DD") : "";
                setStartDate(nextStartDate);
                if (nextStartDate) {
                  if (enableSecondShortPut) {
                    const firstTradingDate = getFirstTradingDateOnOrAfter(nextStartDate) ?? nextStartDate;
                    const nextTradingDate = getNextTradingDate(firstTradingDate) ?? "";
                    setPreferredShortExpiryDate(firstTradingDate);
                    setPreferredSecondShortExpiryDate(nextTradingDate);
                    setPreferredLongExpiryDate(
                      nextTradingDate ? (getNextTradingDate(nextTradingDate) ?? "") : ""
                    );
                  } else {
                    setPreferredShortExpiryDate(getFridayWeeksAfter(nextStartDate, 4));
                    setPreferredLongExpiryDate(getFridayWeeksAfter(nextStartDate, 8));
                  }
                }
              }}
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>{enableSecondShortPut ? "First Buy Put Expiry Date" : "Short Expiry Date (optional)"}</Text>
            <DatePicker
              value={preferredShortExpiryDate ? dayjs(preferredShortExpiryDate) : null}
              onChange={(v) => setPreferredShortExpiryDate(v ? v.format("YYYY-MM-DD") : "")}
              disabledDate={(current) =>
                (!enableSecondShortPut &&
                  current.day() !== 5 &&
                  current.date() !== current.daysInMonth()) ||
                (enableSecondShortPut && preferredSecondShortExpiryDate
                  ? !current.isBefore(dayjs(preferredSecondShortExpiryDate), "day")
                  : false)
              }
              style={{ width: "100%", marginTop: 8 }}
              placeholder="Auto 15-75 DTE"
            />
            {enableSecondShortPut && (
              <InputNumber<number>
                value={firstPutStrike}
                onChange={setFirstPutStrike}
                min={5}
                step={5}
                placeholder="First buy strike (Auto ATM)"
                style={{ width: "100%", marginTop: 8 }}
              />
            )}
          </Col>
          {enableSecondShortPut && (
            <Col xs={24} md={12} lg={6}>
              <Text>Sell Put Expiry Date</Text>
              <DatePicker
                value={preferredSecondShortExpiryDate ? dayjs(preferredSecondShortExpiryDate) : null}
                onChange={(v) => setPreferredSecondShortExpiryDate(v ? v.format("YYYY-MM-DD") : "")}
                disabledDate={(current) =>
                  (preferredShortExpiryDate
                    ? !current.isAfter(dayjs(preferredShortExpiryDate), "day")
                    : false) ||
                  (preferredLongExpiryDate
                    ? !current.isBefore(dayjs(preferredLongExpiryDate), "day")
                    : false)
                }
                style={{ width: "100%", marginTop: 8 }}
                placeholder="Select second short expiry"
              />
              <InputNumber<number>
                value={sellPutStrike}
                onChange={setSellPutStrike}
                min={5}
                step={5}
                placeholder="Sell strike (Auto ATM)"
                style={{ width: "100%", marginTop: 8 }}
              />
            </Col>
          )}
          <Col xs={24} md={12} lg={6}>
            <Text>{enableSecondShortPut ? "Long Buy Put Expiry Date" : "Long Expiry Date (optional)"}</Text>
            <DatePicker
              value={preferredLongExpiryDate ? dayjs(preferredLongExpiryDate) : null}
              onChange={(v) => setPreferredLongExpiryDate(v ? v.format("YYYY-MM-DD") : "")}
              disabledDate={(current) =>
                (!enableSecondShortPut &&
                  current.day() !== 5 &&
                  current.date() !== current.daysInMonth()) ||
                (enableSecondShortPut && preferredSecondShortExpiryDate
                  ? !current.isAfter(dayjs(preferredSecondShortExpiryDate), "day")
                  : false)
              }
              style={{ width: "100%", marginTop: 8 }}
              placeholder="Auto 15-45 days after short expiry"
            />
            {enableSecondShortPut && (
              <InputNumber<number>
                value={longPutStrike}
                onChange={setLongPutStrike}
                min={5}
                step={5}
                placeholder="Long buy strike (Auto ATM)"
                style={{ width: "100%", marginTop: 8 }}
              />
            )}
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
        </Row>

        <Space style={{ marginTop: 16 }} wrap>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={loading}>
            Run Put Calendar Spread
          </Button>
          <Button icon={<CloudUploadOutlined />} onClick={handlePublish} disabled={loading}>
            Publish
          </Button>
          <Button
            icon={<GoogleOutlined />}
            href={GOOGLE_SHEETS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Google Sheets
          </Button>
          <Button
            type={useFivePercentLowerStrike ? "primary" : "default"}
            onClick={() => setUseFivePercentLowerStrike((previous) => !previous)}
            disabled={loading}
          >
            -5% Strike: {useFivePercentLowerStrike ? "ON" : "OFF"}
          </Button>
          <Button
            type={autoRollWeeklyEnabled ? "primary" : "default"}
            onClick={() => setAutoRollWeeklyEnabled((previous) => !previous)}
            disabled={loading}
          >
            Auto Roll Weekly: {autoRollWeeklyEnabled ? "ON" : "OFF"}
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
        <Space direction="vertical" size={8} style={{ width: "100%", marginTop: 16 }}>
          <Text strong>Batch Run (Sequential)</Text>
          <Input.TextArea
            value={batchStartDatesText}
            onChange={(e) => setBatchStartDatesText(e.target.value)}
            placeholder={"One start date per line, e.g.\n2025-01-03\n2025-01-10"}
            autoSize={{ minRows: 3, maxRows: 6 }}
            disabled={batchRunning}
          />
          <Space wrap>
            <Button
              icon={<PlayCircleOutlined />}
              onClick={() => void runBatch()}
              loading={batchRunning}
              disabled={loading}
            >
              Run Sequentially
            </Button>
            {batchProgress && (
              <Text type="secondary">
                Batch progress: {batchProgress.current}/{batchProgress.total}
              </Text>
            )}
          </Space>
        </Space>
        <Text type="secondary" style={{ display: "block", marginTop: 8 }}>
          Processed simulations: {processedSimulationCount}
        </Text>
        <Text type="secondary" style={{ display: "block", marginTop: 4 }}>
          Auto-saved checkpoint: {autoSavedCheckpoint?.date ?? "-"} | Short Put {formatCurrency(autoSavedCheckpoint?.shortPutPrice ?? null)} | Long Put {formatCurrency(autoSavedCheckpoint?.longPutPrice ?? null)}
        </Text>
      </Card>

      {error && <Alert type="error" showIcon message="Put Calendar Spread Error" description={error} />}

      {batchResults.length > 0 && (
        <Card title="Batch Results">
          <Table<PutCalendarBatchResult>
            rowKey="key"
            dataSource={batchResults}
            pagination={{ pageSize: 20 }}
            scroll={{ x: 760 }}
            columns={[
              { title: "Start Date", dataIndex: "startDate", key: "startDate", width: 110 },
              {
                title: "End Date",
                dataIndex: "endDate",
                key: "endDate",
                width: 110,
                render: (v: string | null) => v ?? "-",
              },
              {
                title: "Stock Return ($ | %)",
                key: "stockReturn",
                width: 170,
                render: (_: unknown, row: PutCalendarBatchResult) => (
                  <Space size={2}>
                    <Text>{formatCurrency(row.stockReturn)}</Text>
                    <Text>|</Text>
                    <Text>{formatPercent(row.stockReturnPct)}</Text>
                  </Space>
                ),
              },
              {
                title: "Option Strategy Return ($ | %)",
                key: "optionStrategyReturn",
                width: 200,
                render: (_: unknown, row: PutCalendarBatchResult) => (
                  <Space size={2}>
                    <Text style={{ color: (row.optionStrategyReturn ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                      {formatCurrency(row.optionStrategyReturn)}
                    </Text>
                    <Text>|</Text>
                    <Text style={{ color: (row.optionStrategyReturnPct ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                      {formatPercent(row.optionStrategyReturnPct)}
                    </Text>
                  </Space>
                ),
              },
              {
                title: "Status",
                key: "status",
                render: (_: unknown, row: PutCalendarBatchResult) =>
                  row.error ? <Tag color="red">{row.error}</Tag> : <Tag color="green">Success</Tag>,
              },
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
            <Text type="secondary">Run the simulation to view option prices and returns by date.</Text>
          ) : (
            <div style={{ width: "100%", height: 380 }}>
              <ResponsiveContainer>
                <LineChart data={optionPriceChartData} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis yAxisId="dollars" tickFormatter={(value: number) => `$${value}`} />
                  <YAxis
                    yAxisId="percent"
                    orientation="right"
                    tickFormatter={(value: number) => `${value}%`}
                  />
                  <Tooltip />
                  <Legend
                    onClick={(entry) => toggleChartSeries(entry.dataKey)}
                    formatter={(value, entry) => (
                      <span
                        style={{
                          color: hiddenChartSeries[String(entry.dataKey)] ? "#8c8c8c" : undefined,
                          textDecoration: hiddenChartSeries[String(entry.dataKey)] ? "line-through" : undefined,
                          cursor: "pointer",
                        }}
                      >
                        {value}
                      </span>
                    )}
                  />
                  <Line
                    yAxisId="dollars"
                    type="monotone"
                    dataKey="shortPutPrice"
                    name={enableSecondShortPut ? "Buy Put 1 Price" : "Short Put Price"}
                    hide={Boolean(hiddenChartSeries.shortPutPrice)}
                    stroke="#cf1322"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                  {enableSecondShortPut && (
                    <Line
                      yAxisId="dollars"
                      type="monotone"
                      dataKey="secondShortPutPrice"
                      name="Sell Put Price"
                      hide={Boolean(hiddenChartSeries.secondShortPutPrice)}
                      stroke="#c41d7f"
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                    />
                  )}
                  <Line
                    yAxisId="dollars"
                    type="monotone"
                    dataKey="longPutPrice"
                    name="Long Put Price"
                    hide={Boolean(hiddenChartSeries.longPutPrice)}
                    stroke="#0958d9"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                  <Line
                    yAxisId="dollars"
                    type="monotone"
                    dataKey="stockReturn"
                    name="Stock Return ($)"
                    hide={Boolean(hiddenChartSeries.stockReturn)}
                    stroke="#3f8600"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                  <Line
                    yAxisId="percent"
                    type="monotone"
                    dataKey="stockReturnPct"
                    name="Stock Return (%)"
                    hide={Boolean(hiddenChartSeries.stockReturnPct)}
                    stroke="#08979c"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    dot={false}
                    connectNulls={false}
                  />
                  <Line
                    yAxisId="dollars"
                    type="monotone"
                    dataKey="cumulativePnl"
                    name="Cumulative P&L ($)"
                    hide={Boolean(hiddenChartSeries.cumulativePnl)}
                    stroke="#d46b08"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                  <Line
                    yAxisId="percent"
                    type="monotone"
                    dataKey="cumulativeReturnPct"
                    name="Cumulative Return (%)"
                    hide={Boolean(hiddenChartSeries.cumulativeReturnPct)}
                    stroke="#531dab"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    dot={false}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      )}

      {shouldShowGrid && (
        <Card title="Records">
          <style>
            {`
              .put-calendar-compact-grid .ant-table-thead > tr > th,
              .put-calendar-compact-grid .ant-table-tbody > tr > td {
                padding: 6px 8px;
              }

              .put-calendar-compact-grid .ant-table-thead > tr > th {
                line-height: 1.2;
              }

              .put-calendar-compact-grid .ant-table-tbody > tr.put-calendar-profit-row > td {
                background: #f6ffed;
              }

              .put-calendar-compact-grid .ant-table-tbody > tr.put-calendar-profit-row:hover > td {
                background: #d9f7be;
              }
            `}
          </style>
          <Table<PutCalendarRow>
            className="put-calendar-compact-grid"
            rowKey="key"
            loading={loading}
            dataSource={rows}
            rowClassName={(row) =>
              (row.cumulativeReturnPct ?? Number.NEGATIVE_INFINITY) > 10
                ? "put-calendar-profit-row"
                : ""
            }
            pagination={{ pageSize: 50, showSizeChanger: true }}
            scroll={{ x: 1180 }}
            columns={[
            // { title: "Roll #", dataIndex: "rollNumber", key: "rollNumber", width: 70 },
            // { title: "Date", dataIndex: "date", key: "date", width: 110 },
            // {
            //   title: "Closing Price",
            //   dataIndex: "closingPrice",
            //   key: "closingPrice",
            //   width: 130,
            //   render: (v: number | null) => formatCurrency(v),
            // },
            // {
            //   title: "Strike",
            //   dataIndex: "strike",
            //   key: "strike",
            //   width: 100,
            //   render: (v: number) => formatCurrency(v),
            // },
            {
              title: (
                <span>
                  Closing Price |
                  <br />
                  {enableSecondShortPut
                    ? "Simulation Date | Strikes (Buy 1 / Sell / Long) | DTE"
                    : "Simulation Date | Strike | DTE"}
                </span>
              ),
              key: "closeExpiryStrike",
              width: enableSecondShortPut ? 440 : 320,
              render: (_: number | null, row: PutCalendarRow) => {
                const dte = dayjs(row.shortExpiryDate).diff(dayjs(row.date), "day");
                const dteLabel = Number.isFinite(dte) ? `${dte}d` : "-";

                return (
                  <Space size={2}>
                    <Text>{formatCurrency(row.closingPrice)}</Text>
                    <Text>|</Text>
                    <Text>{row.date || "-"}</Text>
                    <Text>|</Text>
                    <Text>
                      {enableSecondShortPut
                        ? `${formatCurrency(row.strike)} / ${formatCurrency(row.secondShortStrike)} / ${formatCurrency(row.longStrike)}`
                        : formatCurrency(row.strike)}
                    </Text>
                    <Text>|</Text>
                    <Text>{dteLabel}</Text>
                  </Space>
                );
              },
            },
            // { title: "Long Expiry", dataIndex: "longExpiryDate", key: "longExpiryDate", width: 120 },
            {
              title: (
                <span>
                  Put Price
                  <br />
                  {enableSecondShortPut ? "(Buy 1 | Sell | Buy Long)" : "(Short | Long)"}
                </span>
              ),
              key: "putPriceCombined",
              width: 190,
              render: (_: number | null, row: PutCalendarRow) => {
                const shortPut =
                  row.shortPutPrice !== null ? (
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0 }}
                      onClick={() => openPutLegModal(row, "Short Put")}
                    >
                      {formatCurrency(row.shortPutPrice)}
                    </Button>
                  ) : (
                    "-"
                  );

                const longPut =
                  row.longPutPrice !== null ? (
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0 }}
                      onClick={() => openPutLegModal(row, "Long Put")}
                    >
                      {formatCurrency(row.longPutPrice)}
                    </Button>
                  ) : (
                    "-"
                  );

                const secondShortPut =
                  row.secondShortPutPrice !== null
                    ? formatCurrency(row.secondShortPutPrice)
                    : "-";

                return (
                  <Space size={2}>
                    {shortPut}
                    <Text>|</Text>
                    {enableSecondShortPut ? <Text>{secondShortPut}</Text> : null}
                    {enableSecondShortPut ? <Text>|</Text> : null}
                    {longPut}
                  </Space>
                );
              },
            },
            {
              title: (
                <span>
                  Stock Return
                  <br />
                  ($ | %)
                </span>
              ),
              key: "stockReturn",
              width: 170,
              render: (_: unknown, row: PutCalendarRow) => (
                <Space size={2}>
                  <Text style={{ color: (row.stockReturn ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                    {formatCurrency(row.stockReturn)}
                  </Text>
                  <Text>|</Text>
                  <Text style={{ color: (row.stockReturnPct ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                    {formatPercent(row.stockReturnPct)}
                  </Text>
                </Space>
              ),
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
              title: (
                <span>
                  Cumulative P&amp;L
                  <br />
                  ($ | %)
                </span>
              ),
              key: "cumulativeWithRoll",
              width: 250,
              render: (_: number | null, row: PutCalendarRow) => {
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

                const cumulativeReturnNode = (
                  <Text style={{ color: (cumulativeReturnPct ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                    {formatPercent(cumulativeReturnPct)}
                  </Text>
                );

                const hasRoll = roll !== null;
                const rollNode = hasRoll ? (
                  <Text style={{ color: (roll ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}>
                    {formatCurrency(roll)}
                  </Text>
                ) : null;

                return (
                  <Space size={2} wrap>
                    {cumulativeNode}
                    <Text>|</Text>
                    {cumulativeReturnNode}
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
              title: (
                <span>
                  Row
                  <br />
                  Action
                </span>
              ),
              key: "action",
              width: 160,
              render: (_: unknown, row: PutCalendarRow) => (
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
                              title: "Current DTE",
                              key: "currentDte",
                              width: 110,
                              render: () => {
                                const dte = dayjs(row.shortExpiryDate).diff(dayjs(row.date), "day");
                                return Number.isFinite(dte) ? `${dte}d` : "-";
                              },
                            },
                            {
                              title: "New Short Expiry",
                              dataIndex: "expiryDate",
                              key: "expiryDate",
                              width: 130,
                              sorter: (left, right) => left.expiryDate.localeCompare(right.expiryDate),
                            },
                            {
                              title: "New DTE",
                              key: "newDte",
                              width: 100,
                              sorter: (left, right) =>
                                dayjs(left.expiryDate).diff(dayjs(row.date), "day") -
                                dayjs(right.expiryDate).diff(dayjs(row.date), "day"),
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
                              sorter: (left, right) => left.strike - right.strike,
                              render: (value: number) => formatCurrency(value),
                            },
                            {
                              title: "New Premium",
                              dataIndex: "newShortPutPremium",
                              key: "newShortPutPremium",
                              width: 120,
                              sorter: (left, right) =>
                                (left.newShortPutPremium ?? Number.POSITIVE_INFINITY) -
                                (right.newShortPutPremium ?? Number.POSITIVE_INFINITY),
                              render: (value: number | null) => formatCurrency(value),
                            },
                            {
                              title: "Net Credit/Debit",
                              dataIndex: "netCreditDebit",
                              key: "netCreditDebit",
                              sorter: (left, right) =>
                                (left.netCreditDebit ?? Number.POSITIVE_INFINITY) -
                                (right.netCreditDebit ?? Number.POSITIVE_INFINITY),
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
            {
              title: (
                <span>
                  Theta/Day
                  <br />
                  {enableSecondShortPut ? "(Buy 1 | Sell | Buy Long)" : "(Short | Long)"}
                </span>
              ),
              key: "thetaPerDay",
              width: 220,
              render: (_: number | null, row: PutCalendarRow) => {
                const shortTheta = calculateThetaPerDay(
                  row.shortPutPrice,
                  row.closingPrice,
                  row.strike,
                  row.date,
                  row.shortExpiryDate,
                  "P"
                );

                const longTheta = calculateThetaPerDay(
                  row.longPutPrice,
                  row.closingPrice,
                  row.longStrike,
                  row.date,
                  row.longExpiryDate,
                  "P"
                );

                const secondShortTheta = row.secondShortExpiryDate
                  ? calculateThetaPerDay(
                      row.secondShortPutPrice,
                      row.closingPrice,
                      row.secondShortStrike ?? row.strike,
                      row.date,
                      row.secondShortExpiryDate,
                      "P"
                    )
                  : null;

                const netTheta = enableSecondShortPut
                  ? shortTheta !== null && secondShortTheta !== null && longTheta !== null
                    ? shortTheta - secondShortTheta + longTheta
                    : null
                  : shortTheta !== null && longTheta !== null
                    ? longTheta - shortTheta
                    : null;

                const getColor = (value: number | null) => {
                  if (value === null || !Number.isFinite(value)) {
                    return undefined;
                  }
                  return value >= 0 ? "#3f8600" : "#cf1322";
                };

                return (
                  <Space size={2} wrap>
                    <Text>{formatCurrency(shortTheta)}</Text>
                    <Text>|</Text>
                    {enableSecondShortPut ? <Text>{formatCurrency(secondShortTheta)}</Text> : null}
                    {enableSecondShortPut ? <Text>|</Text> : null}
                    <Text>{formatCurrency(longTheta)}</Text>
                    <Text>(</Text>
                    <Text style={{ color: getColor(netTheta) }}>
                      {formatCurrency(netTheta)}
                    </Text>
                    <Text>)</Text>
                  </Space>
                );
              },
            },
            ]}
          />
        </Card>
      )}

      <Modal
        title="Roll Short Put"
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
                -1%
              </Button>
              <Button size="small" onClick={() => rollTargetRow && applyDynamicRollStrike(rollTargetRow, 5)}>
                -5%
              </Button>
              <Button size="small" onClick={() => rollTargetRow && applyDynamicRollStrike(rollTargetRow, 10)}>
                -10%
              </Button>
            </Space>
          </div>

          <Card size="small" title="Roll Preview" loading={rollPreviewLoading}>
            <Row gutter={[8, 8]}>
              <Col span={24}>
                <Text strong>Current Short Put Premium: </Text>
                <Text>{formatCurrency(rollPreview?.currentShortPutPremium ?? null)}</Text>
              </Col>
              <Col span={24}>
                <Text strong>New Short Put Premium: </Text>
                <Text>{formatCurrency(rollPreview?.newShortPutPremium ?? null)}</Text>
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
        title={putLegModalData ? `${putLegModalData.legType} Details` : "Put Leg Details"}
        open={putLegModalOpen}
        footer={null}
        onCancel={() => {
          setPutLegModalOpen(false);
          setRollingOptions([]);
          setRollingOptionsLoading(false);
        }}
      >
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <div>
            <Text strong>Trade Date: </Text>
            <Text>{putLegModalData?.tradeDate ?? "-"}</Text>
          </div>
          <div>
            <Text strong>Expiry Date: </Text>
            <Text>{putLegModalData?.expiryDate ?? "-"}</Text>
          </div>
          <div>
            <Text strong>Strike: </Text>
            <Text>{formatCurrency(putLegModalData?.strike ?? null)}</Text>
          </div>
          <div>
            <Text strong>Premium: </Text>
            <Text>{formatCurrency(putLegModalData?.premium ?? null)}</Text>
          </div>
          <div>
            <Text strong>Status: </Text>
            {putLegModalData ? statusTag(putLegModalData.status) : <Text>-</Text>}
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
                    dataIndex: "newShortPutPremium",
                    key: "newShortPutPremium",
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
      </Modal>

      <Modal
        title="Put Calendar Spread User Guide"
        open={guideModalOpen}
        onCancel={() => setGuideModalOpen(false)}
        footer={null}
        width={900}
      >
        <div style={{ maxHeight: 560, overflowY: "auto", paddingRight: 8 }}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Text>
              This simulator models a put calendar spread with optional manual and auto rolling.
            </Text>

            <div>
              <Text strong>Main Inputs</Text>
              <ul style={{ marginTop: 8, marginBottom: 0 }}>
                <li><Text>Start Date: first simulation date (aligned to next trading date if needed).</Text></li>
                <li><Text>Short Expiry Date (optional): blank uses auto 15-75 DTE selection.</Text></li>
                <li><Text>Long Expiry Date (optional): blank uses auto 15-45 days after the short expiry.</Text></li>
                <li><Text>Stock ticker: underlying symbol (default SPY, placeholder SPY).</Text></li>
              </ul>
            </div>

            <div>
              <Text strong>Primary Actions</Text>
              <ul style={{ marginTop: 8, marginBottom: 0 }}>
                <li><Text>Run Put Calendar Spread: runs a fresh simulation and clears manual rolls.</Text></li>
                <li><Text>Auto Roll Weekly ON/OFF: enables rolling logic when decay or near-expiry conditions are met.</Text></li>
                <li><Text>Show/Hide Summary, Chart, Grid: toggles output sections.</Text></li>
              </ul>
            </div>

            <div>
              <Text strong>Grid Actions</Text>
              <ul style={{ marginTop: 8, marginBottom: 0 }}>
                <li><Text>Roll: opens a modal to set next short expiry and strike, with roll credit/debit preview.</Text></li>
                <li><Text>Auto Roll 1W: opens probable roll candidates; choose Apply to schedule and rerun.</Text></li>
                <li><Text>Click short/long put price links to view leg details and rolling option ideas.</Text></li>
              </ul>
            </div>

            <div>
              <Text strong>Key Outputs</Text>
              <ul style={{ marginTop: 8, marginBottom: 0 }}>
                <li><Text>Summary: stock return vs option strategy return (amount and percentage).</Text></li>
                <li><Text>Option Price Chart: short put and long put prices by date.</Text></li>
                <li><Text>Records: close price, expiry, strike, DTE, theta/day, and cumulative P&L.</Text></li>
                <li><Text>Status lines: processed simulation count and latest auto-saved checkpoint.</Text></li>
              </ul>
            </div>

            <div>
              <Text strong>Common Prompts and Warnings</Text>
              <ul style={{ marginTop: 8, marginBottom: 0 }}>
                <li><Text>Validation: invalid dates, missing ticker, invalid strike, missing next trading date.</Text></li>
                <li><Text>Rate limits: 429 warning retries with 65-second waits.</Text></li>
                <li><Text>Auto-roll stop warnings when no valid credit target or no next trading date exists.</Text></li>
              </ul>
            </div>

            <div>
              <Text strong>Step-by-step Screenshots</Text>
              <Space direction="vertical" size={10} style={{ width: "100%", marginTop: 8 }}>
                <div>
                  <Text strong>Step 1: Open Put Calendar Spread Roll tab</Text>
                  <img
                    src={guideStep1Image}
                    alt="Step 1 - Open Put Calendar Spread Roll tab"
                    style={{ width: "100%", marginTop: 6, borderRadius: 6, border: "1px solid #f0f0f0" }}
                  />
                </div>

                <div>
                  <Text strong>Step 2: Set ticker to SPY</Text>
                  <img
                    src={guideStep2Image}
                    alt="Step 2 - Set ticker to SPY"
                    style={{ width: "100%", marginTop: 6, borderRadius: 6, border: "1px solid #f0f0f0" }}
                  />
                </div>

                <div>
                  <Text strong>Step 3: Click Run Put Calendar Spread</Text>
                  <img
                    src={guideStep3Image}
                    alt="Step 3 - Run simulation"
                    style={{ width: "100%", marginTop: 6, borderRadius: 6, border: "1px solid #f0f0f0" }}
                  />
                </div>

                <div>
                  <Text strong>Step 4: Review Summary metrics</Text>
                  <img
                    src={guideStep4Image}
                    alt="Step 4 - Review summary"
                    style={{ width: "100%", marginTop: 6, borderRadius: 6, border: "1px solid #f0f0f0" }}
                  />
                </div>

                <div>
                  <Text strong>Step 5: Review Chart and Records grid</Text>
                  <img
                    src={guideStep5Image}
                    alt="Step 5 - Chart and records"
                    style={{ width: "100%", marginTop: 6, borderRadius: 6, border: "1px solid #f0f0f0" }}
                  />
                </div>
              </Space>
            </div>
          </Space>
        </div>
      </Modal>

    </Space>
  );
};

export default PutCalendarSpreadRoll;
