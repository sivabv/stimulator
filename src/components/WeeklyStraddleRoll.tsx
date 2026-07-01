import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Col, DatePicker, Input, InputNumber, Row, Space, Spin, Table, Tag, Typography, message } from "antd";
import { DownloadOutlined, PlayCircleOutlined, StarFilled } from "@ant-design/icons";
import dayjs from "dayjs";
import spyClosingData from "../assets/spy-closing.json";
import { getAllSqliteEntries, getSqliteItem, setSqliteItem } from "../utils/sqliteStorage";

const { Text } = Typography;

type LegType = "Call" | "Put";
type LegStatus = "active" | "closed";

interface WeeklyStraddleLeg {
  key: string;
  weekNumber: number;
  legType: LegType;
  entryDate: string;
  initialExpiryDate: string;
  finalExpiryDate: string;
  strike: number;
  rolledCount: number;
  status: LegStatus;
  closeDate: string | null;
  entryPrice: number | null;
  entryOptionClosePrice: number | null;
  closeOptionClosePrice: number | null;
}

interface LocalPricePoint {
  openPrice: number | null;
  closePrice: number | null;
  delta: number | null;
  theta: number | null;
  statusCode: number | null;
}

interface CachedOptionPrice extends LocalPricePoint {
  symbol: string;
  expiryDate: string;
  strikePrice: number;
  optionType: "C" | "P";
  date: string;
}

interface CachedStockPrice extends LocalPricePoint {
  symbol: string;
  date: string;
}

interface DailySummaryRow {
  key: string;
  date: string;
  closePrice: number | null;
  newlyAddedOptions: number;
  shownOptions: number;
  activeOptions: number;
  callsActive: number;
  putsActive: number;
  closedInThisWeek: number;
  cumulativeClosed: number;
}

interface WeeklyStraddleRunSnapshot {
  symbol: string;
  startDate: string;
  endDate: string;
  tradingDays: number;
  generatedAt: string;
  closingPriceByDate: Record<string, number | null>;
  legs: WeeklyStraddleLeg[];
}

interface WeeklyStraddleRollProps {
  onOpenChartsTab?: () => void;
}

type MasterStockData = Record<string, CachedStockPrice>;
type MasterOptionData = Record<string, CachedOptionPrice>;

const MASTER_STOCK_DATA_KEY = "masterStockData";
const MASTER_OPTION_DATA_KEY = "masterOptionData";
const WEEKLY_STRADDLE_RUN_DATA_KEY = "weeklyStraddleRunData";
const SPY_CLOSING_SERIES = spyClosingData as Array<{ date: string; close: number | null }>;
const SPY_CLOSING_DATES = SPY_CLOSING_SERIES.map((point) => point.date);
const SPY_CLOSING_BY_DATE = new Map(SPY_CLOSING_SERIES.map((point) => [point.date, point.close]));
const DEFAULT_START_DATE = SPY_CLOSING_DATES[0] ?? "2025-01-01";
const DEFAULT_SIMULATION_DAYS = 50;
const TRADING_DAYS_PER_PHASE = 5;
const DEFAULT_CALL_STRIKE_PERCENT_ABOVE = 1;
const DEFAULT_PUT_STRIKE_PERCENT_BELOW = 1;
const DEFAULT_DTE_MIN_DAYS = 1;
const DEFAULT_DTE_MAX_DAYS = 4;
const DEFAULT_DTE_TARGET_DAYS = 4;
const DEFAULT_MAX_ACTIVE_LEGS_PER_TYPE = 5;

const isBusinessDay = (date: string) => {
  const dayOfWeek = dayjs(date).day();
  return dayOfWeek !== 0 && dayOfWeek !== 6;
};

const getFirstBusinessDayOnOrAfter = (date: string): string | null => {
  let cursor = dayjs(date);
  if (!cursor.isValid()) return null;

  while (!isBusinessDay(cursor.format("YYYY-MM-DD"))) {
    cursor = cursor.add(1, "day");
  }

  return cursor.format("YYYY-MM-DD");
};

const formatCurrency = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
};

const formatDate = (value: string | null) => value ?? "-";

const roundToNearestFive = (value: number): number => Math.round(value / 5) * 5;

const renderTileTitle = (legType: LegType, weekNumber: number, startDate: string, endDate: string) => (
  <Space direction="vertical" size={0} style={{ width: "100%" }}>
    <Text strong>{`${legType} • Trade ${weekNumber}`}</Text>
    <Text type="secondary" style={{ fontSize: 12 }}>
      {`Active ${startDate} → ${endDate}`}
    </Text>
  </Space>
);

const getCacheKey = (symbol: string, date: string) => `${symbol}|${date}`;
const getOptionCacheKey = (
  symbol: string,
  expiryDate: string,
  strikePrice: number,
  optionType: "C" | "P",
  date: string
) => `${symbol}|${expiryDate}|${strikePrice}|${optionType}|${date}`;

const formatExpiryDate = (dateStr: string): string => dayjs(dateStr).format("YYMMDD");

const getFirstTradingDateOnOrAfter = (date: string): string | null => getFirstBusinessDayOnOrAfter(date);

const getNextTradingDate = (date: string): string | null => {
  let cursor = dayjs(date).add(1, "day");
  let guard = 0;

  while (guard < 14) {
    const candidate = cursor.format("YYYY-MM-DD");
    if (isBusinessDay(candidate)) return candidate;
    cursor = cursor.add(1, "day");
    guard += 1;
  }

  return null;
};

const getAllTradingDatesInRange = (start: string, end: string, symbol: string): string[] => {
  const normalizedStart = getFirstTradingDateOnOrAfter(start);
  if (!normalizedStart || !dayjs(end).isValid() || dayjs(end).isBefore(dayjs(normalizedStart), "day")) {
    return [];
  }

  if (symbol === "SPY" && SPY_CLOSING_DATES.length > 0) {
    return SPY_CLOSING_DATES.filter(
      (date) =>
        (dayjs(date).isSame(dayjs(normalizedStart), "day") || dayjs(date).isAfter(dayjs(normalizedStart), "day")) &&
        (dayjs(date).isSame(dayjs(end), "day") || dayjs(date).isBefore(dayjs(end), "day"))
    );
  }

  const dates: string[] = [];
  let cursor = dayjs(normalizedStart);
  const endDate = dayjs(end);

  while (cursor.isSame(endDate, "day") || cursor.isBefore(endDate, "day")) {
    const candidate = cursor.format("YYYY-MM-DD");
    if (isBusinessDay(candidate)) {
      dates.push(candidate);
    }
    cursor = cursor.add(1, "day");
  }

  return dates;
};

const getTradingDatesFromStart = (start: string, symbol: string, tradingDays: number): string[] => {
  const normalizedStart = getFirstTradingDateOnOrAfter(start);
  const totalDays = Number.isFinite(tradingDays) ? Math.max(1, Math.floor(tradingDays)) : 1;
  if (!normalizedStart) return [];

  if (symbol === "SPY" && SPY_CLOSING_DATES.length > 0) {
    const startIndex = SPY_CLOSING_DATES.findIndex(
      (date) => dayjs(date).isSame(dayjs(normalizedStart), "day") || dayjs(date).isAfter(dayjs(normalizedStart), "day")
    );

    if (startIndex === -1) return [];
    return SPY_CLOSING_DATES.slice(startIndex, startIndex + totalDays);
  }

  const dates = [normalizedStart];
  let currentDate = normalizedStart;

  while (dates.length < totalDays) {
    const nextDate = getNextTradingDate(currentDate);
    if (!nextDate) break;
    dates.push(nextDate);
    currentDate = nextDate;
  }

  return dates;
};

const getSimulationEndDate = (date: string, simulationDays: number, symbol: string) => {
  const tradingDates = getTradingDatesFromStart(date, symbol, simulationDays);
  return tradingDates[tradingDates.length - 1] ?? "";
};

const isLegActiveOnDate = (leg: WeeklyStraddleLeg, asOfDate: string): boolean => {
  const entryDate = dayjs(leg.entryDate);
  const asOf = dayjs(asOfDate);
  const closeDate = leg.closeDate ? dayjs(leg.closeDate) : null;

  if (!entryDate.isValid() || !asOf.isValid()) {
    return false;
  }

  return (
    (asOf.isSame(entryDate, "day") || asOf.isAfter(entryDate, "day")) &&
    (!closeDate || closeDate.isAfter(asOf, "day"))
  );
};

const getExpiryDateInDteWindow = (
  entryDate: string,
  symbol: string,
  minDteDays: number,
  maxDteDays: number,
  targetDteDays: number
): string => {
  const windowStart = dayjs(entryDate).add(minDteDays, "day").format("YYYY-MM-DD");
  const windowEnd = dayjs(entryDate).add(maxDteDays, "day").format("YYYY-MM-DD");
  const targetDate = dayjs(entryDate).add(targetDteDays, "day");
  const candidates = getAllTradingDatesInRange(windowStart, windowEnd, symbol);

  if (candidates.length === 0) {
    return getNextTradingDate(entryDate) ?? entryDate;
  }

  return candidates.reduce((best, candidate) => {
    const bestDistance = Math.abs(dayjs(best).diff(targetDate, "day"));
    const candidateDistance = Math.abs(dayjs(candidate).diff(targetDate, "day"));
    return candidateDistance < bestDistance ? candidate : best;
  }, candidates[0]);
};

const parseMasterStockData = (raw: string | null): MasterStockData => {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as MasterStockData;
  } catch {
    return {};
  }
};

const parseMasterOptionData = (raw: string | null): MasterOptionData => {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as MasterOptionData;
  } catch {
    return {};
  }
};

const parseWeeklyStraddleRunSnapshot = (raw: string | null): WeeklyStraddleRunSnapshot | null => {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as WeeklyStraddleRunSnapshot;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.legs) || !parsed.closingPriceByDate) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

const loadWeeklyStraddleRunData = async (): Promise<WeeklyStraddleRunSnapshot | null> => {
  const sqliteRaw = await getSqliteItem(WEEKLY_STRADDLE_RUN_DATA_KEY);
  return parseWeeklyStraddleRunSnapshot(sqliteRaw);
};

const saveWeeklyStraddleRunData = async (data: WeeklyStraddleRunSnapshot) => {
  const payload = JSON.stringify(data);
  await setSqliteItem(WEEKLY_STRADDLE_RUN_DATA_KEY, payload);
};

const exportStaticDataToFile = async () => {
  const staticDataKeys = [MASTER_STOCK_DATA_KEY, MASTER_OPTION_DATA_KEY, WEEKLY_STRADDLE_RUN_DATA_KEY] as const;
  const sqliteEntries = await getAllSqliteEntries();
  const data: Record<string, unknown> = {};

  staticDataKeys.forEach((key) => {
    const raw = sqliteEntries[key] ?? null;

    try {
      if (!raw) return;
      data[key] = JSON.parse(raw);
    } catch {
      data[key] = raw;
    }
  });

  const payload = {
    exportedAt: dayjs().toISOString(),
    source: "weekly-straddle-static-data-sqlite",
    keys: staticDataKeys,
    data,
  };

  const fileName = `weekly-straddle-static-data-${dayjs().format("YYYY-MM-DD-HHmmss")}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  message.success("Exported static data from SQLite/local cache");
};

const WeeklyStraddleRoll: React.FC<WeeklyStraddleRollProps> = ({ onOpenChartsTab }) => {
  const [stockTicker, setStockTicker] = useState("SPY");
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [simulationDays, setSimulationDays] = useState(DEFAULT_SIMULATION_DAYS);
  const [endDate, setEndDate] = useState(getSimulationEndDate(DEFAULT_START_DATE, DEFAULT_SIMULATION_DAYS, "SPY"));
  const [callStrikePercentAboveInput, setCallStrikePercentAboveInput] = useState<number | null>(null);
  const [putStrikePercentBelowInput, setPutStrikePercentBelowInput] = useState<number | null>(null);
  const [dteMinDaysInput, setDteMinDaysInput] = useState<number | null>(null);
  const [dteMaxDaysInput, setDteMaxDaysInput] = useState<number | null>(null);
  const [dteTargetDaysInput, setDteTargetDaysInput] = useState<number | null>(null);
  const [maxActiveLegsPerTypeInput, setMaxActiveLegsPerTypeInput] = useState<number | null>(null);
  const [activeDateFilter, setActiveDateFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [legs, setLegs] = useState<WeeklyStraddleLeg[]>([]);
  const [closingPriceByDate, setClosingPriceByDate] = useState<Record<string, number | null>>({});
  const [runProgress, setRunProgress] = useState<{ processed: number; total: number; phase: number; totalPhases: number }>({
    processed: 0,
    total: 0,
    phase: 0,
    totalPhases: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const masterStockDataRef = useRef<MasterStockData>({});
  const masterOptionDataRef = useRef<MasterOptionData>({});
  const pendingStockRequestsRef = useRef<Record<string, Promise<CachedStockPrice>>>({});
  const pendingOptionRequestsRef = useRef<Record<string, Promise<CachedOptionPrice>>>({});
  const restoredRunRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadMasterCaches = async () => {
      const [stockRaw, optionRaw] = await Promise.all([
        getSqliteItem(MASTER_STOCK_DATA_KEY),
        getSqliteItem(MASTER_OPTION_DATA_KEY),
      ]);

      if (cancelled) return;
      masterStockDataRef.current = parseMasterStockData(stockRaw);
      masterOptionDataRef.current = parseMasterOptionData(optionRaw);
    };

    void loadMasterCaches();

    return () => {
      cancelled = true;
    };
  }, []);

  const fetchStockWithCache = async (symbol: string, date: string): Promise<CachedStockPrice> => {
    const cacheKey = getCacheKey(symbol, date);
    const cached = masterStockDataRef.current[cacheKey];
    if (cached) return cached;

    if (symbol === "SPY") {
      const localSpyClose = SPY_CLOSING_BY_DATE.get(date);
      if (localSpyClose !== undefined) {
        const result: CachedStockPrice = {
          symbol,
          date,
          openPrice: null,
          closePrice: localSpyClose,
          delta: null,
          theta: null,
          statusCode: 200,
        };
        masterStockDataRef.current[cacheKey] = result;
        return result;
      }
    }

    const pending = pendingStockRequestsRef.current[cacheKey];
    if (pending) return pending;

    const localOnlyResult: CachedStockPrice = {
      symbol,
      date,
      openPrice: null,
      closePrice: null,
      delta: null,
      theta: null,
      statusCode: 204,
    };

    return localOnlyResult;
  };

  const fetchOptionWithCache = async (
    symbol: string,
    expiryDate: string,
    strikePrice: number,
    optionType: "C" | "P",
    date: string
  ): Promise<CachedOptionPrice> => {
    const formattedExpiryDate = formatExpiryDate(expiryDate);
    const cacheKey = getOptionCacheKey(symbol, formattedExpiryDate, strikePrice, optionType, date);
    const cached = masterOptionDataRef.current[cacheKey];
    if (cached) return cached;

    const pending = pendingOptionRequestsRef.current[cacheKey];
    if (pending) return pending;

    const localOnlyResult: CachedOptionPrice = {
      symbol,
      expiryDate: formattedExpiryDate,
      strikePrice,
      optionType,
      date,
      openPrice: null,
      closePrice: null,
      delta: null,
      theta: null,
      statusCode: 204,
    };

    return localOnlyResult;
  };

  useEffect(() => {
    if (restoredRunRef.current) return;
    let cancelled = false;

    const restore = async () => {
      const storedRun = await loadWeeklyStraddleRunData();
      if (!storedRun || cancelled) return;

      const currentSymbol = stockTicker.trim().toUpperCase();
      const storedSymbol = storedRun.symbol.trim().toUpperCase();
      const normalizedStart = getFirstTradingDateOnOrAfter(startDate) ?? startDate;

      if (
        storedSymbol !== currentSymbol ||
        storedRun.startDate !== normalizedStart ||
        storedRun.endDate !== endDate ||
        storedRun.tradingDays !== simulationDays
      ) {
        return;
      }

      restoredRunRef.current = true;
      setClosingPriceByDate(storedRun.closingPriceByDate);
      setLegs(storedRun.legs);
      setLoading(false);
      message.success("Loaded saved weekly straddle data from SQLite");
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, [endDate, simulationDays, startDate, stockTicker]);

  const simulateLeg = async (
    symbol: string,
    weekNumber: number,
    legType: LegType,
    entryDate: string,
    initialExpiryDate: string,
    strike: number,
    dteConfig: { minDays: number; maxDays: number; targetDays: number },
    rangeEndDate: string
  ): Promise<WeeklyStraddleLeg> => {
    const maxMonitorDate = dayjs(rangeEndDate);
    let currentExpiryDate = initialExpiryDate;
    let rolledCount = 0;
    let closeDate: string | null = null;
    let currentDate = entryDate;

    while (!dayjs(currentDate).isAfter(maxMonitorDate, "day")) {
      // Keep the leg active until the current expiry date is reached.
      if (dayjs(currentDate).isBefore(dayjs(currentExpiryDate), "day")) {
        const nextDate = getNextTradingDate(currentDate);
        if (!nextDate) break;
        currentDate = nextDate;
        continue;
      }

      const stockResult = await fetchStockWithCache(symbol, currentDate);
      const closePrice = stockResult.closePrice;

      if (closePrice === null) {
        const nextDate = getNextTradingDate(currentDate);
        if (!nextDate) break;
        currentDate = nextDate;
        continue;
      }

      const isInTheMoney = legType === "Call" ? closePrice > strike : closePrice < strike;

      if (isInTheMoney) {
        const nextDate = getNextTradingDate(currentDate);
        if (!nextDate) {
          closeDate = currentDate;
          break;
        }

        rolledCount += 1;
        currentExpiryDate = getExpiryDateInDteWindow(
          nextDate,
          symbol,
          dteConfig.minDays,
          dteConfig.maxDays,
          dteConfig.targetDays
        );
        currentDate = nextDate;
        continue;
      }

      closeDate = currentDate;
      break;
    }

    if (!closeDate) {
      closeDate = currentDate;
    }

    const optionType: "C" | "P" = legType === "Call" ? "C" : "P";
    const [entryOption, closeOption] = await Promise.all([
      fetchOptionWithCache(symbol, initialExpiryDate, strike, optionType, entryDate).catch(() => null),
      closeDate
        ? fetchOptionWithCache(symbol, currentExpiryDate, strike, optionType, closeDate).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      key: `${weekNumber}-${legType}-${entryDate}`,
      weekNumber,
      legType,
      entryDate,
      initialExpiryDate,
      finalExpiryDate: currentExpiryDate,
      strike,
      rolledCount,
      status: closeDate ? "closed" : "active",
      closeDate,
      entryPrice: entryOption?.closePrice ?? null,
      entryOptionClosePrice: entryOption?.closePrice ?? null,
      closeOptionClosePrice: closeOption?.closePrice ?? null,
    };
  };

  const handleRun = async () => {
    setError(null);
    setLegs([]);
    setClosingPriceByDate({});
    setRunProgress({ processed: 0, total: 0, phase: 0, totalPhases: 0 });
    setLoading(true);

    try {
      const symbol = stockTicker.trim().toUpperCase();
      const effectiveSimulationDays = Math.max(1, Math.floor(simulationDays));
      const effectiveEndDate = getSimulationEndDate(startDate, effectiveSimulationDays, symbol);
      const effectiveCallStrikePercentAbove =
        typeof callStrikePercentAboveInput === "number" && Number.isFinite(callStrikePercentAboveInput) && callStrikePercentAboveInput >= 0
          ? callStrikePercentAboveInput
          : DEFAULT_CALL_STRIKE_PERCENT_ABOVE;
      const effectivePutStrikePercentBelow =
        typeof putStrikePercentBelowInput === "number" && Number.isFinite(putStrikePercentBelowInput) && putStrikePercentBelowInput >= 0
          ? putStrikePercentBelowInput
          : DEFAULT_PUT_STRIKE_PERCENT_BELOW;

      const requestedMinDte =
        typeof dteMinDaysInput === "number" && Number.isFinite(dteMinDaysInput) && dteMinDaysInput >= 1
          ? Math.floor(dteMinDaysInput)
          : DEFAULT_DTE_MIN_DAYS;
      const requestedMaxDte =
        typeof dteMaxDaysInput === "number" && Number.isFinite(dteMaxDaysInput) && dteMaxDaysInput >= 1
          ? Math.floor(dteMaxDaysInput)
          : DEFAULT_DTE_MAX_DAYS;
      const effectiveDteMinDays = Math.min(requestedMinDte, requestedMaxDte);
      const effectiveDteMaxDays = Math.max(requestedMinDte, requestedMaxDte);
      const requestedTargetDte =
        typeof dteTargetDaysInput === "number" && Number.isFinite(dteTargetDaysInput) && dteTargetDaysInput >= 1
          ? Math.floor(dteTargetDaysInput)
          : DEFAULT_DTE_TARGET_DAYS;
      const effectiveDteTargetDays = Math.min(effectiveDteMaxDays, Math.max(effectiveDteMinDays, requestedTargetDte));
      const effectiveMaxActiveLegsPerType =
        typeof maxActiveLegsPerTypeInput === "number" && Number.isFinite(maxActiveLegsPerTypeInput) && maxActiveLegsPerTypeInput >= 1
          ? Math.floor(maxActiveLegsPerTypeInput)
          : DEFAULT_MAX_ACTIVE_LEGS_PER_TYPE;
      const dteConfig = {
        minDays: effectiveDteMinDays,
        maxDays: effectiveDteMaxDays,
        targetDays: effectiveDteTargetDays,
      };

      if (!symbol) throw new Error("Stock ticker is required");
      if (!Number.isFinite(simulationDays) || simulationDays < 1) {
        throw new Error("Trading days must be at least 1");
      }
      if (!dayjs(startDate).isValid()) throw new Error("Start date is invalid");
      if (!dayjs(effectiveEndDate).isValid()) throw new Error("End date is invalid");
      if (dayjs(effectiveEndDate).isBefore(dayjs(startDate), "day")) {
        throw new Error("Simulation end date must be on or after start date");
      }

      const firstDate = getFirstTradingDateOnOrAfter(startDate);
      if (!firstDate) throw new Error("No trading date found on or after the start date");

      const entryDates = getTradingDatesFromStart(firstDate, symbol, effectiveSimulationDays);
      const totalPhases = Math.ceil(entryDates.length / TRADING_DAYS_PER_PHASE);
      setRunProgress({ processed: 0, total: entryDates.length, phase: 0, totalPhases });
      const results: WeeklyStraddleLeg[] = [];

      for (let phaseStart = 0; phaseStart < entryDates.length; phaseStart += TRADING_DAYS_PER_PHASE) {
        const phaseEntryDates = entryDates.slice(phaseStart, phaseStart + TRADING_DAYS_PER_PHASE);

        for (let offset = 0; offset < phaseEntryDates.length; offset += 1) {
          const entryDate = phaseEntryDates[offset];
          const stockResult = await fetchStockWithCache(symbol, entryDate);
          const entryPrice = stockResult.closePrice;
          if (entryPrice === null) continue;

          const callStrike = roundToNearestFive(entryPrice * (1 + effectiveCallStrikePercentAbove / 100));
          const putStrike = roundToNearestFive(entryPrice * (1 - effectivePutStrikePercentBelow / 100));
          const callInitialExpiryDate = getExpiryDateInDteWindow(
            entryDate,
            symbol,
            dteConfig.minDays,
            dteConfig.maxDays,
            dteConfig.targetDays
          );
          const putInitialExpiryDate = getExpiryDateInDteWindow(
            entryDate,
            symbol,
            dteConfig.minDays,
            dteConfig.maxDays,
            dteConfig.targetDays
          );
          const tradeNumber = phaseStart + offset + 1;

          const activeCallCount = results.filter(
            (leg) => leg.legType === "Call" && isLegActiveOnDate(leg, entryDate)
          ).length;
          const activePutCount = results.filter(
            (leg) => leg.legType === "Put" && isLegActiveOnDate(leg, entryDate)
          ).length;

          const nextLegs = await Promise.all([
            activeCallCount < effectiveMaxActiveLegsPerType
              ? simulateLeg(symbol, tradeNumber, "Call", entryDate, callInitialExpiryDate, callStrike, dteConfig, effectiveEndDate)
              : Promise.resolve(null),
            activePutCount < effectiveMaxActiveLegsPerType
              ? simulateLeg(symbol, tradeNumber, "Put", entryDate, putInitialExpiryDate, putStrike, dteConfig, effectiveEndDate)
              : Promise.resolve(null),
          ]);

          results.push(...nextLegs.filter((leg): leg is WeeklyStraddleLeg => leg !== null));
          setRunProgress({
            processed: tradeNumber,
            total: entryDates.length,
            phase: Math.floor(phaseStart / TRADING_DAYS_PER_PHASE) + 1,
            totalPhases,
          });
        }
      }

      const sectionDates = getAllTradingDatesInRange(firstDate, effectiveEndDate, symbol);
      const summaryDates = Array.from(new Set([...results.map((row) => row.entryDate), ...sectionDates]));
      const summaryDateClosePairs = await Promise.all(
        summaryDates.map(async (date) => {
          const stockResult = await fetchStockWithCache(symbol, date);
          return [date, stockResult.closePrice] as const;
        })
      );

      const closingPriceSnapshot = Object.fromEntries(
        summaryDateClosePairs.filter(([, closePrice]) => closePrice !== null)
      );

      setClosingPriceByDate(closingPriceSnapshot);
      setLegs(results);
      void saveWeeklyStraddleRunData({
        symbol,
        startDate: firstDate,
        endDate: effectiveEndDate,
        tradingDays: effectiveSimulationDays,
        generatedAt: dayjs().toISOString(),
        closingPriceByDate: closingPriceSnapshot,
        legs: results,
      });

      if (!results.length) {
        message.warning("No daily straddles could be generated for the selected date range");
      } else {
        message.success("Stored weekly straddle run data in SQLite");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run daily straddle simulation");
    } finally {
      setRunProgress((previous) => ({ ...previous, processed: previous.total, phase: previous.totalPhases }));
      setLoading(false);
    }
  };

  const handleSaveData = () => {
    if (legs.length === 0) {
      message.warning("Run a simulation before saving data");
      return;
    }

    void saveWeeklyStraddleRunData({
      symbol: stockTicker.trim().toUpperCase(),
      startDate,
      endDate,
      tradingDays: simulationDays,
      generatedAt: dayjs().toISOString(),
      closingPriceByDate,
      legs,
    });

    message.success("Saved current weekly straddle data to SQLite");
  };

  useEffect(() => {
    if (loading || legs.length === 0) return;

    void saveWeeklyStraddleRunData({
      symbol: stockTicker.trim().toUpperCase(),
      startDate,
      endDate,
      tradingDays: simulationDays,
      generatedAt: dayjs().toISOString(),
      closingPriceByDate,
      legs,
    });
  }, [closingPriceByDate, endDate, legs, loading, simulationDays, startDate, stockTicker]);

  const sectionData = useMemo(() => {
    if (legs.length === 0) {
      return {
        summaryRows: [] as DailySummaryRow[],
        tiles: [] as React.ReactNode[],
      };
    }

    const symbol = stockTicker.trim().toUpperCase();
    const defaultStart = getFirstTradingDateOnOrAfter(startDate) ?? startDate;
    const filterStart = activeDateFilter ? getFirstTradingDateOnOrAfter(activeDateFilter) ?? activeDateFilter : "";
    const sectionStart = filterStart || defaultStart;
    const sectionDates = getAllTradingDatesInRange(sectionStart, endDate, symbol);

    const summaryRows: DailySummaryRow[] = sectionDates.map((asOfDate, index) => {
      const closePrice = Object.prototype.hasOwnProperty.call(closingPriceByDate, asOfDate)
        ? closingPriceByDate[asOfDate]
        : null;
      const asOf = dayjs(asOfDate);
      const phaseStartIndex = Math.floor(index / TRADING_DAYS_PER_PHASE) * TRADING_DAYS_PER_PHASE;
      const phaseStartDate = sectionDates[phaseStartIndex];
      const phaseEndDate = sectionDates[Math.min(phaseStartIndex + TRADING_DAYS_PER_PHASE - 1, sectionDates.length - 1)];

      const isLegOpenOnDate = (leg: WeeklyStraddleLeg) => {
        const entryDate = dayjs(leg.entryDate);
        const closeDate = leg.closeDate ? dayjs(leg.closeDate) : null;

        return (
          (asOf.isSame(entryDate, "day") || asOf.isAfter(entryDate, "day")) &&
          (!closeDate || asOf.isBefore(closeDate, "day"))
        );
      };

      const isLegClosedOnDate = (leg: WeeklyStraddleLeg) => Boolean(leg.closeDate && dayjs(leg.closeDate).isSame(asOfDate, "day"));
      const isLegVisibleOnDate = (leg: WeeklyStraddleLeg) => isLegOpenOnDate(leg) || isLegClosedOnDate(leg);

      const closedInCurrentWeekCount = legs.filter((leg) => {
        if (!leg.closeDate) return false;
        const closeDate = dayjs(leg.closeDate);
        return (
          (closeDate.isSame(phaseStartDate, "day") || closeDate.isAfter(dayjs(phaseStartDate), "day")) &&
          (closeDate.isSame(phaseEndDate, "day") || closeDate.isBefore(dayjs(phaseEndDate), "day"))
        );
      }).length;

      const cumulativeClosedCount = legs.filter((leg) => {
        if (!leg.closeDate) return false;
        const closeDate = dayjs(leg.closeDate);
        return closeDate.isSame(asOfDate, "day") || closeDate.isBefore(asOf, "day");
      }).length;

      const optionsInWeek = legs
        .filter((leg) => isLegVisibleOnDate(leg))
        .sort((left, right) => {
          if (left.entryDate !== right.entryDate) {
            return dayjs(left.entryDate).valueOf() - dayjs(right.entryDate).valueOf();
          }
          if (left.legType !== right.legType) {
            return left.legType === "Call" ? -1 : 1;
          }
          return left.weekNumber - right.weekNumber;
        });

      const activeCallCount = optionsInWeek.filter((leg) => leg.legType === "Call" && isLegOpenOnDate(leg)).length;
      const activePutCount = optionsInWeek.filter((leg) => leg.legType === "Put" && isLegOpenOnDate(leg)).length;
      const activeOptionCount = optionsInWeek.filter((leg) => isLegOpenOnDate(leg)).length;
      const newlyAddedOptionCount = legs.filter((leg) => dayjs(leg.entryDate).isSame(asOfDate, "day")).length;
      const shownOptionCount = optionsInWeek.length;

      return {
        key: asOfDate,
        date: asOfDate,
        closePrice,
        newlyAddedOptions: newlyAddedOptionCount,
        shownOptions: shownOptionCount,
        activeOptions: activeOptionCount,
        callsActive: activeCallCount,
        putsActive: activePutCount,
        closedInThisWeek: closedInCurrentWeekCount,
        cumulativeClosed: cumulativeClosedCount,
      };
    });

    const summaryByDate = Object.fromEntries(summaryRows.map((row) => [row.date, row] as const));

    const tiles = sectionDates.map((asOfDate, index) => {
      const closePrice = Object.prototype.hasOwnProperty.call(closingPriceByDate, asOfDate)
        ? closingPriceByDate[asOfDate]
        : null;
      const asOf = dayjs(asOfDate);
      const phaseStartIndex = Math.floor(index / TRADING_DAYS_PER_PHASE) * TRADING_DAYS_PER_PHASE;
      const phaseStartDate = sectionDates[phaseStartIndex];
      const phaseEndDate = sectionDates[Math.min(phaseStartIndex + TRADING_DAYS_PER_PHASE - 1, sectionDates.length - 1)];

      const isLegOpenOnDate = (leg: WeeklyStraddleLeg) => {
        const entryDate = dayjs(leg.entryDate);
        const closeDate = leg.closeDate ? dayjs(leg.closeDate) : null;

        return (
          (asOf.isSame(entryDate, "day") || asOf.isAfter(entryDate, "day")) &&
          (!closeDate || asOf.isBefore(closeDate, "day"))
        );
      };

      const isLegClosedOnDate = (leg: WeeklyStraddleLeg) => Boolean(leg.closeDate && dayjs(leg.closeDate).isSame(asOfDate, "day"));
      const isLegVisibleOnDate = (leg: WeeklyStraddleLeg) => isLegOpenOnDate(leg) || isLegClosedOnDate(leg);
      const getLegDisplayStatus = (leg: WeeklyStraddleLeg): { label: "New" | "Active" | "Closed"; color: string } => {
        if (dayjs(leg.entryDate).isSame(asOfDate, "day")) {
          return { label: "New", color: "blue" };
        }
        if (isLegClosedOnDate(leg)) {
          return { label: "Closed", color: "red" };
        }
        return { label: "Active", color: "green" };
      };

      const optionsInWeek = legs
        .filter((leg) => isLegVisibleOnDate(leg))
        .sort((left, right) => {
          if (left.entryDate !== right.entryDate) {
            return dayjs(left.entryDate).valueOf() - dayjs(right.entryDate).valueOf();
          }
          if (left.legType !== right.legType) {
            return left.legType === "Call" ? -1 : 1;
          }
          return left.weekNumber - right.weekNumber;
        });

      const closedInCurrentWeekCount = legs.filter((leg) => {
        if (!leg.closeDate) return false;
        const closeDate = dayjs(leg.closeDate);
        return (
          (closeDate.isSame(phaseStartDate, "day") || closeDate.isAfter(dayjs(phaseStartDate), "day")) &&
          (closeDate.isSame(phaseEndDate, "day") || closeDate.isBefore(dayjs(phaseEndDate), "day"))
        );
      }).length;

      return (
        <Space key={asOfDate} direction="vertical" size={8} style={{ width: "100%", marginBottom: 16 }}>
          <Space size={12} wrap>
            <Text strong style={{ fontSize: 14 }}>
              {`Date: ${asOfDate} | Close: ${formatCurrency(closePrice)}`}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`Shown options: ${optionsInWeek.length} | Active options: ${summaryByDate[asOfDate]?.activeOptions ?? 0} | Calls active: ${summaryByDate[asOfDate]?.callsActive ?? 0} | Puts active: ${summaryByDate[asOfDate]?.putsActive ?? 0} | Closed in this week: ${closedInCurrentWeekCount} | Cumulative closed: ${summaryByDate[asOfDate]?.cumulativeClosed ?? 0}`}
            </Text>
          </Space>

          {optionsInWeek.length === 0 ? (
            <Text type="secondary">No options entered by this date.</Text>
          ) : (
            <Row gutter={[16, 12]}>
              <Col xs={24} sm={12} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Text type="secondary" strong style={{ fontSize: 12 }}>Calls (Left)</Text>
                <Row gutter={[12, 12]}>
                  {optionsInWeek.filter((leg) => leg.legType === "Call").map((leg) => {
                    const displayStatus = getLegDisplayStatus(leg);
                    const isClosed = displayStatus.label === "Closed";
                    const isNew = displayStatus.label === "New";
                    const tileBackground = isClosed ? "#f0f0f0" : isNew ? "#e6f4ff" : "#f6ffed";
                    const tileBorder = isClosed ? "#d9d9d9" : isNew ? "#91caff" : "#b7eb8f";

                    return (
                      <Col key={`${asOfDate}-${leg.key}`} xs={24} sm={24} md={12} lg={8}>
                        <Card
                          size="small"
                          title={renderTileTitle(leg.legType, leg.weekNumber, leg.entryDate, leg.closeDate ?? leg.finalExpiryDate)}
                          style={{ height: "100%", marginBottom: 0, background: tileBackground, borderColor: tileBorder }}
                          extra={<Tag color={displayStatus.color}>{displayStatus.label}</Tag>}
                        >
                          <Space direction="vertical" size={2} style={{ width: "100%" }}>
                            <div>
                              <Text strong>Entry: </Text>
                              <Text>{formatDate(leg.entryDate)} | Expiry: {formatDate(leg.finalExpiryDate)} | Strike: {formatCurrency(leg.strike)}</Text>
                            </div>
                            <div>
                              <Text strong>Rolls: </Text>
                              <Text>
                                {Array.from({ length: leg.rolledCount }).map((_, index) => (
                                  <StarFilled key={index} style={{ color: "#faad14", marginRight: 2 }} />
                                ))}
                                <span style={{ marginLeft: 4 }}>{leg.rolledCount}</span>
                                <span style={{ margin: "0 4px" }}>|</span>
                                Close: {formatDate(leg.closeDate)}
                              </Text>
                            </div>
                            <div>
                              <Text strong>Option px: </Text>
                              <Text>
                                Entry {formatCurrency(leg.entryPrice)}
                                <span style={{ margin: "0 4px" }}>|</span>
                                Close {formatCurrency(leg.closeOptionClosePrice)}
                              </Text>
                            </div>
                          </Space>
                        </Card>
                      </Col>
                    );
                  })}
                </Row>
              </Col>

              <Col xs={24} sm={12} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Text type="secondary" strong style={{ fontSize: 12 }}>Puts (Right)</Text>
                <Row gutter={[12, 12]}>
                  {optionsInWeek.filter((leg) => leg.legType === "Put").map((leg) => {
                    const displayStatus = getLegDisplayStatus(leg);
                    const isClosed = displayStatus.label === "Closed";
                    const isNew = displayStatus.label === "New";
                    const tileBackground = isClosed ? "#f0f0f0" : isNew ? "#e6f4ff" : "#fff0f6";
                    const tileBorder = isClosed ? "#d9d9d9" : isNew ? "#91caff" : "#ffadd2";

                    return (
                      <Col key={`${asOfDate}-${leg.key}`} xs={24} sm={24} md={12} lg={8}>
                        <Card
                          size="small"
                          title={renderTileTitle(leg.legType, leg.weekNumber, leg.entryDate, leg.closeDate ?? leg.finalExpiryDate)}
                          style={{ height: "100%", marginBottom: 0, background: tileBackground, borderColor: tileBorder }}
                          extra={<Tag color={displayStatus.color}>{displayStatus.label}</Tag>}
                        >
                          <Space direction="vertical" size={2} style={{ width: "100%" }}>
                            <div>
                              <Text strong>Entry: </Text>
                              <Text>{formatDate(leg.entryDate)} | Expiry: {formatDate(leg.finalExpiryDate)} | Strike: {formatCurrency(leg.strike)}</Text>
                            </div>
                            <div>
                              <Text strong>Rolls: </Text>
                              <Text>
                                {Array.from({ length: leg.rolledCount }).map((_, index) => (
                                  <StarFilled key={index} style={{ color: "#faad14", marginRight: 2 }} />
                                ))}
                                <span style={{ marginLeft: 4 }}>{leg.rolledCount}</span>
                                <span style={{ margin: "0 4px" }}>|</span>
                                Close: {formatDate(leg.closeDate)}
                              </Text>
                            </div>
                            <div>
                              <Text strong>Option px: </Text>
                              <Text>
                                Entry {formatCurrency(leg.entryPrice)}
                                <span style={{ margin: "0 4px" }}>|</span>
                                Close {formatCurrency(leg.closeOptionClosePrice)}
                              </Text>
                            </div>
                          </Space>
                        </Card>
                      </Col>
                    );
                  })}
                </Row>
              </Col>
            </Row>
          )}
        </Space>
      );
    });

    return { summaryRows, tiles };
  }, [activeDateFilter, closingPriceByDate, endDate, legs, startDate, stockTicker]);

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card title="Daily ATM Short Straddle Roll (Mon-Fri)">
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="Price-free output"
            description="Sells a call above spot and a put below spot each trading day using configurable percent offsets and configurable DTE window (with defaults). Rolls while in the money across 5-trading-day weekly phases using cached stock data."
          />

          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} lg={6}>
              <Text>Start Date</Text>
              <DatePicker
                value={dayjs(startDate)}
                onChange={(v) => {
                  const nextStartDate = v ? v.format("YYYY-MM-DD") : "";
                  setStartDate(nextStartDate);
                  setEndDate(nextStartDate ? getSimulationEndDate(nextStartDate, simulationDays, stockTicker.trim().toUpperCase()) : "");
                }}
                style={{ width: "100%", marginTop: 8 }}
              />
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Text>Trading Days</Text>
              <InputNumber
                min={1}
                max={365}
                value={simulationDays}
                onChange={(value) => {
                  const nextDays = typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
                  setSimulationDays(nextDays);
                  setEndDate(startDate ? getSimulationEndDate(startDate, nextDays, stockTicker.trim().toUpperCase()) : "");
                }}
                style={{ width: "100%", marginTop: 8 }}
              />
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Text>End Date</Text>
              <DatePicker value={endDate ? dayjs(endDate) : null} disabled style={{ width: "100%", marginTop: 8 }} />
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Text>Active On Date Filter</Text>
              <DatePicker
                value={activeDateFilter ? dayjs(activeDateFilter) : null}
                onChange={(v) => {
                  const nextValue = v ? v.format("YYYY-MM-DD") : "";
                  setActiveDateFilter(nextValue);

                  if (!nextValue) return;

                  const symbol = stockTicker.trim().toUpperCase();
                  if (!symbol) return;

                  void (async () => {
                    const normalizedStart = getFirstTradingDateOnOrAfter(nextValue) ?? nextValue;
                    const sectionDates = getAllTradingDatesInRange(normalizedStart, endDate, symbol);
                    const closePairs = await Promise.all(
                      sectionDates.map(async (date) => {
                        const stockResult = await fetchStockWithCache(symbol, date);
                        return [date, stockResult.closePrice] as const;
                      })
                    );

                    setClosingPriceByDate((previous) => ({
                      ...previous,
                      ...Object.fromEntries(closePairs.filter(([, closePrice]) => closePrice !== null)),
                    }));
                  })();
                }}
                style={{ width: "100%", marginTop: 8 }}
                placeholder="Show all dates"
              />
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Text>Stock ticker</Text>
              <Input
                value={stockTicker}
                onChange={(e) => {
                  const nextTicker = e.target.value.toUpperCase();
                  setStockTicker(nextTicker);
                  setEndDate(startDate ? getSimulationEndDate(startDate, simulationDays, nextTicker.trim().toUpperCase()) : "");
                }}
                style={{ marginTop: 8 }}
                placeholder="SPY"
              />
            </Col>

            <Col xs={24} md={12} lg={6}>
              <Text>Call % Above (optional)</Text>
              <InputNumber
                min={0}
                max={100}
                value={callStrikePercentAboveInput}
                onChange={(value) => setCallStrikePercentAboveInput(typeof value === "number" && Number.isFinite(value) ? value : null)}
                style={{ width: "100%", marginTop: 8 }}
                placeholder={`${DEFAULT_CALL_STRIKE_PERCENT_ABOVE}`}
              />
            </Col>

            <Col xs={24} md={12} lg={6}>
              <Text>Put % Below (optional)</Text>
              <InputNumber
                min={0}
                max={100}
                value={putStrikePercentBelowInput}
                onChange={(value) => setPutStrikePercentBelowInput(typeof value === "number" && Number.isFinite(value) ? value : null)}
                style={{ width: "100%", marginTop: 8 }}
                placeholder={`${DEFAULT_PUT_STRIKE_PERCENT_BELOW}`}
              />
            </Col>

            <Col xs={24} md={12} lg={6}>
              <Text>DTE Min (optional)</Text>
              <InputNumber
                min={1}
                max={365}
                value={dteMinDaysInput}
                onChange={(value) => setDteMinDaysInput(typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null)}
                style={{ width: "100%", marginTop: 8 }}
                placeholder={`${DEFAULT_DTE_MIN_DAYS}`}
              />
            </Col>

            <Col xs={24} md={12} lg={6}>
              <Text>DTE Max (optional)</Text>
              <InputNumber
                min={1}
                max={365}
                value={dteMaxDaysInput}
                onChange={(value) => setDteMaxDaysInput(typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null)}
                style={{ width: "100%", marginTop: 8 }}
                placeholder={`${DEFAULT_DTE_MAX_DAYS}`}
              />
            </Col>

            <Col xs={24} md={12} lg={6}>
              <Text>DTE Target (optional)</Text>
              <InputNumber
                min={1}
                max={365}
                value={dteTargetDaysInput}
                onChange={(value) => setDteTargetDaysInput(typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null)}
                style={{ width: "100%", marginTop: 8 }}
                placeholder={`${DEFAULT_DTE_TARGET_DAYS}`}
              />
            </Col>

            <Col xs={24} md={12} lg={6}>
              <Text>Max Active Calls/Puts (optional)</Text>
              <InputNumber
                min={1}
                max={100}
                value={maxActiveLegsPerTypeInput}
                onChange={(value) =>
                  setMaxActiveLegsPerTypeInput(
                    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null
                  )
                }
                style={{ width: "100%", marginTop: 8 }}
                placeholder={`${DEFAULT_MAX_ACTIVE_LEGS_PER_TYPE}`}
              />
            </Col>
          </Row>

          <Space>
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={loading}>
              Run Daily Straddle Simulation
            </Button>
            <Button onClick={handleSaveData} disabled={legs.length === 0}>
              Save Data
            </Button>
            <Button icon={<DownloadOutlined />} onClick={exportStaticDataToFile}>
              Download Static Data
            </Button>
          </Space>
        </Space>
      </Card>

      {error && <Alert type="error" showIcon message="Daily Straddle Error" description={error} />}

      {loading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin size="large" tip="Running simulation…" />
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">{`Processed ${runProgress.processed} of ${runProgress.total} trading dates | Phase ${runProgress.phase} of ${runProgress.totalPhases}`}</Text>
          </div>
        </div>
      )}

      {!loading && legs.length > 0 && (
        <Card title="Option Tiles">
          <Space size={8} style={{ marginBottom: 12 }}>
            <Button onClick={() => onOpenChartsTab?.()}>
              Charts
            </Button>
            <Button onClick={() => setShowSummary((previous) => !previous)}>
              {showSummary ? "Hide Summary" : "Show Summary"}
            </Button>
          </Space>

          {showSummary && (
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              columns={[
                { title: "Date", dataIndex: "date", key: "date" },
                {
                  title: "Close",
                  dataIndex: "closePrice",
                  key: "closePrice",
                  render: (value: number | null) => formatCurrency(value),
                },
                { title: "Newly Added", dataIndex: "newlyAddedOptions", key: "newlyAddedOptions" },
                                { title: "Cumulative closed", dataIndex: "cumulativeClosed", key: "cumulativeClosed" },
{ title: "Shown Options", dataIndex: "shownOptions", key: "shownOptions" },
                { title: "Active Options", dataIndex: "activeOptions", key: "activeOptions" },
                // { title: "Calls Active", dataIndex: "callsActive", key: "callsActive" },
                // { title: "Puts Active", dataIndex: "putsActive", key: "putsActive" },
                // { title: "Closed in this week", dataIndex: "closedInThisWeek", key: "closedInThisWeek" },
              ]}
              dataSource={sectionData.summaryRows}
              style={{ marginBottom: 16 }}
            />
          )}

          {sectionData.tiles}
        </Card>
      )}
    </Space>
  );
};

export default WeeklyStraddleRoll;
