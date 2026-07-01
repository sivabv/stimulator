import React, { useRef, useState } from "react";
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
  Tag,
  Typography,
  message,
} from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  fetchOptionOpenClose,
  fetchStockOpenClose,
  type OptionOpenClose,
} from "../api/backtest";
import tradingDatesJson from "../assets/trading_dates_2026.json";

const { Text } = Typography;

type RowStatus = "active" | "rolled" | "expired";

interface PutCalendarRow {
  key: string;
  date: string;
  closingPrice: number | null;
  strike: number;
  shortExpiryDate: string;
  longExpiryDate: string;
  shortPutPrice: number | null;
  longPutPrice: number | null;
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

interface PauseCheckpointData {
  processedCount: number;
  date: string;
  rollNumber: number;
  closingPrice: number | null;
  cumulativePnl: number | null;
}

type MasterStockData = Record<string, CachedStockPrice>;

const RATE_LIMIT_WAIT_MS = 2_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MASTER_STOCK_DATA_KEY = "masterStockData";
const SHORT_EXPIRY_MIN_DTE_DAYS = 15;
const SHORT_EXPIRY_MAX_DTE_DAYS = 75;
const LONG_EXPIRY_MIN_DTE_DAYS = 150;
const LONG_EXPIRY_MAX_DTE_DAYS = 400;
const MIN_AUTO_ROLL_CREDIT = 1.25;
const AUTO_ROLL_MAX_STRIKE_STEPS = 8;
const AUTO_PAUSE_EVERY_SIMULATIONS = 5;

const tradingDates = (tradingDatesJson as string[])
  .filter((value) => dayjs(value).isValid())
  .sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const roundToNearestFive = (value: number): number => Math.round(value / 5) * 5;
const formatExpiryDate = (dateStr: string): string => dayjs(dateStr).format("YYMMDD");
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

const areRowsEqual = (left: PutCalendarRow, right: PutCalendarRow): boolean => {
  return (
    left.key === right.key &&
    left.date === right.date &&
    left.closingPrice === right.closingPrice &&
    left.strike === right.strike &&
    left.shortExpiryDate === right.shortExpiryDate &&
    left.longExpiryDate === right.longExpiryDate &&
    left.shortPutPrice === right.shortPutPrice &&
    left.longPutPrice === right.longPutPrice &&
    left.entryNetCredit === right.entryNetCredit &&
    left.rollCreditDebit === right.rollCreditDebit &&
    left.closeNetCost === right.closeNetCost &&
    left.legPnl === right.legPnl &&
    left.cumulativePnl === right.cumulativePnl &&
    left.status === right.status &&
    left.rollNumber === right.rollNumber
  );
};

const mergeRows = (previousRows: PutCalendarRow[], nextRows: PutCalendarRow[]): PutCalendarRow[] => {
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

const PutCalendarSpreadRoll: React.FC = () => {
  const [startDate, setStartDate] = useState("2025-01-02");
  const [preferredShortExpiryDate, setPreferredShortExpiryDate] = useState("2025-01-31");
  const [preferredLongExpiryDate, setPreferredLongExpiryDate] = useState("2025-12-19");
  const [stockTicker, setStockTicker] = useState("SPY");
  const [autoRollWeeklyEnabled, setAutoRollWeeklyEnabled] = useState(false);
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
  const [isPaused, setIsPaused] = useState(false);
  const [processedSimulationCount, setProcessedSimulationCount] = useState(0);
  const [pausePromptOpen, setPausePromptOpen] = useState(false);
  const [pauseCheckpointData, setPauseCheckpointData] = useState<PauseCheckpointData | null>(null);

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

  const stockCacheRef = useRef<MasterStockData>(loadMasterStockData());
  const stockInFlightRef = useRef<Map<string, Promise<CachedStockPrice>>>(new Map());
  const optionCacheRef = useRef<Record<string, OptionOpenClose>>({});
  const optionInFlightRef = useRef<Map<string, Promise<OptionOpenClose>>>(new Map());
  const pauseDecisionResolverRef = useRef<((shouldContinue: boolean) => void) | null>(null);
  const manualPauseRequestedRef = useRef(false);

  const setPauseState = (value: boolean) => {
    setIsPaused(value);
  };

  const openPausePrompt = (checkpointData: PauseCheckpointData): Promise<boolean> => {
    setPauseCheckpointData(checkpointData);
    setPausePromptOpen(true);
    setPauseState(true);

    return new Promise<boolean>((resolve) => {
      pauseDecisionResolverRef.current = resolve;
    });
  };

  const resolvePauseDecision = (shouldContinue: boolean) => {
    setPausePromptOpen(false);
    setPauseState(false);
    manualPauseRequestedRef.current = false;
    if (pauseDecisionResolverRef.current) {
      pauseDecisionResolverRef.current(shouldContinue);
      pauseDecisionResolverRef.current = null;
    }
  };

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
    if (cached) return cached;

    const pending = optionInFlightRef.current.get(cacheKey);
    if (pending) return pending;

    const request = (async () => {
      const data = await fetchWithRateLimitRetry(() =>
        fetchOptionOpenClose(symbol, expiryDate, strikePrice, optionType, date)
      );
      optionCacheRef.current[cacheKey] = data;
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

  const openPutLegModal = (row: PutCalendarRow, legType: "Short Put" | "Long Put") => {
    const premium = legType === "Short Put" ? row.shortPutPrice : row.longPutPrice;
    const expiryDate = legType === "Short Put" ? row.shortExpiryDate : row.longExpiryDate;

    setPutLegModalData({
      legType,
      premium,
      expiryDate,
      strike: row.strike,
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
      const targetFromDate = dayjs(row.shortExpiryDate).add(7, "day").format("YYYY-MM-DD");
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

  const handleAutoRollOneWeek = async (row: PutCalendarRow) => {
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
            row.shortPutPrice,
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
    setProcessedSimulationCount(0);
    setPauseState(false);
    setPausePromptOpen(false);
    setPauseCheckpointData(null);
    manualPauseRequestedRef.current = false;

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

      const hasPutData = async (expiryDate: string): Promise<boolean> => {
        const expiryFormatted = formatExpiryDate(expiryDate);
        const peData = await fetchOptionWithCache(symbol, expiryFormatted, openingStrike, "P", firstDate);

        return peData.statusCode === 200 && peData.closePrice !== null;
      };

      const resolveExpiryDate = async (
        preferredExpiryDate: string,
        minDteDays: number,
        maxDteDays: number,
        label: "short" | "long"
      ): Promise<string> => {
        if (preferredExpiryDate) {
          const preferredHasData = await hasPutData(preferredExpiryDate);
          if (!preferredHasData) {
            throw new Error(
              `${label === "short" ? "Short" : "Long"} expiry has no put option data for ${symbol} on ${firstDate} at strike ${openingStrike}`
            );
          }
          return preferredExpiryDate;
        }

        const candidates = getExpiryDateCandidatesInDteWindow(firstDate, minDteDays, maxDteDays);
        for (const candidate of candidates) {
          if (await hasPutData(candidate)) {
            return candidate;
          }
        }

        throw new Error(
          `No ${label} expiry date found in the ${minDteDays}-${maxDteDays} DTE window with put option data`
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

      const allRows: PutCalendarRow[] = [];
      let activeShortExpiryDate = initialShortExpiryDate;
      let activeStrike = openingStrike;
      let rollNumber = 0;
      let entryNetCredit: number | null = null;
      let entryShortPutPrice: number | null = null;
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
          entryShortPutPrice = null;
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

        const [shortPutData, longPutData] = await Promise.all([
          fetchOptionWithCache(symbol, shortExpFmt, activeStrike, "P", date),
          fetchOptionWithCache(symbol, longExpFmt, activeStrike, "P", date),
        ]);

        const shortPutPrice = shortPutData.closePrice;
        const longPutPrice = longPutData.closePrice;
        const currentNetCloseCost =
          shortPutPrice !== null && longPutPrice !== null ? shortPutPrice - longPutPrice : null;

        if (entryNetCredit === null) {
          entryNetCredit = currentNetCloseCost;
        }
        if (entryShortPutPrice === null) {
          entryShortPutPrice = shortPutPrice;
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
          shortPutPrice,
          longPutPrice,
          entryNetCredit,
          rollCreditDebit,
          closeNetCost: status !== "active" ? closeNetCost : null,
          legPnl: status !== "active" ? legPnl : null,
          cumulativePnl: realisedPnl + unrealisedPnl,
          status,
          rollNumber,
        });

        const processedCount = allRows.length;
        setProcessedSimulationCount(processedCount);

        const shouldAutoPause = processedCount % AUTO_PAUSE_EVERY_SIMULATIONS === 0;
        const shouldManualPause = manualPauseRequestedRef.current;

        if (shouldAutoPause || shouldManualPause) {
          const shouldContinue = await openPausePrompt({
            processedCount,
            date,
            rollNumber,
            closingPrice: closePrice,
            cumulativePnl: realisedPnl + unrealisedPnl,
          });

          if (!shouldContinue) {
            autoRollStoppedReason = `Simulation stopped by user after ${processedCount} simulations on ${date}.`;
            break;
          }
        }

        if (isExpiry) {
          autoRollStoppedReason =
            `Simulation stopped at short expiry ${activeShortExpiryDate} on ${date}.`;
          break;
        }

        if (autoRollWeeklyEnabled) {
          const meetsAutoRollDecayCondition =
            entryShortPutPrice !== null &&
            shortPutPrice !== null &&
            shortPutPrice <= entryShortPutPrice * 0.5;

          if (!meetsAutoRollDecayCondition) {
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
      setError(err instanceof Error ? err.message : "Failed to run put calendar spread simulation");
    } finally {
      setPausePromptOpen(false);
      setPauseState(false);
      if (pauseDecisionResolverRef.current) {
        pauseDecisionResolverRef.current(false);
        pauseDecisionResolverRef.current = null;
      }
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

  const statusTag = (status: RowStatus) => {
    if (status === "rolled") return <Tag color="orange">Rolled</Tag>;
    if (status === "expired") return <Tag color="red">Expired</Tag>;
    return <Tag color="green">Active</Tag>;
  };

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card title="Put Calendar Spread (Roll)">
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
            Run Put Calendar Spread
          </Button>
          <Button
            onClick={() => {
              if (isPaused && pausePromptOpen) {
                resolvePauseDecision(true);
              } else {
                manualPauseRequestedRef.current = true;
                message.info("Pause requested. Simulation will ask to continue at the next checkpoint.");
              }
            }}
            disabled={!loading}
          >
            {isPaused ? "Continue" : "Pause"}
          </Button>
          <Button
            type={autoRollWeeklyEnabled ? "primary" : "default"}
            onClick={() => setAutoRollWeeklyEnabled((previous) => !previous)}
            disabled={loading}
          >
            Auto Roll Weekly: {autoRollWeeklyEnabled ? "ON" : "OFF"}
          </Button>
        </Space>
        <Text type="secondary" style={{ display: "block", marginTop: 8 }}>
          Auto pause every {AUTO_PAUSE_EVERY_SIMULATIONS} simulations with continue confirmation. Processed: {processedSimulationCount}
        </Text>
      </Card>

      {error && <Alert type="error" showIcon message="Put Calendar Spread Error" description={error} />}

      {summary && (
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

      <Card title="Records">
        <Table<PutCalendarRow>
          rowKey="key"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 50, showSizeChanger: true }}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Roll #", dataIndex: "rollNumber", key: "rollNumber", width: 70 },
            { title: "Date", dataIndex: "date", key: "date", width: 110 },
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
            { title: "Long Expiry", dataIndex: "longExpiryDate", key: "longExpiryDate", width: 120 },
            {
              title: "Short Put",
              dataIndex: "shortPutPrice",
              key: "shortPutPrice",
              width: 120,
              render: (v: number | null, row: PutCalendarRow) =>
                v !== null ? (
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openPutLegModal(row, "Short Put")}>
                    {formatCurrency(v)}
                  </Button>
                ) : (
                  "-"
                ),
            },
            {
              title: "Long Put",
              dataIndex: "longPutPrice",
              key: "longPutPrice",
              width: 120,
              render: (v: number | null, row: PutCalendarRow) =>
                v !== null ? (
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openPutLegModal(row, "Long Put")}>
                    {formatCurrency(v)}
                  </Button>
                ) : (
                  "-"
                ),
            },
            {
              title: "Entry Net Credit",
              dataIndex: "entryNetCredit",
              key: "entryNetCredit",
              width: 140,
              render: (v: number | null) => formatCurrency(v),
            },
            {
              title: "Close Net Cost",
              dataIndex: "closeNetCost",
              key: "closeNetCost",
              width: 130,
              render: (v: number | null) => (v !== null ? formatCurrency(v) : "-"),
            },
            {
              title: "Leg P&L",
              dataIndex: "legPnl",
              key: "legPnl",
              width: 110,
              render: (v: number | null) =>
                v !== null ? (
                  <Text style={{ color: v >= 0 ? "#3f8600" : "#cf1322" }}>{formatCurrency(v)}</Text>
                ) : (
                  "-"
                ),
            },
            {
              title: "Roll Credit/Debit",
              dataIndex: "rollCreditDebit",
              key: "rollCreditDebit",
              width: 140,
              render: (v: number | null) =>
                v !== null ? (
                  <Text style={{ color: v >= 0 ? "#3f8600" : "#cf1322" }}>{formatCurrency(v)}</Text>
                ) : (
                  "-"
                ),
            },
            {
              title: "Cumulative P&L",
              dataIndex: "cumulativePnl",
              key: "cumulativePnl",
              width: 140,
              render: (v: number | null) =>
                v !== null ? (
                  <Text style={{ color: v >= 0 ? "#3f8600" : "#cf1322" }}>{formatCurrency(v)}</Text>
                ) : (
                  "-"
                ),
            },
            {
              title: "Status",
              dataIndex: "status",
              key: "status",
              width: 100,
              render: (v: RowStatus) => statusTag(v),
              filters: [
                { text: "Active", value: "active" },
                { text: "Rolled", value: "rolled" },
                { text: "Expired", value: "expired" },
              ],
              onFilter: (value, record) => record.status === value,
            },
            {
              title: "Action",
              key: "action",
              width: 220,
              render: (_: unknown, row: PutCalendarRow) => (
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
        title="Simulation Paused"
        open={pausePromptOpen}
        closable={false}
        maskClosable={false}
        footer={[
          <Button key="stop" danger onClick={() => resolvePauseDecision(false)}>
            Stop
          </Button>,
          <Button key="continue" type="primary" onClick={() => resolvePauseDecision(true)}>
            Continue
          </Button>,
        ]}
      >
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Text>Simulation paused for safety. Continue?</Text>
          <div>
            <Text strong>Processed Simulations: </Text>
            <Text>{pauseCheckpointData?.processedCount ?? 0}</Text>
          </div>
          <div>
            <Text strong>Current Date: </Text>
            <Text>{pauseCheckpointData?.date ?? "-"}</Text>
          </div>
          <div>
            <Text strong>Roll #: </Text>
            <Text>{pauseCheckpointData?.rollNumber ?? 0}</Text>
          </div>
          <div>
            <Text strong>Closing Price: </Text>
            <Text>{formatCurrency(pauseCheckpointData?.closingPrice ?? null)}</Text>
          </div>
          <div>
            <Text strong>Cumulative P&L: </Text>
            <Text
              style={{
                color: (pauseCheckpointData?.cumulativePnl ?? 0) >= 0 ? "#3f8600" : "#cf1322",
              }}
            >
              {formatCurrency(pauseCheckpointData?.cumulativePnl ?? null)}
            </Text>
          </div>
        </Space>
      </Modal>
    </Space>
  );
};

export default PutCalendarSpreadRoll;
