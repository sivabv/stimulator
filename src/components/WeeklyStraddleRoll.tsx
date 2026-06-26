import React, { useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Col, DatePicker, Input, Row, Space, Spin, Tag, Typography, message } from "antd";
import { PlayCircleOutlined, StarFilled } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchStockOpenClose } from "../api/backtest";

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

interface CachedStockPrice {
  symbol: string;
  date: string;
  closePrice: number | null;
}

type MasterStockData = Record<string, CachedStockPrice>;

const MASTER_STOCK_DATA_KEY = "masterStockData";
const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_START_DATE = "2025-01-02";
const DEFAULT_END_DATE = "2025-01-15";
const DISPLAY_TRADING_DAYS = 10;

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

const isLegActiveOnDate = (leg: WeeklyStraddleLeg, asOfDate: string) => {
  const asOf = dayjs(asOfDate);
  const entry = dayjs(leg.entryDate);
  const close = leg.closeDate ? dayjs(leg.closeDate) : null;

  return (
    (asOf.isSame(entry, "day") || asOf.isAfter(entry, "day")) &&
    (!close || asOf.isBefore(close, "day") || asOf.isSame(close, "day"))
  );
};

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

const getTradingDateWindow = (start: string, count: number): string[] => {
  const normalizedStart = getFirstTradingDateOnOrAfter(start);
  if (!normalizedStart || count <= 0) return [];

  const window: string[] = [];
  let cursor = normalizedStart;
  while (window.length < count) {
    window.push(cursor);
    const next = getNextTradingDate(cursor);
    if (!next) break;
    cursor = next;
  }

  return window;
};

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WeeklyStraddleRoll: React.FC = () => {
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState(DEFAULT_END_DATE);
  const [activeDateFilter, setActiveDateFilter] = useState("");
  const [stockTicker, setStockTicker] = useState("SPY");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legs, setLegs] = useState<WeeklyStraddleLeg[]>([]);
  const [closingPriceByDate, setClosingPriceByDate] = useState<Record<string, number | null>>({});
  const masterStockDataRef = useRef<MasterStockData>(loadMasterStockData());
  const pendingStockRequestsRef = useRef<Record<string, Promise<CachedStockPrice>>>({});

  const fetchWithRateLimitRetry = async <T extends { statusCode: number | null }>(
    work: () => Promise<T>
  ) => {
    let response = await work();
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

    const pending = pendingStockRequestsRef.current[cacheKey];
    if (pending) return pending;

    const request = (async () => {
      try {
        const stockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(symbol, date));
        const result: CachedStockPrice = { symbol, date, closePrice: stockData.closePrice };
        masterStockDataRef.current[cacheKey] = result;
        saveMasterStockData(masterStockDataRef.current);
        return result;
      } finally {
        delete pendingStockRequestsRef.current[cacheKey];
      }
    })();

    pendingStockRequestsRef.current[cacheKey] = request;
    return request;
  };

  const buildDailyEntryDates = (firstDate: string, lastDate: string): string[] =>
    getTradingDateWindow(firstDate, DISPLAY_TRADING_DAYS).filter(
      (date) => !dayjs(date).isAfter(dayjs(lastDate), "day")
    );

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

      const isInTheMoney =
        legType === "Call" ? closePrice > strike : closePrice < strike;

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
    setLoading(true);

    try {
      const symbol = stockTicker.trim().toUpperCase();
      if (!symbol) throw new Error("Stock ticker is required");
      if (!dayjs(startDate).isValid()) throw new Error("Start date is invalid");
      if (!dayjs(endDate).isValid()) throw new Error("End date is invalid");
      if (dayjs(endDate).isBefore(dayjs(startDate), "day")) {
        throw new Error("End date must be on or after start date");
      }

      const firstDate = getFirstTradingDateOnOrAfter(startDate);
      if (!firstDate) throw new Error("No trading date found on or after the start date");

      const entryDates = buildDailyEntryDates(firstDate, endDate);
      const results: WeeklyStraddleLeg[] = [];

      for (let i = 0; i < entryDates.length; i += 1) {
        const entryDate = entryDates[i];
        const stockResult = await fetchStockWithCache(symbol, entryDate);
        const entryPrice = stockResult.closePrice;
        if (entryPrice === null) continue;

        const strike = roundToNearestFive(entryPrice);
        const initialExpiryDate = getNextTradingDate(entryDate) ?? entryDate;

        const [callLeg, putLeg] = await Promise.all([
          simulateLeg(i + 1, "Call", entryDate, initialExpiryDate, strike, endDate),
          simulateLeg(i + 1, "Put", entryDate, initialExpiryDate, strike, endDate),
        ]);

        results.push(callLeg, putLeg);
        // Stream partial progress by date while the run continues.
        setLegs([...results]);
        setClosingPriceByDate((previous) => ({
          ...previous,
          [entryDate]: entryPrice,
        }));
      }

      const sectionDates = getTradingDateWindow(firstDate, DISPLAY_TRADING_DAYS);
      const summaryDates = Array.from(new Set([...results.map((row) => row.entryDate), ...sectionDates]));
      const summaryDateClosePairs = await Promise.all(
        summaryDates.map(async (date) => {
          const stockResult = await fetchStockWithCache(symbol, date);
          return [date, stockResult.closePrice] as const;
        })
      );

      setClosingPriceByDate(Object.fromEntries(summaryDateClosePairs));

      setLegs(results);
      if (!results.length) {
        message.warning("No daily straddles could be generated for the selected date range");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run daily straddle simulation");
    } finally {
      setLoading(false);
    }
  };

  const sectionTiles = useMemo(() => {
    if (legs.length === 0) return [];

    const defaultStart = getFirstTradingDateOnOrAfter(startDate) ?? startDate;
    const filterStart = activeDateFilter ? getFirstTradingDateOnOrAfter(activeDateFilter) ?? activeDateFilter : "";
    const sectionStart = filterStart || defaultStart;
    const sectionDates = getTradingDateWindow(sectionStart, DISPLAY_TRADING_DAYS);

    return sectionDates.map((asOfDate) => {
      const closePrice =
        Object.prototype.hasOwnProperty.call(closingPriceByDate, asOfDate)
          ? closingPriceByDate[asOfDate]
          : null;
      const asOf = dayjs(asOfDate);
      const currentWeekEndDate = asOf.add(7, "day");
      const closedInCurrentWeekCount = legs.filter((leg) => {
        if (!leg.closeDate) {
          return false;
        }
        const closeDate = dayjs(leg.closeDate);
        return (
          (closeDate.isSame(asOfDate, "day") || closeDate.isAfter(asOf, "day")) &&
          (closeDate.isSame(currentWeekEndDate, "day") || closeDate.isBefore(currentWeekEndDate, "day"))
        );
      }).length;
      const cumulativeClosedCount = legs.filter((leg) => {
        if (!leg.closeDate) {
          return false;
        }
        const closeDate = dayjs(leg.closeDate);
        return closeDate.isSame(asOfDate, "day") || closeDate.isBefore(asOf, "day");
      }).length;
      const activeOnDate = legs
        .filter((leg) => isLegActiveOnDate(leg, asOfDate))
        .sort((left, right) => {
          if (left.entryDate !== right.entryDate) {
            return dayjs(left.entryDate).valueOf() - dayjs(right.entryDate).valueOf();
          }
          if (left.legType !== right.legType) {
            return left.legType === "Call" ? -1 : 1;
          }
          return left.weekNumber - right.weekNumber;
        });
      const activeCallCount = activeOnDate.filter((leg) => leg.legType === "Call").length;
      const activePutCount = activeOnDate.filter((leg) => leg.legType === "Put").length;
      const activeOptionCount = activeOnDate.length;

      return (
        <Space key={asOfDate} direction="vertical" size={8} style={{ width: "100%", marginBottom: 16 }}>
          <Space size={12} wrap>
            <Text strong style={{ fontSize: 14 }}>
              {`Date: ${asOfDate} | Close: ${formatCurrency(closePrice)}`}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`Active options: ${activeOptionCount} | Calls active: ${activeCallCount} | Puts active: ${activePutCount} | Closed in this week: ${closedInCurrentWeekCount} | Cumulative closed: ${cumulativeClosedCount}`}
            </Text>
          </Space>
          {activeOptionCount === 0 ? (
            <Text type="secondary">No active options on this date.</Text>
          ) : (
            <Row gutter={[16, 12]}>
              <Col xs={24} sm={12} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Text type="secondary" strong style={{ fontSize: 12 }}>Calls (Left)</Text>
                <Row gutter={[12, 12]}>
                  {activeOnDate.filter((leg) => leg.legType === "Call").map((leg) => (
                    <Col key={`${asOfDate}-${leg.key}`} xs={24} sm={24} md={12} lg={8}>
                      {(() => {
                        const isCall = leg.legType === "Call";
                        const isClosed = !isLegActiveOnDate(leg, asOfDate);
                        const tileBackground = isClosed ? "#f0f0f0" : (isCall ? "#f6ffed" : "#fff0f6");
                        const tileBorder = isClosed ? "#d9d9d9" : (isCall ? "#b7eb8f" : "#ffadd2");
                        return (
                          <Card
                            size="small"
                            title={renderTileTitle(
                              leg.legType,
                              leg.weekNumber,
                              leg.entryDate,
                              leg.closeDate ?? leg.finalExpiryDate
                            )}
                            style={{
                              height: "100%",
                              marginBottom: 0,
                              background: tileBackground,
                              borderColor: tileBorder,
                            }}
                            extra={
                              <Tag color={isLegActiveOnDate(leg, asOfDate) ? "green" : "red"}>
                                {isLegActiveOnDate(leg, asOfDate) ? "Active" : "Closed"}
                              </Tag>
                            }
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
                        );
                      })()}
                    </Col>
                  ))}
                </Row>
              </Col>
              <Col xs={24} sm={12} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Text type="secondary" strong style={{ fontSize: 12 }}>Puts (Right)</Text>
                <Row gutter={[12, 12]}>
                  {activeOnDate.filter((leg) => leg.legType === "Put").map((leg) => (
                    <Col key={`${asOfDate}-${leg.key}`} xs={24} sm={24} md={12} lg={8}>
                      {(() => {
                        const isCall = leg.legType === "Call";
                        const isClosed = !isLegActiveOnDate(leg, asOfDate);
                        const tileBackground = isClosed ? "#f0f0f0" : (isCall ? "#f6ffed" : "#fff0f6");
                        const tileBorder = isClosed ? "#d9d9d9" : (isCall ? "#b7eb8f" : "#ffadd2");
                        return (
                          <Card
                            size="small"
                            title={renderTileTitle(
                              leg.legType,
                              leg.weekNumber,
                              leg.entryDate,
                              leg.closeDate ?? leg.finalExpiryDate
                            )}
                            style={{
                              height: "100%",
                              marginBottom: 0,
                              background: tileBackground,
                              borderColor: tileBorder,
                            }}
                            extra={
                              <Tag color={isLegActiveOnDate(leg, asOfDate) ? "green" : "red"}>
                                {isLegActiveOnDate(leg, asOfDate) ? "Active" : "Closed"}
                              </Tag>
                            }
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
                        );
                      })()}
                    </Col>
                  ))}
                </Row>
              </Col>
            </Row>
          )}
        </Space>
      );
    });
  }, [activeDateFilter, closingPriceByDate, legs, startDate]);

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card title="Daily ATM Short Straddle Roll (Mon-Fri)">
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="Price-free output"
            description="Sells an ATM call and put each trading day, uses 1-trading-day expiry, and rolls forward by 1 day while in the money."
          />

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
              <Text>End Date</Text>
              <DatePicker
                value={dayjs(endDate)}
                onChange={(v) => setEndDate(v ? v.format("YYYY-MM-DD") : "")}
                style={{ width: "100%", marginTop: 8 }}
              />
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Text>Active On Date Filter</Text>
              <DatePicker
                value={activeDateFilter ? dayjs(activeDateFilter) : null}
                onChange={(v) => {
                  const nextValue = v ? v.format("YYYY-MM-DD") : "";
                  setActiveDateFilter(nextValue);

                  if (!nextValue) {
                    return;
                  }

                  const symbol = stockTicker.trim().toUpperCase();
                  if (!symbol) {
                    return;
                  }

                  void (async () => {
                    const normalizedStart = getFirstTradingDateOnOrAfter(nextValue) ?? nextValue;
                    const sectionDates = getTradingDateWindow(normalizedStart, DISPLAY_TRADING_DAYS);
                    const closePairs = await Promise.all(
                      sectionDates.map(async (date) => {
                        const stockResult = await fetchStockWithCache(symbol, date);
                        return [date, stockResult.closePrice] as const;
                      })
                    );

                    setClosingPriceByDate((previous) => ({
                      ...previous,
                      ...Object.fromEntries(closePairs),
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
                onChange={(e) => setStockTicker(e.target.value.toUpperCase())}
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
          {legs.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary">Showing partial dates while loading...</Text>
            </div>
          )}
        </div>
      )}

      {legs.length > 0 && (
        <Card title="Option Tiles">
          {sectionTiles}
        </Card>
      )}
    </Space>
  );
};

export default WeeklyStraddleRoll;