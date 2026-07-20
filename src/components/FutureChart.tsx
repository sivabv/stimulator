import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Col, DatePicker, InputNumber, Row, Select, Space, Statistic, Typography } from "antd";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import dayjs, { type Dayjs } from "dayjs";
import { fetchOptionOpenClose, fetchStockOpenClose } from "../api/backtest";

const { Title, Text } = Typography;

type OptionType = "Call" | "Put";

interface ChartPoint {
  x: number;
  optionValue: number;
}

interface CombinedChartPoint {
  index: number;
  stockPrice: number | null;
  optionValueByStock: number | null;
  daysToExpirePoint: number | null;
  optionValueByDte: number | null;
}

const DEFAULT_SYMBOL = "SPY";
const DEFAULT_START_DATE = dayjs("2026-01-02");
const DEFAULT_EXPIRY_DATE = dayjs("2026-12-18");
const DEFAULT_STRIKE_PRICE = 650;

const formatOptionExpiry = (dateValue: Dayjs): string => dateValue.format("YYMMDD");
const toApiOptionType = (value: OptionType): "C" | "P" => (value === "Call" ? "C" : "P");

const normalCdf = (value: number): number => {
  const sign = value < 0 ? -1 : 1;
  const absValue = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * absValue);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erfApprox =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-absValue * absValue);

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

  const sqrtTime = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * timeYears) / (sigma * sqrtTime);
  const d2 = d1 - sigma * sqrtTime;

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

  const intrinsic = optionType === "Call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const targetPrice = Math.max(marketPrice, intrinsic + 1e-8);

  let low = 0.0001;
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

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);

const FutureChart: React.FC = () => {
  const [optionType, setOptionType] = useState<OptionType>("Call");
  const [startDate, setStartDate] = useState<Dayjs>(DEFAULT_START_DATE);
  const [expiryDate, setExpiryDate] = useState<Dayjs>(DEFAULT_EXPIRY_DATE);
  const [stockPrice, setStockPrice] = useState<number>(650);
  const [strikePrice, setStrikePrice] = useState<number>(DEFAULT_STRIKE_PRICE);
  const [daysToExpire, setDaysToExpire] = useState<number>(Math.max(DEFAULT_EXPIRY_DATE.diff(DEFAULT_START_DATE, "day"), 1));
  const [optionPrice, setOptionPrice] = useState<number>(25);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

  useEffect(() => {
    if (!startDate?.isValid() || !expiryDate?.isValid()) {
      return;
    }

    setDaysToExpire(Math.max(expiryDate.diff(startDate, "day"), 1));
  }, [expiryDate, startDate]);

  const loadMarketValues = useCallback(async () => {
    if (!startDate?.isValid() || !expiryDate?.isValid()) {
      setMarketError("Select valid start and expiry dates.");
      return;
    }

    if (strikePrice <= 0 || !Number.isFinite(strikePrice)) {
      setMarketError("Strike price must be greater than zero.");
      return;
    }

    const quoteDate = startDate.format("YYYY-MM-DD");
    const formattedExpiry = formatOptionExpiry(expiryDate);

    setMarketLoading(true);
    setMarketError(null);

    try {
      const [stockResponse, optionResponse] = await Promise.all([
        fetchStockOpenClose(DEFAULT_SYMBOL, quoteDate),
        fetchOptionOpenClose(DEFAULT_SYMBOL, formattedExpiry, strikePrice, toApiOptionType(optionType), quoteDate),
      ]);

      const nextStockPrice =
        typeof stockResponse.closePrice === "number" && Number.isFinite(stockResponse.closePrice)
          ? stockResponse.closePrice
          : typeof stockResponse.openPrice === "number" && Number.isFinite(stockResponse.openPrice)
            ? stockResponse.openPrice
            : null;

      const nextOptionPrice =
        typeof optionResponse.closePrice === "number" && Number.isFinite(optionResponse.closePrice)
          ? optionResponse.closePrice
          : typeof optionResponse.openPrice === "number" && Number.isFinite(optionResponse.openPrice)
            ? optionResponse.openPrice
            : null;

      if (nextStockPrice !== null) {
        setStockPrice(Number(nextStockPrice.toFixed(2)));
      }

      if (nextOptionPrice !== null) {
        setOptionPrice(Number(nextOptionPrice.toFixed(2)));
      }

      if (nextStockPrice === null && nextOptionPrice === null) {
        setMarketError("No stock/option value found for the selected setup.");
      } else if (nextOptionPrice === null) {
        setMarketError("Stock price loaded. Option value not available for this date/expiry/strike.");
      }
    } catch {
      setMarketError("Failed to load market values.");
    } finally {
      setMarketLoading(false);
    }
  }, [expiryDate, optionType, startDate, strikePrice]);

  useEffect(() => {
    void loadMarketValues();
  }, [loadMarketValues]);

  const timeYears = Math.max(daysToExpire, 1) / 365;

  const impliedVolatility = useMemo(() => {
    return estimateImpliedVolatility(optionPrice, stockPrice, strikePrice, timeYears, optionType) ?? 0.25;
  }, [optionPrice, optionType, stockPrice, strikePrice, timeYears]);

  const currentModelPrice = useMemo(() => {
    return blackScholesPrice(stockPrice, strikePrice, timeYears, impliedVolatility, optionType);
  }, [impliedVolatility, optionType, stockPrice, strikePrice, timeYears]);

  const priceCurveData = useMemo<ChartPoint[]>(() => {
    const minStockPrice = Math.max(1, Math.round(stockPrice * 0.5));
    const maxStockPrice = Math.max(minStockPrice + 1, Math.round(stockPrice * 1.5));
    const pointCount = 40;
    const step = Math.max(1, Math.round((maxStockPrice - minStockPrice) / pointCount));
    const points: ChartPoint[] = [];

    for (let value = minStockPrice; value <= maxStockPrice; value += step) {
      points.push({
        x: value,
        optionValue: Number(blackScholesPrice(value, strikePrice, timeYears, impliedVolatility, optionType).toFixed(2)),
      });
    }

    return points;
  }, [impliedVolatility, optionType, stockPrice, strikePrice, timeYears]);

  const dteCurveData = useMemo<ChartPoint[]>(() => {
    const maxDays = Math.max(1, Math.min(365, Math.round(daysToExpire * 2)));
    const pointCount = 36;
    const step = Math.max(1, Math.round(maxDays / pointCount));
    const points: ChartPoint[] = [];

    for (let value = 1; value <= maxDays; value += step) {
      points.push({
        x: value,
        optionValue: Number(
          blackScholesPrice(stockPrice, strikePrice, value / 365, impliedVolatility, optionType).toFixed(2)
        ),
      });
    }

    return points;
  }, [daysToExpire, impliedVolatility, optionType, stockPrice, strikePrice]);

  const maxCurveValue = useMemo(() => {
    const values = [...priceCurveData, ...dteCurveData].map((point) => point.optionValue);
    return Math.max(1, ...values);
  }, [dteCurveData, priceCurveData]);

  const combinedChartData = useMemo<CombinedChartPoint[]>(() => {
    const maxLength = Math.max(priceCurveData.length, dteCurveData.length);
    const rows: CombinedChartPoint[] = [];

    for (let index = 0; index < maxLength; index += 1) {
      const pricePoint = priceCurveData[index];
      const dtePoint = dteCurveData[index];

      rows.push({
        index: index + 1,
        stockPrice: pricePoint?.x ?? null,
        optionValueByStock: pricePoint?.optionValue ?? null,
        daysToExpirePoint: dtePoint?.x ?? null,
        optionValueByDte: dtePoint?.optionValue ?? null,
      });
    }

    return rows;
  }, [dteCurveData, priceCurveData]);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Title level={4} style={{ marginBottom: 0 }}>
            Future Chart
          </Title>
          <Text type="secondary">
            Default setup uses SPY, start date Jan 01 2026, expiry Dec 18 2026, strike 650. Load market values, or
            override the prices manually to run custom what-if curves.
          </Text>

          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}>
              <Text>Symbol</Text>
              <Select
                value={DEFAULT_SYMBOL}
                disabled
                options={[{ value: DEFAULT_SYMBOL, label: DEFAULT_SYMBOL }]}
                style={{ width: "100%", marginTop: 4 }}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Text>Option Type</Text>
              <Select
                value={optionType}
                onChange={(value) => setOptionType(value)}
                options={[
                  { value: "Call", label: "Call" },
                  { value: "Put", label: "Put" },
                ]}
                style={{ width: "100%", marginTop: 4 }}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Text>Start Date</Text>
              <DatePicker
                value={startDate}
                onChange={(value) => {
                  if (value && value.isValid()) {
                    setStartDate(value);
                  }
                }}
                format="YYYY-MM-DD"
                style={{ width: "100%", marginTop: 4 }}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Text>Expiry Date</Text>
              <DatePicker
                value={expiryDate}
                onChange={(value) => {
                  if (value && value.isValid()) {
                    setExpiryDate(value);
                  }
                }}
                format="YYYY-MM-DD"
                style={{ width: "100%", marginTop: 4 }}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Text>Stock Price</Text>
              <InputNumber
                value={stockPrice}
                onChange={(value) => setStockPrice(Number(value ?? 0))}
                min={1}
                step={1}
                style={{ width: "100%", marginTop: 4 }}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Text>Strike Price</Text>
              <InputNumber
                value={strikePrice}
                onChange={(value) => setStrikePrice(Number(value ?? 0))}
                min={1}
                step={1}
                style={{ width: "100%", marginTop: 4 }}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Text>Days to Expire</Text>
              <InputNumber
                value={daysToExpire}
                disabled
                min={1}
                step={1}
                style={{ width: "100%", marginTop: 4 }}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Text>Observed Option Price</Text>
              <InputNumber
                value={optionPrice}
                onChange={(value) => setOptionPrice(Number(value ?? 0))}
                min={0}
                step={0.1}
                style={{ width: "100%", marginTop: 4 }}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Text>Load Market Values</Text>
              <Button
                type="primary"
                block
                loading={marketLoading}
                onClick={() => {
                  void loadMarketValues();
                }}
                style={{ marginTop: 4 }}
              >
                Refresh
              </Button>
            </Col>
          </Row>

          {marketError && <Alert type="warning" showIcon message={marketError} />}

          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Statistic title="Implied Volatility" value={`${(impliedVolatility * 100).toFixed(2)}%`} />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Statistic title="Model Price" value={formatCurrency(currentModelPrice)} />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Statistic title="Intrinsic Value" value={formatCurrency(blackScholesPrice(stockPrice, strikePrice, 0, impliedVolatility, optionType))} />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Statistic title="Time Value" value={formatCurrency(Math.max(currentModelPrice - blackScholesPrice(stockPrice, strikePrice, 0, impliedVolatility, optionType), 0))} />
              </Card>
            </Col>
          </Row>

          {optionPrice <= 0 && (
            <Alert
              type="info"
              showIcon
              message="Enter a positive option price to derive implied volatility. The chart will still render using a fallback volatility if the value is zero or invalid."
            />
          )}
        </Space>
      </Card>

      <Card title="Combined Option Value Chart (Stock + DTE)" size="small">
        <ResponsiveContainer width="100%" height={380}>
          <LineChart data={combinedChartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="index" tickFormatter={(value) => `P${value}`} />
            <YAxis domain={[0, Math.ceil(maxCurveValue * 1.1)]} tickFormatter={(value) => `$${Number(value).toFixed(0)}`} />
            <Tooltip
              formatter={(value, name) => {
                const label = name === "optionValueByStock" ? "Option Value (Stock Sweep)" : "Option Value (DTE Sweep)";
                return [formatCurrency(Number(value ?? 0)), label];
              }}
              labelFormatter={(value) => {
                const row = combinedChartData.find((entry) => entry.index === Number(value));
                const stockLabel = row?.stockPrice !== null && row?.stockPrice !== undefined ? `$${row.stockPrice}` : "-";
                const dteLabel = row?.daysToExpirePoint !== null && row?.daysToExpirePoint !== undefined ? `${row.daysToExpirePoint}d` : "-";
                return `Point ${value} | Stock ${stockLabel} | DTE ${dteLabel}`;
              }}
            />
            <ReferenceLine y={currentModelPrice} stroke="#999" strokeDasharray="4 4" />
            <Line type="monotone" dataKey="optionValueByStock" name="optionValueByStock" stroke="#1677ff" strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="optionValueByDte" name="optionValueByDte" stroke="#13c2c2" strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card size="small">
        <Text type="secondary">
          The model uses the entered option price to estimate volatility, then prices the same contract across a range
          of stock prices and time-to-expiry values.
        </Text>
      </Card>
    </Space>
  );
};

export default FutureChart;