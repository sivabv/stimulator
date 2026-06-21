import React, { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Input,
  InputNumber,
  Row,
  Space,
  Table,
  Typography,
  message,
} from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchOptionOpenClose, fetchStockOpenClose } from "../api/backtest";
import tradingDatesJson from "../assets/trading_dates_2026.json";

const { Text } = Typography;

interface CoveredPutRow {
  key: string;
  date: string;
  closingPrice: number | null;
  strikePrice: number;
  expiryDate: string;
  putPrice: number | null;
  premiumReceived: number | null;
  cashToSecure: number;
  statusCode: number | null;
}

interface CachedStockPrice {
  symbol: string;
  date: string;
  closePrice: number | null;
}

type MasterStockData = Record<string, CachedStockPrice>;

const RATE_LIMIT_WAIT_MS = 2_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MASTER_STOCK_DATA_KEY = "masterStockData";
const SHARES_PER_CONTRACT = 100;
const tradingDates = (tradingDatesJson as string[])
  .filter((value) => dayjs(value).isValid())
  .sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const roundToNearestFive = (value: number): number => Math.round(value / 5) * 5;

const formatExpiryDate = (dateStr: string): string => dayjs(dateStr).format("YYMMDD");

const formatCurrency = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
};

const getFirstTradingDateOnOrAfter = (date: string): string | null => {
  return tradingDates.find((candidate) => !dayjs(candidate).isBefore(dayjs(date), "day")) ?? null;
};

const getExpiryDate = (baseDate: string, preferredExpiryDate: string): string | null => {
  if (preferredExpiryDate) {
    return preferredExpiryDate;
  }

  const start = dayjs(baseDate).add(30, "day");
  const end = dayjs(baseDate).add(45, "day");

  const candidates = tradingDates.filter((candidateDate) => {
    const candidate = dayjs(candidateDate);
    return (
      (candidate.isAfter(start, "day") || candidate.isSame(start, "day")) &&
      (candidate.isBefore(end, "day") || candidate.isSame(end, "day"))
    );
  });

  return candidates[0] ?? null;
};

const getCacheKey = (symbol: string, date: string): string => {
  return `${symbol}|${date}`;
};

const loadMasterStockData = (): MasterStockData => {
  try {
    const raw = localStorage.getItem(MASTER_STOCK_DATA_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as MasterStockData;
  } catch {
    return {};
  }
};

const saveMasterStockData = (data: MasterStockData) => {
  localStorage.setItem(MASTER_STOCK_DATA_KEY, JSON.stringify(data));
};

const CoveredPut: React.FC = () => {
  const [date, setDate] = useState("2025-01-02");
  const [stockTicker, setStockTicker] = useState("SPY");
  const [strikePctBelow, setStrikePctBelow] = useState(2);
  const [preferredExpiryDate, setPreferredExpiryDate] = useState("2026-12-18");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStockPrice, setCurrentStockPrice] = useState<number | null>(null);
  const [calculatedStrikePrice, setCalculatedStrikePrice] = useState<number | null>(null);
  const [calculatedExpiryDate, setCalculatedExpiryDate] = useState<string | null>(null);
  const [rows, setRows] = useState<CoveredPutRow[]>([]);

  const fetchStockWithCache = async (symbol: string, rowDate: string): Promise<CachedStockPrice> => {
    const masterData = loadMasterStockData();
    const cacheKey = getCacheKey(symbol, rowDate);
    const cached = masterData[cacheKey];

    if (cached) {
      return cached;
    }

    const stockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(symbol, rowDate));
    const result: CachedStockPrice = {
      symbol,
      date: rowDate,
      closePrice: stockData.closePrice,
    };

    masterData[cacheKey] = result;
    saveMasterStockData(masterData);

    return result;
  };

  const fetchWithRateLimitRetry = async <T extends { statusCode: number | null }>(work: () => Promise<T>) => {
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

  const handleRun = async () => {
    setError(null);
    setRows([]);
    setLoading(true);

    try {
      const normalizedTicker = stockTicker.trim().toUpperCase();

      if (!normalizedTicker) {
        throw new Error("Stock ticker is required");
      }

      if (!dayjs(date).isValid()) {
        throw new Error("Date is invalid");
      }

      if (preferredExpiryDate && !dayjs(preferredExpiryDate).isValid()) {
        throw new Error("Preferred expiry date is invalid");
      }

      const firstDate = getFirstTradingDateOnOrAfter(date);
      if (!firstDate) {
        throw new Error("No JSON trading date found on or after the given date");
      }

      const stockDataResult = await fetchStockWithCache(normalizedTicker, firstDate);
      const stockData = { closePrice: stockDataResult.closePrice, statusCode: 200 };
      if (stockData.closePrice === null) {
        throw new Error(`No stock close price found for ${normalizedTicker} on ${firstDate}`);
      }

      const strike = roundToNearestFive(stockData.closePrice * (1 - strikePctBelow / 100));
      const expiry = getExpiryDate(firstDate, preferredExpiryDate);
      if (!expiry) {
        throw new Error(`No expiry date found in 30-45 DTE window from ${firstDate}. Provide a preferred date.`);
      }

      setCurrentStockPrice(stockData.closePrice);
      setCalculatedStrikePrice(strike);
      setCalculatedExpiryDate(expiry);

      const requestDates = tradingDates.filter((candidateDate) => {
        const candidate = dayjs(candidateDate);
        return (
          (candidate.isAfter(dayjs(firstDate), "day") || candidate.isSame(dayjs(firstDate), "day")) &&
          (candidate.isBefore(dayjs(expiry), "day") || candidate.isSame(dayjs(expiry), "day"))
        );
      });

      if (requestDates.length === 0) {
        throw new Error(`No JSON dates found between ${firstDate} and expiry ${expiry}`);
      }

      const requestRows = requestDates.map((rowDate) => ({
        key: rowDate,
        date: rowDate,
        closingPrice: null,
        strikePrice: strike,
        expiryDate: expiry,
      }));

      for (const row of requestRows) {
        const stockRowDataResult = await fetchStockWithCache(normalizedTicker, row.date);
        const stockRowData = { closePrice: stockRowDataResult.closePrice, statusCode: 200 };

        const optionData = await fetchWithRateLimitRetry(() =>
          fetchOptionOpenClose(
            normalizedTicker,
            formatExpiryDate(row.expiryDate),
            row.strikePrice,
            "P",
            row.date
          )
        );

        const premiumReceived =
          optionData.closePrice === null ? null : optionData.closePrice * SHARES_PER_CONTRACT;

        const completedRow: CoveredPutRow = {
          ...row,
          closingPrice: stockRowData.closePrice,
          putPrice: optionData.closePrice,
          premiumReceived,
          cashToSecure: row.strikePrice * SHARES_PER_CONTRACT,
          statusCode: optionData.statusCode,
        };

        if (completedRow.putPrice !== null) {
          setRows((previousRows) => [...previousRows, completedRow]);
        }
      }
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "Failed to run covered put analysis";
      setError(nextError);
    } finally {
      setLoading(false);
    }
  };

  const metaItems = useMemo(
    () => [
      { key: "first", label: "1st date from JSON", children: getFirstTradingDateOnOrAfter(date) ?? "-" },
      { key: "stock", label: "Current stock close", children: formatCurrency(currentStockPrice) },
      { key: "strike", label: "Calculated strike", children: formatCurrency(calculatedStrikePrice) },
      { key: "cash", label: "Cash secured / contract", children: formatCurrency(calculatedStrikePrice === null ? null : calculatedStrikePrice * SHARES_PER_CONTRACT) },
      { key: "expiry", label: "Calculated expiry (preferred or 30-45 DTE)", children: calculatedExpiryDate ?? "-" },
    ],
    [calculatedExpiryDate, calculatedStrikePrice, currentStockPrice, date]
  );

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <Card title="Covered Put Inputs">
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12} lg={6}>
            <Text>Date</Text>
            <DatePicker
              value={dayjs(date)}
              onChange={(value) => setDate(value ? value.format("YYYY-MM-DD") : "")}
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>Stock ticker</Text>
            <Input
              value={stockTicker}
              onChange={(event) => setStockTicker(event.target.value.toUpperCase())}
              style={{ marginTop: 8 }}
              placeholder="SPY"
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>Strike % below stock close</Text>
            <InputNumber<number>
              value={strikePctBelow}
              onChange={(value) => setStrikePctBelow(Math.max(0, value ?? 0))}
              min={0}
              max={50}
              step={0.25}
              precision={2}
              style={{ width: "100%", marginTop: 8 }}
              formatter={(value) => `${value ?? ""}%`}
              parser={(value) => Number(String(value ?? "").replace(/[^\d.-]/g, ""))}
            />
          </Col>
          <Col xs={24} md={12} lg={6}>
            <Text>Preferred expiry date</Text>
            <DatePicker
              value={preferredExpiryDate ? dayjs(preferredExpiryDate) : null}
              onChange={(value) => setPreferredExpiryDate(value ? value.format("YYYY-MM-DD") : "")}
              style={{ width: "100%", marginTop: 8 }}
            />
          </Col>
        </Row>

        <Space style={{ marginTop: 16 }}>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={loading}>
            Run Covered Put
          </Button>
        </Space>
      </Card>

      <Card title="Cash Secured Put Values">
        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} items={metaItems} />
      </Card>

      {error && <Alert type="error" showIcon message="Covered Put Error" description={error} />}

      <Card title="Records">
        <Table<CoveredPutRow>
          rowKey="key"
          loading={loading}
          dataSource={rows}
          pagination={false}
          columns={[
            { title: "Date", dataIndex: "date", key: "date" },
            {
              title: "Closing Price",
              dataIndex: "closingPrice",
              key: "closingPrice",
              render: (value: number | null) => formatCurrency(value),
            },
            {
              title: "Strike Price",
              dataIndex: "strikePrice",
              key: "strikePrice",
              render: (value: number) => formatCurrency(value),
            },
            { title: "Expiry Date", dataIndex: "expiryDate", key: "expiryDate" },
            {
              title: "Put Price",
              dataIndex: "putPrice",
              key: "putPrice",
              render: (value: number | null) => formatCurrency(value),
            },
            {
              title: "Premium / Contract",
              dataIndex: "premiumReceived",
              key: "premiumReceived",
              render: (value: number | null) => formatCurrency(value),
            },
            {
              title: "Cash to Secure",
              dataIndex: "cashToSecure",
              key: "cashToSecure",
              render: (value: number) => formatCurrency(value),
            },
          ]}
        />
      </Card>
    </Space>
  );
};

export default CoveredPut;