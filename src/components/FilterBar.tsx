/**
 * FilterBar — top-of-page controls for configuring and launching a backtest.
 * Renders inputs for symbol, date range, expiry months, strike offset,
 * and a "Run Backtest" button.
 */

import React, { useState } from "react";
import {
  Button,
  DatePicker,
  Input,
  InputNumber,
  Select,
  Form,
} from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import type { BacktestRequest } from "../types";

const { RangePicker } = DatePicker;

interface FilterBarProps {
  /** Called when the user clicks "Run Backtest" with valid inputs */
  onRun: (req: BacktestRequest) => void;
  /** True while a backtest request is in flight */
  loading: boolean;
}

/** Available expiry month options */
const EXPIRY_OPTIONS = [1, 2, 3, 6, 12].map((m) => ({
  value: m,
  label: `${m} month${m > 1 ? "s" : ""}`,
}));

const FilterBar: React.FC<FilterBarProps> = ({ onRun, loading }) => {
  // Local state for each filter field
  const [symbol, setSymbol] = useState("GLD");
  const [dates, setDates] = useState<[Dayjs, Dayjs] | null>([
    dayjs().subtract(1, "year"),
    dayjs(),
  ]);
  const [expiryMonths, setExpiryMonths] = useState(3);
  const [strikeOffset, setStrikeOffset] = useState(5);

  /** Validate inputs and invoke the parent callback */
  const handleRun = () => {
    if (!symbol.trim() || !dates) return;
    onRun({
      symbol: symbol.trim().toUpperCase(),
      from_date: dates[0].format("YYYY-MM-DD"),
      to_date: dates[1].format("YYYY-MM-DD"),
      expiry_months: expiryMonths,
      strike_offset: strikeOffset,
    });
  };

  return (
    <Form layout="inline" style={{ marginBottom: 24, flexWrap: "wrap", gap: 8 }}>
      {/* Ticker symbol input */}
      <Form.Item label="Symbol">
        <Input
          placeholder="GLD, SPY, GC=F …"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          style={{ width: 140 }}
        />
      </Form.Item>

      {/* Date range picker */}
      <Form.Item label="Date Range">
        <RangePicker
          value={dates}
          onChange={(vals) =>
            setDates(vals as [Dayjs, Dayjs] | null)
          }
        />
      </Form.Item>

      {/* Expiry months dropdown */}
      <Form.Item label="Expiry">
        <Select
          value={expiryMonths}
          onChange={setExpiryMonths}
          options={EXPIRY_OPTIONS}
          style={{ width: 120 }}
        />
      </Form.Item>

      {/* Strike offset numeric input */}
      <Form.Item label="Strike Offset">
        <InputNumber
          min={0.01}
          step={0.5}
          value={strikeOffset}
          onChange={(v) => setStrikeOffset(v ?? 5)}
          style={{ width: 100 }}
        />
      </Form.Item>

      {/* Run button */}
      <Form.Item>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          onClick={handleRun}
          loading={loading}
          disabled={!symbol.trim() || !dates}
        >
          Run Backtest
        </Button>
      </Form.Item>
    </Form>
  );
};

export default FilterBar;
