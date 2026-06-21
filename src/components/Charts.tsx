/**
 * Charts — renders two Recharts visualisations above the results table:
 * 1. Price line chart with PE/CE entry markers
 * 2. Cumulative P&L area chart
 */

import React, { useMemo } from "react";
import { Card, Row, Col } from "antd";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from "recharts";
import type { BacktestRow } from "../types";

interface ChartsProps {
  rows: BacktestRow[];
}

const Charts: React.FC<ChartsProps> = ({ rows }) => {
  /**
   * Build a cumulative P&L series and collect PE/CE entry points
   * for chart markers.
   */
  const { priceData, cumulativeData, peEntries, ceEntries } = useMemo(() => {
    let cumPnl = 0;
    const priceData: { date: string; price: number }[] = [];
    const cumulativeData: { date: string; cumPnl: number }[] = [];
    const peEntries: { date: string; price: number }[] = [];
    const ceEntries: { date: string; price: number }[] = [];

    for (const r of rows) {
      priceData.push({ date: r.date, price: r.price });
      cumPnl += r.pnl;
      cumulativeData.push({ date: r.date, cumPnl: parseFloat(cumPnl.toFixed(2)) });

      // Mark days where new PE/CE positions were opened
      if (r.new_pe !== null) {
        peEntries.push({ date: r.date, price: r.price });
      }
      if (r.new_ce !== null) {
        ceEntries.push({ date: r.date, price: r.price });
      }
    }

    return { priceData, cumulativeData, peEntries, ceEntries };
  }, [rows]);

  // Show only a subset of date labels to avoid overcrowding the x-axis
  const tickInterval = Math.max(1, Math.floor(rows.length / 12));

  return (
    <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
      {/* Price chart with PE/CE entry markers */}
      <Col xs={24} lg={12}>
        <Card title="Index Price" size="small">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={priceData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" interval={tickInterval} tick={{ fontSize: 11 }} />
              <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="price"
                stroke="#1677ff"
                dot={false}
                strokeWidth={2}
              />
              {/* PE entry markers (blue dots) */}
              {peEntries.map((p) => (
                <ReferenceDot
                  key={`pe-${p.date}`}
                  x={p.date}
                  y={p.price}
                  r={3}
                  fill="#1677ff"
                  stroke="#1677ff"
                />
              ))}
              {/* CE entry markers (orange dots) */}
              {ceEntries.map((p) => (
                <ReferenceDot
                  key={`ce-${p.date}`}
                  x={p.date}
                  y={p.price}
                  r={3}
                  fill="#fa8c16"
                  stroke="#fa8c16"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </Col>

      {/* Cumulative P&L area chart */}
      <Col xs={24} lg={12}>
        <Card title="Cumulative P&L" size="small">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={cumulativeData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" interval={tickInterval} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="cumPnl"
                stroke="#389e0d"
                fill="#d9f7be"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      </Col>
    </Row>
  );
};

export default Charts;
