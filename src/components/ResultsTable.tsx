/**
 * ResultsTable — renders the per-day backtest output in an Ant Design table.
 * Columns: Date, Price, New PE, Open PEs, New CE, Open CEs,
 *          Rolled Today, Closed Today, P&L.
 * P&L cells are color-coded green (profit) / red (loss).
 * Includes CSV export functionality.
 */

import React, { useCallback } from "react";
import { Table, Tag, Button, Tooltip } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { saveAs } from "file-saver";
import type { BacktestRow, RolledPosition, ClosedPosition } from "../types";
import type { ColumnsType } from "antd/es/table";

interface ResultsTableProps {
  rows: BacktestRow[];
  /** Total P&L for the summary footer row */
  totalPnl: number;
}

/** Format a number to 2 decimal places */
const fmt = (n: number) => n.toFixed(2);

/** Color-code P&L: green for >= 0, red for < 0 */
const pnlColor = (val: number) => (val >= 0 ? "#389e0d" : "#cf1322");

/** Render rolled positions as a compact list of tags */
const renderRolled = (items: RolledPosition[]) => {
  if (!items.length) return "—";
  return (
    <span>
      {items.map((r, i) => (
        <Tooltip
          key={i}
          title={`${r.type} rolled: ${fmt(r.old_strike)} → ${fmt(r.new_strike)} (P&L: ${fmt(r.pnl)})`}
        >
          <Tag color={r.pnl >= 0 ? "green" : "red"} style={{ marginBottom: 2 }}>
            {r.type} {fmt(r.old_strike)}→{fmt(r.new_strike)}
          </Tag>
        </Tooltip>
      ))}
    </span>
  );
};

/** Render closed positions as a compact list of tags */
const renderClosed = (items: ClosedPosition[]) => {
  if (!items.length) return "—";
  return (
    <span>
      {items.map((c, i) => (
        <Tooltip
          key={i}
          title={`${c.type} strike ${fmt(c.strike)} opened ${c.entry_date} — P&L: ${fmt(c.pnl)}`}
        >
          <Tag color={c.pnl >= 0 ? "green" : "red"} style={{ marginBottom: 2 }}>
            {c.type} {fmt(c.strike)} ({fmt(c.pnl)})
          </Tag>
        </Tooltip>
      ))}
    </span>
  );
};

/** Table column definitions */
const columns: ColumnsType<BacktestRow> = [
  {
    title: "Date",
    dataIndex: "date",
    key: "date",
    width: 120,
    fixed: "left" as const,
  },
  {
    title: "Price",
    dataIndex: "price",
    key: "price",
    width: 100,
    render: (v: number) => fmt(v),
  },
  {
    title: "New PE",
    dataIndex: "new_pe",
    key: "new_pe",
    width: 100,
    render: (v: number | null) => (v !== null ? fmt(v) : "—"),
  },
  {
    title: "Open PEs",
    dataIndex: "open_pes",
    key: "open_pes",
    width: 90,
  },
  {
    title: "New CE",
    dataIndex: "new_ce",
    key: "new_ce",
    width: 100,
    render: (v: number | null) => (v !== null ? fmt(v) : "—"),
  },
  {
    title: "Open CEs",
    dataIndex: "open_ces",
    key: "open_ces",
    width: 90,
  },
  {
    title: "Rolled Today",
    dataIndex: "rolled_today",
    key: "rolled_today",
    width: 220,
    render: renderRolled,
  },
  {
    title: "Closed Today",
    dataIndex: "closed_today",
    key: "closed_today",
    width: 220,
    render: renderClosed,
  },
  {
    title: "P&L",
    dataIndex: "pnl",
    key: "pnl",
    width: 100,
    render: (v: number) => (
      <span style={{ color: pnlColor(v), fontWeight: 600 }}>{fmt(v)}</span>
    ),
  },
];

const ResultsTable: React.FC<ResultsTableProps> = ({ rows, totalPnl }) => {
  /**
   * Export the results table to a CSV file.
   * Rolled and Closed columns are serialised as semicolon-separated summaries.
   */
  const exportCsv = useCallback(() => {
    const header =
      "Date,Price,New PE,Open PEs,New CE,Open CEs,Rolled Today,Closed Today,P&L\n";
    const body = rows
      .map((r) => {
        const rolled = r.rolled_today
          .map((x) => `${x.type} ${x.old_strike}->${x.new_strike}`)
          .join("; ");
        const closed = r.closed_today
          .map((x) => `${x.type} ${x.strike} (${x.pnl})`)
          .join("; ");
        return [
          r.date,
          r.price,
          r.new_pe ?? "",
          r.open_pes,
          r.new_ce ?? "",
          r.open_ces,
          `"${rolled}"`,
          `"${closed}"`,
          r.pnl,
        ].join(",");
      })
      .join("\n");

    // Append summary row
    const summary = `\nTotal P&L,,,,,,,,${totalPnl}`;
    const blob = new Blob([header + body + summary], {
      type: "text/csv;charset=utf-8",
    });
    saveAs(blob, "backtest_results.csv");
  }, [rows, totalPnl]);

  return (
    <>
      {/* Export button */}
      <div style={{ marginBottom: 12, textAlign: "right" }}>
        <Button icon={<DownloadOutlined />} onClick={exportCsv} size="small">
          Export CSV
        </Button>
      </div>

      {/* Results data table */}
      <Table<BacktestRow>
        columns={columns}
        dataSource={rows}
        rowKey="date"
        size="small"
        bordered
        scroll={{ x: 1200 }}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={8}>
                <strong>Total P&L</strong>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={8}>
                <strong style={{ color: pnlColor(totalPnl) }}>
                  {fmt(totalPnl)}
                </strong>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />
    </>
  );
};

export default ResultsTable;
