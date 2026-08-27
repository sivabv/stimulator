import React, { useMemo } from "react";
import { Button, Card, Col, Row, Space, Typography } from "antd";
import dayjs from "dayjs";
import weekday from "dayjs/plugin/weekday";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter";
import spyClosingData from "../assets/spy-closing.json";

const { Title, Text } = Typography;

dayjs.extend(weekday);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const spyClosingByDate = new Map(
  (spyClosingData as Array<{ date: string; close: number | null }>).map((point) => [point.date, point.close])
);

const getFirstFridayOfMonth = (year: number, monthIndex: number) => {
  const monthStart = dayjs(`${year}-${String(monthIndex + 1).padStart(2, "0")}-01`);
  const monthEnd = monthStart.endOf("month");
  let cursor = monthStart;

  while (cursor.isBefore(monthEnd, "day") || cursor.isSame(monthEnd, "day")) {
    if (cursor.day() === 5) {
      const dateValue = cursor.format("YYYY-MM-DD");
      if (spyClosingByDate.has(dateValue)) {
        return cursor;
      }
    }
    cursor = cursor.add(1, "day");
  }

  return monthStart;
};

const SimulationCalendar: React.FC = () => {
  const monthButtons = useMemo(() => {
    const year = dayjs().year();
    return monthNames.map((monthLabel, index) => {
      const firstFriday = getFirstFridayOfMonth(year, index);
      const closePrice = spyClosingByDate.get(firstFriday.format("YYYY-MM-DD"));
      return {
        key: `${year}-${monthLabel}`,
        label: monthLabel,
        date: firstFriday.format("MM/DD/YYYY"),
        closePrice: closePrice ?? null,
      };
    });
  }, []);

  const monthButtons2025 = useMemo(() => {
    return monthNames.map((monthLabel, index) => {
      const firstFriday = getFirstFridayOfMonth(2025, index);
      const closePrice = spyClosingByDate.get(firstFriday.format("YYYY-MM-DD"));
      return {
        key: `2025-${monthLabel}`,
        label: monthLabel,
        date: firstFriday.format("MM/DD/YYYY"),
        closePrice: closePrice ?? null,
      };
    });
  }, []);

  return (
    <Card>
      <Space direction="vertical" size={20} style={{ width: "100%" }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Simulation Calendar
          </Title>
          <Text type="secondary">Current year: first Friday for each month with SPY close</Text>
          <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
            {monthButtons.map((item) => (
              <Col xs={12} sm={8} md={6} lg={3} key={item.key}>
                <Button
                  block
                  size="large"
                  style={{
                    minHeight: 88,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "8px 12px",
                    whiteSpace: "normal",
                  }}
                >
                  <span>{item.label}</span>
                  <span style={{ fontSize: 12, marginTop: 4 }}>{item.date}</span>
                  <span style={{ fontSize: 11, marginTop: 4, color: "#666" }}>
                    {item.closePrice !== null ? `$${item.closePrice.toFixed(2)}` : "No close"}
                  </span>
                </Button>
              </Col>
            ))}
          </Row>
        </div>

        <div>
          <Title level={5} style={{ margin: 0 }}>
            2025 Trading Calendar
          </Title>
          <Text type="secondary">January–December 2025 first Friday with SPY close</Text>
          <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
            {monthButtons2025.map((item) => (
              <Col xs={12} sm={8} md={6} lg={3} key={item.key}>
                <Button
                  block
                  size="large"
                  style={{
                    minHeight: 88,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "8px 12px",
                    whiteSpace: "normal",
                  }}
                >
                  <span>{item.label}</span>
                  <span style={{ fontSize: 12, marginTop: 4 }}>{item.date}</span>
                  <span style={{ fontSize: 11, marginTop: 4, color: "#666" }}>
                    {item.closePrice !== null ? `$${item.closePrice.toFixed(2)}` : "No close"}
                  </span>
                </Button>
              </Col>
            ))}
          </Row>
        </div>
      </Space>
    </Card>
  );
};

export default SimulationCalendar;
