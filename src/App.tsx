/**
 * App — root component for the Backtesting Dashboard.
 * Orchestrates FilterBar, Charts, PnLSummary, and ResultsTable,
 * managing the backtest request lifecycle and error display.
 */

import React, { useState } from "react";
import { Layout, Typography, Alert, Spin, ConfigProvider, theme, Tabs } from "antd";
import FilterBar from "./components/FilterBar";
import ResultsTable from "./components/ResultsTable";
import PnLSummary from "./components/PnLSummary";
import Charts from "./components/Charts";
import OptionsAnalyzer from "./components/OptionsAnalyzer";
import OptionsAnalyzerV2 from "./components/OptionsAnalyzerV2";
import PutCalendar from "./components/PutCalendar";
import CallCalendar from "./components/CallCalendar";
import InterestCalculator from "./components/InterestCalculator";
import CoveredCall from "./components/CoveredCall";
import CoveredPut from "./components/CoveredPut";
import StraddleRolling from "./components/StraddleRolling";
import PutCalendarSpreadRoll from "./components/PutCalendarSpreadRoll";
import CallCalendarSpreadRoll from "./components/CallCalendarSpreadRoll";
import WeeklyStraddleRoll from "./components/WeeklyStraddleRoll";
import { runBacktest } from "./api/backtest";
import type { BacktestRequest, BacktestResponse } from "./types";

const { Header, Content, Footer } = Layout;
const { Title } = Typography;

const App: React.FC = () => {
  // Backtest state
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("backtest");

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
        {/* App header */}
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

        <Content style={{ padding: "24px 24px 0" }}>
          {/* Tab navigation */}
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
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
                key: "options-analyzer",
                label: "Options Analyzer",
                children: <OptionsAnalyzer />,
              },
              {
                key: "options-analyser-v2",
                label: "Option Analyser V2",
                children: <OptionsAnalyzerV2 />,
              },
              {
                key: "interest-calculator",
                label: "Interest Calculator",
                children: <InterestCalculator />,
              },
                {
                key: "weekly-straddle-roll",
                label: "Weekly Straddle Roll",
                children: <WeeklyStraddleRoll />,
              },
              {
                key: "covered-call",
                label: "Covered Call",
                children: <CoveredCall />,
              },
              {
                key: "covered-put",
                label: "Covered Put",
                children: <CoveredPut />,
              },
              {
                key: "put-calendar",
                label: "Put Calendar",
                children: <PutCalendar />,
              },
              {
                key: "call-calendar",
                label: "Call Calendar",
                children: <CallCalendar />,
              },
              {
                key: "straddle-rolling",
                label: "Straddle Rolling",
                children: <StraddleRolling />,
              },
              {
                key: "put-calendar-spread-roll",
                label: "Put Calendar Spread Roll",
                children: <PutCalendarSpreadRoll />,
              },
              {
                key: "call-calendar-spread-roll",
                label: "Call Calendar Spread Roll",
                children: <CallCalendarSpreadRoll />,
              },
            
            ]}
          />
        </Content>

        <Footer style={{ textAlign: "center" }}>
          Backtesting Dashboard · Built with FastAPI + React + Ant Design
        </Footer>
      </Layout>
    </ConfigProvider>
  );
};

export default App;


// An API to get stock price for a given symbol and date range of two years , for any give closing price and date- find the next  higheshet closing from the array and get date...

