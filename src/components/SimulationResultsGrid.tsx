import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space, Table, Tag, Typography } from "antd";
import { LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchOptionOpenClose, type OptionOpenClose } from "../api/backtest";
import {
  fetchPutCalendarSimulationResults,
  isSimulationResultsApiConfigured,
  type PutCalendarSimulationResult,
} from "../api/simulationResults";

const { Text } = Typography;

const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 2_000;
const CALL_OPTION_CACHE_STORAGE_KEY = "simulationResultsCallOptionCache";
const CALL_OPTION_CACHE_MAX_ENTRIES = 2000;
const CALL_OPTION_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

interface CallOptionCacheEntry {
  data: OptionOpenClose;
  fetchedAt: string;
}

type CallOptionCacheData = Record<string, CallOptionCacheEntry>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getCallOptionCacheKey = (symbol: string, expiryDate: string, strikePrice: number, date: string) =>
  `${symbol}|${expiryDate}|${strikePrice}|C|${date}`;

const formatOptionExpiry = (dateStr: string): string => dayjs(dateStr).format("YYMMDD");

const loadCallOptionCache = (): CallOptionCacheData => {
  try {
    const raw = localStorage.getItem(CALL_OPTION_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CallOptionCacheData;
  } catch {
    return {};
  }
};

const saveCallOptionCache = (data: CallOptionCacheData) => {
  const entries = Object.entries(data).sort(
    ([, a], [, b]) => new Date(b.fetchedAt).valueOf() - new Date(a.fetchedAt).valueOf()
  );
  const trimmed = Object.fromEntries(entries.slice(0, CALL_OPTION_CACHE_MAX_ENTRIES));
  localStorage.setItem(CALL_OPTION_CACHE_STORAGE_KEY, JSON.stringify(trimmed));
};

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
};

const formatPercent = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
};

const returnColor = (value: number | null | undefined) =>
  (value ?? 0) >= 0 ? "#3f8600" : "#cf1322";

const formatDateOnly = (value: string | null | undefined) => {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
};

const getDurationDays = (startDate: string | null | undefined, endDate: string | null | undefined) => {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
};

const getTheta = (row: PutCalendarSimulationResult) => {
  const durationDays = getDurationDays(row.actualStartDate, row.endDate);
  if (durationDays === null || durationDays === 0 || !Number.isFinite(row.optionStrategyReturn)) {
    return null;
  }
  return row.optionStrategyReturn / durationDays;
};

const getFilterOptions = (values: Array<string | null | undefined>) =>
  Array.from(new Set(values.filter((value): value is string => Boolean(value)))).map((value) => ({
    text: value,
    value,
  }));

const buildSimulationUrl = (row: PutCalendarSimulationResult): string => {
  const url = new URL(window.location.href);
  const params = new URLSearchParams({
    tab: row.strategy === "3 Tier" ? "three-tier" : "put-calendar-spread-roll",
    run: "true",
    ticker: row.ticker,
    start: row.requestedStartDate,
    firstExpiry: row.shortExpiryDate,
    longExpiry: row.longExpiryDate,
    fivePercentStrike: String(row.fivePercentStrike),
    autoRoll: String(row.autoRoll),
  });

  if (row.sellExpiryDate) params.set("sellExpiry", row.sellExpiryDate);
  if (row.shortStrike) params.set("firstStrike", String(row.shortStrike));
  if (row.sellStrike) params.set("sellStrike", String(row.sellStrike));
  if (row.longStrike) params.set("longStrike", String(row.longStrike));

  url.search = params.toString();
  return url.toString();
};

interface SimulationResultRow extends PutCalendarSimulationResult {
  key: string;
}

const SimulationResultsGrid: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SimulationResultRow[]>([]);
  const [callValuesByRowKey, setCallValuesByRowKey] = useState<Record<string, Array<number | null>>>({});
  const [callValueLoadingByRowKey, setCallValueLoadingByRowKey] = useState<Record<string, boolean>>({});
  const [longCallValuesByRowKey, setLongCallValuesByRowKey] = useState<Record<string, Array<number | null>>>({});
  const [longCallValueLoadingByRowKey, setLongCallValueLoadingByRowKey] = useState<Record<string, boolean>>({});
  const callOptionCacheRef = useRef<CallOptionCacheData>(loadCallOptionCache());
  const callOptionInFlightRef = useRef<Map<string, Promise<OptionOpenClose>>>(new Map());

  const fetchCallOptionWithCache = async (
    symbol: string,
    expiryDate: string,
    strikePrice: number,
    date: string
  ): Promise<OptionOpenClose> => {
    const cacheKey = getCallOptionCacheKey(symbol, expiryDate, strikePrice, date);
    const cached = callOptionCacheRef.current[cacheKey];
    const cacheAgeMs = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Number.POSITIVE_INFINITY;
    if (cached && cacheAgeMs < CALL_OPTION_CACHE_TTL_MS) {
      return cached.data;
    }

    const pending = callOptionInFlightRef.current.get(cacheKey);
    if (pending) return pending;

    const request = (async () => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        try {
          const data = await fetchOptionOpenClose(symbol, expiryDate, strikePrice, "C", date);

          const isRateLimited = data.statusCode === 429;
          const isServerError = data.statusCode !== null && data.statusCode >= 500;
          if ((isRateLimited || isServerError) && attempt < MAX_RATE_LIMIT_RETRIES) {
            await sleep(isRateLimited ? RATE_LIMIT_WAIT_MS : RETRY_BACKOFF_BASE_MS * (attempt + 1));
            continue;
          }

          callOptionCacheRef.current[cacheKey] = { data, fetchedAt: new Date().toISOString() };
          saveCallOptionCache(callOptionCacheRef.current);
          return data;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_RATE_LIMIT_RETRIES) {
            await sleep(RETRY_BACKOFF_BASE_MS * (attempt + 1));
            continue;
          }
        }
      }

      console.warn("Failed to fetch call option value after retries", lastError);
      return { openPrice: null, closePrice: null, delta: null, theta: null, statusCode: null };
    })();

    callOptionInFlightRef.current.set(cacheKey, request);
    try {
      return await request;
    } finally {
      callOptionInFlightRef.current.delete(cacheKey);
    }
  };

  const loadCallValuesForRow = async (row: SimulationResultRow) => {
    const gridRows = row.gridData?.rows ?? [];
    if (gridRows.length === 0 || callValuesByRowKey[row.key] || callValueLoadingByRowKey[row.key]) {
      return;
    }

    setCallValueLoadingByRowKey((prev) => ({ ...prev, [row.key]: true }));
    try {
      const values = await Promise.all(
        gridRows.map(async (gridRow) => {
          const date = gridRow.date;
          const shortExpiryDate = gridRow.shortExpiryDate;
          const strike = gridRow.strike;
          if (
            typeof date !== "string" ||
            typeof shortExpiryDate !== "string" ||
            typeof strike !== "number"
          ) {
            return null;
          }
          const optionData = await fetchCallOptionWithCache(
            row.ticker,
            formatOptionExpiry(shortExpiryDate),
            strike,
            date
          );
          return optionData.closePrice;
        })
      );
      setCallValuesByRowKey((prev) => ({ ...prev, [row.key]: values }));
    } finally {
      setCallValueLoadingByRowKey((prev) => ({ ...prev, [row.key]: false }));
    }
  };

  const loadLongCallValuesForRow = async (row: SimulationResultRow) => {
    const gridRows = row.gridData?.rows ?? [];
    if (gridRows.length === 0 || longCallValuesByRowKey[row.key] || longCallValueLoadingByRowKey[row.key]) {
      return;
    }

    setLongCallValueLoadingByRowKey((prev) => ({ ...prev, [row.key]: true }));
    try {
      const values = await Promise.all(
        gridRows.map(async (gridRow) => {
          const date = gridRow.date;
          const longExpiryDate = gridRow.longExpiryDate;
          const longStrike = gridRow.longStrike;
          if (
            typeof date !== "string" ||
            typeof longExpiryDate !== "string" ||
            typeof longStrike !== "number"
          ) {
            return null;
          }
          const optionData = await fetchCallOptionWithCache(
            row.ticker,
            formatOptionExpiry(longExpiryDate),
            longStrike,
            date
          );
          return optionData.closePrice;
        })
      );
      setLongCallValuesByRowKey((prev) => ({ ...prev, [row.key]: values }));
    } finally {
      setLongCallValueLoadingByRowKey((prev) => ({ ...prev, [row.key]: false }));
    }
  };

  const loadAllCallOptionData = async (rowsToLoad: SimulationResultRow[]) => {
    for (const row of rowsToLoad) {
      await Promise.all([loadCallValuesForRow(row), loadLongCallValuesForRow(row)]);
    }
  };

  const loadResults = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPutCalendarSimulationResults();
      const mapped = data.map((row, index) => ({
        ...row,
        key: `${row.recordedAt ?? "row"}-${index}`,
      }));
      setResults(mapped);
      void loadAllCallOptionData(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load simulation results");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSimulationResultsApiConfigured()) {
      void loadResults();
    }
  }, []);

  const getCallOptionStrategyReturn = (
    row: SimulationResultRow
  ): { pnl: number; pnlPct: number | null } | null => {
    const gridRows = row.gridData?.rows ?? [];
    const shortCallValues = callValuesByRowKey[row.key];
    const longCallValues = longCallValuesByRowKey[row.key];
    if (gridRows.length === 0 || !shortCallValues || !longCallValues) {
      return null;
    }

    let realisedPnl = 0;
    let initialInvestment: number | null = null;
    let segmentEntryNetCredit: number | null = null;
    let previousRollNumber: number | null = null;

    gridRows.forEach((gridRow, index) => {
      const shortCall = shortCallValues[index];
      const longCall = longCallValues[index];
      if (shortCall === null || shortCall === undefined || longCall === null || longCall === undefined) {
        return;
      }

      const netCost = shortCall - longCall;
      const rollNumber = typeof gridRow.rollNumber === "number" ? gridRow.rollNumber : 0;

      if (segmentEntryNetCredit === null || previousRollNumber !== rollNumber) {
        segmentEntryNetCredit = netCost;
        if (initialInvestment === null) initialInvestment = Math.abs(netCost);
      }

      if (gridRow.status === "rolled" || gridRow.status === "expired") {
        realisedPnl += segmentEntryNetCredit - netCost;
        segmentEntryNetCredit = null;
      }

      previousRollNumber = rollNumber;
    });

    const pnlPct =
      initialInvestment !== null && initialInvestment !== 0 ? (realisedPnl / initialInvestment) * 100 : null;
    return { pnl: realisedPnl, pnlPct };
  };

  const strategyFilters = getFilterOptions(results.map((row) => row.strategy));
  const tickerFilters = getFilterOptions(results.map((row) => row.ticker));
  const startDateFilters = getFilterOptions(results.map((row) => row.actualStartDate));
  const endDateFilters = getFilterOptions(results.map((row) => row.endDate));
  const stopReasonFilters = getFilterOptions(results.map((row) => row.stopReason));

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card
        title="Simulation Results"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void loadResults()} loading={loading}>
            Refresh
          </Button>
        }
      >
        {!isSimulationResultsApiConfigured() && (
          <Alert
            type="warning"
            showIcon
            message="Google Sheets results API is not configured"
            description="Set VITE_GOOGLE_SHEETS_WEB_APP_URL to load simulation results from the spreadsheet."
          />
        )}
        {error && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message="Failed to load simulation results"
            description={error}
          />
        )}
      </Card>

      <Card title="Records">
        <Table<SimulationResultRow>
          rowKey="key"
          loading={loading}
          dataSource={results}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          scroll={{ x: 1400 }}
          expandable={{
            onExpand: (expanded, row) => {
              if (expanded) {
                void loadCallValuesForRow(row);
                void loadLongCallValuesForRow(row);
              }
            },
            expandedRowRender: (row) => {
              const gridRows = row.gridData?.rows ?? [];
              if (gridRows.length === 0) {
                return <Text type="secondary">No grid data recorded for this simulation.</Text>;
              }

              const columnKeys = Object.keys(gridRows[0]);
              const hasPutOptionParams =
                columnKeys.includes("shortPutPrice") &&
                columnKeys.includes("shortExpiryDate") &&
                columnKeys.includes("strike") &&
                columnKeys.includes("date");
              const hasLongPutOptionParams =
                columnKeys.includes("longPutPrice") &&
                columnKeys.includes("longExpiryDate") &&
                columnKeys.includes("longStrike") &&
                columnKeys.includes("date");
              const callValues = callValuesByRowKey[row.key];
              const callValuesLoading = callValueLoadingByRowKey[row.key] ?? false;
              const longCallValues = longCallValuesByRowKey[row.key];
              const longCallValuesLoading = longCallValueLoadingByRowKey[row.key] ?? false;

              const columns = columnKeys.map((columnKey) => ({
                title: columnKey,
                dataIndex: columnKey,
                key: columnKey,
                render: (value: string | number | null) =>
                  typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : value ?? "-",
              }));

              if (hasPutOptionParams) {
                columns.push({
                  title: "shortCallPrice",
                  dataIndex: "__callOptionValue",
                  key: "__callOptionValue",
                  render: (_: unknown, __: unknown, index: number) => {
                    if (callValuesLoading && !callValues) return "Loading...";
                    const value = callValues?.[index];
                    return value === null || value === undefined ? "-" : value.toFixed(2);
                  },
                } as (typeof columns)[number]);
              }

              if (hasLongPutOptionParams) {
                columns.push({
                  title: "longCallPrice",
                  dataIndex: "__longCallOptionValue",
                  key: "__longCallOptionValue",
                  render: (_: unknown, __: unknown, index: number) => {
                    if (longCallValuesLoading && !longCallValues) return "Loading...";
                    const value = longCallValues?.[index];
                    return value === null || value === undefined ? "-" : value.toFixed(2);
                  },
                } as (typeof columns)[number]);
              }

              return (
                <Table
                  size="small"
                  rowKey={(_, index) => `${row.key}-grid-${index}`}
                  dataSource={gridRows}
                  pagination={{ pageSize: 15 }}
                  scroll={{ x: "max-content" }}
                  columns={columns}
                />
              );
            },
          }}
          columns={[
            {
              title: "Open",
              key: "open",
              width: 70,
              fixed: "left",
              render: (_: unknown, row: SimulationResultRow) => (
                <Button
                  type="link"
                  icon={<LinkOutlined />}
                  title="Open simulation in a new tab"
                  aria-label="Open simulation in a new tab"
                  onClick={() => window.open(buildSimulationUrl(row), "_blank", "noopener,noreferrer")}
                />
              ),
            },
            // {
            //   title: "Recorded At",
            //   dataIndex: "recordedAt",
            //   key: "recordedAt",
            //   width: 130,
            //   sorter: (a, b) => (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""),
            //   render: (value: string | null) => formatDateOnly(value),
            // },
            {
              title: "Strategy",
              dataIndex: "strategy",
              key: "strategy",
              width: 140,
              sorter: (a, b) => (a.strategy ?? "").localeCompare(b.strategy ?? ""),
              filters: strategyFilters,
              onFilter: (value, record) => (record.strategy ?? "") === String(value),
              filterSearch: true,
            },
            {
              title: "Ticker",
              dataIndex: "ticker",
              key: "ticker",
              width: 90,
              sorter: (a, b) => (a.ticker ?? "").localeCompare(b.ticker ?? ""),
              filters: tickerFilters,
              onFilter: (value, record) => (record.ticker ?? "") === String(value),
              filterSearch: true,
            },
            {
              title: "Start Date",
              dataIndex: "actualStartDate",
              key: "actualStartDate",
              width: 110,
              sorter: (a, b) => (a.actualStartDate ?? "").localeCompare(b.actualStartDate ?? ""),
              filters: startDateFilters,
              onFilter: (value, record) => (record.actualStartDate ?? "") === String(value),
              render: (value: string | null) => formatDateOnly(value),
            },
            {
              title: "End Date",
              dataIndex: "endDate",
              key: "endDate",
              width: 110,
              sorter: (a, b) => (a.endDate ?? "").localeCompare(b.endDate ?? ""),
              filters: endDateFilters,
              onFilter: (value, record) => (record.endDate ?? "") === String(value),
              render: (value: string | null) => formatDateOnly(value),
            },
            {
              title: "Duration",
              key: "duration",
              width: 100,
              sorter: (a, b) =>
                (getDurationDays(a.actualStartDate, a.endDate) ?? 0) -
                (getDurationDays(b.actualStartDate, b.endDate) ?? 0),
              render: (_: unknown, row: SimulationResultRow) => {
                const durationDays = getDurationDays(row.actualStartDate, row.endDate);
                return durationDays === null ? "-" : `${durationDays} days`;
              },
            },
            {
              title: "Theta ($ / day)",
              key: "theta",
              width: 130,
              sorter: (a, b) => (getTheta(a) ?? 0) - (getTheta(b) ?? 0),
              render: (_: unknown, row: SimulationResultRow) => {
                const theta = getTheta(row);
                return theta === null ? "-" : formatCurrency(theta);
              },
            },
            {
              title: "Stock Return ($ | %)",
              key: "stockReturn",
              width: 190,
              sorter: (a, b) => (a.stockReturn ?? 0) - (b.stockReturn ?? 0),
              render: (_: unknown, row: SimulationResultRow) => (
                <Space size={2}>
                  <Text style={{ color: returnColor(row.stockReturn) }}>
                    {formatCurrency(row.stockReturn)}
                  </Text>
                  <Text>|</Text>
                  <Text style={{ color: returnColor(row.stockReturnPct) }}>
                    {formatPercent(row.stockReturnPct)}
                  </Text>
                </Space>
              ),
            },
            {
              title: "Option Strategy Return ($ | %)",
              key: "optionStrategyReturn",
              width: 220,
              sorter: (a, b) => (a.optionStrategyReturn ?? 0) - (b.optionStrategyReturn ?? 0),
              render: (_: unknown, row: SimulationResultRow) => (
                <Space size={2}>
                  <Text style={{ color: returnColor(row.optionStrategyReturn) }}>
                    {formatCurrency(row.optionStrategyReturn)}
                  </Text>
                  <Text>|</Text>
                  <Text style={{ color: returnColor(row.optionStrategyReturnPct) }}>
                    {formatPercent(row.optionStrategyReturnPct)}
                  </Text>
                </Space>
              ),
            },
            {
              title: "Call Option Strategy Return ($ | %)",
              key: "callOptionStrategyReturn",
              width: 220,
              sorter: (a, b) =>
                (getCallOptionStrategyReturn(a)?.pnl ?? 0) - (getCallOptionStrategyReturn(b)?.pnl ?? 0),
              render: (_: unknown, row: SimulationResultRow) => {
                const result = getCallOptionStrategyReturn(row);
                if (!result) return "Loading...";
                return (
                  <Space size={2}>
                    <Text style={{ color: returnColor(result.pnl) }}>{formatCurrency(result.pnl)}</Text>
                    <Text>|</Text>
                    <Text style={{ color: returnColor(result.pnlPct) }}>{formatPercent(result.pnlPct)}</Text>
                  </Space>
                );
              },
            },
            {
              title: "Processed Days",
              dataIndex: "processedDays",
              key: "processedDays",
              width: 120,
              sorter: (a, b) => (a.processedDays ?? 0) - (b.processedDays ?? 0),
            },
            {
              title: "Stop Reason",
              dataIndex: "stopReason",
              key: "stopReason",
              width: 260,
              sorter: (a, b) => (a.stopReason ?? "").localeCompare(b.stopReason ?? ""),
              filters: stopReasonFilters,
              onFilter: (value, record) => (record.stopReason ?? "") === String(value),
              filterSearch: true,
              render: (value: string | null) => (value ? <Tag color="orange">{value}</Tag> : "-"),
            },
          ]}
        />
      </Card>
    </Space>
  );
};

export default SimulationResultsGrid;
