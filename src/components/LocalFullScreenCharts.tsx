import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, DatePicker, Empty, Select, Space, Table, Tag, Typography } from "antd";
import {
	Brush,
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ReferenceLine,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
	ZAxis,
} from "recharts";
import dayjs from "dayjs";
import { getSqliteItem, migrateLocalStorageKeysToSqlite } from "../utils/sqliteStorage";

const { Text, Title } = Typography;

type LegType = "Call" | "Put";
type LegStatusFilter = "active" | "open" | "closed" | "rolled";

type WeeklyStraddleLeg = {
	key: string;
	weekNumber: number;
	legType: LegType;
	entryDate: string;
	finalExpiryDate: string;
	strike: number;
	rolledCount: number;
	closeDate: string | null;
	entryPrice: number | null;
	closeOptionClosePrice: number | null;
};

type WeeklyStraddleRunSnapshot = {
	symbol: string;
	startDate: string;
	endDate: string;
	tradingDays: number;
	generatedAt: string;
	closingPriceByDate: Record<string, number | null>;
	legs: WeeklyStraddleLeg[];
};

type DailySummaryRow = {
	key: string;
	date: string;
	closePrice: number | null;
	shownOptions: number;
	activeOptions: number;
	callsActive: number;
	putsActive: number;
	closedInThisWeek: number;
	cumulativeClosed: number;
};

type OptionListRow = {
	key: string;
	legType: LegType;
	weekNumber: number;
	entryDate: string;
	closeDate: string | null;
	finalExpiryDate: string;
	strike: number;
	rolledCount: number;
	entryPrice: number | null;
	closeOptionClosePrice: number | null;
	status: LegStatusFilter;
};

const WEEKLY_STRADDLE_RUN_DATA_KEY = "weeklyStraddleRunData";

const formatCurrency = (value: number | null) => {
	if (value === null || !Number.isFinite(value)) return "-";
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	}).format(value);
};

const parseWeeklyStraddleSnapshot = (raw: string | null): WeeklyStraddleRunSnapshot | null => {
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as WeeklyStraddleRunSnapshot;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.legs) || !parsed.closingPriceByDate) {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
};

const loadWeeklyStraddleSnapshot = async (): Promise<WeeklyStraddleRunSnapshot | null> => {
	await migrateLocalStorageKeysToSqlite([WEEKLY_STRADDLE_RUN_DATA_KEY]);

	const sqliteRaw = await getSqliteItem(WEEKLY_STRADDLE_RUN_DATA_KEY);
	const sqliteSnapshot = parseWeeklyStraddleSnapshot(sqliteRaw);
	if (sqliteSnapshot) {
		return sqliteSnapshot;
	}

	return parseWeeklyStraddleSnapshot(localStorage.getItem(WEEKLY_STRADDLE_RUN_DATA_KEY));
};

const LocalFullScreenCharts: React.FC = () => {
	const [snapshot, setSnapshot] = useState<WeeklyStraddleRunSnapshot | null>(null);
	const [bubbleWindow, setBubbleWindow] = useState<{ startIndex: number; endIndex: number }>({
		startIndex: 0,
		endIndex: 0,
	});
	const [showSummary, setShowSummary] = useState(false);
	const [selectedOptionDate, setSelectedOptionDate] = useState("");
	const [selectedOptionStatus, setSelectedOptionStatus] = useState<LegStatusFilter>("active");

	useEffect(() => {
		let cancelled = false;

		const loadSnapshot = async () => {
			const saved = await loadWeeklyStraddleSnapshot();
			if (!cancelled) {
				setSnapshot(saved);
			}
		};

		void loadSnapshot();

		return () => {
			cancelled = true;
		};
	}, []);

	const chartData = useMemo(() => {
		if (!snapshot) {
			return {
				summaryRows: [] as DailySummaryRow[],
				trendData: [] as Array<{ date: string; openedOptions: number; closedOptions: number; activeOptions: number }>,
				bubbleChartDate: "",
				bubbleChartClosePrice: null as number | null,
				bubbleChartPoints: [] as Array<{
					date: string;
					strike: number;
					legType: LegType;
					label: string;
					closePrice: number | null;
					bubbleSize: number;
				}>,
			};
		}

		const { legs, closingPriceByDate, startDate, endDate } = snapshot;
		const sectionDates = Object.keys(closingPriceByDate)
			.filter((date) => dayjs(date).isValid())
			.filter((date) => dayjs(date).isSame(dayjs(startDate), "day") || dayjs(date).isAfter(dayjs(startDate), "day"))
			.filter((date) => dayjs(date).isSame(dayjs(endDate), "day") || dayjs(date).isBefore(dayjs(endDate), "day"))
			.sort((left, right) => dayjs(left).valueOf() - dayjs(right).valueOf());

		const summaryRows: DailySummaryRow[] = sectionDates.map((asOfDate, index) => {
			const closePrice = Object.prototype.hasOwnProperty.call(closingPriceByDate, asOfDate)
				? closingPriceByDate[asOfDate]
				: null;
			const asOf = dayjs(asOfDate);
			const phaseStartIndex = Math.floor(index / 5) * 5;
			const phaseStartDate = sectionDates[phaseStartIndex];
			const phaseEndDate = sectionDates[Math.min(phaseStartIndex + 4, sectionDates.length - 1)];

			const isLegOpenOnDate = (leg: WeeklyStraddleLeg) => {
				const entryDate = dayjs(leg.entryDate);
				const closeDate = leg.closeDate ? dayjs(leg.closeDate) : null;

				return (
					(asOf.isSame(entryDate, "day") || asOf.isAfter(entryDate, "day")) &&
					(!closeDate || asOf.isBefore(closeDate, "day"))
				);
			};

			const isLegClosedOnDate = (leg: WeeklyStraddleLeg) => Boolean(leg.closeDate && dayjs(leg.closeDate).isSame(asOfDate, "day"));
			const isLegVisibleOnDate = (leg: WeeklyStraddleLeg) => isLegOpenOnDate(leg) || isLegClosedOnDate(leg);

			const closedInCurrentWeekCount = legs.filter((leg) => {
				if (!leg.closeDate) return false;
				const closeDate = dayjs(leg.closeDate);
				return (
					(closeDate.isSame(phaseStartDate, "day") || closeDate.isAfter(dayjs(phaseStartDate), "day")) &&
					(closeDate.isSame(phaseEndDate, "day") || closeDate.isBefore(dayjs(phaseEndDate), "day"))
				);
			}).length;

			const cumulativeClosedCount = legs.filter((leg) => {
				if (!leg.closeDate) return false;
				const closeDate = dayjs(leg.closeDate);
				return closeDate.isSame(asOfDate, "day") || closeDate.isBefore(asOf, "day");
			}).length;

			const optionsInWeek = legs
				.filter((leg) => isLegVisibleOnDate(leg))
				.sort((left, right) => {
					if (left.entryDate !== right.entryDate) {
						return dayjs(left.entryDate).valueOf() - dayjs(right.entryDate).valueOf();
					}
					if (left.legType !== right.legType) {
						return left.legType === "Call" ? -1 : 1;
					}
					return left.weekNumber - right.weekNumber;
				});

			const activeCallCount = optionsInWeek.filter((leg) => leg.legType === "Call" && isLegOpenOnDate(leg)).length;
			const activePutCount = optionsInWeek.filter((leg) => leg.legType === "Put" && isLegOpenOnDate(leg)).length;
			const activeOptionCount = optionsInWeek.filter((leg) => isLegOpenOnDate(leg)).length;
			const shownOptionCount = optionsInWeek.length;

			return {
				key: asOfDate,
				date: asOfDate,
				closePrice,
				shownOptions: shownOptionCount,
				activeOptions: activeOptionCount,
				callsActive: activeCallCount,
				putsActive: activePutCount,
				closedInThisWeek: closedInCurrentWeekCount,
				cumulativeClosed: cumulativeClosedCount,
			};
		});

		const bubbleChartDate = sectionDates[sectionDates.length - 1] ?? startDate;
		const bubbleChartClosePrice = Object.prototype.hasOwnProperty.call(closingPriceByDate, bubbleChartDate)
			? closingPriceByDate[bubbleChartDate]
			: null;

		const bubbleChartPoints = legs.map((leg) => ({
			date: leg.entryDate,
			strike: leg.strike,
			legType: leg.legType,
			label: `${leg.legType} ${formatCurrency(leg.strike)} • ${leg.entryDate}`,
			closePrice: bubbleChartClosePrice,
			bubbleSize: 120 + Math.min(leg.rolledCount, 4) * 35,
		}));

		const trendData = sectionDates.map((date) => ({
			date,
			openedOptions: legs.filter((leg) => leg.entryDate === date).length,
			closedOptions: legs.filter((leg) => leg.closeDate === date).length,
			activeOptions: summaryRows.find((row) => row.date === date)?.activeOptions ?? 0,
		}));

		return { summaryRows, trendData, bubbleChartDate, bubbleChartClosePrice, bubbleChartPoints };
	}, [snapshot]);

	useEffect(() => {
		setBubbleWindow({
			startIndex: 0,
			endIndex: Math.max(0, chartData.bubbleChartPoints.length - 1),
		});
	}, [chartData.bubbleChartPoints.length]);

	useEffect(() => {
		if (selectedOptionDate || !snapshot) return;
		setSelectedOptionDate(chartData.bubbleChartDate || snapshot.endDate || snapshot.startDate || "");
	}, [chartData.bubbleChartDate, selectedOptionDate, snapshot]);

	const visibleBubbleChartPoints = useMemo(
		() => chartData.bubbleChartPoints.slice(bubbleWindow.startIndex, bubbleWindow.endIndex + 1),
		[bubbleWindow.endIndex, bubbleWindow.startIndex, chartData.bubbleChartPoints]
	);

	const bubbleChartHeight = Math.max(620, Math.min(1400, 240 + visibleBubbleChartPoints.length * 14));

	const optionListData = useMemo(() => {
		if (!snapshot || !selectedOptionDate) return [] as OptionListRow[];

		const selectedDay = dayjs(selectedOptionDate);

		return snapshot.legs
			.map((leg) => {
				const entryDate = dayjs(leg.entryDate);
				const closeDate = leg.closeDate ? dayjs(leg.closeDate) : null;
				const active =
					(selectedDay.isSame(entryDate, "day") || selectedDay.isAfter(entryDate, "day")) &&
					(!closeDate || selectedDay.isBefore(closeDate, "day"));
				const opened = selectedDay.isSame(entryDate, "day");
				const closed = Boolean(closeDate && selectedDay.isSame(closeDate, "day"));
				const rolled = leg.rolledCount > 0 && (selectedDay.isSame(entryDate, "day") || selectedDay.isAfter(entryDate, "day"));

				const matches =
					(selectedOptionStatus === "active" && active) ||
					(selectedOptionStatus === "open" && opened) ||
					(selectedOptionStatus === "closed" && closed) ||
					(selectedOptionStatus === "rolled" && rolled);

				if (!matches) return null;

				return {
					key: leg.key,
					legType: leg.legType,
					weekNumber: leg.weekNumber,
					entryDate: leg.entryDate,
					closeDate: leg.closeDate,
					finalExpiryDate: leg.finalExpiryDate,
					strike: leg.strike,
					rolledCount: leg.rolledCount,
					entryPrice: leg.entryPrice,
					closeOptionClosePrice: leg.closeOptionClosePrice,
					status: selectedOptionStatus,
				} as OptionListRow;
			})
			.filter((row): row is OptionListRow => row !== null)
			.sort((left, right) => {
				if (left.entryDate !== right.entryDate) {
					return dayjs(left.entryDate).valueOf() - dayjs(right.entryDate).valueOf();
				}
				if (left.legType !== right.legType) {
					return left.legType === "Call" ? -1 : 1;
				}
				return left.weekNumber - right.weekNumber;
			});
	}, [selectedOptionDate, selectedOptionStatus, snapshot]);

	if (!snapshot) {
		return (
			<Space direction="vertical" size={16} style={{ width: "100%" }}>
				<Alert
					type="info"
					showIcon
					message="No weekly straddle data found"
					description="Run Weekly Straddle Roll once so the chart data is saved to localStorage, then open this tab again."
				/>
				<Empty description="Charts will appear after a weekly straddle run is saved" />
			</Space>
		);
	}

	return (
		<Space direction="vertical" size={16} style={{ width: "100%" }}>
			<Card style={{ width: "100%" }} bodyStyle={{ padding: 20 }}>
				<Space direction="vertical" size={4} style={{ width: "100%", marginBottom: 20 }}>
					<Title level={3} style={{ marginBottom: 0 }}>
						Weekly Straddle Charts
					</Title>
					<Text type="secondary">Imported from the most recent Weekly Straddle Roll snapshot saved in localStorage.</Text>
				</Space>

				<Space direction="vertical" size={20} style={{ width: "100%" }}>
					<div style={{ width: "100%", height: 320 }}>
						<ResponsiveContainer>
							<LineChart data={chartData.trendData} margin={{ top: 8, right: 20, left: 0, bottom: 8 }}>
								<CartesianGrid strokeDasharray="3 3" />
								<XAxis dataKey="date" />
								<YAxis allowDecimals={false} />
								<Tooltip />
								<Legend />
								<Line type="monotone" dataKey="openedOptions" name="Opened" stroke="#1677ff" strokeWidth={2} dot={false} />
								<Line type="monotone" dataKey="closedOptions" name="Closed" stroke="#ff4d4f" strokeWidth={2} dot={false} />
								<Line type="monotone" dataKey="activeOptions" name="Active" stroke="#52c41a" strokeWidth={2} dot={false} />
							</LineChart>
						</ResponsiveContainer>
					</div>

					<div style={{ width: "100%", height: bubbleChartHeight }}>
						<ResponsiveContainer>
							<ScatterChart margin={{ top: 16, right: 20, bottom: 24, left: 0 }}>
								<CartesianGrid strokeDasharray="3 3" />
								<XAxis dataKey="date" type="category" allowDuplicatedCategory={false} tick={{ fontSize: 12 }} />
								<YAxis dataKey="strike" type="number" tickFormatter={(value) => `$${value}`} domain={["dataMin - 10", "dataMax + 10"]} />
								<ZAxis dataKey="bubbleSize" range={[80, 260]} />
								<Tooltip
									formatter={(value, name) => {
										if (name === "strike") return [formatCurrency(Number(value)), "Strike"];
										return [value, name];
									}}
									labelFormatter={() => `Selected date: ${chartData.bubbleChartDate || "-"}`}
								/>
								<Legend />
								{chartData.bubbleChartClosePrice !== null && (
									<ReferenceLine y={chartData.bubbleChartClosePrice} stroke="#1677ff" strokeDasharray="6 6" />
								)}
								{chartData.bubbleChartDate && (
									<ReferenceLine x={chartData.bubbleChartDate} stroke="#595959" strokeDasharray="3 3" />
								)}
								<Scatter name="Calls" data={visibleBubbleChartPoints.filter((point) => point.legType === "Call")} fill="#52c41a" shape="circle" />
								<Scatter name="Puts" data={visibleBubbleChartPoints.filter((point) => point.legType === "Put")} fill="#eb2f96" shape="circle" />
								<Brush
									dataKey="date"
									height={28}
									stroke="#1677ff"
									startIndex={bubbleWindow.startIndex}
									endIndex={bubbleWindow.endIndex || Math.max(0, chartData.bubbleChartPoints.length - 1)}
									onChange={(range) => {
										if (!range) return;
										setBubbleWindow({
											startIndex: range.startIndex ?? 0,
											endIndex: range.endIndex ?? Math.max(0, chartData.bubbleChartPoints.length - 1),
										});
									}}
								/>
							</ScatterChart>
						</ResponsiveContainer>
					</div>

					<Space style={{ width: "100%" }}>
						<Text strong>Summary Panel</Text>
						<Button onClick={() => setShowSummary((previous) => !previous)}>
							{showSummary ? "Hide Summary" : "Show Summary"}
						</Button>
					</Space>

					<Space direction="vertical" size={8} style={{ width: "100%" }}>
						<Space wrap>
							<div>
								<Text strong>Option Date</Text>
								<div style={{ marginTop: 6 }}>
									<DatePicker
										value={selectedOptionDate ? dayjs(selectedOptionDate) : null}
										onChange={(value) => setSelectedOptionDate(value ? value.format("YYYY-MM-DD") : "")}
										style={{ width: 180 }}
									/>
								</div>
							</div>

							<div>
								<Text strong>Status Filter</Text>
								<div style={{ marginTop: 6 }}>
									<Select<LegStatusFilter>
										value={selectedOptionStatus}
										onChange={(value) => setSelectedOptionStatus(value)}
										style={{ minWidth: 260 }}
										options={[
											{ label: "Active", value: "active" },
											{ label: "Open", value: "open" },
											{ label: "Closed", value: "closed" },
											{ label: "Rolled", value: "rolled" },
										]}
										placeholder="Filter status"
									/>
								</div>
							</div>
						</Space>
					</Space>

					{selectedOptionDate && (
						<Alert
							style={{ marginTop: 8 }}
							type="info"
							showIcon
							message={`Showing ${selectedOptionStatus} options for ${selectedOptionDate}`}
						/>
					)}

					{selectedOptionDate && (
						<Table
							style={{ marginTop: 12 }}
							rowKey="key"
							size="small"
							pagination={false}
							columns={[
								{ title: "Type", dataIndex: "legType", key: "legType" },
								{ title: "Trade", dataIndex: "weekNumber", key: "weekNumber" },
								{ title: "Entry", dataIndex: "entryDate", key: "entryDate" },
								{ title: "Close", dataIndex: "closeDate", key: "closeDate", render: (value: string | null) => value ?? "-" },
								{ title: "Expiry", dataIndex: "finalExpiryDate", key: "finalExpiryDate" },
								{ title: "Strike", dataIndex: "strike", key: "strike", render: (value: number) => formatCurrency(value) },
								{ title: "Rolled", dataIndex: "rolledCount", key: "rolledCount" },
								{
									title: "Status",
									dataIndex: "status",
									key: "status",
									render: (value: LegStatusFilter) => {
										const colors: Record<LegStatusFilter, string> = {
											active: "green",
											open: "blue",
											closed: "red",
											rolled: "gold",
										};

										return <Tag color={colors[value]}>{value.toUpperCase()}</Tag>;
									},
								},
								{
									title: "Entry Px",
									dataIndex: "entryPrice",
									key: "entryPrice",
									render: (value: number | null) => formatCurrency(value),
								},
								{
									title: "Close Px",
									dataIndex: "closeOptionClosePrice",
									key: "closeOptionClosePrice",
									render: (value: number | null) => formatCurrency(value),
								},
							]}
							dataSource={optionListData}
							locale={{ emptyText: "No options match the selected date and status filter" }}
						/>
					)}

					{showSummary && (
						<Table
							rowKey="key"
							size="small"
							pagination={false}
							columns={[
								{ title: "Date", dataIndex: "date", key: "date" },
								{
									title: "Close",
									dataIndex: "closePrice",
									key: "closePrice",
									render: (value: number | null) => formatCurrency(value),
								},
								{ title: "Shown Options", dataIndex: "shownOptions", key: "shownOptions" },
								{ title: "Active Options", dataIndex: "activeOptions", key: "activeOptions" },
								{ title: "Calls Active", dataIndex: "callsActive", key: "callsActive" },
								{ title: "Puts Active", dataIndex: "putsActive", key: "putsActive" },
								{ title: "Closed in this week", dataIndex: "closedInThisWeek", key: "closedInThisWeek" },
								{ title: "Cumulative closed", dataIndex: "cumulativeClosed", key: "cumulativeClosed" },
							]}
							dataSource={chartData.summaryRows}
						/>
					)}
				</Space>
			</Card>
		</Space>
	);
};

export default LocalFullScreenCharts;