import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Col, DatePicker, Input, InputNumber, Row, Space, Spin, Table, Tag, Typography, message } from "antd";
import { PlayCircleOutlined, StarFilled } from "@ant-design/icons";
import dayjs from "dayjs";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchStockOpenClose, type OptionOpenClose } from "../api/backtest";
import cachedData from "../assets/data.json";

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
}

interface CachedStockPrice extends OptionOpenClose {
  symbol: string;
  date: string;
}

interface DataFileStockPrice {
  symbol: string;
  date: string;
  openPrice?: number | null;
  closePrice?: number | null;
  delta?: number | null;
  theta?: number | null;
  statusCode?: number | null;
}

interface DailySummaryRow {
  key: string;
  date: string;
  closePrice: number | null;
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

type MasterStockData = Record<string, CachedStockPrice>;

const MASTER_STOCK_DATA_KEY = "masterStockData";
const WEEKLY_STRADDLE_RUN_DATA_KEY = "weeklyStraddleRunData";
const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const SPY_CLOSING_SERIES =
  (((cachedData as { "SPY-closing"?: Array<{ date: string; close: number | null }> })["SPY-closing"]) ?? []);
const SPY_CLOSING_DATES = SPY_CLOSING_SERIES.map((point) => point.date);
const SPY_CLOSING_BY_DATE = new Map(SPY_CLOSING_SERIES.map((point) => [point.date, point.close]));
const RAW_DATA_FILE_STOCK_DATA =
  ((cachedData as unknown as { masterStockData?: Record<string, DataFileStockPrice> }).masterStockData ?? {});
const DATA_FILE_STOCK_DATA: MasterStockData = Object.fromEntries(
  Object.entries(RAW_DATA_FILE_STOCK_DATA).map(([key, value]) => [
    key,
    {
      symbol: value.symbol,
      date: value.date,
      openPrice: value.openPrice ?? null,
      closePrice: value.closePrice ?? null,
      delta: value.delta ?? null,
      theta: value.theta ?? null,
      statusCode: value.statusCode ?? 200,
    } satisfies CachedStockPrice,
  ])
);
const LOCAL_STOCK_DATES_BY_SYMBOL = Object.entries(DATA_FILE_STOCK_DATA).reduce<Record<string, string[]>>(
  (acc, [cacheKey, value]) => {
    const [symbol, date] = cacheKey.split("|");
    if (!symbol || !date) return acc;
    if (value?.closePrice === null || value?.closePrice === undefined) return acc;
    if (!acc[symbol]) acc[symbol] = [];
    acc[symbol].push(date);
    return acc;
  },
  {}
);
Object.values(LOCAL_STOCK_DATES_BY_SYMBOL).forEach((dates) => dates.sort());
const DEFAULT_START_DATE = SPY_CLOSING_SERIES[0]?.date ?? "2025-01-02";
const DEFAULT_SIMULATION_DAYS = 125;
const TRADING_DAYS_PER_PHASE = 5;

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

  const localDates = LOCAL_STOCK_DATES_BY_SYMBOL[symbol] ?? [];
  if (localDates.length > 0) {
    return localDates.filter(
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

  const localDates = LOCAL_STOCK_DATES_BY_SYMBOL[symbol] ?? [];
  if (localDates.length > 0) {
    const startIndex = localDates.findIndex(
      (date) => dayjs(date).isSame(dayjs(normalizedStart), "day") || dayjs(date).isAfter(dayjs(normalizedStart), "day")
    );

    if (startIndex === -1) return [];
    return localDates.slice(startIndex, startIndex + totalDays);
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

const DEFAULT_END_DATE = getSimulationEndDate(DEFAULT_START_DATE, DEFAULT_SIMULATION_DAYS, "SPY");

const loadMasterStockData = (): MasterStockData => {
  try {
    const raw = localStorage.getItem(MASTER_STOCK_DATA_KEY);
    if (!raw) return { ...DATA_FILE_STOCK_DATA };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DATA_FILE_STOCK_DATA };
    return {
      ...DATA_FILE_STOCK_DATA,
      ...(parsed as MasterStockData),
    };
  } catch {
    return { ...DATA_FILE_STOCK_DATA };
  }
};

const saveMasterStockData = (data: MasterStockData) => {
  localStorage.setItem(MASTER_STOCK_DATA_KEY, JSON.stringify(data));
};

const saveWeeklyStraddleRunData = (data: WeeklyStraddleRunSnapshot) => {
  localStorage.setItem(WEEKLY_STRADDLE_RUN_DATA_KEY, JSON.stringify(data));
};

const loadWeeklyStraddleRunData = (): WeeklyStraddleRunSnapshot | null => {
  try {
    const raw = localStorage.getItem(WEEKLY_STRADDLE_RUN_DATA_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as WeeklyStraddleRunSnapshot;
  } catch {
    return null;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WeeklyStraddleRoll: React.FC = () => {
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState(DEFAULT_END_DATE);
  const [simulationDays, setSimulationDays] = useState(DEFAULT_SIMULATION_DAYS);
  const [activeDateFilter, setActiveDateFilter] = useState("");
  const [stockTicker, setStockTicker] = useState("SPY");
  const [loading, setLoading] = useState(false);
  const [runProgress, setRunProgress] = useState<{ processed: number; total: number; phase: number; totalPhases: number }>({
    processed: 0,
    total: 0,
    phase: 0,
    totalPhases: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [legs, setLegs] = useState<WeeklyStraddleLeg[]>([]);
  const [closingPriceByDate, setClosingPriceByDate] = useState<Record<string, number | null>>({});
  const masterStockDataRef = useRef<MasterStockData>(loadMasterStockData());
  const pendingStockRequestsRef = useRef<Record<string, Promise<CachedStockPrice>>>({});

  useEffect(() => {
    const savedRun = loadWeeklyStraddleRunData();
    if (!savedRun) return;

    const restoredSymbol = savedRun.symbol || "SPY";
    const restoredStartDate = savedRun.startDate || DEFAULT_START_DATE;

    setStockTicker(restoredSymbol);
    setStartDate(restoredStartDate);
    setSimulationDays(DEFAULT_SIMULATION_DAYS);
    setEndDate(getSimulationEndDate(restoredStartDate, DEFAULT_SIMULATION_DAYS, restoredSymbol));
    setClosingPriceByDate(savedRun.closingPriceByDate ?? {});
    setLegs(savedRun.legs ?? []);

    const restoredTradeCount = Math.max(0, Math.floor((savedRun.legs?.length ?? 0) / 2));
    const restoredTotalPhases = Math.max(1, Math.ceil(restoredTradeCount / TRADING_DAYS_PER_PHASE));
    setRunProgress({
      processed: restoredTradeCount,
      total: restoredTradeCount,
      phase: restoredTotalPhases,
      totalPhases: restoredTotalPhases,
    });
  }, []);

  const fetchWithRateLimitRetry = async <T extends { statusCode: number | null }>(
    work: () => Promise<T>,
    options?: { stopOnRateLimit?: boolean }
  ) => {
    let response = await work();

    if (response.statusCode === 429 && options?.stopOnRateLimit) {
      throw new Error("Rate limit hit (429). Run stopped. Please wait and try again.");
    }

    let attempts = 0;
    while (response.statusCode === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      attempts += 1;
      message.warning(`Rate limit hit (429). Waiting ${RATE_LIMIT_WAIT_MS / 1000} seconds before retry ${attempts}.`);
      await sleep(RATE_LIMIT_WAIT_MS);
      response = await work();
    }
    return response;
  };

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

    // If this symbol exists in bundled local data, avoid external calls and rely only on local coverage.
    const hasLocalSymbolCoverage = Boolean(LOCAL_STOCK_DATES_BY_SYMBOL[symbol]?.length);
    if (hasLocalSymbolCoverage) {
      return {
        symbol,
        date,
        openPrice: null,
        closePrice: null,
        delta: null,
        theta: null,
        statusCode: 200,
      };
    }

    const pending = pendingStockRequestsRef.current[cacheKey];
    if (pending) return pending;

    const request = (async () => {
      try {
        const stockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(symbol, date), {
          stopOnRateLimit: true,
        });

        if (stockData.statusCode === 429) {
          throw new Error("Rate limit was hit repeatedly while fetching stock prices. Please wait a minute and try again.");
        }

        if (stockData.statusCode === null) {
          throw new Error("Stock price service is unavailable right now. Please retry shortly.");
        }

        const result: CachedStockPrice = { symbol, date, ...stockData };

        if (stockData.statusCode >= 200 && stockData.statusCode < 300 && stockData.closePrice !== null) {
          masterStockDataRef.current[cacheKey] = result;
          saveMasterStockData(masterStockDataRef.current);
        }

        return result;
      } finally {
        delete pendingStockRequestsRef.current[cacheKey];
      }
    })();

    pendingStockRequestsRef.current[cacheKey] = request;
    return request;
  };

  const simulateLeg = async (
    weekNumber: number,
    legType: LegType,
    entryDate: string,
    initialExpiryDate: string,
    strike: number,
    rangeEndDate: string
  ): Promise<WeeklyStraddleLeg> => {
    const maxMonitorDate = dayjs(rangeEndDate);
    let currentExpiryDate = initialExpiryDate;
    let rolledCount = 0;
    let closeDate: string | null = null;
    let currentDate = entryDate;

    while (!dayjs(currentDate).isAfter(maxMonitorDate, "day")) {
      const stockResult = await fetchStockWithCache(stockTicker.trim().toUpperCase(), currentDate);
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
        currentExpiryDate = nextDate;
        currentDate = nextDate;
        continue;
      }

      closeDate = currentDate;
      break;
    }

    if (!closeDate) {
      closeDate = currentDate;
    }

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

          const strike = roundToNearestFive(entryPrice);
          const initialExpiryDate = getNextTradingDate(entryDate) ?? entryDate;
          const tradeNumber = phaseStart + offset + 1;

          const [callLeg, putLeg] = await Promise.all([
            simulateLeg(tradeNumber, "Call", entryDate, initialExpiryDate, strike, effectiveEndDate),
            simulateLeg(tradeNumber, "Put", entryDate, initialExpiryDate, strike, effectiveEndDate),
          ]);

          results.push(callLeg, putLeg);
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
      saveWeeklyStraddleRunData({
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
        message.success("Stored weekly straddle run data as JSON in localStorage");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run daily straddle simulation");
    } finally {
      setRunProgress((previous) => ({ ...previous, processed: previous.total, phase: previous.totalPhases }));
      setLoading(false);
    }
  };

  const sectionData = useMemo(() => {
    if (legs.length === 0) {
      return { summaryRows: [] as DailySummaryRow[], tiles: [] as React.ReactNode[] };
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
      const shownOptionCount = optionsInWeek.length;

      return {
        key: asOfDate,
        date: asOfDate,
        closePrice,
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

  const optionsTrendData = useMemo(
    () =>
      sectionData.summaryRows.map((row) => ({
        date: row.date,
        openedOptions: legs.filter((leg) => leg.entryDate === row.date).length,
        closedOptions: legs.filter((leg) => leg.closeDate === row.date).length,
        activeOptions: row.activeOptions,
      })),
    [sectionData.summaryRows, legs]
  );

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card title="Daily ATM Short Straddle Roll (Mon-Fri)">
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="Price-free output"
            description="Sells an ATM call and put each trading day, uses 1-trading-day expiry, rolls forward by 1 day while in the money, and runs in 5-trading-day weekly phases using cached stock data."
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
          </Row>

          <Space>
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={loading}>
              Run Daily Straddle Simulation
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
          <div style={{ width: "100%", height: 320, marginBottom: 16 }}>
            <ResponsiveContainer>
              <LineChart data={optionsTrendData} margin={{ top: 8, right: 20, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="openedOptions" name="Opened" stroke="#1677ff" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="closedOptions" name="Closed" stroke="#ff4d4f" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="activeOptions" name="Active" stroke="#52c41a" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
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
              { title: "Shown Options", dataIndex: "shownOptions", key: "shownOptions" },
              { title: "Active Options", dataIndex: "activeOptions", key: "activeOptions" },
              { title: "Calls Active", dataIndex: "callsActive", key: "callsActive" },
              { title: "Puts Active", dataIndex: "putsActive", key: "putsActive" },
              { title: "Closed in this week", dataIndex: "closedInThisWeek", key: "closedInThisWeek" },
              { title: "Cumulative closed", dataIndex: "cumulativeClosed", key: "cumulativeClosed" },
            ]}
            dataSource={sectionData.summaryRows}
          />
          {sectionData.tiles}
        </Card>
      )}
    </Space>
  );
};

export default WeeklyStraddleRoll;
