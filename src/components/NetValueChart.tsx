import React from "react";
import { Card, Empty } from "antd";
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

export interface NetValueChartPoint {
  date: string;
  netValue: number;
  percentageChange: number | null;
}

interface NetValueChartProps {
  data: NetValueChartPoint[];
  title?: string;
}

const NetValueChart: React.FC<NetValueChartProps> = ({ data, title = "Net Value Trend" }) => {
  if (data.length === 0) {
    return (
      <Card title={title} style={{ marginBottom: 24 }}>
        <Empty description="No net value data" />
      </Card>
    );
  }

  return (
    <Card title={title} style={{ marginBottom: 24 }}>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 8, right: 24, left: 8, bottom: 12 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11 }}
            height={50}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 11 }}
            tickFormatter={(value: number) => value.toFixed(2)}
            width={80}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 11 }}
            tickFormatter={(value: number) => `${value.toFixed(2)}%`}
            width={80}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;

              const point = payload[0].payload as NetValueChartPoint;

              return (
                <div
                  style={{
                    background: "#fff",
                    border: "1px solid #d9d9d9",
                    borderRadius: 8,
                    padding: "10px 12px",
                    boxShadow: "0 6px 20px rgba(0, 0, 0, 0.08)",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>{label}</div>
                  <div style={{ marginBottom: 4 }}>Net Value: {point.netValue.toFixed(2)}</div>
                  <div>
                    Percentage Change:{" "}
                    {point.percentageChange === null
                      ? "N/A"
                      : `${point.percentageChange >= 0 ? "+" : ""}${point.percentageChange.toFixed(2)}%`}
                  </div>
                </div>
              );
            }}
          />
          <Legend />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="netValue"
            name="Net Value"
            stroke="#1677ff"
            strokeWidth={2}
            dot={false}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="percentageChange"
            name="Percentage Change"
            stroke="#13c2c2"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
};

export default NetValueChart;