import React, { useEffect, useState } from "react";
import { Alert, Button, Card, Space, Table, Tag, Typography } from "antd";
import { LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  fetchPutCalendarSimulationResults,
  isSimulationResultsApiConfigured,
  type PutCalendarSimulationResult,
} from "../api/simulationResults";

const { Text } = Typography;

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

  const loadResults = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPutCalendarSimulationResults();
      setResults(
        data.map((row, index) => ({
          ...row,
          key: `${row.recordedAt ?? "row"}-${index}`,
        }))
      );
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
            expandedRowRender: (row) => {
              const gridRows = row.gridData?.rows ?? [];
              if (gridRows.length === 0) {
                return <Text type="secondary">No grid data recorded for this simulation.</Text>;
              }

              const columnKeys = Object.keys(gridRows[0]);
              return (
                <Table
                  size="small"
                  rowKey={(_, index) => `${row.key}-grid-${index}`}
                  dataSource={gridRows}
                  pagination={{ pageSize: 15 }}
                  scroll={{ x: "max-content" }}
                  columns={columnKeys.map((columnKey) => ({
                    title: columnKey,
                    dataIndex: columnKey,
                    key: columnKey,
                    render: (value: string | number | null) =>
                      typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : value ?? "-",
                  }))}
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
