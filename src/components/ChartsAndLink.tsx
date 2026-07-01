import React, { useState } from "react";
import { Button, Card, Col, DatePicker, Form, InputNumber, Modal, Row, Select, Space, Table, Typography, message } from "antd";
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
import dayjs, { type Dayjs } from "dayjs";
import spyClosingData from "../assets/spy-closing.json";
import { fetchOptionOpenClose } from "../api/backtest";

const { Title, Link } = Typography;

const SYMBOLS = ["SPY", "QQQ", "IWM", "DIA", "AAPL", "TSLA", "NVDA", "AMZN", "MSFT", "GOOG"];
type OptionType = "Call" | "Put";

interface SelectedOptionQuote {
  date: string;
  openPrice: number | null;
  closePrice: number | null;
  delta: number | null;
  theta: number | null;
}

interface WeeklyOptionCloseRow {
  key: string;
  date: string;
  closePrice: number | null;
}

interface SavedWeeklyCloseRecord {
  id: string;
  label: string;
  symbol: string;
  optionType: OptionType;
  strike: number;
  startDate: string;
  expiryDate: string;
  rows: WeeklyOptionCloseRow[];
}

interface OptionPivotRow {
  key: string;
  date: string;
  [datasetKey: string]: string | number | null;
}

interface CachedOptionQuoteResponse {
  openPrice: number | null;
  closePrice: number | null;
  delta: number | null;
  theta: number | null;
}

interface TradeLink {
  label: string;
  url: (symbol: string) => string;
}

const TRADE_LINKS: TradeLink[] = [
  {
    label: "TradingView Chart",
    url: (s) => `https://www.tradingview.com/chart/?symbol=${s}`,
  },
  {
    label: "Option Chain (Nasdaq)",
    url: (s) => `https://www.nasdaq.com/market-activity/stocks/${s.toLowerCase()}/option-chain`,
  },
  {
    label: "OptionStrat",
    url: (s) => `https://optionstrat.com/build/custom/${s}`,
  },
  {
    label: "Barchart Options",
    url: (s) => `https://www.barchart.com/stocks/quotes/${s}/options`,
  },
  {
    label: "CBOE Options",
    url: (s) => `https://www.cboe.com/delayed_quotes/${s}/options`,
  },
  {
    label: "Market Chameleon",
    url: (s) => `https://marketchameleon.com/Overview/${s}/`,
  },
  {
    label: "Unusual Whales",
    url: (s) => `https://unusualwhales.com/stock/${s}`,
  },
  {
    label: "Yahoo Finance",
    url: (s) => `https://finance.yahoo.com/quote/${s}/options/`,
  },
];

const FIXED_DEFAULT_CURRENT_DATE = dayjs("2025-01-02");
const FIXED_DEFAULT_EXPIRY_DATE = dayjs("2025-12-19");
const formatExpiryDate = (dateValue: Dayjs) => dateValue.format("YYMMDD");
const getRollDateFromExpiry = (expiryDateIso: string): Dayjs | null => {
  const expiry = dayjs(expiryDateIso);
  if (!expiry.isValid()) {
    return null;
  }

  // Roll date must be at least one week after expiry and land on a Friday.
  const minimumDate = expiry.add(7, "day");
  const fridayIndex = 5;
  const daysUntilFriday = (fridayIndex - minimumDate.day() + 7) % 7;
  return minimumDate.add(daysUntilFriday, "day");
};
const CHARTS_LINK_DATES_STORAGE_KEY = "chartsAndLinkDates";
const CHARTS_LINK_OPTION_API_CACHE_KEY = "chartsAndLinkOptionApiCache";
const CHARTS_LINK_WEEKLY_CLOSE_STORAGE_KEY = "chartsAndLinkWeeklyCloseRecords";
const CHARTS_LINK_PAGE_SNAPSHOT_STORAGE_KEY = "chartsAndLinkPageSnapshot";
const OPTION_SERIES_COLORS = ["#1677ff", "#13c2c2", "#52c41a", "#faad14", "#fa541c", "#eb2f96", "#722ed1"];

const PRELOADED_WEEKLY_RECORDS: SavedWeeklyCloseRecord[] = [
  {
    id: "preload|SPY|P|600|2025-01-02|2025-12-19",
    label: "SPY Put 600 (2025-01-02 -> 2025-12-19)",
    symbol: "SPY",
    optionType: "Put",
    strike: 600,
    startDate: "2025-01-02",
    expiryDate: "2025-12-19",
    rows: [],
  },
  {
    id: "preload|SPY|C|600|2025-01-02|2025-12-19",
    label: "SPY Call 600 (2025-01-02 -> 2025-12-19)",
    symbol: "SPY",
    optionType: "Call",
    strike: 600,
    startDate: "2025-01-02",
    expiryDate: "2025-12-19",
    rows: [],
  },
];

const ChartsAndLink: React.FC = () => {
  const [selectedSymbol, setSelectedSymbol] = useState("SPY");
  const [currentDate, setCurrentDate] = useState<Dayjs | null>(FIXED_DEFAULT_CURRENT_DATE);
  const [expiryDate, setExpiryDate] = useState<Dayjs | null>(FIXED_DEFAULT_EXPIRY_DATE);
  const [optionType, setOptionType] = useState<OptionType>("Put");
  const [strikePrice, setStrikePrice] = useState<number | null>(600);
  const [optionQuoteLoading, setOptionQuoteLoading] = useState(false);
  const [selectedOptionQuote, setSelectedOptionQuote] = useState<SelectedOptionQuote | null>(null);
  const [weeklyCloseLoading, setWeeklyCloseLoading] = useState(false);
  const [weeklyCloseRows, setWeeklyCloseRows] = useState<WeeklyOptionCloseRow[]>([]);
  const [savedWeeklyCloseRecords, setSavedWeeklyCloseRecords] = useState<SavedWeeklyCloseRecord[]>([]);
  const [activeWeeklyRecordId, setActiveWeeklyRecordId] = useState<string | null>(null);
  const [showWeeklyCloseTable, setShowWeeklyCloseTable] = useState(true);
  const [pivotValuePopup, setPivotValuePopup] = useState<{
    open: boolean;
    date: string;
    optionName: string;
    currentValue: number | null;
    rollDate: Dayjs | null;
    rollStrike: number | null;
    symbol: string;
    optionSide: "C" | "P" | null;
    expiryDate: string;
    fetchedOptionValue: number | null;
    netTradeResult: number | null;
  }>({
    open: false,
    date: "",
    optionName: "",
    currentValue: null,
    rollDate: null,
    rollStrike: null,
    symbol: "",
    optionSide: null,
    expiryDate: "",
    fetchedOptionValue: null,
    netTradeResult: null,
  });
  const [rollOptionValueLoading, setRollOptionValueLoading] = useState(false);

  const extractStrikeFromOptionName = (optionName: string): number | null => {
    const strikeMatch = optionName.match(/\b(\d+(?:\.\d+)?)\b/);
    if (!strikeMatch) {
      return null;
    }

    const parsed = Number(strikeMatch[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const handleGetPopupOptionValue = async () => {
    if (!pivotValuePopup.symbol || !pivotValuePopup.optionSide || !pivotValuePopup.expiryDate) {
      message.warning("Missing option metadata for this row");
      return;
    }

    if (!pivotValuePopup.rollDate || !pivotValuePopup.rollDate.isValid()) {
      message.warning("Select roll date");
      return;
    }

    if (typeof pivotValuePopup.rollStrike !== "number" || !Number.isFinite(pivotValuePopup.rollStrike) || pivotValuePopup.rollStrike <= 0) {
      message.warning("Enter valid roll strike");
      return;
    }

    setRollOptionValueLoading(true);
    try {
      const response = await fetchOptionOpenCloseCached(
        pivotValuePopup.symbol,
        formatExpiryDate(dayjs(pivotValuePopup.expiryDate)),
        pivotValuePopup.rollStrike,
        pivotValuePopup.optionSide,
        pivotValuePopup.rollDate.format("YYYY-MM-DD")
      );

      const nextOptionValue = response.closePrice ?? response.openPrice;
      const netTradeResult =
        typeof nextOptionValue === "number" && Number.isFinite(nextOptionValue) &&
        typeof pivotValuePopup.currentValue === "number" && Number.isFinite(pivotValuePopup.currentValue)
          ? nextOptionValue - pivotValuePopup.currentValue
          : null;

      setPivotValuePopup((previous) => ({
        ...previous,
        fetchedOptionValue: typeof nextOptionValue === "number" && Number.isFinite(nextOptionValue) ? Number(nextOptionValue.toFixed(2)) : null,
        netTradeResult: typeof netTradeResult === "number" && Number.isFinite(netTradeResult) ? Number(netTradeResult.toFixed(2)) : null,
      }));

      if (nextOptionValue === null || !Number.isFinite(nextOptionValue)) {
        message.warning("No option value returned for roll date/strike");
      }
    } catch {
      message.error("Failed to fetch rolled option value");
    } finally {
      setRollOptionValueLoading(false);
    }
  };

  const getOptionCacheKey = (
    symbol: string,
    formattedExpiry: string,
    strike: number,
    optionSide: "C" | "P",
    quoteDate: string
  ) => `${symbol}|${formattedExpiry}|${strike}|${optionSide}|${quoteDate}`;

  const readOptionApiCache = (): Record<string, CachedOptionQuoteResponse> => {
    const rawCache = localStorage.getItem(CHARTS_LINK_OPTION_API_CACHE_KEY);
    if (!rawCache) {
      return {};
    }

    try {
      const parsed = JSON.parse(rawCache) as Record<string, CachedOptionQuoteResponse>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  const writeOptionApiCache = (cache: Record<string, CachedOptionQuoteResponse>) => {
    localStorage.setItem(CHARTS_LINK_OPTION_API_CACHE_KEY, JSON.stringify(cache));
  };

  const fetchOptionOpenCloseCached = async (
    symbol: string,
    formattedExpiry: string,
    strike: number,
    optionSide: "C" | "P",
    quoteDate: string
  ): Promise<CachedOptionQuoteResponse> => {
    const cacheKey = getOptionCacheKey(symbol, formattedExpiry, strike, optionSide, quoteDate);
    const cache = readOptionApiCache();
    const cachedResponse = cache[cacheKey];

    if (cachedResponse) {
      return cachedResponse;
    }

    const apiResponse = await fetchOptionOpenClose(symbol, formattedExpiry, strike, optionSide, quoteDate);
    const normalizedResponse: CachedOptionQuoteResponse = {
      openPrice: apiResponse.openPrice,
      closePrice: apiResponse.closePrice,
      delta: apiResponse.delta,
      theta: apiResponse.theta,
    };

    cache[cacheKey] = normalizedResponse;
    writeOptionApiCache(cache);
    return normalizedResponse;
  };

  const sanitizeWeeklyRows = (rows: WeeklyOptionCloseRow[]) => {
    return rows
      .filter((row) => row && typeof row.date === "string")
      .map((row) => ({
        key: row.date,
        date: row.date,
        closePrice: typeof row.closePrice === "number" && Number.isFinite(row.closePrice) ? row.closePrice : null,
      }));
  };

  React.useEffect(() => {
    const rawDates = localStorage.getItem(CHARTS_LINK_DATES_STORAGE_KEY);
    if (!rawDates) {
      return;
    }

    try {
      const parsed = JSON.parse(rawDates) as {
        currentDate?: string;
        expiryDate?: string;
      };

      if (parsed.currentDate) {
        const parsedCurrentDate = dayjs(parsed.currentDate);
        if (parsedCurrentDate.isValid()) {
          setCurrentDate(parsedCurrentDate);
        }
      }

      if (parsed.expiryDate) {
        const parsedExpiryDate = dayjs(parsed.expiryDate);
        if (parsedExpiryDate.isValid()) {
          setExpiryDate(parsedExpiryDate);
        }
      }
    } catch {
      // Ignore malformed date storage.
    }
  }, []);

  React.useEffect(() => {
    const rawSnapshot = localStorage.getItem(CHARTS_LINK_PAGE_SNAPSHOT_STORAGE_KEY);
    if (!rawSnapshot) {
      return;
    }

    try {
      const parsed = JSON.parse(rawSnapshot) as {
        selectedSymbol?: string;
        optionType?: OptionType;
        strikePrice?: number | null;
        currentDate?: string | null;
        expiryDate?: string | null;
        activeWeeklyRecordId?: string | null;
        showWeeklyCloseTable?: boolean;
      };

      if (typeof parsed.selectedSymbol === "string" && parsed.selectedSymbol) {
        setSelectedSymbol(parsed.selectedSymbol);
      }

      if (parsed.optionType === "Call" || parsed.optionType === "Put") {
        setOptionType(parsed.optionType);
      }

      if (typeof parsed.strikePrice === "number" && Number.isFinite(parsed.strikePrice) && parsed.strikePrice > 0) {
        setStrikePrice(parsed.strikePrice);
      }

      if (parsed.currentDate) {
        const parsedCurrentDate = dayjs(parsed.currentDate);
        if (parsedCurrentDate.isValid()) {
          setCurrentDate(parsedCurrentDate);
        }
      }

      if (parsed.expiryDate) {
        const parsedExpiryDate = dayjs(parsed.expiryDate);
        if (parsedExpiryDate.isValid()) {
          setExpiryDate(parsedExpiryDate);
        }
      }

      if (typeof parsed.activeWeeklyRecordId === "string" || parsed.activeWeeklyRecordId === null) {
        setActiveWeeklyRecordId(parsed.activeWeeklyRecordId ?? null);
      }

      if (typeof parsed.showWeeklyCloseTable === "boolean") {
        setShowWeeklyCloseTable(parsed.showWeeklyCloseTable);
      }
    } catch {
      // Ignore malformed page snapshot.
    }
  }, []);

  React.useEffect(() => {
    const rawWeeklyRows = localStorage.getItem(CHARTS_LINK_WEEKLY_CLOSE_STORAGE_KEY);
    if (!rawWeeklyRows) {
      setSavedWeeklyCloseRecords(PRELOADED_WEEKLY_RECORDS);
      setActiveWeeklyRecordId(PRELOADED_WEEKLY_RECORDS[0]?.id ?? null);
      return;
    }

    try {
      const parsed = JSON.parse(rawWeeklyRows) as SavedWeeklyCloseRecord[] | WeeklyOptionCloseRow[];

      // Backward compatibility for older single-array storage.
      if (Array.isArray(parsed) && parsed.length > 0 && "date" in parsed[0] && !("rows" in parsed[0])) {
        const legacyRows = sanitizeWeeklyRows(parsed as WeeklyOptionCloseRow[]);
        if (legacyRows.length > 0) {
          const legacyRecord: SavedWeeklyCloseRecord = {
            id: "legacy",
            label: "Legacy Saved Data",
            symbol: selectedSymbol,
            optionType,
            strike: strikePrice ?? 0,
            startDate: legacyRows[0]?.date ?? "",
            expiryDate: legacyRows[legacyRows.length - 1]?.date ?? "",
            rows: legacyRows,
          };
          setSavedWeeklyCloseRecords([legacyRecord]);
          setActiveWeeklyRecordId(legacyRecord.id);
          setWeeklyCloseRows(legacyRows);
        }
        return;
      }

      if (Array.isArray(parsed)) {
        const sanitizedRecords = parsed
          .filter((record) => record && typeof (record as SavedWeeklyCloseRecord).id === "string")
          .map((record) => {
            const normalizedRecord = record as SavedWeeklyCloseRecord;
            return {
              ...normalizedRecord,
              rows: sanitizeWeeklyRows(normalizedRecord.rows ?? []),
            };
          });

        setSavedWeeklyCloseRecords(sanitizedRecords);
        if (sanitizedRecords.length > 0) {
          setActiveWeeklyRecordId(sanitizedRecords[0].id);
          setWeeklyCloseRows(sanitizedRecords[0].rows);
        } else {
          setSavedWeeklyCloseRecords(PRELOADED_WEEKLY_RECORDS);
          setActiveWeeklyRecordId(PRELOADED_WEEKLY_RECORDS[0]?.id ?? null);
        }
      }
    } catch {
      // Ignore malformed weekly close storage.
      setSavedWeeklyCloseRecords(PRELOADED_WEEKLY_RECORDS);
      setActiveWeeklyRecordId(PRELOADED_WEEKLY_RECORDS[0]?.id ?? null);
    }
  }, []);

  React.useEffect(() => {
    const payload = {
      currentDate: currentDate && currentDate.isValid() ? currentDate.format("YYYY-MM-DD") : null,
      expiryDate: expiryDate && expiryDate.isValid() ? expiryDate.format("YYYY-MM-DD") : null,
    };
    localStorage.setItem(CHARTS_LINK_DATES_STORAGE_KEY, JSON.stringify(payload));
  }, [currentDate, expiryDate]);

  React.useEffect(() => {
    localStorage.setItem(CHARTS_LINK_WEEKLY_CLOSE_STORAGE_KEY, JSON.stringify(savedWeeklyCloseRecords));
  }, [savedWeeklyCloseRecords]);

  React.useEffect(() => {
    const payload = {
      selectedSymbol,
      optionType,
      strikePrice,
      currentDate: currentDate && currentDate.isValid() ? currentDate.format("YYYY-MM-DD") : null,
      expiryDate: expiryDate && expiryDate.isValid() ? expiryDate.format("YYYY-MM-DD") : null,
      activeWeeklyRecordId,
      showWeeklyCloseTable,
    };

    localStorage.setItem(CHARTS_LINK_PAGE_SNAPSHOT_STORAGE_KEY, JSON.stringify(payload));
  }, [
    activeWeeklyRecordId,
    currentDate,
    expiryDate,
    optionType,
    selectedSymbol,
    showWeeklyCloseTable,
    strikePrice,
  ]);

  const getSelectedOptionRequest = () => {
    if (!selectedSymbol) {
      message.warning("Select ticker first");
      return null;
    }

    if (!currentDate || !currentDate.isValid()) {
      message.warning("Select current date");
      return null;
    }

    if (!expiryDate || !expiryDate.isValid()) {
      message.warning("Select expiry date");
      return null;
    }

    if (typeof strikePrice !== "number" || !Number.isFinite(strikePrice) || strikePrice <= 0) {
      message.warning("Enter valid strike price");
      return null;
    }

    return {
      symbol: selectedSymbol,
      startDate: currentDate.startOf("day"),
      expiry: expiryDate.startOf("day"),
      strike: strikePrice,
      optionSide: optionType === "Call" ? "C" as const : "P" as const,
      formattedExpiry: formatExpiryDate(expiryDate),
    };
  };

  const buildWeeklyDatesUntilExpiry = (startDate: Dayjs, expiry: Dayjs) => {
    const dates: string[] = [];
    let cursor = startDate;

    while (cursor.isBefore(expiry, "day") || cursor.isSame(expiry, "day")) {
      dates.push(cursor.format("YYYY-MM-DD"));
      cursor = cursor.add(7, "day");
    }

    const expiryIso = expiry.format("YYYY-MM-DD");
    if (dates[dates.length - 1] !== expiryIso) {
      dates.push(expiryIso);
    }

    return dates;
  };

  const handleGetOptionPriceForSelectedDate = async () => {
    const selectedRequest = getSelectedOptionRequest();
    if (!selectedRequest) {
      return;
    }

    setOptionQuoteLoading(true);
    try {
      const response = await fetchOptionOpenCloseCached(
        selectedRequest.symbol,
        selectedRequest.formattedExpiry,
        selectedRequest.strike,
        selectedRequest.optionSide,
        selectedRequest.startDate.format("YYYY-MM-DD")
      );

      setSelectedOptionQuote({
        date: selectedRequest.startDate.format("YYYY-MM-DD"),
        openPrice: response.openPrice,
        closePrice: response.closePrice,
        delta: response.delta,
        theta: response.theta,
      });

      if (response.openPrice === null && response.closePrice === null) {
        message.warning("No option price returned for selected values/date");
        return;
      }

      message.success("Fetched option price from Massive API");
    } catch {
      message.error("Failed to fetch option price from Massive API");
    } finally {
      setOptionQuoteLoading(false);
    }
  };

  const handleGetWeeklyClosingPrices = async () => {
    const selectedRequest = getSelectedOptionRequest();
    if (!selectedRequest) {
      return;
    }

    const weeklyDates = buildWeeklyDatesUntilExpiry(selectedRequest.startDate, selectedRequest.expiry);
    setWeeklyCloseLoading(true);
    try {
      const rows: WeeklyOptionCloseRow[] = [];

      for (const quoteDate of weeklyDates) {
        const response = await fetchOptionOpenCloseCached(
          selectedRequest.symbol,
          selectedRequest.formattedExpiry,
          selectedRequest.strike,
          selectedRequest.optionSide,
          quoteDate
        );

        rows.push({
          key: quoteDate,
          date: quoteDate,
          closePrice: response.closePrice,
        });
      }

      setWeeklyCloseRows(rows);
      const recordId = [
        selectedRequest.symbol,
        selectedRequest.optionSide,
        selectedRequest.strike,
        selectedRequest.startDate.format("YYYY-MM-DD"),
        selectedRequest.expiry.format("YYYY-MM-DD"),
      ].join("|");
      const optionTypeLabel = selectedRequest.optionSide === "C" ? "Call" : "Put";
      const nextRecord: SavedWeeklyCloseRecord = {
        id: recordId,
        label: `${selectedRequest.symbol} ${optionTypeLabel} ${selectedRequest.strike} (${selectedRequest.startDate.format("YYYY-MM-DD")} -> ${selectedRequest.expiry.format("YYYY-MM-DD")})`,
        symbol: selectedRequest.symbol,
        optionType: optionTypeLabel,
        strike: selectedRequest.strike,
        startDate: selectedRequest.startDate.format("YYYY-MM-DD"),
        expiryDate: selectedRequest.expiry.format("YYYY-MM-DD"),
        rows,
      };

      setSavedWeeklyCloseRecords((previous) => {
        const withoutCurrent = previous.filter((item) => item.id !== nextRecord.id);
        return [nextRecord, ...withoutCurrent];
      });
      setActiveWeeklyRecordId(nextRecord.id);
      message.success(`Fetched weekly close prices for ${rows.length} dates`);
    } catch {
      message.error("Failed to fetch weekly close prices from Massive API");
    } finally {
      setWeeklyCloseLoading(false);
    }
  };

  const chartData = spyClosingData.map((d) => ({
    date: d.date,
    close: d.close,
  }));

  const optionChartState = React.useMemo(() => {
    const series = savedWeeklyCloseRecords.map((record, index) => ({
      id: record.id,
      key: `series_${index + 1}`,
      label: record.label,
    }));

    const dateMap = new Map<string, Record<string, string | number | null>>();

    savedWeeklyCloseRecords.forEach((record, index) => {
      const seriesKey = `series_${index + 1}`;
      record.rows.forEach((row) => {
        const existing = dateMap.get(row.date) ?? { date: row.date };
        existing[seriesKey] = row.closePrice;
        dateMap.set(row.date, existing);
      });
    });

    const data = Array.from(dateMap.entries())
      .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
      .map(([, row]) => row);

    return { data, series };
  }, [savedWeeklyCloseRecords]);

  const pivotTableState = React.useMemo(() => {
    const recordsWithData = savedWeeklyCloseRecords
      .filter((record) => record.rows.length > 0)
      .sort((left, right) => {
        if (left.startDate !== right.startDate) {
          return left.startDate.localeCompare(right.startDate);
        }
        if (left.expiryDate !== right.expiryDate) {
          return left.expiryDate.localeCompare(right.expiryDate);
        }
        return left.label.localeCompare(right.label);
      });

    const columnMeta = recordsWithData.map((record, index) => ({
      key: `dataset_${index + 1}`,
      title: record.label,
      recordId: record.id,
      symbol: record.symbol,
      optionSide: record.optionType === "Call" ? "C" as const : "P" as const,
      expiryDate: record.expiryDate,
      defaultStrike: record.strike,
    }));

    const rowMap = new Map<string, OptionPivotRow>();

    recordsWithData.forEach((record, index) => {
      const datasetKey = `dataset_${index + 1}`;
      record.rows.forEach((row) => {
        const existing = rowMap.get(row.date) ?? { key: row.date, date: row.date };
        existing[datasetKey] = row.closePrice;
        rowMap.set(row.date, existing);
      });
    });

    const rows = Array.from(rowMap.values()).sort((left, right) => left.date.localeCompare(right.date));

    const resultValueForRow = (row: OptionPivotRow) => {
      const col1 = Number(row.dataset_1);
      const col2 = Number(row.dataset_2);
      const col3 = Number(row.dataset_3);
      const col4 = Number(row.dataset_4);

      if ([col1, col2, col3, col4].some((value) => !Number.isFinite(value))) {
        return null;
      }

      return col4 + col3 - col2 - col1;
    };

    return {
      rows,
      columns: [
        {
          title: "Date",
          dataIndex: "date",
          key: "date",
          fixed: "left" as const,
          width: 130,
        },
        ...columnMeta.map((meta) => ({
          title: meta.title,
          dataIndex: meta.key,
          key: meta.key,
          align: "center" as const,
          render: (value: number | null | undefined, row: OptionPivotRow) => {
            if (typeof value !== "number" || !Number.isFinite(value)) {
              return "-";
            }

            return (
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setPivotValuePopup({
                    open: true,
                    date: row.date,
                    optionName: meta.title,
                    currentValue: value,
                    rollDate: getRollDateFromExpiry(meta.expiryDate),
                    rollStrike: extractStrikeFromOptionName(meta.title) ?? meta.defaultStrike,
                    symbol: meta.symbol,
                    optionSide: meta.optionSide,
                    expiryDate: meta.expiryDate,
                    fetchedOptionValue: null,
                    netTradeResult: null,
                  });
                }}
              >
                {value.toFixed(2)}
              </Button>
            );
          },
        })),
        {
          title: "Result",
          key: "result",
          align: "center" as const,
          render: (_: unknown, row: OptionPivotRow) => {
            const resultValue = resultValueForRow(row);
            return resultValue !== null ? resultValue.toFixed(2) : "-";
          },
        },
      ],
    };
  }, [savedWeeklyCloseRecords]);

  const selectedDatePivotState = React.useMemo(() => {
    if (!currentDate || !currentDate.isValid()) {
      return {
        rows: [] as OptionPivotRow[],
        columns: [] as Array<{
          title: string;
          dataIndex: string;
          key: string;
          fixed?: "left";
          width?: number;
          align?: "center";
          render?: (value: number | null | undefined) => string;
        }>,
      };
    }

    const selectedDateIso = currentDate.format("YYYY-MM-DD");
    const recordsWithData = savedWeeklyCloseRecords
      .filter((record) => record.rows.length > 0)
      .sort((left, right) => {
        if (left.startDate !== right.startDate) {
          return left.startDate.localeCompare(right.startDate);
        }
        if (left.expiryDate !== right.expiryDate) {
          return left.expiryDate.localeCompare(right.expiryDate);
        }
        return left.label.localeCompare(right.label);
      });

    const row: OptionPivotRow = { key: selectedDateIso, date: selectedDateIso };
    const resultValueForRow = (currentRow: OptionPivotRow) => {
      const col1 = Number(currentRow.dataset_1);
      const col2 = Number(currentRow.dataset_2);
      const col3 = Number(currentRow.dataset_3);
      const col4 = Number(currentRow.dataset_4);

      if ([col1, col2, col3, col4].some((value) => !Number.isFinite(value))) {
        return null;
      }

      return col4 + col3 - col2 - col1;
    };

    const columns = [
      {
        title: "Date",
        dataIndex: "date",
        key: "date",
        fixed: "left" as const,
        width: 130,
      },
      ...recordsWithData.map((record, index) => ({
        title: record.label,
        dataIndex: `dataset_${index + 1}`,
        key: `dataset_${index + 1}`,
        align: "center" as const,
        render: (value: number | null | undefined, currentRow: OptionPivotRow) => {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            return "-";
          }

          return (
            <Button
              type="link"
              size="small"
              onClick={() => {
                setPivotValuePopup({
                  open: true,
                  date: currentRow.date,
                  optionName: record.label,
                  currentValue: value,
                  rollDate: getRollDateFromExpiry(record.expiryDate),
                  rollStrike: extractStrikeFromOptionName(record.label) ?? record.strike,
                  symbol: record.symbol,
                  optionSide: record.optionType === "Call" ? "C" : "P",
                  expiryDate: record.expiryDate,
                  fetchedOptionValue: null,
                  netTradeResult: null,
                });
              }}
            >
              {value.toFixed(2)}
            </Button>
          );
        },
      })),
    ];

    recordsWithData.forEach((record, index) => {
      const matchingRow = record.rows.find((entry) => entry.date === selectedDateIso);
      row[`dataset_${index + 1}`] = matchingRow?.closePrice ?? null;
    });

    row.result = resultValueForRow(row);

    return {
      rows: Object.values(row).length > 2 ? [row] : [],
      columns,
    };
  }, [currentDate, savedWeeklyCloseRecords]);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Modal
        open={pivotValuePopup.open}
        title="Option Price Details"
        onCancel={() => setPivotValuePopup((previous) => ({ ...previous, open: false }))}
        footer={[
          <Button key="close" onClick={() => setPivotValuePopup((previous) => ({ ...previous, open: false }))}>
            Close
          </Button>,
        ]}
      >
        <Space direction="vertical" size={6}>
          <Typography.Text>Date: {pivotValuePopup.date || "-"}</Typography.Text>
          <Typography.Text>Option: {pivotValuePopup.optionName || "-"}</Typography.Text>
          <Typography.Text>
            Current Closing Price: {typeof pivotValuePopup.currentValue === "number" ? pivotValuePopup.currentValue.toFixed(2) : "-"}
          </Typography.Text>
          <Typography.Text strong>Rolling an Option</Typography.Text>
          <div>
            <Typography.Text type="secondary">Roll Date</Typography.Text>
            <DatePicker
              value={pivotValuePopup.rollDate}
              onChange={(value) => {
                setPivotValuePopup((previous) => ({
                  ...previous,
                  rollDate: value,
                }));
              }}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <div>
            <Typography.Text type="secondary">Roll Strike</Typography.Text>
            <InputNumber
              min={0.01}
              step={0.5}
              value={pivotValuePopup.rollStrike}
              onChange={(value) => {
                setPivotValuePopup((previous) => ({
                  ...previous,
                  rollStrike: typeof value === "number" && Number.isFinite(value) ? value : null,
                }));
              }}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <Button type="primary" onClick={() => void handleGetPopupOptionValue()} loading={rollOptionValueLoading}>
            Get Option Value
          </Button>
          <Typography.Text>
            Rolled Option Value: {typeof pivotValuePopup.fetchedOptionValue === "number" ? pivotValuePopup.fetchedOptionValue.toFixed(2) : "-"}
          </Typography.Text>
          <Typography.Text strong>
            Net Trade Result: {typeof pivotValuePopup.netTradeResult === "number" ? pivotValuePopup.netTradeResult.toFixed(2) : "-"}
          </Typography.Text>
        </Space>
      </Modal>

      <Row gutter={[16, 16]} align="middle">
        <Col>
          <Title level={4} style={{ margin: 0 }}>
            Charts &amp; Links
          </Title>
        </Col>
      </Row>

      {/* Input fields */}
      <Card size="small" title="Trade Parameters">
        <Form layout="inline" style={{ flexWrap: "wrap", gap: 8 }}>
          <Form.Item label="Ticker">
            <Select
              value={selectedSymbol}
              onChange={setSelectedSymbol}
              options={SYMBOLS.map((s) => ({ label: s, value: s }))}
              style={{ width: 120 }}
              showSearch
            />
          </Form.Item>
          <Form.Item label="Current Date">
            <DatePicker
              value={currentDate}
              onChange={setCurrentDate}
              format="YYYY-MM-DD"
              style={{ width: 150 }}
            />
          </Form.Item>
          <Form.Item label="Expiry Date">
            <DatePicker
              value={expiryDate}
              onChange={setExpiryDate}
              format="YYYY-MM-DD"
              style={{ width: 150 }}
              disabledDate={(d) => currentDate != null && d.isBefore(currentDate, "day")}
            />
          </Form.Item>
          <Form.Item label="Option Type">
            <Select
              value={optionType}
              onChange={setOptionType}
              options={[
                { label: "Call", value: "Call" },
                { label: "Put", value: "Put" },
              ]}
              style={{ width: 120 }}
            />
          </Form.Item>
          <Form.Item label="Strike Price">
            <InputNumber
              value={strikePrice}
              onChange={setStrikePrice}
              min={0}
              step={0.5}
              prefix="$"
              placeholder="e.g. 590"
              style={{ width: 140 }}
            />
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={() => void handleGetOptionPriceForSelectedDate()} loading={optionQuoteLoading}>
              Get Option Price
            </Button>
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={() => void handleGetWeeklyClosingPrices()} loading={weeklyCloseLoading}>
              Get Weekly Closing Prices
            </Button>
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={() => setShowWeeklyCloseTable((previous) => !previous)}>
              {showWeeklyCloseTable ? "Hide Table" : "Show Table"}
            </Button>
          </Form.Item>
        </Form>
        {selectedOptionQuote && (
          <Space size={12} wrap style={{ marginTop: 12 }}>
            <Typography.Text type="secondary">Date: {selectedOptionQuote.date}</Typography.Text>
            <Typography.Text type="secondary">
              Open: {selectedOptionQuote.openPrice !== null ? selectedOptionQuote.openPrice.toFixed(2) : "-"}
            </Typography.Text>
            <Typography.Text type="secondary">
              Close: {selectedOptionQuote.closePrice !== null ? selectedOptionQuote.closePrice.toFixed(2) : "-"}
            </Typography.Text>
            <Typography.Text type="secondary">
              Delta: {selectedOptionQuote.delta !== null ? selectedOptionQuote.delta.toFixed(4) : "-"}
            </Typography.Text>
            <Typography.Text type="secondary">
              Theta: {selectedOptionQuote.theta !== null ? selectedOptionQuote.theta.toFixed(4) : "-"}
            </Typography.Text>
          </Space>
        )}

        {savedWeeklyCloseRecords.length > 0 && (
          <Space wrap size={8} style={{ marginTop: 12 }}>
            {savedWeeklyCloseRecords.map((record) => (
              <Button
                key={record.id}
                type={record.id === activeWeeklyRecordId ? "primary" : "default"}
                onClick={() => {
                  setActiveWeeklyRecordId(record.id);
                  setWeeklyCloseRows(record.rows);
                }}
              >
                {record.label}
              </Button>
            ))}
          </Space>
        )}

        {showWeeklyCloseTable && (
          <Table<WeeklyOptionCloseRow>
            style={{ marginTop: 12 }}
            size="small"
            rowKey="key"
            loading={weeklyCloseLoading}
            dataSource={weeklyCloseRows}
            pagination={false}
            locale={{ emptyText: "No weekly closing prices loaded" }}
            columns={[
              {
                title: "Date",
                dataIndex: "date",
                key: "date",
              },
              {
                title: "Closing Price",
                dataIndex: "closePrice",
                key: "closePrice",
                render: (value: number | null) => (value !== null ? value.toFixed(2) : "-"),
              },
            ]}
          />
        )}
      </Card>

      <Card title="Option Closing Price (Saved Records)" size="small">
        {optionChartState.series.length === 0 ? (
          <Typography.Text type="secondary">No saved option records to chart yet.</Typography.Text>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={optionChartState.data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => `$${v.toFixed(0)}`}
              />
              <Tooltip
                formatter={(v) => {
                  const numericValue = typeof v === "number" ? v : Number(v);
                  const safeValue = Number.isFinite(numericValue) ? numericValue : 0;
                  return [`$${safeValue.toFixed(2)}`, "Close"];
                }}
              />
              <Legend />
              {optionChartState.series.map((series, index) => (
                <Line
                  key={series.id}
                  type="monotone"
                  dataKey={series.key}
                  name={series.label}
                  stroke={OPTION_SERIES_COLORS[index % OPTION_SERIES_COLORS.length]}
                  dot={false}
                  connectNulls
                  strokeWidth={series.id === activeWeeklyRecordId ? 3 : 2}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card
        title={`All Options Snapshot (${currentDate && currentDate.isValid() ? currentDate.format("YYYY-MM-DD") : "-"})`}
        size="small"
      >
        <Table<OptionPivotRow>
          size="small"
          rowKey="key"
          dataSource={selectedDatePivotState.rows}
          pagination={false}
          columns={selectedDatePivotState.columns}
          locale={{ emptyText: "No option data exists for the selected date" }}
          scroll={{ x: true }}
        />
      </Card>

      <Card title="Date / Option Names Pivot Table" size="small">
        <Table<OptionPivotRow>
          size="small"
          rowKey="key"
          dataSource={pivotTableState.rows}
          columns={pivotTableState.columns}
          pagination={{ pageSize: 50 }}
          scroll={{ x: true }}
          locale={{ emptyText: "No loaded option data available for pivot table" }}
        />
      </Card>

      {/* SPY Price Chart */}
      <Card title="SPY Closing Price" size="small">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              interval={Math.floor(chartData.length / 12)}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            />
            <Tooltip
              formatter={(v) => {
                const numericValue = typeof v === "number" ? v : Number(v);
                const safeValue = Number.isFinite(numericValue) ? numericValue : 0;
                return [`$${safeValue.toFixed(2)}`, "Close"];
              }}
            />
            <Line
              type="monotone"
              dataKey="close"
              stroke="#1677ff"
              dot={false}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Trading Resource Links */}
      <Card title={`Trading Links — ${selectedSymbol}`} size="small">
        <Row gutter={[12, 12]}>
          {TRADE_LINKS.map((tl) => (
            <Col key={tl.label} xs={24} sm={12} md={8} lg={6}>
              <Card
                size="small"
                hoverable
                bodyStyle={{ padding: "10px 14px" }}
              >
                <Link href={tl.url(selectedSymbol)} target="_blank" rel="noopener noreferrer">
                  {tl.label} ↗
                </Link>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>
    </Space>
  );
};

export default ChartsAndLink;
