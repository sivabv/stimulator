/**
 * OptionChainChart — fetches Alpha Vantage HISTORICAL_OPTIONS data for a
 * symbol/date and charts implied volatility and open interest by strike,
 * split into calls and puts.
 */

import React, { useMemo, useState } from "react";
import { Card, Input, DatePicker, Button, Space, Alert, Spin, Typography, Row, Col } from "antd";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import dayjs, { Dayjs } from "dayjs";
import { fetchHistoricalOptions, type AlphaVantageOptionContract } from "../api/backtest";

const { Text } = Typography;

interface ChainPoint {
  strike: number;
  callIV: number | null;
  putIV: number | null;
  callOI: number | null;
  putOI: number | null;
}

const toNumber = (value: string | undefined): number | null => {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildChainData = (contracts: AlphaVantageOptionContract[]): ChainPoint[] => {
  const byStrike = new Map<number, ChainPoint>();

  for (const contract of contracts) {
    const strike = Number(contract.strike);
    if (!Number.isFinite(strike)) continue;

    const point = byStrike.get(strike) ?? {
      strike,
      callIV: null,
      putIV: null,
      callOI: null,
      putOI: null,
    };

    const iv = toNumber(contract.implied_volatility);
    const oi = toNumber(contract.open_interest);

    if (contract.type === "call") {
      point.callIV = iv;
      point.callOI = oi;
    } else if (contract.type === "put") {
      point.putIV = iv;
      point.putOI = oi;
    }

    byStrike.set(strike, point);
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
};

const OptionChainChart: React.FC = () => {
  const [symbol, setSymbol] = useState("IBM");
  const [date, setDate] = useState<Dayjs | null>(dayjs("2017-11-15"));
  const [contracts, setContracts] = useState<AlphaVantageOptionContract[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chainData = useMemo(() => buildChainData(contracts), [contracts]);

  const handleFetch = async () => {
    if (!symbol.trim()) {
      setError("Please enter a symbol.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetchHistoricalOptions(
        symbol.trim().toUpperCase(),
        date ? date.format("YYYY-MM-DD") : undefined
      );
      setContracts(response.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch option chain.");
      setContracts([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Option Chain Chart (Alpha Vantage)" size="small">
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="Symbol (e.g. IBM)"
          style={{ width: 140 }}
        />
        <DatePicker value={date} onChange={setDate} allowClear />
        <Button type="primary" onClick={handleFetch} loading={loading}>
          Fetch
        </Button>
      </Space>

      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />}
      {loading && <Spin />}

      {!loading && chainData.length > 0 && (
        <>
          <Text type="secondary">
            {chainData.length} strikes · {contracts.length} contracts
          </Text>
          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            <Col xs={24} lg={12}>
              <Card title="Implied Volatility by Strike" size="small">
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={chainData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="strike" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="callIV" name="Call IV" stroke="#1677ff" dot={false} />
                    <Line type="monotone" dataKey="putIV" name="Put IV" stroke="#ff4d4f" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title="Open Interest by Strike" size="small">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={chainData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="strike" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="callOI" name="Call OI" fill="#1677ff" />
                    <Bar dataKey="putOI" name="Put OI" fill="#ff4d4f" />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </Col>
          </Row>
        </>
      )}

      {!loading && !error && chainData.length === 0 && (
        <Text type="secondary">Enter a symbol and date, then click Fetch.</Text>
      )}
    </Card>
  );
};

export default OptionChainChart;
