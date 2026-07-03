import React from "react";
import { Col, Row, Space, Typography } from "antd";
import CallCalendarSpreadRoll from "./CallCalendarSpreadRoll";
import PutCalendarSpreadRoll from "./PutCalendarSpreadRoll";

const { Title } = Typography;

const CalendarSpreadRollSplit: React.FC = () => {
  return (
    <Row gutter={[16, 16]} align="top">
      <Col xs={24} xl={12}>
        <Space direction="vertical" size={24} style={{ width: "100%" }}>
          <div style={{ width: "100%" }}>
            <Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
              Call Calendar Spread Roll
            </Title>
            <CallCalendarSpreadRoll />
          </div>
          <div style={{ width: "100%" }}>
            <Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
              Call Calendar Spread Roll
            </Title>
            <CallCalendarSpreadRoll />
          </div>
        </Space>
      </Col>
      <Col xs={24} xl={12}>
        <Space direction="vertical" size={24} style={{ width: "100%" }}>
          <div style={{ width: "100%" }}>
            <Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
              Put Calendar Spread Roll
            </Title>
            <PutCalendarSpreadRoll />
          </div>
          <div style={{ width: "100%" }}>
            <Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
              Put Calendar Spread Roll
            </Title>
            <PutCalendarSpreadRoll />
          </div>
        </Space>
      </Col>
    </Row>
  );
};

export default CalendarSpreadRollSplit;