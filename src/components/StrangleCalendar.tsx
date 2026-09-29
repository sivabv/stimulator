import React, { useEffect, useEffectEvent, useState } from "react";
import { Alert, Button, Card, Col, DatePicker, Input, InputNumber, Modal, Row, Space, Table, Typography, message } from "antd";
import dayjs from "dayjs";
import { CloudUploadOutlined, GoogleOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { fetchOptionOpenClose, fetchStockOpenClose } from "../api/backtest";
import { appendCallCalendarSimulationResult, isSimulationResultsApiConfigured } from "../api/simulationResults";
import tradingDatesJson from "../assets/trading_dates_2026.json";
import spyClosingData from "../assets/spy-closing.json";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const { Text } = Typography;

interface StrangleCalendarRow {
  key: string;
  date: string;
  stockPrice: number | null;
  callStrike: number;
  putStrike: number;
  shortCallPrice: number | null;
  longCallPrice: number | null;
  shortPutPrice: number | null;
  longPutPrice: number | null;
  positionValue: number | null;
  pnl: number | null;
  shortExpiryDate: string;
  status: "active" | "rolled" | "expired";
}

interface StrangleRollInstruction {
  fromDate: string;
  shortExpiryDate: string;
  strike: number;
  rollCreditDebit: number | null;
}

interface StrangleBatchResult {
  key: string;
  startDate: string;
  endDate: string | null;
  pnl: number | null;
  error: string | null;
}

interface StrangleSummary {
  startDate: string;
  endDate: string;
  stockStartPrice: number;
  stockEndPrice: number | null;
  stockReturn: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  stopReason: string | null;
}

const fullTradingDatesFromSpy = (spyClosingData as Array<{ date?: string }>)
  .map((entry) => (typeof entry.date === "string" ? entry.date : null))
  .filter((value): value is string => Boolean(value) && dayjs(value).isValid());

const tradingDates = Array.from(
  new Set([...(tradingDatesJson as string[]), ...fullTradingDatesFromSpy])
).filter((value) => dayjs(value).isValid())
  .sort((left, right) => dayjs(left).valueOf() - dayjs(right).valueOf());

const OPTION_PRICE_FALLBACK_WINDOW_DAYS = 5;
const OPTION_CACHE_STORAGE_KEY = "strangleCalendarOptionCache";
const OPTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const GOOGLE_SHEETS_URL = import.meta.env.VITE_GOOGLE_SHEETS_URL?.trim() ||
  "https://docs.google.com/spreadsheets/d/1aAN8mmMhXhlG7jmqO62DvEothIz2ELW4JWpLSRMbX7Y/edit";
type CachedOptionQuote = { data: Awaited<ReturnType<typeof fetchOptionOpenClose>>; fetchedAt: number };
const optionQuoteCache = new Map<string, CachedOptionQuote>();
const roundToNearestFive = (value: number): number => Math.round(value / 5) * 5;
const formatCurrency = (value: number | null): string =>
  value === null || !Number.isFinite(value)
    ? "-"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value);

const getFirstTradingDateOnOrAfter = (date: string): string | null =>
  tradingDates.find((candidate) => !dayjs(candidate).isBefore(dayjs(date), "day")) ?? null;

try {
  const savedCache = JSON.parse(localStorage.getItem(OPTION_CACHE_STORAGE_KEY) ?? "[]") as Array<[string, CachedOptionQuote]>;
  savedCache.forEach(([key, value]) => {
    if (value && Date.now() - value.fetchedAt < OPTION_CACHE_TTL_MS) optionQuoteCache.set(key, value);
  });
} catch {
  optionQuoteCache.clear();
}

const fetchExactOptionWithCache = async (
  symbol: string,
  expiry: string,
  strike: number,
  type: "C" | "P",
  date: string
) => {
  const cacheKey = `${symbol}|${expiry}|${strike}|${type}|${date}`;
  const cached = optionQuoteCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < OPTION_CACHE_TTL_MS) return cached.data;

  let data = await fetchOptionOpenClose(symbol, expiry, strike, type, date);
  let retries = 0;
  while (data.statusCode === 429 && retries < MAX_RATE_LIMIT_RETRIES) {
    retries += 1;
    message.warning(`Rate limit hit (429). Waiting 65 seconds before retry ${retries}.`);
    await new Promise((resolve) => window.setTimeout(resolve, RATE_LIMIT_WAIT_MS));
    data = await fetchOptionOpenClose(symbol, expiry, strike, type, date);
  }
  if (data.statusCode !== 429) optionQuoteCache.set(cacheKey, { data, fetchedAt: Date.now() });
  try {
    localStorage.setItem(OPTION_CACHE_STORAGE_KEY, JSON.stringify(Array.from(optionQuoteCache.entries()).slice(-2000)));
  } catch {
    optionQuoteCache.clear();
    optionQuoteCache.set(cacheKey, { data, fetchedAt: Date.now() });
  }
  return data;
};

const fetchOptionWithDateFallback = async (
  symbol: string,
  expiry: string,
  strike: number,
  type: "C" | "P",
  date: string
) => {
  const exactData = await fetchExactOptionWithCache(symbol, expiry, strike, type, date);
  if (exactData.closePrice !== null || exactData.statusCode === 429) return exactData;

  const targetDate = dayjs(date);
  const candidates = tradingDates
    .map((candidateDate) => ({
      date: candidateDate,
      offsetDays: dayjs(candidateDate).diff(targetDate, "day"),
    }))
    .filter(
      ({ offsetDays }) =>
        offsetDays !== 0 && Math.abs(offsetDays) <= OPTION_PRICE_FALLBACK_WINDOW_DAYS
    )
    .sort(
      (left, right) =>
        Math.abs(left.offsetDays) - Math.abs(right.offsetDays) ||
        left.offsetDays - right.offsetDays
    );

  for (const candidate of candidates) {
    const nearbyData = await fetchExactOptionWithCache(
      symbol,
      expiry,
      strike,
      type,
      candidate.date
    );
    if (nearbyData.closePrice !== null || nearbyData.statusCode === 429) return nearbyData;
  }

  return exactData;
};

const StrangleCalendar: React.FC = () => {
  const routeParams = new URLSearchParams(window.location.search);
  const routeTargetsThisTab = routeParams.get("tab") === "strangle-calendar";
  const [ticker, setTicker] = useState(routeTargetsThisTab ? routeParams.get("ticker")?.toUpperCase() ?? "SPY" : "SPY");
  const [startDate, setStartDate] = useState(routeTargetsThisTab ? routeParams.get("start") ?? "2026-01-02" : "2026-01-02");
  const [shortExpiryDate, setShortExpiryDate] = useState(routeTargetsThisTab ? routeParams.get("shortExpiry") ?? "2026-01-30" : "2026-01-30");
  const [longExpiryDate, setLongExpiryDate] = useState(routeTargetsThisTab ? routeParams.get("longExpiry") ?? "2026-12-18" : "2026-12-18");
  const [strike, setStrike] = useState<number | null>(null);
  const [rows, setRows] = useState<StrangleCalendarRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<StrangleSummary | null>(null);
  const [batchStartDatesText, setBatchStartDatesText] = useState("");
  const [batchResults, setBatchResults] = useState<StrangleBatchResult[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [showChart, setShowChart] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [processedCount, setProcessedCount] = useState(0);
  const [checkpointDate, setCheckpointDate] = useState("");
  const [manualRolls, setManualRolls] = useState<StrangleRollInstruction[]>([]);
  const [rollModalOpen, setRollModalOpen] = useState(false);
  const [rollTargetRow, setRollTargetRow] = useState<StrangleCalendarRow | null>(null);
  const [rollExpiryDate, setRollExpiryDate] = useState("");
  const [rollStrike, setRollStrike] = useState(0);
  const [rollCreditDebit, setRollCreditDebit] = useState<number | null>(null);
  const [autoRollWeekly, setAutoRollWeekly] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const runSimulation = async (
    overrideStartDate?: string,
    publish = false,
    rolls: StrangleRollInstruction[] = manualRolls
  ) => {
    setError(null);
    setRows([]);
    setSummary(null);
    setLoading(true);

    try {
      const symbol = ticker.trim().toUpperCase();
      const effectiveStartDate = overrideStartDate ?? startDate;
      if (!symbol) throw new Error("Stock ticker is required");
      if (!dayjs(effectiveStartDate).isValid()) throw new Error("Start date is invalid");

      const firstDate = getFirstTradingDateOnOrAfter(effectiveStartDate);
      if (!firstDate) throw new Error("No trading date found on or after the start date");
      if (!dayjs(shortExpiryDate).isAfter(dayjs(firstDate), "day")) {
        throw new Error("Short expiry must be after the first trading date");
      }
      if (!dayjs(longExpiryDate).isAfter(dayjs(shortExpiryDate), "day")) {
        throw new Error("Long expiry must be after short expiry");
      }

      const openingStock = await fetchStockOpenClose(symbol, firstDate);
      if (openingStock.closePrice === null) {
        throw new Error(`No stock close price found for ${symbol} on ${firstDate}`);
      }

      const resolvedStrike = roundToNearestFive(strike ?? openingStock.closePrice);
      if (resolvedStrike <= 0) {
        throw new Error("Strike must be greater than zero");
      }

      const effectiveRolls = [...rolls].filter((roll) =>
        !dayjs(roll.fromDate).isBefore(dayjs(firstDate), "day")
      ).sort((left, right) => dayjs(left.fromDate).valueOf() - dayjs(right.fromDate).valueOf());
      const simulationEndDate = autoRollWeekly
        ? longExpiryDate
        : effectiveRolls.reduce((latest, roll) =>
            dayjs(roll.shortExpiryDate).isAfter(dayjs(latest), "day") ? roll.shortExpiryDate : latest,
          shortExpiryDate);
      const dates = tradingDates.filter((date) => {
        const current = dayjs(date);
        return (
          !current.isBefore(dayjs(firstDate), "day") &&
          !current.isAfter(dayjs(simulationEndDate), "day") &&
          (current.day() === 5 || effectiveRolls.some((roll) => dayjs(roll.fromDate).isSame(current, "day")) ||
            current.isSame(dayjs(shortExpiryDate), "day") ||
            effectiveRolls.some((roll) => dayjs(roll.shortExpiryDate).isSame(current, "day")))
        );
      });
      if (dates.length === 0) throw new Error("No simulation dates found before short expiry");

      const nextRows: StrangleCalendarRow[] = [];
      let openingPositionValue: number | null = null;
      const longExpiry = dayjs(longExpiryDate).format("YYMMDD");
      let activeShortExpiryDate = shortExpiryDate;
      let activeStrike = resolvedStrike;
      let realisedRollCreditDebit = 0;
      let autoRollStoppedReason: string | null = null;

      for (const date of dates) {
        const rollForToday = effectiveRolls.find((roll) => dayjs(roll.fromDate).isSame(dayjs(date), "day"));
        if (rollForToday) {
          activeShortExpiryDate = rollForToday.shortExpiryDate;
          activeStrike = rollForToday.strike;
          realisedRollCreditDebit += rollForToday.rollCreditDebit ?? 0;
        }
        const shortExpiry = dayjs(activeShortExpiryDate).format("YYMMDD");
        const [stock, shortCall, longCall, shortPut, longPut] = await Promise.all([
          fetchStockOpenClose(symbol, date),
          fetchOptionWithDateFallback(symbol, shortExpiry, activeStrike, "C", date),
          fetchOptionWithDateFallback(symbol, longExpiry, resolvedStrike, "C", date),
          fetchOptionWithDateFallback(symbol, shortExpiry, activeStrike, "P", date),
          fetchOptionWithDateFallback(symbol, longExpiry, resolvedStrike, "P", date),
        ]);

        const optionPrices = [
          shortCall.closePrice,
          longCall.closePrice,
          shortPut.closePrice,
          longPut.closePrice,
        ];
        const positionValue = optionPrices.every((price) => price !== null)
          ? (longCall.closePrice ?? 0) + (longPut.closePrice ?? 0) -
            (shortCall.closePrice ?? 0) - (shortPut.closePrice ?? 0)
          : null;
        if (openingPositionValue === null && positionValue !== null) {
          openingPositionValue = positionValue;
        }

        nextRows.push({
          key: date,
          date,
          stockPrice: stock.closePrice,
          callStrike: activeStrike,
          putStrike: activeStrike,
          shortCallPrice: shortCall.closePrice,
          longCallPrice: longCall.closePrice,
          shortPutPrice: shortPut.closePrice,
          longPutPrice: longPut.closePrice,
          positionValue,
          pnl: positionValue !== null && openingPositionValue !== null
            ? realisedRollCreditDebit + positionValue - openingPositionValue
            : null,
          shortExpiryDate: activeShortExpiryDate,
          status: rollForToday
            ? "rolled"
            : dayjs(date).isSame(dayjs(activeShortExpiryDate), "day") ? "expired" : "active",
        });

        const daysUntilShortExpiry = dayjs(activeShortExpiryDate).diff(dayjs(date), "day");
        if (autoRollWeekly && daysUntilShortExpiry >= 0 && daysUntilShortExpiry < 10) {
          const nextFriday = tradingDates.find((candidate) =>
            dayjs(candidate).day() === 5 && dayjs(candidate).isAfter(dayjs(date), "day")
          );
          const alreadyScheduled = nextFriday && effectiveRolls.some((roll) =>
            dayjs(roll.fromDate).isSame(dayjs(nextFriday), "day")
          );
          if (!nextFriday || alreadyScheduled) {
            if (!nextFriday) autoRollStoppedReason = `Auto roll stopped after ${date}: no next Friday is available.`;
          } else {
            const candidates = tradingDates.filter((candidate) =>
              dayjs(candidate).isAfter(dayjs(nextFriday), "day") &&
              dayjs(candidate).isBefore(dayjs(longExpiryDate), "day")
            );
            let selectedRoll: StrangleRollInstruction | null = null;
            const currentShortPremium = shortCall.closePrice !== null && shortPut.closePrice !== null
              ? shortCall.closePrice + shortPut.closePrice
              : null;
            for (const candidateExpiry of candidates) {
              if (currentShortPremium === null) break;
              const formattedExpiry = dayjs(candidateExpiry).format("YYMMDD");
              const [candidateCall, candidatePut] = await Promise.all([
                fetchOptionWithDateFallback(symbol, formattedExpiry, activeStrike, "C", date),
                fetchOptionWithDateFallback(symbol, formattedExpiry, activeStrike, "P", date),
              ]);
              if (candidateCall.closePrice === null || candidatePut.closePrice === null) continue;
              const credit = candidateCall.closePrice + candidatePut.closePrice - currentShortPremium;
              if (credit >= 0.2) {
                selectedRoll = {
                  fromDate: nextFriday,
                  shortExpiryDate: candidateExpiry,
                  strike: activeStrike,
                  rollCreditDebit: credit,
                };
                break;
              }
            }
            if (selectedRoll) {
              effectiveRolls.push(selectedRoll);
              effectiveRolls.sort((left, right) => dayjs(left.fromDate).valueOf() - dayjs(right.fromDate).valueOf());
            } else {
              autoRollStoppedReason = `Auto roll stopped after ${date}: no paired call/put roll met the minimum credit.`;
            }
          }
        }
        if (autoRollStoppedReason) break;
      }

      setStrike(resolvedStrike);
      setRows(nextRows);
      setProcessedCount(nextRows.length);
      const lastRow = nextRows.at(-1);
      const firstPricedRow = nextRows.find((row) => row.positionValue !== null);
      const finalPnl = lastRow?.pnl ?? null;
      const optionInvestment = firstPricedRow?.positionValue === undefined || firstPricedRow.positionValue === null
        ? null
        : Math.abs(firstPricedRow.positionValue);
      const nextSummary: StrangleSummary = {
        startDate: firstDate,
        endDate: lastRow?.date ?? firstDate,
        stockStartPrice: openingStock.closePrice,
        stockEndPrice: lastRow?.stockPrice ?? null,
        stockReturn: lastRow?.stockPrice !== null && lastRow?.stockPrice !== undefined
          ? lastRow.stockPrice - openingStock.closePrice
          : null,
        pnl: finalPnl,
        pnlPercent: finalPnl !== null && optionInvestment !== null && optionInvestment > 0
          ? (finalPnl / optionInvestment) * 100
          : null,
        stopReason: autoRollStoppedReason,
      };
      setSummary(nextSummary);
      if (lastRow) {
        const checkpoint = {
          date: lastRow.date,
          callStrike: resolvedStrike,
          putStrike: resolvedStrike,
          positionValue: lastRow.positionValue,
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem("strangleCalendarAutoSavedCheckpoint", JSON.stringify(checkpoint));
        setCheckpointDate(lastRow.date);
      }
      if (nextRows.every((row) => row.positionValue === null)) {
        message.warning("No complete four-leg option prices were found for these dates.");
      }
      if (publish) {
        if (!isSimulationResultsApiConfigured()) {
          message.warning("Simulation completed, but the Google Sheets results API is not configured.");
        } else {
          await appendCallCalendarSimulationResult({
            recordedAt: new Date().toISOString(),
            strategy: "Strangle Calendar",
            ticker: symbol,
            requestedStartDate: effectiveStartDate,
            actualStartDate: firstDate,
            endDate: nextSummary.endDate,
            shortExpiryDate,
            sellExpiryDate: null,
            longExpiryDate,
            shortStrike: resolvedStrike,
            sellStrike: null,
            longStrike: resolvedStrike,
            fivePercentStrike: false,
            autoRoll: autoRollWeekly,
            processedDays: nextRows.length,
            stockStartPrice: nextSummary.stockStartPrice,
            stockEndPrice: nextSummary.stockEndPrice,
            stockReturn: nextSummary.stockReturn,
            stockReturnPct: nextSummary.stockReturn && nextSummary.stockStartPrice
              ? (nextSummary.stockReturn / nextSummary.stockStartPrice) * 100
              : null,
            optionInvestment,
            optionStrategyReturn: finalPnl ?? 0,
            optionStrategyReturnPct: nextSummary.pnlPercent,
            stopReason: autoRollStoppedReason,
            sourceUrl: window.location.href,
            inputParams: Object.fromEntries(new URL(window.location.href).searchParams.entries()),
            gridData: { rows: nextRows.map((row) => ({ ...row })) },
            resultSummary: {
              startDate: nextSummary.startDate,
              endDate: nextSummary.endDate,
              stockStartPrice: nextSummary.stockStartPrice,
              stockEndPrice: nextSummary.stockEndPrice,
              optionInvestment,
              stockReturn: nextSummary.stockReturn,
              stockReturnPct: nextSummary.stockReturn && nextSummary.stockStartPrice
                ? (nextSummary.stockReturn / nextSummary.stockStartPrice) * 100
                : null,
              optionStrategyReturn: finalPnl ?? 0,
              optionStrategyReturnPct: nextSummary.pnlPercent,
            },
          });
          message.success("Strangle calendar result sent to Google Sheets.");
        }
      }
      return nextSummary;
    } catch (simulationError) {
      const messageText = simulationError instanceof Error
        ? simulationError.message
        : "Failed to run strangle calendar simulation";
      setError(messageText);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const openRollModal = (row: StrangleCalendarRow) => {
    const defaultExpiry = tradingDates.find((date) =>
      dayjs(date).isAfter(dayjs(row.shortExpiryDate), "day")
    ) ?? "";
    setRollTargetRow(row);
    setRollExpiryDate(defaultExpiry);
    setRollStrike(row.callStrike);
    setRollCreditDebit(null);
    setRollModalOpen(true);
    if (defaultExpiry) void previewManualRoll(row, defaultExpiry, row.callStrike);
  };

  const previewManualRoll = async (
    row: StrangleCalendarRow,
    expiryDate: string,
    nextStrike: number
  ) => {
    if (!expiryDate || nextStrike <= 0) {
      setRollCreditDebit(null);
      return;
    }
    try {
      const symbol = ticker.trim().toUpperCase();
      const expiry = dayjs(expiryDate).format("YYMMDD");
      const roundedStrike = roundToNearestFive(nextStrike);
      const [nextCall, nextPut] = await Promise.all([
        fetchOptionWithDateFallback(symbol, expiry, roundedStrike, "C", row.date),
        fetchOptionWithDateFallback(symbol, expiry, roundedStrike, "P", row.date),
      ]);
      const oldPremium = row.shortCallPrice !== null && row.shortPutPrice !== null
        ? row.shortCallPrice + row.shortPutPrice
        : null;
      setRollCreditDebit(nextCall.closePrice !== null && nextPut.closePrice !== null && oldPremium !== null
        ? nextCall.closePrice + nextPut.closePrice - oldPremium
        : null);
    } catch {
      setRollCreditDebit(null);
    }
  };

  const confirmManualRoll = async () => {
    if (!rollTargetRow || !dayjs(rollExpiryDate).isValid()) {
      message.error("Choose a valid short expiry date for the paired roll.");
      return;
    }
    if (rollStrike <= 0) {
      message.error("Strike must be greater than zero.");
      return;
    }
    const nextFriday = tradingDates.find((date) =>
      dayjs(date).day() === 5 && dayjs(date).isAfter(dayjs(rollTargetRow.date), "day")
    );
    if (!nextFriday) {
      message.error("No next Friday trading date is available for this roll.");
      return;
    }
    if (!dayjs(rollExpiryDate).isAfter(dayjs(nextFriday), "day") ||
        !dayjs(rollExpiryDate).isBefore(dayjs(longExpiryDate), "day")) {
      message.error("New short expiry must be after the roll date and before the long expiry.");
      return;
    }
    if (rollCreditDebit === null) {
      message.error("A complete paired premium preview is required before scheduling the roll.");
      return;
    }
    const updatedRolls = [
      ...manualRolls.filter((roll) => !dayjs(roll.fromDate).isSame(dayjs(nextFriday), "day")),
      {
        fromDate: nextFriday,
        shortExpiryDate: rollExpiryDate,
        strike: roundToNearestFive(rollStrike),
        rollCreditDebit,
      },
    ].sort((left, right) => dayjs(left.fromDate).valueOf() - dayjs(right.fromDate).valueOf());
    setManualRolls(updatedRolls);
    setRollModalOpen(false);
    await runSimulation(undefined, false, updatedRolls);
  };

  const parseBatchDates = (value: string): string[] => Array.from(new Set(
    value.split(/[\n,]+/)
      .map((item) => item.trim())
      .filter((item) => item && dayjs(item).isValid())
      .map((item) => dayjs(item).format("YYYY-MM-DD"))
  )).sort((left, right) => dayjs(left).valueOf() - dayjs(right).valueOf());

  const runBatch = async () => {
    const dates = parseBatchDates(batchStartDatesText);
    if (dates.length === 0) {
      message.warning("Enter at least one valid start date.");
      return;
    }
    setBatchRunning(true);
    setBatchResults([]);
    setBatchProgress({ current: 0, total: dates.length });
    for (let index = 0; index < dates.length; index += 1) {
      const date = dates[index];
      try {
        const result = await runSimulation(date, false, []);
        setBatchResults((previous) => [...previous, {
          key: date,
          startDate: date,
          endDate: result?.endDate ?? null,
          pnl: result?.pnl ?? null,
          error: result ? null : "Simulation failed; see the error message above.",
        }]);
      } catch (batchError) {
        setBatchResults((previous) => [...previous, {
          key: date,
          startDate: date,
          endDate: null,
          pnl: null,
          error: batchError instanceof Error ? batchError.message : "Batch run failed",
        }]);
      } finally {
        setBatchProgress({ current: index + 1, total: dates.length });
      }
    }
    setBatchRunning(false);
    message.success(`Batch run complete: ${dates.length} simulation(s) processed.`);
  };

  const handlePublish = async () => {
    await runSimulation(undefined, true);
  };

  const runAutoSimulation = useEffectEvent(() => {
    void runSimulation();
  });

  useEffect(() => {
    try {
      const checkpoint = JSON.parse(localStorage.getItem("strangleCalendarAutoSavedCheckpoint") ?? "null");
      if (checkpoint && typeof checkpoint.date === "string") setCheckpointDate(checkpoint.date);
    } catch {
      setCheckpointDate("");
    }
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") !== "strangle-calendar" ||
        !["true", "1"].includes(url.searchParams.get("run") ?? "")) return;
    url.searchParams.delete("run");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    runAutoSimulation();
  }, []);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card title="Strangle Calendar">
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={4}>
            <Text>Ticker</Text>
            <Input
              value={ticker}
              onChange={(event) => setTicker(event.target.value.toUpperCase())}
              style={{ marginTop: 8 }}
            />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Text>Start Date</Text>
            <DatePicker
              value={dayjs(startDate)}
              onChange={(value) => setStartDate(value?.format("YYYY-MM-DD") ?? "")}
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Text>Short Expiry</Text>
            <DatePicker
              value={shortExpiryDate ? dayjs(shortExpiryDate) : null}
              onChange={(value) => setShortExpiryDate(value?.format("YYYY-MM-DD") ?? "")}
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Text>Long Expiry</Text>
            <DatePicker
              value={longExpiryDate ? dayjs(longExpiryDate) : null}
              onChange={(value) => setLongExpiryDate(value?.format("YYYY-MM-DD") ?? "")}
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Text>Call Strike</Text>
            <InputNumber
              value={strike}
              onChange={(value) => setStrike(value === null ? null : roundToNearestFive(value))}
              min={5}
              step={5}
              placeholder="Auto: ATM, rounded to $5"
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
        </Row>
        <Space wrap style={{ marginTop: 16 }}>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => void runSimulation()} loading={loading}>
            Run Strangle Calendar
          </Button>
          <Button icon={<CloudUploadOutlined />} onClick={() => void handlePublish()} disabled={loading}>
            Publish
          </Button>
          <Button icon={<GoogleOutlined />} href={GOOGLE_SHEETS_URL} target="_blank" rel="noopener noreferrer">
            Google Sheets
          </Button>
          <Button onClick={() => setGuideOpen(true)} disabled={loading}>User Guide</Button>
          <Button onClick={() => setShowChart((value) => !value)} disabled={loading}>
            {showChart ? "Hide Chart" : "Show Chart"}
          </Button>
          <Button onClick={() => setShowGrid((value) => !value)} disabled={loading}>
            {showGrid ? "Hide Grid" : "Show Grid"}
          </Button>
          <Button
            type={autoRollWeekly ? "primary" : "default"}
            onClick={() => setAutoRollWeekly((value) => !value)}
            disabled={loading}
          >
            Auto Roll Weekly: {autoRollWeekly ? "ON" : "OFF"}
          </Button>
        </Space>
        <Space direction="vertical" size={8} style={{ width: "100%", marginTop: 16 }}>
          <Text strong>Batch Run (Sequential)</Text>
          <Input.TextArea
            value={batchStartDatesText}
            onChange={(event) => setBatchStartDatesText(event.target.value)}
            placeholder={"One start date per line, e.g.\n2025-01-03\n2025-01-10"}
            autoSize={{ minRows: 2, maxRows: 5 }}
            disabled={batchRunning}
          />
          <Space wrap>
            <Button icon={<PlayCircleOutlined />} onClick={() => void runBatch()} loading={batchRunning} disabled={loading}>
              Run Sequentially
            </Button>
            {batchProgress && <Text type="secondary">Batch progress: {batchProgress.current}/{batchProgress.total}</Text>}
          </Space>
        </Space>
        <Text type="secondary" style={{ display: "block", marginTop: 8 }}>
          Processed simulations: {processedCount} | Auto-saved checkpoint: {checkpointDate || "-"}
        </Text>
      </Card>

      {error && <Alert type="error" showIcon message="Strangle Calendar Error" description={error} />}

      {rows.length > 0 && (
        <>
          {summary && <Card title="Summary">
            <Space wrap size={24}>
              <Text>Processed dates: {rows.length}</Text>
              <Text>Start / end: {summary.startDate} / {summary.endDate}</Text>
              <Text>Stock return: {formatCurrency(summary.stockReturn)}</Text>
              <Text>Shared call/put strike: {formatCurrency(rows[0].callStrike)}</Text>
              <Text>Combined P&amp;L: {formatCurrency(summary.pnl)}</Text>
              <Text>Combined return: {summary.pnlPercent === null ? "-" : `${summary.pnlPercent.toFixed(2)}%`}</Text>
              {summary.stopReason && <Text type="secondary">{summary.stopReason}</Text>}
            </Space>
          </Card>}
          {showChart && <Card title="Option Price and Return Chart">
            <div style={{ width: "100%", height: 360 }}>
              <ResponsiveContainer>
                <LineChart data={rows} margin={{ top: 12, right: 20, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="shortCallPrice" name="Short Call" stroke="#cf1322" dot={false} />
                  <Line type="monotone" dataKey="longCallPrice" name="Long Call" stroke="#1677ff" dot={false} />
                  <Line type="monotone" dataKey="shortPutPrice" name="Short Put" stroke="#d46b08" dot={false} />
                  <Line type="monotone" dataKey="longPutPrice" name="Long Put" stroke="#08979c" dot={false} />
                  <Line type="monotone" dataKey="pnl" name="Combined P&L" stroke="#389e0d" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>}
          {showGrid && <Card title="Strangle Calendar Records">
            <Table<StrangleCalendarRow>
              rowKey="key"
              dataSource={rows}
              pagination={{ pageSize: 20 }}
              scroll={{ x: 1100 }}
              columns={[
                { title: "Date", dataIndex: "date", key: "date", width: 110 },
                { title: "Stock Close", dataIndex: "stockPrice", key: "stockPrice", render: formatCurrency },
                { title: "Short Call", dataIndex: "shortCallPrice", key: "shortCallPrice", render: formatCurrency },
                { title: "Long Call", dataIndex: "longCallPrice", key: "longCallPrice", render: formatCurrency },
                { title: "Short Put", dataIndex: "shortPutPrice", key: "shortPutPrice", render: formatCurrency },
                { title: "Long Put", dataIndex: "longPutPrice", key: "longPutPrice", render: formatCurrency },
                { title: "Position Value", dataIndex: "positionValue", key: "positionValue", render: formatCurrency },
                { title: "Combined P&L", dataIndex: "pnl", key: "pnl", render: formatCurrency },
                { title: "Short Expiry", dataIndex: "shortExpiryDate", key: "shortExpiryDate" },
                { title: "Status", dataIndex: "status", key: "status" },
                {
                  title: "Action",
                  key: "action",
                  render: (_: unknown, row: StrangleCalendarRow) => (
                    <Button size="small" onClick={() => openRollModal(row)} disabled={loading || row.status === "expired"}>
                      Roll Pair
                    </Button>
                  ),
                },
              ]}
            />
          </Card>}
        </>
      )}
      {batchResults.length > 0 && <Card title="Batch Results">
        <Table<StrangleBatchResult>
          rowKey="key"
          dataSource={batchResults}
          pagination={{ pageSize: 20 }}
          columns={[
            { title: "Start Date", dataIndex: "startDate", key: "startDate" },
            { title: "End Date", dataIndex: "endDate", key: "endDate", render: (value: string | null) => value ?? "-" },
            { title: "Combined P&L", dataIndex: "pnl", key: "pnl", render: formatCurrency },
            { title: "Error", dataIndex: "error", key: "error", render: (value: string | null) => value ?? "-" },
          ]}
        />
      </Card>}
      <Modal
        title="Roll Call and Put Together"
        open={rollModalOpen}
        onCancel={() => setRollModalOpen(false)}
        onOk={() => void confirmManualRoll()}
        okText="Schedule Paired Roll"
        confirmLoading={loading}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Text>Current row: {rollTargetRow?.date ?? "-"}. Both short legs share the new expiry.</Text>
          <div>
            <Text>New short expiry</Text>
            <DatePicker
              value={rollExpiryDate ? dayjs(rollExpiryDate) : null}
              onChange={(value) => {
                const nextExpiry = value?.format("YYYY-MM-DD") ?? "";
                setRollExpiryDate(nextExpiry);
                if (rollTargetRow && nextExpiry) {
                  void previewManualRoll(rollTargetRow, nextExpiry, rollStrike);
                }
              }}
              style={{ width: "100%", marginTop: 8 }}
            />
          </div>
          <Row gutter={12}>
            <Col span={12}>
              <Text>New shared call/put strike</Text>
              <InputNumber
                value={rollStrike}
                min={5}
                step={5}
                onChange={(value) => {
                  const nextStrike = value === null ? 0 : roundToNearestFive(value);
                  setRollStrike(nextStrike);
                  if (rollTargetRow && rollExpiryDate) {
                    void previewManualRoll(rollTargetRow, rollExpiryDate, nextStrike);
                  }
                }}
                style={{ width: "100%", marginTop: 8 }}
              />
            </Col>
          </Row>
          <Text>Estimated combined roll credit/debit: {formatCurrency(rollCreditDebit)}</Text>
        </Space>
      </Modal>
      <Modal title="Strangle Calendar User Guide" open={guideOpen} onCancel={() => setGuideOpen(false)} footer={null}>
        <Space direction="vertical" size={8}>
          <Text>Models a long-dated call and put against a paired short-dated call and put.</Text>
          <Text>Set ticker, start date, expiries, and one shared strike for the call and put; the default is the underlying close rounded to the nearest $5.</Text>
          <Text>Manual rolls schedule both short legs together with one expiry and one shared strike. Weekly auto-roll seeks at least $0.20 combined credit.</Text>
          <Text>Batch runs are sequential. Publish sends the current simulation and its records to Google Sheets.</Text>
          <Text>Missing option quotes are searched on nearby trading dates within five calendar days.</Text>
        </Space>
      </Modal>
    </Space>
  );
};

export default StrangleCalendar;