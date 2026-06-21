import React, { useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Col,
	DatePicker,
	Descriptions,
	InputNumber,
	Row,
	Select,
	Space,
	Table,
	Typography,
	message,
} from "antd";
import { PlayCircleOutlined, AimOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchOptionOpenClose, fetchStockOpenClose } from "../api/backtest";
import tradingDatesJson from "../assets/trading_dates_2026.json";

const { Paragraph, Text, Title } = Typography;

type OptionType = "C" | "P";

interface AnalysisRow {
	key: string;
	date: string;
	expiryDate: string;
	strikePrice: number;
	stockClose: number | null;
	optionClose: number | null;
	daysToExpiry: number;
	interestPercentage: number | null;
	annualInterestRate: number | null;
	statusCode: number | null;
}

const RATE_LIMIT_WAIT_MS = 2_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const tradingDates = tradingDatesJson as string[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const roundToNearestFive = (value: number): number => Math.round(value / 5) * 5;

const formatExpiryDate = (dateStr: string): string => dayjs(dateStr).format("YYMMDD");

const formatCurrency = (value: number | null) => {
	if (value === null || !Number.isFinite(value)) {
		return "-";
	}

	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	}).format(value);
};

const formatPercent = (value: number | null) => {
	if (value === null || !Number.isFinite(value)) {
		return "-";
	}

	return `${value.toFixed(2)}%`;
};

const InterestCalculator: React.FC = () => {
	const [symbol, setSymbol] = useState("SPY");
	const [startDate, setStartDate] = useState("2025-06-20");
	const [strikePrice, setStrikePrice] = useState<number | null>(null);
	const [optionType, setOptionType] = useState<OptionType>("P");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [rows, setRows] = useState<AnalysisRow[]>([]);

	const observationDates = useMemo(() => {
		const start = dayjs(startDate);
		const end = dayjs("2026-12-31");

		return tradingDates.filter((date) => {
			const candidate = dayjs(date);
			return (
				candidate.isValid() &&
				(candidate.isAfter(start, "day") || candidate.isSame(start, "day")) &&
				(candidate.isBefore(end, "day") || candidate.isSame(end, "day"))
			);
		});
	}, [startDate]);

	const fetchWithRateLimitRetry = async <T extends { statusCode: number | null }>(work: () => Promise<T>) => {
		let response = await work();
		let attempts = 0;

		while (response.statusCode === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
			attempts += 1;
			message.warning(`Rate limit hit (429). Waiting 2 seconds before retry ${attempts}.`);
			await sleep(RATE_LIMIT_WAIT_MS);
			response = await work();
		}

		return response;
	};

	const analyzeInterest = async (nextStrikePrice: number) => {
		const normalizedSymbol = symbol.trim().toUpperCase();

		if (!normalizedSymbol) {
			throw new Error("Symbol is required");
		}

		if (!dayjs(startDate).isValid()) {
			throw new Error("Start date must be valid");
		}

		if (!Number.isFinite(nextStrikePrice) || nextStrikePrice <= 0) {
			throw new Error("Strike price must be a positive number");
		}

		if (observationDates.length === 0) {
			throw new Error("No trading dates were found between the selected start date and December 2026");
		}

		const startStockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(normalizedSymbol, startDate));
		const givenDateStockClose = startStockData.closePrice;

		const seededRows: AnalysisRow[] = observationDates.map((rowExpiryDate) => ({
			key: rowExpiryDate,
			date: startDate,
			expiryDate: rowExpiryDate,
			strikePrice: nextStrikePrice,
			stockClose: givenDateStockClose,
			optionClose: null,
			daysToExpiry: dayjs(rowExpiryDate).diff(dayjs(startDate), "day"),
			interestPercentage: null,
			annualInterestRate: null,
			statusCode: null,
		}));

		setRows(seededRows);

		for (const seededRow of seededRows) {
			const optionData = await fetchWithRateLimitRetry(() =>
				fetchOptionOpenClose(
					normalizedSymbol,
					formatExpiryDate(seededRow.expiryDate),
					seededRow.strikePrice,
					optionType,
					startDate
				)
			);

			const optionClose = optionData.closePrice;
			const interestPercentage =
				optionClose !== null && seededRow.strikePrice > 0 ? (optionClose / seededRow.strikePrice) * 100 : null;
			const annualInterestRate =
				interestPercentage !== null && seededRow.daysToExpiry > 0
					? interestPercentage * (365 / seededRow.daysToExpiry)
					: null;

			setRows((previousRows) =>
				previousRows.map((row) =>
					row.key === seededRow.key
						? {
							...row,
							optionClose,
							interestPercentage,
							annualInterestRate,
							statusCode: optionData.statusCode,
						}
						: row
				)
			);
		}
	};

	const handlePickCurrentStrike = async () => {
		setError(null);
		setRows([]);
		setLoading(true);

		try {
			const normalizedSymbol = symbol.trim().toUpperCase();

			if (!normalizedSymbol) {
				throw new Error("Symbol is required");
			}

			if (!dayjs(startDate).isValid()) {
				throw new Error("Start date is invalid");
			}

			const stockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(normalizedSymbol, startDate));

			if (stockData.closePrice === null) {
				throw new Error(`No stock close price found for ${normalizedSymbol} on ${startDate}`);
			}

			const roundedStrike = roundToNearestFive(stockData.closePrice);
			setStrikePrice(roundedStrike);
			await analyzeInterest(roundedStrike);
			message.success(`Picked strike ${roundedStrike} from ${normalizedSymbol} close ${stockData.closePrice.toFixed(2)} and refreshed option data.`);
		} catch (err) {
			const nextError = err instanceof Error ? err.message : "Failed to load current strike price";
			setError(nextError);
		} finally {
			setLoading(false);
		}
	};

	const handleAnalyze = async () => {
		setError(null);
		setRows([]);
		setLoading(true);

		try {
			if (strikePrice === null || !Number.isFinite(strikePrice) || strikePrice <= 0) {
				throw new Error("Strike price must be a positive number");
			}

			await analyzeInterest(strikePrice);
		} catch (err) {
			const nextError = err instanceof Error ? err.message : "Failed to analyze interest";
			setError(nextError);
		} finally {
			setLoading(false);
		}
	};

	const rowsWithData = rows.filter((row) => row.optionClose !== null);
	const visibleRows = rowsWithData.slice(0, 50);

	return (
		<Space direction="vertical" size={20} style={{ width: "100%" }}>
			<Card>
				<Title level={4} style={{ marginTop: 0 }}>
					Option Interest Calculator
				</Title>
				<Paragraph style={{ marginBottom: 0 }}>
					Pick a strike from the stock close on the start date, keep that start date fixed for pricing,
					and iterate expiry dates from the JSON list through December 2026.
				</Paragraph>
			</Card>

			<Card title="Inputs">
				<Row gutter={[16, 16]}>
					<Col xs={24} md={8}>
						<Text>Symbol</Text>
						<Select
							showSearch
							value={symbol}
							onChange={setSymbol}
							style={{ width: "100%", marginTop: 8 }}
							options={["SPY", "QQQ", "IWM", "GLD", "TSLA", "AAPL", "NVDA"].map((value) => ({
								label: value,
								value,
							}))}
						/>
					</Col>

					<Col xs={24} md={8}>
						<Text>Start date</Text>
						<DatePicker
							value={dayjs(startDate)}
							onChange={(value) => setStartDate(value ? value.format("YYYY-MM-DD") : "")}
							style={{ width: "100%", marginTop: 8 }}
						/>
					</Col>

					<Col xs={24} md={8}>
						<Text>Option type</Text>
						<Select
							value={optionType}
							onChange={setOptionType}
							style={{ width: "100%", marginTop: 8 }}
							options={[
								{ label: "Put", value: "P" },
								{ label: "Call", value: "C" },
							]}
						/>
					</Col>

					<Col xs={24} md={8}>
						<Text>Strike price</Text>
						<InputNumber<number>
							min={1}
							step={5}
							value={strikePrice ?? undefined}
							onChange={(value) => setStrikePrice(value ?? null)}
							style={{ width: "100%", marginTop: 8 }}
						/>
					</Col>

					<Col xs={24} md={8}>
						<Text>Expiry rows</Text>
						<Descriptions
							column={1}
							size="small"
							bordered
							style={{ marginTop: 8 }}
							items={[
								{
									key: "count",
									label: "Expiry rows",
									children: observationDates.length,
								},
								{
									key: "window",
									label: "Window end",
									children:
										observationDates[observationDates.length - 1] ?? "2026-12-31",
								},
								{
									key: "start",
									label: "Fixed pricing date",
									children: startDate,
								},
							]}
						/>
					</Col>
				</Row>

				<Space style={{ marginTop: 16 }} wrap>
					<Button icon={<AimOutlined />} onClick={handlePickCurrentStrike} loading={loading}>
						Pick Current Strike
					</Button>
					<Button type="primary" icon={<PlayCircleOutlined />} onClick={handleAnalyze} loading={loading}>
						Analyze Interest
					</Button>
				</Space>
			</Card>

			{error && <Alert type="error" showIcon message="Interest Analysis Error" description={error} />}

			{/* <Row gutter={[16, 16]}>
				<Col xs={24} md={8}>
					<Card>
						<Statistic title="Current stock close" value={currentStockClose ?? 0} precision={2} prefix="$" />
					</Card>
				</Col>
				<Col xs={24} md={8}>
					<Card>
						<Statistic title="Latest interest %" value={latestInterestPercentage ?? 0} precision={2} suffix="%" />
					</Card>
				</Col>
				<Col xs={24} md={8}>
					<Card>
						<Statistic title="Latest annual rate" value={latestAnnualizedRate ?? 0} precision={2} suffix="%" />
					</Card>
				</Col>
			</Row> */}

			<Card title="Option interest table">
				<Table<AnalysisRow>
					rowKey="key"
					loading={loading}
					dataSource={visibleRows}
					pagination={false}
					scroll={{ x: 1100, y: 640 }}
					columns={[
						// {
						// 	title: "Given date",
						// 	dataIndex: "date",
						// 	key: "date",
						// },
                        // {
						// 	title: "Stock close",
						// 	dataIndex: "stockClose",
						// 	key: "stockClose",
						// 	render: (value: number | null) => formatCurrency(value),
						// },
						{
							title: "Expiry date",
							dataIndex: "expiryDate",
							key: "expiryDate",
						},						
						// {
						// 	title: "Strike",
						// 	dataIndex: "strikePrice",
						// 	key: "strike",
						// 	render: (value: number) => formatCurrency(value),
						// },
						{
							title: "Option close",
							dataIndex: "optionClose",
							key: "optionClose",
							render: (value: number | null) => formatCurrency(value),
						},
						{
							title: "Days to expiry",
							dataIndex: "daysToExpiry",
							key: "daysToExpiry",
						},
						{
							title: "Interest %",
							dataIndex: "interestPercentage",
							key: "interestPercentage",
							render: (value: number | null) => formatPercent(value),
						},
						{
							title: "Annual interest rate",
							dataIndex: "annualInterestRate",
							key: "annualInterestRate",
							render: (value: number | null) => formatPercent(value),
						},
						// {
						// 	title: "API status",
						// 	dataIndex: "statusCode",
						// 	key: "statusCode",
						// 	render: (value: number | null) => value ?? "-",
						// },
					]}
				/>
			</Card>
		</Space>
	);
};

export default InterestCalculator;
