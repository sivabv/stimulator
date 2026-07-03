import React, { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Input,
  InputNumber,
  Modal,
  Row,
  Space,
  Table,
  Typography,
  message,
} from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
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
import { fetchOptionOpenClose, fetchStockOpenClose } from "../api/backtest";
import tradingDatesJson from "../assets/trading_dates_2026.json";

const { Text } = Typography;

type RowStatus = "active" | "rolled" | "expired";

interface CallCalendarRow {
  key: string;
  date: string;
  closingPrice: number | null;
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

interface AutoSavedOptionCheckpoint {
  date: string;
  shortCallPrice: number | null;
  longCallPrice: number | null;
  savedAt: string;
}

type MasterStockData = Record<string, CachedStockPrice>;

const RATE_LIMIT_WAIT_MS = 2_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MASTER_STOCK_DATA_KEY = "masterStockData";
const CALL_CALENDAR_AUTO_SAVED_CHECKPOINT_KEY = "callCalendarSpreadRollAutoSavedCheckpoint";
const SHORT_EXPIRY_MIN_DTE_DAYS = 15;
const SHORT_EXPIRY_MAX_DTE_DAYS = 75;
const LONG_EXPIRY_MIN_DTE_DAYS = 150;
const LONG_EXPIRY_MAX_DTE_DAYS = 400;
const MIN_AUTO_ROLL_CREDIT = 1.25;
const AUTO_ROLL_MAX_STRIKE_STEPS = 8;

const tradingDates = (tradingDatesJson as string[])
  .filter((value) => dayjs(value).isValid())
  .sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());

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

const areRowsEqual = (left: CallCalendarRow, right: CallCalendarRow): boolean => {
  return (
    left.key === right.key &&
    left.date === right.date &&
    left.closingPrice === right.closingPrice &&
    left.strike === right.strike &&
    left.shortExpiryDate === right.shortExpiryDate &&
    left.longExpiryDate === right.longExpiryDate &&
    left.shortCallPrice === right.shortCallPrice &&
    left.longCallPrice === right.longCallPrice &&
    left.entryNetCredit === right.entryNetCredit &&
    left.rollCreditDebit === right.rollCreditDebit &&
    left.closeNetCost === right.closeNetCost &&
    left.legPnl === right.legPnl &&
    left.cumulativePnl === right.cumulativePnl &&
    left.status === right.status &&
    left.rollNumber === right.rollNumber
  );
};

const mergeRows = (previousRows: CallCalendarRow[], nextRows: CallCalendarRow[]): CallCalendarRow[] => {
  const previousByKey = new Map(previousRows.map((row) => [row.key, row]));
  return nextRows.map((row) => {
    const previous = previousByKey.get(row.key);
    return previous && areRowsEqual(previous, row) ? previous : row;
  });
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
  const [startDate, setStartDate] = useState("2025-01-02");
  const [preferredShortExpiryDate, setPreferredShortExpiryDate] = useState("2025-06-30");
  const [preferredLongExpiryDate, setPreferredLongExpiryDate] = useState("2025-12-19");
  const [stockTicker, setStockTicker] = useState("SPY");
  const [autoRollWeeklyEnabled] = useState(false);
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
  const [autoSavedCheckpoint, setAutoSavedCheckpoint] = useState<AutoSavedOptionCheckpoint | null>(
    loadAutoSavedCheckpoint()
  );
  const [showSummary, setShowSummary] = useState(true);
  const [showChart, setShowChart] = useState(true);
  const [showGrid, setShowGrid] = useState(true);

  const [summary, setSummary] = useState<{
    startDate: string;
    endDate: string;
    stockStartPrice: number;
    stockEndPrice: number | null;
    optionInvestment: number | null;
    stockReturn: number | null;
    stockReturnPct: number | null;
    optionStrategyReturn: number;
    optionStrategyReturnPct: number | null;
  } | null>(null);

  const fetchWithRateLimitRetry = async <T extends { statusCode: number | null }>(
    work: () => Promise<T>
  ) => {
    let response = await work();
    let attempts = 0;
    while (response.statusCode === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      attempts += 1;
      message.warning(`Rate limit hit (429). Waiting 2 seconds before retry ${attempts}.`);
      await sleep(RATE_LIMIT_WAIT_MS);
      response = await work();
    }
    return response;
  };

  const fetchStockWithCache = async (symbol: string, date: string): Promise<CachedStockPrice> => {
    const masterData = loadMasterStockData();
    const cacheKey = getCacheKey(symbol, date);
    const cached = masterData[cacheKey];
    if (cached) return cached;

    const stockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(symbol, date));
    const result: CachedStockPrice = { symbol, date, closePrice: stockData.closePrice };
    masterData[cacheKey] = result;
    saveMasterStockData(masterData);
    return result;
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
    const newShortCallData = await fetchWithRateLimitRetry(() =>
      fetchOptionOpenClose(symbol, expiryFormatted, nextStrike, "C", currentDate)
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
    setCallLegModalOpen(true);
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

  const handleAutoRollOneWeek = async (row: CallCalendarRow) => {
    const nextTradingDate = getNextTradingDate(row.date);
    if (!nextTradingDate) {
      message.error("No next trading date available for this auto roll");
      return;
    }

    try {
      const targetFromDate = dayjs(row.shortExpiryDate).add(7, "day").format("YYYY-MM-DD");
      const candidateExpiries = tradingDates.filter((value) =>
        dayjs(value).isSame(dayjs(targetFromDate), "day") || dayjs(value).isAfter(dayjs(targetFromDate), "day")
      );

      let autoRollExpiryDate: string | null = null;
      let autoRollStrike: number | null = null;
      let preview: RollPreview | null = null;
      const strikeCandidates = buildStrikeCandidates(row.strike, AUTO_ROLL_MAX_STRIKE_STEPS);

      for (const candidate of candidateExpiries) {
        for (const candidateStrike of strikeCandidates) {
          const candidatePreview = await getRollPreview(
            row.date,
            row.shortCallPrice,
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
            preview = candidatePreview;
            break;
          }
        }
        if (autoRollExpiryDate && autoRollStrike !== null && preview) {
          break;
        }
      }

      if (!autoRollExpiryDate || autoRollStrike === null || !preview) {
        message.error(
          `No auto roll target found with minimum credit ${MIN_AUTO_ROLL_CREDIT.toFixed(2)} on/after +1 week`
        );
        return;
      }

      const updated = [
        ...manualRolls.filter((roll) => !dayjs(roll.fromDate).isSame(dayjs(nextTradingDate), "day")),
        {
          fromDate: nextTradingDate,
          shortExpiryDate: autoRollExpiryDate,
          strike: autoRollStrike,
          rollCreditDebit: preview.netCreditDebit,
        },
      ].sort((a, b) => dayjs(a.fromDate).valueOf() - dayjs(b.fromDate).valueOf());

      setManualRolls(updated);
      await runSimulation(updated);
      message.success(
        `Auto roll scheduled to ${autoRollExpiryDate} @ ${autoRollStrike} (credit ${formatCurrency(preview.netCreditDebit)})`
      );
    } catch {
      message.error("Failed to auto roll by 1 week using available option data");
    }
  };

  const runSimulation = async (activeManualRolls: ManualRollInstruction[]) => {
    setError(null);
    setSummary(null);
    setLoading(true);

    try {
      const symbol = stockTicker.trim().toUpperCase();
      if (!symbol) throw new Error("Stock ticker is required");
      if (!dayjs(startDate).isValid()) throw new Error("Start date is invalid");
      if (preferredShortExpiryDate && !dayjs(preferredShortExpiryDate).isValid()) {
        throw new Error("Short expiry date is invalid");
      }
      if (preferredLongExpiryDate && !dayjs(preferredLongExpiryDate).isValid()) {
        throw new Error("Long expiry date is invalid");
      }

      const firstDate = getFirstTradingDateOnOrAfter(startDate);
      if (!firstDate) throw new Error("No trading date found on or after the start date");

      const openingStockResult = await fetchStockWithCache(symbol, firstDate);
      const openingClosePrice = openingStockResult.closePrice;
      if (openingClosePrice === null) {
        throw new Error(`No stock close price found for ${symbol} on ${firstDate}`);
      }
      const openingStrike = roundToNearestFive(openingClosePrice);

      const hasCallData = async (expiryDate: string): Promise<boolean> => {
        const expiryFormatted = formatExpiryDate(expiryDate);
        const ceData = await fetchWithRateLimitRetry(() =>
          fetchOptionOpenClose(symbol, expiryFormatted, openingStrike, "C", firstDate)
        );
        return ceData.statusCode === 200 && ceData.closePrice !== null;
      };

      const resolveExpiryDate = async (
        preferredExpiryDate: string,
        minDteDays: number,
        maxDteDays: number,
        label: "short" | "long"
      ): Promise<string> => {
        if (preferredExpiryDate) {
          const preferredHasData = await hasCallData(preferredExpiryDate);
          if (!preferredHasData) {
            throw new Error(
              `${label === "short" ? "Short" : "Long"} expiry has no call option data for ${symbol} on ${firstDate} at strike ${openingStrike}`
            );
          }
          return preferredExpiryDate;
        }

        const candidates = getExpiryDateCandidatesInDteWindow(firstDate, minDteDays, maxDteDays);
        for (const candidate of candidates) {
          if (await hasCallData(candidate)) {
            return candidate;
          }
        }

        throw new Error(
          `No ${label} expiry date found in the ${minDteDays}-${maxDteDays} DTE window with call option data`
        );
      };

      const initialShortExpiryDate = await resolveExpiryDate(
        preferredShortExpiryDate,
        SHORT_EXPIRY_MIN_DTE_DAYS,
        SHORT_EXPIRY_MAX_DTE_DAYS,
        "short"
      );
      const longExpiryDate = await resolveExpiryDate(
        preferredLongExpiryDate,
        LONG_EXPIRY_MIN_DTE_DAYS,
        LONG_EXPIRY_MAX_DTE_DAYS,
        "long"
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
      });

      if (dates.length === 0) {
        throw new Error(`No trading dates found between ${firstDate} and ${simulationEndDate}`);
      }

      const allRows: CallCalendarRow[] = [];
      let activeShortExpiryDate = initialShortExpiryDate;
      let activeStrike = openingStrike;
      let rollNumber = 0;
      let entryNetCredit: number | null = null;
      let simulationStartShortCallPrice: number | null = null;
      let realisedPnl = 0;
      let autoRollStoppedReason: string | null = null;

      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const rollForToday = relevantRolls.find((roll) => dayjs(roll.fromDate).isSame(dayjs(date), "day"));
        const rolledToday = Boolean(rollForToday);
        const rollCreditDebit = rollForToday?.rollCreditDebit ?? null;

        if (rollForToday) {
          activeShortExpiryDate = rollForToday.shortExpiryDate;
          activeStrike = roundToNearestFive(rollForToday.strike);
          entryNetCredit = null;
          rollNumber += 1;
          realisedPnl += rollForToday.rollCreditDebit ?? 0;
        }

        const stockResult = await fetchStockWithCache(symbol, date);
        const closePrice = stockResult.closePrice;
        if (closePrice === null) {
          continue;
        }

        const shortExpFmt = formatExpiryDate(activeShortExpiryDate);
        const longExpFmt = formatExpiryDate(longExpiryDate);

        const [shortCallData, longCallData] = await Promise.all([
          fetchWithRateLimitRetry(() =>
            fetchOptionOpenClose(symbol, shortExpFmt, activeStrike, "C", date)
          ),
          fetchWithRateLimitRetry(() =>
            fetchOptionOpenClose(symbol, longExpFmt, activeStrike, "C", date)
          ),
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
        if (simulationStartShortCallPrice === null) {
          simulationStartShortCallPrice = shortCallPrice;
        }

        const isExpiry = dayjs(date).isSame(dayjs(activeShortExpiryDate), "day");
        const isLastDate = i === dates.length - 1;

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

        allRows.push({
          key: `${rollNumber}-${date}`,
          date,
          closingPrice: closePrice,
          strike: activeStrike,
          shortExpiryDate: activeShortExpiryDate,
          longExpiryDate,
          shortCallPrice,
          longCallPrice,
          entryNetCredit,
          rollCreditDebit,
          closeNetCost: status !== "active" ? closeNetCost : null,
          legPnl: status !== "active" ? legPnl : null,
          cumulativePnl: realisedPnl + unrealisedPnl,
          status,
          rollNumber,
        });

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

          const nextTradingDate = getNextTradingDate(date);
          if (!nextTradingDate) {
            autoRollStoppedReason = `Auto roll stopped after ${date}: no next trading date available.`;
            break;
          }

          const hasExistingRollForNextTradingDate = relevantRolls.some((roll) =>
            dayjs(roll.fromDate).isSame(dayjs(nextTradingDate), "day")
          );

          if (!hasExistingRollForNextTradingDate) {
            const targetFromDate = dayjs(activeShortExpiryDate).add(7, "day").format("YYYY-MM-DD");
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

      setRows((previousRows) => mergeRows(previousRows, allRows));

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

      setSummary({
        startDate: firstDate,
        endDate: actualEndDate,
        stockStartPrice: openingClosePrice,
        stockEndPrice: endingClosePrice,
        optionInvestment: initialOptionEntry !== null ? Math.abs(initialOptionEntry) : null,
        stockReturn,
        stockReturnPct,
        optionStrategyReturn: realisedPnl,
        optionStrategyReturnPct,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run call calendar spread simulation");
    } finally {
      setLoading(false);
    }
  };

  const handleRun = async () => {
    setManualRolls([]);
    await runSimulation([]);
  };

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
      })),
    [rows]
  );

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
        </Row>

        <Space style={{ marginTop: 16 }}>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={loading}>
            Run Call Calendar Spread
          </Button>
          <Button
            type={autoRollWeeklyEnabled ? "primary" : "default"}
            disabled
          >
            Auto Roll Weekly: {autoRollWeeklyEnabled ? "ON" : "OFF"}
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
          Auto-saved checkpoint: {autoSavedCheckpoint?.date ?? "-"} | Short Call {formatCurrency(autoSavedCheckpoint?.shortCallPrice ?? null)} | Long Call {formatCurrency(autoSavedCheckpoint?.longCallPrice ?? null)}
        </Text>
      </Card>

      {error && <Alert type="error" showIcon message="Call Calendar Spread Error" description={error} />}

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
        <Card title="Option Price Chart">
          {optionPriceChartData.length === 0 ? (
            <Text type="secondary">Run the simulation to view option prices by date.</Text>
          ) : (
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer>
                <LineChart data={optionPriceChartData} margin={{ top: 16, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="shortCallPrice"
                    name="Short Call Price"
                    stroke="#cf1322"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="longCallPrice"
                    name="Long Call Price"
                    stroke="#0958d9"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      )}

      {showGrid && (
        <Card title="Records">
          <Table<CallCalendarRow>
            rowKey="key"
            loading={loading}
            dataSource={rows}
            pagination={{ pageSize: 50, showSizeChanger: true }}
            scroll={{ x: "max-content" }}
            columns={[
            { title: "Roll #", dataIndex: "rollNumber", key: "rollNumber", width: 70 },
            // { title: "Date", dataIndex: "date", key: "date", width: 110 },
            {
              title: "Closing Price",
              dataIndex: "closingPrice",
              key: "closingPrice",
              width: 130,
              render: (v: number | null) => formatCurrency(v),
            },
            {
              title: "Strike",
              dataIndex: "strike",
              key: "strike",
              width: 100,
              render: (v: number) => formatCurrency(v),
            },
            { title: "Short Expiry", dataIndex: "shortExpiryDate", key: "shortExpiryDate", width: 120 },
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
              title: "Cumulative P&L (Roll Credit/Debit)",
              key: "cumulativeWithRoll",
              width: 260,
              render: (_: number | null, row: CallCalendarRow) => {
                const cumulative = row.cumulativePnl;
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
                  <Button size="small" onClick={() => void handleAutoRollOneWeek(row)} disabled={loading}>
                    Auto Roll 1W
                  </Button>
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
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
};

export default CallCalendarSpreadRoll;
