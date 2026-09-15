/**
 * App — root component for the Backtesting Dashboard.
 * Orchestrates FilterBar, Charts, PnLSummary, and ResultsTable,
 * managing the backtest request lifecycle and error display.
 */

import React, { Suspense, lazy, useEffect, useState } from "react";
import { Layout, Typography, Alert, Spin, ConfigProvider, theme, Tabs, Button, Modal, Descriptions, Space, Result } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import FilterBar from "./components/FilterBar";
import ResultsTable from "./components/ResultsTable";
import PnLSummary from "./components/PnLSummary";
import Charts from "./components/Charts";
import { runBacktest } from "./api/backtest";
import type { BacktestRequest, BacktestResponse } from "./types";
import { getAllSqliteEntries, getSqliteMetrics } from "./utils/sqliteStorage";

const { Header, Content, Footer } = Layout;
const { Title } = Typography;

const OptionsAnalyzer = lazy(() => import("./components/OptionsAnalyzer"));
const OptionsAnalyzerV2 = lazy(() => import("./components/OptionsAnalyzerV2"));
const InterestCalculator = lazy(() => import("./components/InterestCalculator"));
const TradeLinks = lazy(() => import("./components/TradeLinks"));
const WeeklyStraddleRoll = lazy(() => import("./components/WeeklyStraddleRoll"));
const StraddleRolling = lazy(() => import("./components/StraddleRolling"));
const PutCalendarSpreadRoll = lazy(() => import("./components/PutCalendarSpreadRoll"));
const CallCalendarSpreadRoll = lazy(() => import("./components/CallCalendarSpreadRoll"));
const CalendarSpreadRollSplit = lazy(() => import("./components/CalendarSpreadRollSplit"));
const LocalFullScreenCharts = lazy(() => import("./components/LocalFullScreenCharts"));
const ChartsAndLink = lazy(() => import("./components/ChartsAndLink"));
const ChartsAndLinkV2 = lazy(() => import("./components/ChartsAndLinkV2"));
const FutureChart = lazy(() => import("./components/FutureChart"));
const ThreeTier = lazy(() => import("./components/ThreeTier"));
const SimulationCalendar = lazy(() => import("./components/SimulationCalendar"));
const SimulationResultsGrid = lazy(() => import("./components/SimulationResultsGrid"));
const OptionChainChart = lazy(() => import("./components/OptionChainChart"));

const PAGE_NOT_FOUND_KEY = "page-not-found";
const VALID_TABS = new Set([
  "trade-links",
  "backtest",
  "charts-and-link-v2",
  "options-analyzer",
  "options-analyser-v2",
  "interest-calculator",
  "weekly-straddle-roll",
  "straddle-rolling",
  "put-calendar-spread-roll",
  "simulation-calendar",
  "simulation-results",
  "call-calendar-spread-roll",
  "calendar-spread-roll-split",
  "local-full-screen-charts",
  "charts-and-link",
  "future-chart",
  "three-tier",
  "option-chain-chart",
]);

const PageNotFound: React.FC = () => (
  <Result
    status="404"
    title="Page not found"
    subTitle="The requested page does not exist."
  />
);

const App: React.FC = () => {
  // Backtest state
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return tab && VALID_TABS.has(tab) ? tab : PAGE_NOT_FOUND_KEY;
  });

  const syncTabState = (nextTab: string) => {
    const url = new URL(window.location.href);

    if (nextTab === PAGE_NOT_FOUND_KEY) {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", nextTab);
    }

    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  useEffect(() => {
    if (activeTab !== PAGE_NOT_FOUND_KEY) {
      syncTabState(activeTab);
    }
  }, [activeTab]);

  useEffect(() => {
    const handlePopState = () => {
      const nextTab = new URLSearchParams(window.location.search).get("tab");
      setActiveTab(nextTab && VALID_TABS.has(nextTab) ? nextTab : PAGE_NOT_FOUND_KEY);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const [dbStatusOpen, setDbStatusOpen] = useState(false);
  const [dbStatusLoading, setDbStatusLoading] = useState(false);
  const [dbStatus, setDbStatus] = useState<{
    sqliteEntries: number;
    sqliteApproxKb: number;
    localStorageKeys: number;
    localStorageApproxKb: number;
    sqliteReads: number;
    sqliteWrites: number;
    sqliteRemoves: number;
    sqliteListReads: number;
    sqliteMigrationsAttempted: number;
    sqliteMigrationsApplied: number;
    sqliteLastOperationAt: string | null;
    sampleKeys: string[];
    checkedAt: string;
  } | null>(null);

  /** Export a full local snapshot as JSON, including SQLite-backed data */
  const combineTickerStockData = (data: Record<string, unknown>): Record<string, Record<string, unknown>> => {
    const grouped: Record<string, Record<string, unknown>> = {};

    for (const [key, value] of Object.entries(data)) {
      if (!value || typeof value !== "object" || Array.isArray(value) || !key.includes("|")) {
        continue;
      }

      const [symbol, date] = key.split("|");
      if (!symbol || !date) {
        continue;
      }

      if (!grouped[symbol]) {
        grouped[symbol] = {};
      }

      grouped[symbol][date] = value;
    }

    return grouped;
  };

  const normalizeExportSnapshot = (snapshot: Record<string, unknown>): Record<string, unknown> => {
    const normalized: Record<string, unknown> = { ...snapshot };

    if (normalized.masterStockData && typeof normalized.masterStockData === "object") {
      normalized.masterStockData = combineTickerStockData(
        normalized.masterStockData as Record<string, unknown>
      );
    }

    return normalized;
  };

  const handleDownloadLocalStorage = async () => {
    const storageSnapshot: Record<string, unknown> = {};
    const sqliteSnapshot: Record<string, unknown> = {};

    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) {
        continue;
      }

      const rawValue = localStorage.getItem(key);
      if (rawValue === null) {
        continue;
      }

      try {
        storageSnapshot[key] = JSON.parse(rawValue);
      } catch {
        storageSnapshot[key] = rawValue;
      }
    }

    const sqliteEntries = await getAllSqliteEntries();
    Object.entries(sqliteEntries).forEach(([key, rawValue]) => {
      try {
        sqliteSnapshot[key] = JSON.parse(rawValue);
      } catch {
        sqliteSnapshot[key] = rawValue;
      }
    });

    const payload = {
      exportedAt: new Date().toISOString(),
      source: "browser-local-data",
      data: {
        localStorage: normalizeExportSnapshot(storageSnapshot),
        sqlite: normalizeExportSnapshot(sqliteSnapshot),
      },
    };

    const fileName = `local-data-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleOpenDbStatus = async () => {
    setDbStatusOpen(true);
    setDbStatusLoading(true);

    try {
      const sqliteEntries = await getAllSqliteEntries();
      const sqliteMetrics = getSqliteMetrics();
      const sqliteValues = Object.values(sqliteEntries);
      const sqliteApproxBytes = sqliteValues.reduce((sum, value) => sum + value.length, 0);

      const localValues: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        const rawValue = localStorage.getItem(key);
        if (rawValue !== null) {
          localValues.push(rawValue);
        }
      }

      const localApproxBytes = localValues.reduce((sum, value) => sum + value.length, 0);

      setDbStatus({
        sqliteEntries: Object.keys(sqliteEntries).length,
        sqliteApproxKb: Number((sqliteApproxBytes / 1024).toFixed(2)),
        localStorageKeys: localStorage.length,
        localStorageApproxKb: Number((localApproxBytes / 1024).toFixed(2)),
        sqliteReads: sqliteMetrics.reads,
        sqliteWrites: sqliteMetrics.writes,
        sqliteRemoves: sqliteMetrics.removes,
        sqliteListReads: sqliteMetrics.listReads,
        sqliteMigrationsAttempted: sqliteMetrics.migrationsAttempted,
        sqliteMigrationsApplied: sqliteMetrics.migrationsApplied,
        sqliteLastOperationAt: sqliteMetrics.lastOperationAt,
        sampleKeys: Object.keys(sqliteEntries).slice(0, 8),
        checkedAt: new Date().toISOString(),
      });
    } catch {
      setDbStatus(null);
    } finally {
      setDbStatusLoading(false);
    }
  };

  /** Trigger a backtest via the API and store the result */
  const handleRun = async (req: BacktestRequest) => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await runBacktest(req);
      setResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: { colorPrimary: "#1677ff" },
      }}
    >
      <Layout style={{ minHeight: "100vh" }}>
        {activeTab !== PAGE_NOT_FOUND_KEY && (
          <Header
            style={{
              background: "#001529",
              display: "flex",
              alignItems: "center",
              padding: "0 24px",
            }}
          >
            <Title level={3} style={{ color: "#fff", margin: 0 }}>
              Options Backtesting Dashboard
            </Title>
          </Header>
        )}

        <Content style={{ padding: activeTab === PAGE_NOT_FOUND_KEY ? "24px" : "24px 24px 0" }}>
          {activeTab === PAGE_NOT_FOUND_KEY ? (
            <PageNotFound />
          ) : (
            <Tabs
            activeKey={activeTab}
            onChange={(tabKey) => {
              setActiveTab(tabKey);
              syncTabState(tabKey);
            }}
            items={[
                {
                key: "interest-calculator",
                label: "Interest Calculator",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <InterestCalculator />
                  </Suspense>
                ),
              },
              {
                key: "put-calendar-spread-roll",
                label: "Put Calendar Spread Roll",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <PutCalendarSpreadRoll />
                  </Suspense>
                ),
              },
              {
                key: "simulation-calendar",
                label: "Simulation Calendar",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <SimulationCalendar />
                  </Suspense>
                ),
              },
              {
                key: "simulation-results",
                label: "Simulation Results",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <SimulationResultsGrid />
                  </Suspense>
                ),
              },
              {
                key: "trade-links",
                label: "Trade",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <TradeLinks />
                  </Suspense>
                ),
              },
              {
                key: "backtest",
                label: "Backtest",
                children: (
                  <>
                    {/* Filter controls */}
                    <FilterBar onRun={handleRun} loading={loading} />

                    {/* Error alert */}
                    {error && (
                      <Alert
                        message="Backtest Error"
                        description={error}
                        type="error"
                        showIcon
                        closable
                        style={{ marginBottom: 16 }}
                        onClose={() => setError(null)}
                      />
                    )}

                    {/* Loading spinner */}
                    {loading && (
                      <div style={{ textAlign: "center", padding: 48 }}>
                        <Spin
                          size="large"
                          tip="Running backtest…"
                          style={{ transform: "scale(0.6)", transformOrigin: "center" }}
                        />
                      </div>
                    )}

                    {/* Results: charts, summary card, and data table */}
                    {result && !loading && (
                      <>
                        <Charts rows={result.rows} />
                        <PnLSummary
                          rows={result.rows}
                          totalPnl={result.total_pnl}
                          symbol={result.symbol}
                        />
                        <ResultsTable rows={result.rows} totalPnl={result.total_pnl} />
                      </>
                    )}
                  </>
                ),
              },
              {
                key: "charts-and-link-v2",
                label: "Charts & Links V2",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <ChartsAndLinkV2 />
                  </Suspense>
                ),
              },
              {
                key: "options-analyzer",
                label: "Options Analyzer",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <OptionsAnalyzer />
                  </Suspense>
                ),
              },
              {
                key: "options-analyser-v2",
                label: "Option Analyser V2",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <OptionsAnalyzerV2 />
                  </Suspense>
                ),
              },
            
              {
                key: "weekly-straddle-roll",
                label: "Weekly Straddle Roll",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <WeeklyStraddleRoll onOpenChartsTab={() => setActiveTab("local-full-screen-charts")} />
                  </Suspense>
                ),
              },
              // {
              //   key: "covered-call",
              //   label: "Covered Call",
              //   children: <CoveredCall />,
              // },
              // {
              //   key: "covered-put",
              //   label: "Covered Put",
              //   children: <CoveredPut />,
              // },
              // {
              //   key: "put-calendar",
              //   label: "Put Calendar",
              //   children: <PutCalendar />,
              // },
              // {
              //   key: "call-calendar",
              //   label: "Call Calendar",
              //   children: <CallCalendar />,
              // },
              {
                key: "straddle-rolling",
                label: "Straddle Rolling",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <StraddleRolling />
                  </Suspense>
                ),
              },
              
              {
                key: "call-calendar-spread-roll",
                label: "Call Calendar Spread Roll",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <CallCalendarSpreadRoll />
                  </Suspense>
                ),
              },
              {
                key: "calendar-spread-roll-split",
                label: "Call + Put Split",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <CalendarSpreadRollSplit />
                  </Suspense>
                ),
              },
              {
                key: "local-full-screen-charts",
                label: "Static Data Charts",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <LocalFullScreenCharts />
                  </Suspense>
                ),
              },
              {
                key: "charts-and-link",
                label: "Charts & Links",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <ChartsAndLink />
                  </Suspense>
                ),
              },
              {
                key: "future-chart",
                label: "Future Chart",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <FutureChart />
                  </Suspense>
                ),
              },
              {
                key: "three-tier",
                label: "3 Tier",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <ThreeTier />
                  </Suspense>
                ),
              },
              {
                key: "option-chain-chart",
                label: "Option Chain Chart",
                children: (
                  <Suspense fallback={<Spin size="large" tip="Loading tab…" />}>
                    <OptionChainChart />
                  </Suspense>
                ),
              },


            ]}
          />
          )}
        </Content>

        {activeTab !== PAGE_NOT_FOUND_KEY && (
          <>
            <Footer style={{ textAlign: "center" }}>
              Backtesting Dashboard · Built with FastAPI + React + Ant Design
            </Footer>

            <Space
              direction="vertical"
              size={8}
              style={{
                position: "fixed",
                right: 24,
                bottom: 24,
                zIndex: 1000,
              }}
            >
              <Button onClick={handleOpenDbStatus} loading={dbStatusLoading}>
                DB Status
              </Button>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={handleDownloadLocalStorage}
              >
                Download Local Data
              </Button>
            </Space>
          </>
        )}

        <Modal
          title="Local DB Status"
          open={dbStatusOpen}
          onCancel={() => setDbStatusOpen(false)}
          footer={null}
        >
          {dbStatusLoading ? (
            <Spin />
          ) : dbStatus ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="SQLite Entries">{dbStatus.sqliteEntries}</Descriptions.Item>
              <Descriptions.Item label="SQLite Approx Size">{dbStatus.sqliteApproxKb} KB</Descriptions.Item>
              <Descriptions.Item label="SQLite Reads">{dbStatus.sqliteReads}</Descriptions.Item>
              <Descriptions.Item label="SQLite Writes">{dbStatus.sqliteWrites}</Descriptions.Item>
              <Descriptions.Item label="SQLite Removes">{dbStatus.sqliteRemoves}</Descriptions.Item>
              <Descriptions.Item label="SQLite List Reads">{dbStatus.sqliteListReads}</Descriptions.Item>
              <Descriptions.Item label="Migrations Attempted">{dbStatus.sqliteMigrationsAttempted}</Descriptions.Item>
              <Descriptions.Item label="Migrations Applied">{dbStatus.sqliteMigrationsApplied}</Descriptions.Item>
              <Descriptions.Item label="SQLite Last Operation">{dbStatus.sqliteLastOperationAt ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="localStorage Keys">{dbStatus.localStorageKeys}</Descriptions.Item>
              <Descriptions.Item label="localStorage Approx Size">{dbStatus.localStorageApproxKb} KB</Descriptions.Item>
              <Descriptions.Item label="Checked At">{dbStatus.checkedAt}</Descriptions.Item>
              <Descriptions.Item label="SQLite Sample Keys">
                {dbStatus.sampleKeys.length > 0 ? dbStatus.sampleKeys.join(", ") : "No keys found"}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Alert type="warning" showIcon message="Could not load DB status" />
          )}
        </Modal>
      </Layout>
    </ConfigProvider>
  );
};

export default App;


// An API to get stock price for a given symbol and date range of two years , for any give closing price and date- find the next  higheshet closing from the array and get date...

