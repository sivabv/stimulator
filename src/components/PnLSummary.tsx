/**
 * PnLSummary — summary statistics card displayed above the results table.
 * Shows total P&L, number of trades, winning/losing trade counts, etc.
 */

import React from "react";
import { Card, Statistic, Row, Col } from "antd";
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import type { BacktestRow } from "../types";

interface PnLSummaryProps {
  rows: BacktestRow[];
  totalPnl: number;
  symbol: string;
}

const PnLSummary: React.FC<PnLSummaryProps> = ({ rows, totalPnl, symbol }) => {
  // Count total closed + rolled positions across all days
  const totalClosed = rows.reduce((s, r) => s + r.closed_today.length, 0);
  const totalRolled = rows.reduce((s, r) => s + r.rolled_today.length, 0);

  // Aggregate winning vs losing closed positions
  const winners = rows.reduce(
    (s, r) => s + r.closed_today.filter((c) => c.pnl >= 0).length,
    0
  );
  const losers = totalClosed - winners;

  return (
    <Card
      title={`Backtest Summary — ${symbol}`}
      style={{ marginBottom: 24 }}
      bordered
    >
      <Row gutter={[24, 16]}>
        {/* Total P&L with color indicator */}
        <Col xs={12} sm={6}>
          <Statistic
            title="Total P&L"
            value={totalPnl}
            precision={2}
            valueStyle={{ color: totalPnl >= 0 ? "#389e0d" : "#cf1322" }}
            prefix={totalPnl >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
          />
        </Col>

        {/* Number of trading days */}
        <Col xs={12} sm={6}>
          <Statistic title="Trading Days" value={rows.length} />
        </Col>

        {/* Total closed positions */}
        <Col xs={12} sm={6}>
          <Statistic
            title="Closed Trades"
            value={totalClosed}
            suffix={
              <span style={{ fontSize: 14 }}>
                ({winners}W / {losers}L)
              </span>
            }
          />
        </Col>

        {/* Total rolled positions */}
        <Col xs={12} sm={6}>
          <Statistic
            title="Rolled"
            value={totalRolled}
            prefix={<SwapOutlined />}
          />
        </Col>
      </Row>
    </Card>
  );
};

export default PnLSummary;
