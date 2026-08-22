import React, { useEffect, useMemo, useState } from "react";
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
	Tooltip,
	Typography,
	message,
} from "antd";
import { PlayCircleOutlined, AimOutlined, InfoCircleOutlined } from "@ant-design/icons";
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
	delta: number | null;
	interestPercentage: number | null;
	annualInterestRate: number | null;
	annualStockInterestRate: number | null;
	thetaPerDay: number | null;
	intrinsicValue: number | null;
	extrinsicValue: number | null;
	statusCode: number | null;
}

interface SavedInterestSimulation {
	symbol: string;
	startDate: string;
	strikePrice: number | null;
	optionType: OptionType;
	savedAt: string;
	rows: AnalysisRow[];
}

const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const INTEREST_CALCULATOR_SNAPSHOT_KEY = "interestCalculatorSavedSimulation";
const INTEREST_CALCULATOR_SAVED_SIMULATIONS_KEY = "interestCalculatorSavedSimulations";
const tradingDates = tradingDatesJson as string[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const roundToNearestFive = (value: number): number => Math.round(value / 5) * 5;

const formatExpiryDate = (dateStr: string): string => dayjs(dateStr).format("YYMMDD");
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

const normalPdf = (x: number): number => Math.exp(-0.5 * x * x) / SQRT_TWO_PI;

const normalCdf = (x: number): number => {
	const sign = x < 0 ? -1 : 1;
	const absX = Math.abs(x) / Math.sqrt(2);
	const t = 1 / (1 + 0.3275911 * absX);
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const erfApprox =
		1 -
		(((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
			Math.exp(-absX * absX);

	return 0.5 * (1 + sign * erfApprox);
};

const blackScholesPrice = (
	spot: number,
	strike: number,
	timeYears: number,
	sigma: number,
	optionType: OptionType
): number => {
	if (timeYears <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) {
		return optionType === "C" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
	}

	const sqrtT = Math.sqrt(timeYears);
	const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * timeYears) / (sigma * sqrtT);
	const d2 = d1 - sigma * sqrtT;

	if (optionType === "C") {
		return spot * normalCdf(d1) - strike * normalCdf(d2);
	}

	return strike * normalCdf(-d2) - spot * normalCdf(-d1);
};

const estimateImpliedVolatility = (
	marketPrice: number,
	spot: number,
	strike: number,
	timeYears: number,
	optionType: OptionType
): number | null => {
	if (marketPrice <= 0 || spot <= 0 || strike <= 0 || timeYears <= 0) {
		return null;
	}

	const intrinsic = optionType === "C" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
	const targetPrice = Math.max(marketPrice, intrinsic + 1e-8);

	let low = 1e-4;
	let high = 5;

	for (let i = 0; i < 80; i += 1) {
		const mid = (low + high) / 2;
		const modelPrice = blackScholesPrice(spot, strike, timeYears, mid, optionType);

		if (Math.abs(modelPrice - targetPrice) < 1e-5) {
			return mid;
		}

		if (modelPrice > targetPrice) {
			high = mid;
		} else {
			low = mid;
		}
	}

	return (low + high) / 2;
};

const calculateThetaPerDay = (
	optionPrice: number | null,
	stockPrice: number | null,
	strike: number,
	asOfDate: string,
	expiryDate: string,
	optionType: OptionType
): number | null => {
	if (
		optionPrice === null ||
		stockPrice === null ||
		!Number.isFinite(optionPrice) ||
		!Number.isFinite(stockPrice) ||
		strike <= 0
	) {
		return null;
	}

	const daysToExpiry = dayjs(expiryDate).diff(dayjs(asOfDate), "day");
	if (daysToExpiry <= 0) {
		return null;
	}

	const timeYears = daysToExpiry / 365;
	const impliedVol = estimateImpliedVolatility(optionPrice, stockPrice, strike, timeYears, optionType);
	if (impliedVol === null) {
		return null;
	}

	const sqrtT = Math.sqrt(timeYears);
	const d1 = (Math.log(stockPrice / strike) + 0.5 * impliedVol * impliedVol * timeYears) /
		(impliedVol * sqrtT);
	const thetaPerYear = -(stockPrice * normalPdf(d1) * impliedVol) / (2 * sqrtT);

	return thetaPerYear / 365;
};

const calculateDelta = (
	optionPrice: number | null,
	stockPrice: number | null,
	strike: number,
	asOfDate: string,
	expiryDate: string,
	optionType: OptionType
): number | null => {
	if (
		optionPrice === null ||
		stockPrice === null ||
		!Number.isFinite(optionPrice) ||
		!Number.isFinite(stockPrice) ||
		strike <= 0
	) {
		return null;
	}

	const daysToExpiry = dayjs(expiryDate).diff(dayjs(asOfDate), "day");
	if (daysToExpiry <= 0) {
		return null;
	}

	const timeYears = daysToExpiry / 365;
	const impliedVol = estimateImpliedVolatility(optionPrice, stockPrice, strike, timeYears, optionType);
	if (impliedVol === null) {
		return null;
	}

	const sqrtT = Math.sqrt(timeYears);
	const d1 = (Math.log(stockPrice / strike) + 0.5 * impliedVol * impliedVol * timeYears) /
		(impliedVol * sqrtT);

	return optionType === "C" ? normalCdf(d1) : normalCdf(d1) - 1;
};

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

const InterestCalculator: React.FC = () => {
	const [symbol, setSymbol] = useState("SPY");
	const [startDate, setStartDate] = useState("2026-01-05");
	const [strikePrice, setStrikePrice] = useState<number | null>(null);
	const [optionType, setOptionType] = useState<OptionType>("P");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [rows, setRows] = useState<AnalysisRow[]>([]);
	const [savedSimulations, setSavedSimulations] = useState<SavedInterestSimulation[]>([]);

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
			message.warning(`Rate limit hit (429). Waiting 65 seconds before retry ${attempts}.`);
			await sleep(RATE_LIMIT_WAIT_MS);
			response = await work();
		}

		return response;
	};

	const findPreviousClose = async (normalizedSymbol: string, referenceDate: string): Promise<{ price: number; date: string } | null> => {
		let backwardCursor = dayjs(referenceDate).subtract(1, "day");

		for (let attempt = 0; attempt < 15; attempt += 1) {
			const quoteDate = backwardCursor.format("YYYY-MM-DD");
			const stockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(normalizedSymbol, quoteDate));

			if (typeof stockData.closePrice === "number" && Number.isFinite(stockData.closePrice)) {
				return { price: stockData.closePrice, date: quoteDate };
			}

			backwardCursor = backwardCursor.subtract(1, "day");
		}

		let forwardCursor = dayjs(referenceDate).add(1, "day");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const quoteDate = forwardCursor.format("YYYY-MM-DD");
			const stockData = await fetchWithRateLimitRetry(() => fetchStockOpenClose(normalizedSymbol, quoteDate));

			if (typeof stockData.closePrice === "number" && Number.isFinite(stockData.closePrice)) {
				return { price: stockData.closePrice, date: quoteDate };
			}

			forwardCursor = forwardCursor.add(1, "day");
		}

		return null;
	};

	const analyzeInterest = async (nextStrikePrice: number): Promise<AnalysisRow[]> => {
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
			delta: null,
			interestPercentage: null,
			annualInterestRate: null,
			annualStockInterestRate: null,
			thetaPerDay: null,
			intrinsicValue: null,
			extrinsicValue: null,
			statusCode: null,
		}));

		const finalRows: AnalysisRow[] = seededRows.map((row) => ({ ...row }));
		setRows(finalRows);

		for (let index = 0; index < seededRows.length; index += 1) {
			const seededRow = seededRows[index];
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
			const annualStockInterestRate =
				optionClose !== null &&
				seededRow.stockClose !== null &&
				seededRow.stockClose > 0 &&
				seededRow.daysToExpiry > 0
					? (optionClose / seededRow.stockClose) * (365 / seededRow.daysToExpiry) * 100
					: null;
			const delta = calculateDelta(
				optionClose,
				seededRow.stockClose,
				seededRow.strikePrice,
				seededRow.date,
				seededRow.expiryDate,
				optionType
			);
			const thetaPerDay = calculateThetaPerDay(
				optionClose,
				seededRow.stockClose,
				seededRow.strikePrice,
				seededRow.date,
				seededRow.expiryDate,
				optionType
			);
			const intrinsicValue =
				optionClose !== null && seededRow.stockClose !== null
					? optionType === "C"
						? Math.max(seededRow.stockClose - seededRow.strikePrice, 0)
						: Math.max(seededRow.strikePrice - seededRow.stockClose, 0)
					: null;
			const extrinsicValue =
				optionClose !== null && intrinsicValue !== null ? Math.max(optionClose - intrinsicValue, 0) : null;

			finalRows[index] = {
				...finalRows[index],
				optionClose,
				delta,
				interestPercentage,
				annualInterestRate,
				annualStockInterestRate,
				thetaPerDay,
				intrinsicValue,
				extrinsicValue,
				statusCode: optionData.statusCode,
			};

			setRows(finalRows.map((row) => ({ ...row })));
		}

		return finalRows;
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

			const previousClose = await findPreviousClose(normalizedSymbol, startDate);

			if (!previousClose) {
				throw new Error(`No close price found for ${normalizedSymbol} near ${startDate} (previous days and +5 days)`);
			}

			const roundedStrike = roundToNearestFive(previousClose.price);
			setStrikePrice(roundedStrike);
			const finalRows = await analyzeInterest(roundedStrike);
			handleSaveSimulation(finalRows);
			message.success(`Picked strike ${roundedStrike} from ${normalizedSymbol} previous close ${previousClose.date} = ${previousClose.price.toFixed(2)} and refreshed option data.`);
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
			const normalizedSymbol = symbol.trim().toUpperCase();
			let strikeToUse =
				typeof strikePrice === "number" && Number.isFinite(strikePrice) && strikePrice > 0
					? strikePrice
					: null;

			if (strikeToUse === null) {
				if (!normalizedSymbol) {
					throw new Error("Symbol is required");
				}

				if (!dayjs(startDate).isValid()) {
					throw new Error("Start date is invalid");
				}

				const previousClose = await findPreviousClose(normalizedSymbol, startDate);
				if (!previousClose) {
					throw new Error(`No close price found for ${normalizedSymbol} near ${startDate} (previous days and +5 days)`);
				}

				strikeToUse = roundToNearestFive(previousClose.price);
				setStrikePrice(strikeToUse);
				message.info(`Auto-picked strike ${strikeToUse} from ${normalizedSymbol} previous close ${previousClose.date} = ${previousClose.price.toFixed(2)}.`);
			}

			const finalRows = await analyzeInterest(strikeToUse);
			handleSaveSimulation(finalRows);
		} catch (err) {
			const nextError = err instanceof Error ? err.message : "Failed to analyze interest";
			setError(nextError);
		} finally {
			setLoading(false);
		}
	};

	const readSavedSimulations = (): SavedInterestSimulation[] => {
		if (typeof window === "undefined") {
			return [];
		}

		try {
			const raw = window.localStorage.getItem(INTEREST_CALCULATOR_SAVED_SIMULATIONS_KEY);
			if (!raw) {
				const legacyRaw = window.localStorage.getItem(INTEREST_CALCULATOR_SNAPSHOT_KEY);
				if (!legacyRaw) {
					return [];
				}

				const legacySaved = JSON.parse(legacyRaw) as Partial<SavedInterestSimulation>;
				if (!legacySaved || typeof legacySaved !== "object" || !Array.isArray((legacySaved as any).rows)) {
					return [];
				}

				return [legacySaved as SavedInterestSimulation];
			}

			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(saved): saved is SavedInterestSimulation =>
						!!saved && typeof saved === "object" && Array.isArray((saved as any).rows)
				);
			}

			if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).rows)) {
				return [parsed as SavedInterestSimulation];
			}

			return [];
		} catch {
			return [];
		}
	};

	const restoreSavedSimulation = (target?: SavedInterestSimulation): boolean => {
		if (typeof window === "undefined") {
			return false;
		}

		try {
			const saved = target ??
				(() => {
					const list = readSavedSimulations();
					return list[list.length - 1];
				})();

			if (!saved || typeof saved !== "object" || !Array.isArray(saved.rows)) {
				return false;
			}

			setSymbol(typeof saved.symbol === "string" ? saved.symbol : "SPY");
			setStartDate(typeof saved.startDate === "string" ? saved.startDate : "2026-01-05");
			setStrikePrice(typeof saved.strikePrice === "number" ? saved.strikePrice : null);
			setOptionType(saved.optionType === "C" ? "C" : "P");
			setRows(saved.rows as AnalysisRow[]);
			return true;
		} catch {
			return false;
		}
	};

	const handleSaveSimulation = (nextRows?: AnalysisRow[]) => {
		if (typeof window === "undefined") {
			return;
		}

		const snapshotRows = (nextRows ?? rows).filter((row) => row.optionClose !== null);
		const snapshot: SavedInterestSimulation = {
			symbol: symbol.trim().toUpperCase() || "SPY",
			startDate,
			strikePrice,
			optionType,
			savedAt: new Date().toISOString(),
			rows: snapshotRows,
		};

		try {
			const currentEntries = readSavedSimulations();
			const nextEntries = [snapshot, ...currentEntries.filter((entry) => entry.savedAt !== snapshot.savedAt)];
			window.localStorage.setItem(INTEREST_CALCULATOR_SAVED_SIMULATIONS_KEY, JSON.stringify(nextEntries));
			window.localStorage.setItem(INTEREST_CALCULATOR_SNAPSHOT_KEY, JSON.stringify(snapshot));
			setSavedSimulations(nextEntries);
			message.success("Simulation saved locally.");
		} catch {
			setError("Could not save simulation to local storage.");
		}
	};

	useEffect(() => {
		const initialSaved = readSavedSimulations();
		setSavedSimulations(initialSaved);

		if (initialSaved.length > 0) {
			const latestSaved = initialSaved[0];
			restoreSavedSimulation(latestSaved);
			return;
		}

		const restored = restoreSavedSimulation();
		if (!restored) {
			void handleAnalyze();
		}
	}, []);

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
						<Space direction="vertical" style={{ width: "100%" }}>
							<DatePicker
								value={dayjs(startDate)}
								onChange={(value) => setStartDate(value ? value.format("YYYY-MM-DD") : "")}
								style={{ width: "100%", marginTop: 8 }}
							/>
							<Button
								size="small"
								type="default"
								style={{ minWidth: 72 }}
							>
								{dayjs(startDate).isValid() ? dayjs(startDate).format("MM/DD") : "MM/DD"}
							</Button>
						</Space>
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
						<Text>
							Expiry rows
							<Tooltip
								placement="right"
								title={
									<Descriptions
										column={1}
										size="small"
										bordered
										style={{ marginTop: 0 }}
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
								}
							>
								<InfoCircleOutlined
									style={{ marginLeft: 8, color: "#1677ff", cursor: "pointer" }}
								/>
							</Tooltip>
						</Text>
					</Col>
				</Row>

				<Space style={{ marginTop: 16 }} wrap>
					<Button icon={<AimOutlined />} onClick={handlePickCurrentStrike} loading={loading}>
						Pick Current Strike
					</Button>
					<Button
						onClick={() => handleSaveSimulation(rows)}
						disabled={loading || rows.length === 0}
					>
						Save Simulation
					</Button>
					<Button type="primary" icon={<PlayCircleOutlined />} onClick={handleAnalyze} loading={loading}>
						Analyze Interest
					</Button>
				</Space>

				{savedSimulations.length > 0 && (
					<Space style={{ marginTop: 16 }} wrap>
						{savedSimulations.map((saved, index) => (
							<Button
								key={`${saved.savedAt}-${index}`}
								type={saved.startDate === startDate ? "primary" : "default"}
								onClick={() => {
									setSymbol(saved.symbol);
									setStartDate(saved.startDate);
									setStrikePrice(saved.strikePrice);
									setOptionType(saved.optionType);
									setRows(saved.rows);
								}}
							>
								{dayjs(saved.startDate).isValid() ? dayjs(saved.startDate).format("MM/DD") : "MM/DD"}
							</Button>
						))}
					</Space>
				)}
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
							title: "Delta",
							dataIndex: "delta",
							key: "delta",
							render: (value: number | null) =>
								value !== null && Number.isFinite(value) ? value.toFixed(4) : "-",
						},
						{
							title: "Days to expiry",
							dataIndex: "daysToExpiry",
							key: "daysToExpiry",
						},
						{
							title: "Annual rate vs stock",
							dataIndex: "annualStockInterestRate",
							key: "annualStockInterestRate",
							render: (value: number | null) =>
								value !== null && Number.isFinite(value) ? `${value.toFixed(2)}%` : "-",
						},
					
						{
							title: "Theta / day",
							dataIndex: "thetaPerDay",
							key: "thetaPerDay",
							render: (value: number | null) => formatCurrency(value),
						},
						{
							title: "Intrinsic",
							dataIndex: "intrinsicValue",
							key: "intrinsicValue",
							render: (value: number | null) => formatCurrency(value),
						},
						{
							title: "Extrinsic",
							dataIndex: "extrinsicValue",
							key: "extrinsicValue",
							render: (value: number | null) => formatCurrency(value),
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
