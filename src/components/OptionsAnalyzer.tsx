/**
 * OptionsAnalyzer — screen for analyzing option premiums over a date range
 * Accepts JSON input with array of objects, calls Massive.com API, and displays results
 */

import React, { useState } from "react";
import {
  Button,
  Input,
  Space,
  Table,
  Alert,
  Spin,
  Card,
  message,
  Empty,
} from "antd";
import {
  PlayCircleOutlined,
  CopyOutlined,
  CheckOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import * as XLSX from "xlsx";
import { fetchOptionOpenClose } from "../api/backtest";
import tradingDates2026Json from "../assets/trading_dates_2026.json";
import type {
  OptionsInput,
  OptionsAnalysisRow,
  StrikePremium,
} from "../types";

interface AnalysisResult {
  rows: OptionsAnalysisRow[];
  inputData: OptionsInput[];
}

interface CachedOptionResponse {
  symbol: string;
  expiryDate: string;
  strikePrice: number;
  optionType: "C" | "P";
  date: string;
  openPrice: number | null;
  closePrice: number | null;
  statusCode: number | null;
  skipFuture: boolean;
}

type MasterOptionData = Record<string, CachedOptionResponse>;

const MASTER_OPTION_DATA_KEY = "masterOptionData";
const tradingDates2026 = new Set<string>(tradingDates2026Json as string[]);
const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RATE_LIMIT_RETRIES = 3;

const OptionsAnalyzer: React.FC = () => {
  const [jsonInput, setJsonInput] = useState<string>(
    JSON.stringify(
      [
        {
          "expiryDate": "2026-12-18",
          "date": "2026-05-01",
          "strikePrice": 450,
          "symbol": "GLD"
        }
      ],
      null,
      2
    )
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [copied, setCopied] = useState(false);

  const getCacheKey = (
    symbol: string,
    expiryDate: string,
    strikePrice: number,
    optionType: "C" | "P",
    date: string
  ): string => {
    return `${symbol}|${expiryDate}|${strikePrice}|${optionType}|${date}`;
  };

  const loadMasterOptionData = (): MasterOptionData => {
    try {
      const raw = localStorage.getItem(MASTER_OPTION_DATA_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as MasterOptionData;
    } catch {
      return {};
    }
  };

  const saveMasterOptionData = (data: MasterOptionData) => {
    localStorage.setItem(MASTER_OPTION_DATA_KEY, JSON.stringify(data));
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const fetchOptionWithRateLimitRetry = async (
    symbol: string,
    expiryDate: string,
    strikePrice: number,
    optionType: "C" | "P",
    date: string
  ) => {
    let response = await fetchOptionOpenClose(symbol, expiryDate, strikePrice, optionType, date);
    let attempts = 0;

    while (response.statusCode === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      attempts += 1;
      message.warning(`Rate limit hit (429). Waiting 65 seconds before retry ${attempts}.`);
      await sleep(RATE_LIMIT_WAIT_MS);
      response = await fetchOptionOpenClose(symbol, expiryDate, strikePrice, optionType, date);
    }

    return response;
  };

  /**
   * Format date from YYYY-MM-DD to YYMMDD
   */
  const formatExpiryDate = (dateStr: string): string => {
    return dayjs(dateStr).format("YYMMDD");
  };

  /**
   * Format date from YYYY-MM-DD to MM/DD/YY for display
   */
  const formatDisplayDate = (dateStr: string): string => {
    return dayjs(dateStr).format("MM/DD/YY");
  };

  /**
   * Parse JSON input and validate structure
   */
  const parseInput = (): OptionsInput[] => {
    try {
      const parsed = JSON.parse(jsonInput);

      if (!Array.isArray(parsed)) {
        throw new Error("Input must be an array of objects");
      }

      if (parsed.length === 0) {
        throw new Error("Input array cannot be empty");
      }

      // Validate each object
      parsed.forEach((obj, idx) => {
        if (!obj.expiryDate || !obj.date || typeof obj.strikePrice !== "number" || !obj.symbol) {
          throw new Error(
            `Invalid object at index ${idx}: must have expiryDate, date, strikePrice, and symbol`
          );
        }
        if (!Number.isFinite(obj.strikePrice)) {
          throw new Error(`Invalid strikePrice at index ${idx}: must be a finite number`);
        }
        // Validate dates are valid ISO format
        if (!dayjs(obj.expiryDate).isValid() || !dayjs(obj.date).isValid()) {
          throw new Error(
            `Invalid date format at index ${idx}: dates must be in YYYY-MM-DD format`
          );
        }
      });

      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to parse JSON";
      throw new Error(msg);
    }
  };

  const expandInputData = (inputs: OptionsInput[]): OptionsInput[] => {
    const expanded: OptionsInput[] = [];

    for (const input of inputs) {
      const start = dayjs(input.date);
      const end = dayjs(input.expiryDate);

      if (start.isAfter(end)) {
        throw new Error(
          `Invalid range for ${input.symbol}: date (${input.date}) cannot be after expiryDate (${input.expiryDate})`
        );
      }

      let current = start;
      while (!current.isAfter(end, "day")) {
        // skip dates that are not in the trading_dates_2026 set to reduce API calls for non-trading days
        if (!tradingDates2026.has(current.format("YYYY-MM-DD"))) {
          current = current.add(1, "day");
          continue;
        }

        expanded.push({
          ...input,
          date: current.format("YYYY-MM-DD"),
        });
        current = current.add(1, "day");
      }
    }

    return expanded;
  };

  /**
   * Main analysis function
   */
  const handleAnalyze = async () => {
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const inputData = parseInput();
      const expandedInputData = expandInputData(inputData);
      const masterOptionData = loadMasterOptionData();
      let cacheUpdated = false;
      let sawRateLimit = false;

      const rows: OptionsAnalysisRow[] = [];
      setResult({ rows: [], inputData });

      // Process each input row independently so each row keeps its own strike/symbol/expiry/date
      for (const input of expandedInputData) {
        const date = input.date;
        const strikePrice = input.strikePrice;
        const symbol = input.symbol.toUpperCase();
        const expiryDate = formatExpiryDate(input.expiryDate);
        const ceStrike = strikePrice + 0;//temp 0
        const peStrike = strikePrice - 0;// temp 0 

        const ceKey = getCacheKey(symbol, expiryDate, ceStrike, "C", date);
        const peKey = getCacheKey(symbol, expiryDate, peStrike, "P", date);

        const ceCached = masterOptionData[ceKey];
        const peCached = masterOptionData[peKey];

        // Backfill old cache entries that predate status metadata.
        if (ceCached && (typeof ceCached.skipFuture === "undefined" || typeof ceCached.statusCode === "undefined")) {
          ceCached.skipFuture = false;
          ceCached.statusCode = null;
          cacheUpdated = true;
        }
        if (peCached && (typeof peCached.skipFuture === "undefined" || typeof peCached.statusCode === "undefined")) {
          peCached.skipFuture = false;
          peCached.statusCode = null;
          cacheUpdated = true;
        }

        // Migrate old entries that used 429 as permanent skip so retries can happen.
        if (ceCached?.statusCode === 429 && ceCached.skipFuture) {
          ceCached.skipFuture = false;
          cacheUpdated = true;
        }
        if (peCached?.statusCode === 429 && peCached.skipFuture) {
          peCached.skipFuture = false;
          cacheUpdated = true;
        }

        const ceCanUseCache = Boolean(
          ceCached &&
          ((ceCached.skipFuture && ceCached.statusCode === 404) ||
            ceCached.openPrice !== null ||
            ceCached.closePrice !== null)
        );
        const peCanUseCache = Boolean(
          peCached &&
          ((peCached.skipFuture && peCached.statusCode === 404) ||
            peCached.openPrice !== null ||
            peCached.closePrice !== null)
        );

        // Check localStorage cache first and call API only for misses
        const [ceData, peData] = await Promise.all([
          ceCanUseCache
            ? Promise.resolve({
              openPrice: ceCached?.openPrice ?? null,
              closePrice: ceCached?.closePrice ?? null,
              statusCode: ceCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, expiryDate, ceStrike, "C", date),
          peCanUseCache
            ? Promise.resolve({
              openPrice: peCached?.openPrice ?? null,
              closePrice: peCached?.closePrice ?? null,
              statusCode: peCached?.statusCode ?? null,
            })
            : fetchOptionWithRateLimitRetry(symbol, expiryDate, peStrike, "P", date),
        ]);

        if (ceData.statusCode === 429 || peData.statusCode === 429) {
          sawRateLimit = true;
        }

        const cePrice = ceData.closePrice;
        const pePrice = peData.closePrice;

        if (!ceCanUseCache) {
          const shouldSkipCe = ceData.statusCode === 404;
          masterOptionData[ceKey] = {
            symbol,
            expiryDate,
            strikePrice: ceStrike,
            optionType: "C",
            date,
            openPrice: ceData.openPrice,
            closePrice: cePrice,
            statusCode: ceData.statusCode,
            skipFuture: shouldSkipCe,
          };
          cacheUpdated = true;
        }

        if (!peCanUseCache) {
          const shouldSkipPe = peData.statusCode === 404;
          masterOptionData[peKey] = {
            symbol,
            expiryDate,
            strikePrice: peStrike,
            optionType: "P",
            date,
            openPrice: peData.openPrice,
            closePrice: pePrice,
            statusCode: peData.statusCode,
            skipFuture: shouldSkipPe,
          };
          cacheUpdated = true;
        }

        let previousDate: string | null = null;
        for (let daysBack = 1; daysBack <= 5; daysBack += 1) {
          const candidate = dayjs(date).subtract(daysBack, "day").format("YYYY-MM-DD");
          if (tradingDates2026.has(candidate)) {
            previousDate = candidate;
            break;
          }
        }
        const previousCeClose = previousDate
          ? masterOptionData[getCacheKey(symbol, expiryDate, ceStrike, "C", previousDate)]
            ?.closePrice ?? null
          : null;
        const previousPeClose = previousDate
          ? masterOptionData[getCacheKey(symbol, expiryDate, peStrike, "P", previousDate)]
            ?.closePrice ?? null
          : null;

        const markChangeCall =
          cePrice !== null && previousCeClose !== null ? cePrice - previousCeClose : null;
        const markChangePut =
          pePrice !== null && previousPeClose !== null ? pePrice - previousPeClose : null;

        const row: OptionsAnalysisRow = {
          date: formatDisplayDate(date),
          closingPrice: strikePrice,
          ceStrike,
          peStrike,
          cePremiumData: cePrice !== null
            ? {
              expiryDate: formatDisplayDate(input.expiryDate),
              strike: ceStrike,
              closePrice: cePrice,
            }
            : null,
          markChangeCall,
          pePremiumData: pePrice !== null
            ? {
              expiryDate: formatDisplayDate(input.expiryDate),
              strike: peStrike,
              closePrice: pePrice,
            }
            : null,
          markChangePut,
        };

        rows.push(row);
        // Stream rows to the table as each API response completes.
        setResult({ rows: [...rows], inputData });
      }

      if (cacheUpdated) {
        saveMasterOptionData(masterOptionData);
      }

      if (sawRateLimit) {
        message.warning("Some requests returned 429 after retries; processing continued.");
      }
      message.success(`Analysis completed for ${rows.length} dates`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Copy results to clipboard as JSON
   */
  const copyToClipboard = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.rows, null, 2));
      setCopied(true);
      message.success("Results copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      message.error("Failed to copy");
    }
  };

  const downloadCurrentViewAsExcel = () => {
    if (!result || result.rows.length === 0) {
      message.warning("No rows available to export");
      return;
    }

    try {
      const exportRows = result.rows.map((row) => ({
        Date: row.date,
        "Closing/Stock Price": row.closingPrice.toFixed(2),
        "CE Strike": row.ceStrike.toFixed(0),
        "PE Strike": row.peStrike.toFixed(0),
        "CE Call Premium": row.cePremiumData
          ? `${row.cePremiumData.expiryDate}-${row.cePremiumData.strike}`
          : "—",
        "Call Price": row.cePremiumData ? row.cePremiumData.closePrice.toFixed(2) : "—",
        "Mark change - Call": row.markChangeCall !== null ? row.markChangeCall.toFixed(2) : "—",
        "Put Premium": row.pePremiumData
          ? `${row.pePremiumData.expiryDate}-${row.pePremiumData.strike}`

          : "—",
        "PE Price": row.pePremiumData ? row.pePremiumData.closePrice.toFixed(2) : "—",
        "Total Value":
          row.cePremiumData !== null && row.pePremiumData !== null
            ? (row.cePremiumData.closePrice + row.pePremiumData.closePrice).toFixed(2)
            : "—",
        "Mark change - Put": row.markChangePut !== null ? row.markChangePut.toFixed(2) : "—",
      }));

      const worksheet = XLSX.utils.json_to_sheet(exportRows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Analysis Results");

      const timestamp = dayjs().format("YYYYMMDD-HHmmss");
      XLSX.writeFile(workbook, `options-analysis-${timestamp}.xlsx`);
    } catch {
      message.error("Failed to export Excel file");
    }
  };

  const columns = [
    {
      title: "Date",
      dataIndex: "date",
      key: "date",
      width: 100,
    },
    {
      title: "Closing/Stock Price",
      dataIndex: "closingPrice",
      key: "closingPrice",
      width: 150,
      render: (value: number) => value.toFixed(2),
    },
    {
      title: "Call Strike",
      dataIndex: "ceStrike",
      key: "ceStrike",
      width: 120,
      render: (value: number) => value.toFixed(0),
    },
    {
      title: "Put Strike",
      dataIndex: "peStrike",
      key: "peStrike",
      width: 120,
      render: (value: number) => value.toFixed(0),
    },
    {
      title: "Call Premium",
      dataIndex: "cePremiumData",
      key: "cePremium",
      width: 200,
      render: (value: StrikePremium | null) => {
        if (!value) return "—";
        return `${value.expiryDate}-${value.strike}`;
      },
    },
    {
      title: "Call Price",
      dataIndex: "cePremiumData",
      key: "cePrice",
      width: 120,
      render: (value: StrikePremium | null) => {
        if (!value) return "—";
        return value.closePrice.toFixed(2);
      },
    },
    {
      title: "Mark change - Call",
      dataIndex: "markChangeCall",
      key: "markChangeCall",
      width: 170,
      render: (value: number | null) => {
        if (value === null) return "—";
        return value.toFixed(2);
      },
    },
    {
      title: "Put Premium",
      dataIndex: "pePremiumData",
      key: "pePremium",
      width: 200,
      render: (value: StrikePremium | null) => {
        if (!value) return "—";
        return `${value.expiryDate}-${value.strike}`;
      },
    },
    {
      title: "Put Price",
      dataIndex: "pePremiumData",
      key: "pePrice",
      width: 120,
      render: (value: StrikePremium | null) => {
        if (!value) return "—";
        return value.closePrice.toFixed(2);
      },
    },
    {
      title: "Mark change - Put",
      dataIndex: "markChangePut",
      key: "markChangePut",
      width: 170,
      render: (value: number | null) => {
        if (value === null) return "—";
        return value.toFixed(2);
      },
    },
    {
      title: "Total Value",
      key: "totalValue",
      width: 130,
      render: (_value: unknown, record: OptionsAnalysisRow) => {
        if (!record.cePremiumData || !record.pePremiumData) return "—";
        return (record.cePremiumData.closePrice + record.pePremiumData.closePrice).toFixed(2);
      },
    },
  ];

  return (
    <div style={{ padding: "24px" }}>
      <Card title="Options Chain Analyzer" style={{ marginBottom: "24px" }}>
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <div>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "500" }}>
              Input JSON (Array of Options):
            </label>
            <Input.TextArea
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              rows={10}
              placeholder='[{"expiryDate": "2026-06-12", "date": "2026-05-15", "strikePrice": 750, "symbol": "SPY"}]'
              style={{ fontFamily: "monospace" }}
            />
            <p style={{ fontSize: "12px", color: "#666", marginTop: "8px" }}>
              Format: Array of objects with expiryDate, date, strikePrice, and symbol.
              Dates should be in YYYY-MM-DD format.
            </p>
          </div>

          <Space>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleAnalyze}
              loading={loading}
              size="large"
            >
              Analyze
            </Button>
          </Space>

          {error && <Alert message="Error" description={error} type="error" showIcon />}
        </Space>
      </Card>

      {loading && (
        <Card style={{ textAlign: "center" }}>
          <Spin size="large" tip="Fetching option prices..." />
        </Card>
      )}

      {result && (
        <Card title="Analysis Results" style={{ marginBottom: "24px" }}>
          <Space style={{ marginBottom: "16px" }}>
            <Button
              icon={copied ? <CheckOutlined /> : <CopyOutlined />}
              onClick={copyToClipboard}
            >
              {copied ? "Copied!" : "Copy Results"}
            </Button>
            <Button icon={<DownloadOutlined />} onClick={downloadCurrentViewAsExcel}>
              Download Excel
            </Button>
          </Space>

          {result.rows.length === 0 ? (
            <Empty description="No data to display" />
          ) : (
            <Table
              columns={columns}
              dataSource={result.rows.map((row, idx) => ({
                ...row,
                key: idx,
              }))}
              pagination={{ pageSize: 50 }}
              scroll={{ x: 1600 }}
              size="small"
            />
          )}

          <div style={{ marginTop: "24px" }}>
            <p style={{ fontWeight: "500", marginBottom: "8px" }}>Input Data:</p>
            <pre
              style={{
                backgroundColor: "#f5f5f5",
                padding: "12px",
                borderRadius: "4px",
                overflow: "auto",
              }}
            >
              {JSON.stringify(result.inputData, null, 2)}
            </pre>
          </div>
        </Card>
      )}
    </div>
  );
};

export default OptionsAnalyzer;
