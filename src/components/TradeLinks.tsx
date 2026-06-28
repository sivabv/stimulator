import React, { useState } from "react";
import { DeleteOutlined } from "@ant-design/icons";
import { Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import dayjs from "dayjs";
import spyClosingData from "../assets/spy-closing.json";
import tradingDatesData from "../assets/trading_dates_2026.json";
import { getSqliteItem } from "../utils/sqliteStorage";
import { fetchOptionOpenClose } from "../api/backtest";

const { Title, Text } = Typography;

type TradeAction = "Buy" | "Sell" | "Roll";
type OptionType = "Call" | "Put";

interface TradeOrder {
  key: string;
  action: TradeAction;
  symbol: string;
  currentDate: string;
  optionType: OptionType;
  strike: number;
  expiry: string;
  longExpiry?: string;
  quantity: number;
  premium: number;
}

interface TradeFormValues {
  action: TradeAction;
  symbol: string;
  optionType: OptionType;
  strike: number;
  currentDate: dayjs.Dayjs;
  expiry: dayjs.Dayjs;
  longExpiry?: dayjs.Dayjs;
  quantity: number;
  premium: number;
}

interface PersistedTradeFormValues extends Omit<TradeFormValues, "expiry" | "currentDate" | "longExpiry"> {
  currentDate: string;
  expiry: string;
  longExpiry?: string;
}

interface PersistedTradeSession {
  orders: TradeOrder[];
  sectionPremiumsByDate: Record<string, Record<string, number>>;
  probableOptions: ProbableOptionCandidate[];
  dateSections: string[];
  sectionTwoDate?: string;
  selectedAction?: TradeAction;
  selectedOptionType?: OptionType;
}

const TRADE_FORM_STORAGE_KEY = "tradeFormDraft";
const TRADE_SESSION_STORAGE_KEY = "tradeSessionState";
const MASTER_STOCK_DATA_KEY = "masterStockData";
const TRADING_DATES = tradingDatesData as string[];
const SPY_CLOSE_BY_DATE = new Map(
  (spyClosingData as Array<{ date: string; close: number | null }>).map((row) => [row.date, row.close])
);
const roundToNearestFive = (value: number) => Math.round(value / 5) * 5;
const formatExpiryDate = (dateStr: string) => dayjs(dateStr).format("YYMMDD");
const getNextFriday = (baseDate: dayjs.Dayjs) => {
  const dayOfWeek = baseDate.day();
  const fridayIndex = 5;
  let daysUntilNextFriday = (fridayIndex - dayOfWeek + 7) % 7;
  if (daysUntilNextFriday === 0) {
    daysUntilNextFriday = 7;
  }
  return baseDate.add(daysUntilNextFriday, "day");
};

const sortUniqueDates = (dates: string[]) => Array.from(new Set(dates)).sort((left, right) => left.localeCompare(right));

type MasterStockData = Record<string, { closePrice: number | null }>;

interface ProbableOptionCandidate {
  strike: number;
  premium: number;
  source: "close" | "open";
}

interface RollPopupState {
  open: boolean;
  order: TradeOrder | null;
  targetDate: string;
  rollDate: dayjs.Dayjs | null;
  strike: number;
  rollPremium: number;
}

const TradeLinks: React.FC = () => {
  const defaultCurrentDate = dayjs();
  const defaultExpiryDate = getNextFriday(defaultCurrentDate);
  const defaultLongExpiryDate = getNextFriday(defaultExpiryDate.add(1, "day"));
  const [form] = Form.useForm<TradeFormValues>();
  const watchedStrike = Form.useWatch("strike", form);
  const watchedPremium = Form.useWatch("premium", form);
  const watchedAction = Form.useWatch("action", form);
  const watchedSymbol = Form.useWatch("symbol", form);
  const watchedOptionType = Form.useWatch("optionType", form);
  const watchedExpiry = Form.useWatch("expiry", form);
  const watchedCurrentDate = Form.useWatch("currentDate", form);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [dayClosePrice, setDayClosePrice] = useState<number | null>(null);
  const [strikeStep, setStrikeStep] = useState<number>(1);
  const [activeAdjustControl, setActiveAdjustControl] = useState<"up" | "down">("up");
  const [premiumLoading, setPremiumLoading] = useState(false);
  const [rollPremiumLoading, setRollPremiumLoading] = useState(false);
  const [updatingPrices, setUpdatingPrices] = useState(false);
  const [autoApiPricing, setAutoApiPricing] = useState(true);
  const [probableOptions, setProbableOptions] = useState<ProbableOptionCandidate[]>([]);
  const [probableLoading, setProbableLoading] = useState(false);
  const [sectionPremiumsByDate, setSectionPremiumsByDate] = useState<Record<string, Record<string, number>>>({});
  const [dateSections, setDateSections] = useState<string[]>([]);
  const [sectionTwoDate, setSectionTwoDate] = useState<string | null>(null);
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [rollPopup, setRollPopup] = useState<RollPopupState>({
    open: false,
    order: null,
    targetDate: "",
    rollDate: null,
    strike: 0,
    rollPremium: 0,
  });

  React.useEffect(() => {
    const rawDraft = localStorage.getItem(TRADE_FORM_STORAGE_KEY);
    if (!rawDraft) {
      form.setFieldValue("expiry", getNextFriday(defaultCurrentDate));
      return;
    }

    try {
      const parsed = JSON.parse(rawDraft) as Partial<PersistedTradeFormValues>;
      const draftCurrentDate = parsed.currentDate ? dayjs(parsed.currentDate) : defaultCurrentDate;
      const parsedExpiry = parsed.expiry ? dayjs(parsed.expiry) : null;
      const parsedLongExpiry = parsed.longExpiry ? dayjs(parsed.longExpiry) : null;
      const draftValues: Partial<TradeFormValues> = {
        ...parsed,
        currentDate: draftCurrentDate,
        expiry: parsedExpiry && parsedExpiry.isValid() ? parsedExpiry : getNextFriday(draftCurrentDate),
        longExpiry:
          parsedLongExpiry && parsedLongExpiry.isValid()
            ? parsedLongExpiry
            : getNextFriday(getNextFriday(draftCurrentDate).add(1, "day")),
      };
      form.setFieldsValue(draftValues);
    } catch {
      // Ignore malformed local draft and keep defaults.
      form.setFieldValue("expiry", getNextFriday(defaultCurrentDate));
    }
  }, [defaultCurrentDate, form]);

  React.useEffect(() => {
    const rawSession = localStorage.getItem(TRADE_SESSION_STORAGE_KEY);
    if (!rawSession) {
      setSessionHydrated(true);
      return;
    }

    try {
      const parsed = JSON.parse(rawSession) as Partial<PersistedTradeSession>;
      setOrders(Array.isArray(parsed.orders) ? parsed.orders : []);
      setSectionPremiumsByDate(
        parsed.sectionPremiumsByDate && typeof parsed.sectionPremiumsByDate === "object"
          ? parsed.sectionPremiumsByDate
          : {}
      );
      setProbableOptions(Array.isArray(parsed.probableOptions) ? parsed.probableOptions : []);
      setDateSections(
        Array.isArray(parsed.dateSections)
          ? sortUniqueDates(parsed.dateSections.filter((date) => Boolean(date)))
          : []
      );
      setSectionTwoDate(
        typeof parsed.sectionTwoDate === "string" && parsed.sectionTwoDate
          ? parsed.sectionTwoDate
          : TRADING_DATES[0] ?? null
      );

      if (parsed.selectedAction === "Buy" || parsed.selectedAction === "Sell" || parsed.selectedAction === "Roll") {
        form.setFieldValue("action", parsed.selectedAction);
      }

      if (parsed.selectedOptionType === "Call" || parsed.selectedOptionType === "Put") {
        form.setFieldValue("optionType", parsed.selectedOptionType);
      }
    } catch {
      // Ignore malformed session state.
    } finally {
      setSessionHydrated(true);
    }
  }, [form]);

  React.useEffect(() => {
    if (!sessionHydrated) return;

    const payload: PersistedTradeSession = {
      orders,
      sectionPremiumsByDate,
      probableOptions,
      dateSections,
      sectionTwoDate: sectionTwoDate ?? undefined,
      selectedAction: watchedAction,
      selectedOptionType: watchedOptionType,
    };
    localStorage.setItem(TRADE_SESSION_STORAGE_KEY, JSON.stringify(payload));
  }, [dateSections, orders, probableOptions, sectionPremiumsByDate, sectionTwoDate, sessionHydrated, watchedAction, watchedOptionType]);

  const persistDraft = (_changedValues: Partial<TradeFormValues>, allValues: TradeFormValues) => {
    const payload: Partial<PersistedTradeFormValues> = {
      ...allValues,
      currentDate: allValues.currentDate ? allValues.currentDate.format("YYYY-MM-DD") : "",
      expiry: allValues.expiry ? allValues.expiry.format("YYYY-MM-DD") : "",
      longExpiry: allValues.longExpiry ? allValues.longExpiry.format("YYYY-MM-DD") : "",
    };
    localStorage.setItem(TRADE_FORM_STORAGE_KEY, JSON.stringify(payload));
  };

  const setStrikeAndPersist = (strikeValue: number) => {
    form.setFieldValue("strike", strikeValue);
    const allValues = form.getFieldsValue();
    persistDraft({}, allValues as TradeFormValues);
  };

  const setPremiumAndPersist = (premiumValue: number) => {
    form.setFieldValue("premium", premiumValue);
    const allValues = form.getFieldsValue();
    persistDraft({}, allValues as TradeFormValues);
  };

  const loadProbableOptions = async (
    symbol: string,
    formattedExpiry: string,
    apiOptionType: "C" | "P",
    date: string,
    baseStrike: number
  ) => {
    setProbableLoading(true);

    try {
      const roundedBase = roundToNearestFive(baseStrike);
      const offsets = [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25];
      const candidateStrikes = Array.from(
        new Set(
          offsets
            .map((offset) => roundedBase + offset)
            .filter((strikeValue) => strikeValue > 0)
        )
      );

      const responses = await Promise.all(
        candidateStrikes.map(async (candidateStrike) => {
          const response = await fetchOptionOpenClose(
            symbol,
            formattedExpiry,
            candidateStrike,
            apiOptionType,
            date
          );

          const premiumValue = response.closePrice ?? response.openPrice;
          if (premiumValue === null || !Number.isFinite(premiumValue)) {
            return null;
          }

          return {
            strike: candidateStrike,
            premium: Number(premiumValue.toFixed(2)),
            source: response.closePrice !== null ? "close" : "open",
          } as ProbableOptionCandidate;
        })
      );

      const availableOptions = responses
        .filter((item): item is ProbableOptionCandidate => item !== null)
        .sort((left, right) => Math.abs(left.strike - baseStrike) - Math.abs(right.strike - baseStrike))
        .slice(0, 8);

      setProbableOptions(availableOptions);
      if (availableOptions.length === 0) {
        message.warning("No nearby option prices found for this date/expiry");
      } else {
        message.warning("Exact option missing. Select from closest available options below.");
      }
    } catch {
      setProbableOptions([]);
    } finally {
      setProbableLoading(false);
    }
  };

  const handleSubmit = (values: TradeFormValues) => {
    const order: TradeOrder = {
      key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: values.action,
      symbol: values.symbol.trim().toUpperCase(),
      currentDate: values.currentDate.format("YYYY-MM-DD"),
      optionType: values.optionType,
      strike: values.strike,
      expiry: values.expiry.format("YYYY-MM-DD"),
      longExpiry: values.longExpiry ? values.longExpiry.format("YYYY-MM-DD") : "",
      quantity: values.quantity,
      premium: values.premium,
    };

    setOrders((previous) => [order, ...previous]);
    form.resetFields(["strike", "expiry", "longExpiry", "quantity", "premium"]);

    const refreshedCurrentDate = (form.getFieldValue("currentDate") as dayjs.Dayjs | undefined) ?? dayjs();
    form.setFieldValue("expiry", getNextFriday(refreshedCurrentDate));
    form.setFieldValue("longExpiry", getNextFriday(getNextFriday(refreshedCurrentDate).add(1, "day")));

    const remainingValues = form.getFieldsValue();
    persistDraft({}, remainingValues as TradeFormValues);
  };

  const getLocalClosePrice = async (): Promise<{ symbol: string; date: string; closePrice: number | null }> => {
    const symbol = form.getFieldValue("symbol")?.trim().toUpperCase();
    const currentDate = form.getFieldValue("currentDate") as dayjs.Dayjs | undefined;

    if (!symbol) {
      message.warning("Enter symbol first");
      return { symbol: "", date: "", closePrice: null };
    }

    if (!currentDate || !dayjs(currentDate).isValid()) {
      message.warning("Select current date first");
      return { symbol, date: "", closePrice: null };
    }

    const date = currentDate.format("YYYY-MM-DD");
    let closePrice: number | null = null;

    const rawMasterStock = await getSqliteItem(MASTER_STOCK_DATA_KEY);
    if (rawMasterStock) {
      try {
        const parsed = JSON.parse(rawMasterStock) as MasterStockData;
        const cacheKey = `${symbol}|${date}`;
        closePrice = parsed[cacheKey]?.closePrice ?? null;
      } catch {
        closePrice = null;
      }
    }

    if (closePrice === null && symbol === "SPY") {
      closePrice = SPY_CLOSE_BY_DATE.get(date) ?? null;
    }

    return { symbol, date, closePrice };
  };

  const handleLoadDayClose = async () => {
    const { symbol, date, closePrice } = await getLocalClosePrice();

    if (closePrice === null) {
      setDayClosePrice(null);
      message.warning(`No local close price found for ${symbol} on ${date}`);
      return;
    }

    const roundedStrike = roundToNearestFive(closePrice);
    setDayClosePrice(closePrice);
    setStrikeAndPersist(roundedStrike);
    message.success(`Loaded local close ${closePrice} and rounded strike to ${roundedStrike}`);
  };

  const adjustStrike = async (direction: "up" | "down", stepOverride?: number) => {
    setActiveAdjustControl(direction);

    const step = typeof stepOverride === "number" ? stepOverride : strikeStep;

    if (step < 0) {
      message.info("Step cannot be negative");
      return;
    }

    const { symbol, date, closePrice } = await getLocalClosePrice();
    if (closePrice === null) {
      setDayClosePrice(null);
      message.warning(`No local close price found for ${symbol} on ${date}`);
      return;
    }

    const roundedBase = roundToNearestFive(closePrice);
    setDayClosePrice(closePrice);

    if (step === 0) {
      setStrikeAndPersist(roundedBase);
      message.success(`Loaded rounded base strike ${roundedBase}`);
      return;
    }

    if (step <= 0) {
      message.info("Select step greater than 0 to adjust strike");
      return;
    }

    const percent = step / 100;
    const nextStrike = direction === "up"
      ? roundedBase * (1 + percent)
      : Math.max(0, roundedBase * (1 - percent));
    setStrikeAndPersist(Number(nextStrike.toFixed(2)));
    message.success(`Calculated strike ${Number(nextStrike.toFixed(2))} from close ${closePrice} using ${step}%`);
  };

  const loadPremiumFromApi = async (showFeedback: boolean) => {
    const symbol = form.getFieldValue("symbol")?.trim().toUpperCase();
    const optionType = form.getFieldValue("optionType") as OptionType | undefined;
    const strike = Number(form.getFieldValue("strike"));
    const expiry = form.getFieldValue("expiry") as dayjs.Dayjs | undefined;
    const currentDate = form.getFieldValue("currentDate") as dayjs.Dayjs | undefined;

    if (!symbol) {
      if (showFeedback) message.warning("Enter symbol first");
      return;
    }

    if (!optionType) {
      if (showFeedback) message.warning("Select option type");
      return;
    }

    if (!Number.isFinite(strike) || strike <= 0) {
      if (showFeedback) message.warning("Enter valid strike first");
      return;
    }

    if (!expiry || !dayjs(expiry).isValid()) {
      if (showFeedback) message.warning("Select expiry first");
      return;
    }

    if (!currentDate || !dayjs(currentDate).isValid()) {
      if (showFeedback) message.warning("Select current date first");
      return;
    }

    const date = currentDate.format("YYYY-MM-DD");
    const formattedExpiry = formatExpiryDate(expiry.format("YYYY-MM-DD"));
    const apiOptionType = optionType === "Call" ? "C" : "P";

    setPremiumLoading(true);
    try {
      const response = await fetchOptionOpenClose(symbol, formattedExpiry, strike, apiOptionType, date);
      const premium = response.closePrice ?? response.openPrice;

      if (premium === null || !Number.isFinite(premium)) {
        await loadProbableOptions(symbol, formattedExpiry, apiOptionType, date, strike);
        if (showFeedback) {
          message.warning("No premium price returned for exact strike. Showing closest options.");
        }
        return;
      }

      const roundedPremium = Number(premium.toFixed(2));
      setPremiumAndPersist(roundedPremium);
      setProbableOptions([]);
      if (showFeedback) {
        message.success(`Loaded premium ${roundedPremium} from Massive API`);
      }
    } catch {
      if (showFeedback) {
        message.error("Failed to fetch premium from Massive API");
      }
    } finally {
      setPremiumLoading(false);
    }
  };

  const handleLoadPremiumFromApi = async () => {
    await loadPremiumFromApi(true);
  };

  const handleSelectProbableOption = (candidate: ProbableOptionCandidate) => {
    setStrikeAndPersist(candidate.strike);
    setPremiumAndPersist(candidate.premium);
    setProbableOptions([]);
    message.success(`Selected strike ${candidate.strike} with premium ${candidate.premium}`);
  };

  const handleDeleteOrder = (orderKey: string) => {
    setOrders((previous) => previous.filter((order) => order.key !== orderKey));
    setSectionPremiumsByDate((previous) => {
      const nextEntries = Object.entries(previous).map(([dateKey, premiums]) => {
        const { [orderKey]: _removed, ...remaining } = premiums;
        return [dateKey, remaining] as const;
      });
      return Object.fromEntries(nextEntries);
    });
    message.success("Trade entry removed");
  };

  const resolvePremiumForDate = (order: TradeOrder, targetDate: string) => {
    const localizedPremium = sectionPremiumsByDate[targetDate]?.[order.key];
    if (typeof localizedPremium === "number" && Number.isFinite(localizedPremium)) {
      return localizedPremium;
    }
    return Number(order.premium) || 0;
  };

  const handleRollOrder = (order: TradeOrder, targetDate: string, rollDate: string, strike: number, rollPremium: number) => {
    if (!order.longExpiry || order.longExpiry === order.expiry) {
      message.info("Long Expiry is required to roll this trade");
      return;
    }

    const nextOrder: TradeOrder = {
      ...order,
      key: `${Date.now()}-${Math.random()}`,
      action: "Roll",
      currentDate: rollDate,
      strike: Number(strike.toFixed(2)),
      expiry: order.longExpiry,
      premium: Number(rollPremium.toFixed(2)),
    };

    setOrders((previous) => [...previous, nextOrder]);
    setSectionPremiumsByDate((previous) => ({
      ...previous,
      [targetDate]: {
        ...(previous[targetDate] ?? {}),
        [nextOrder.key]: nextOrder.premium,
      },
    }));
    message.success("Roll trade added");
  };

  const fetchRollPremiumForPopup = async (
    order: TradeOrder,
    rollDate: dayjs.Dayjs,
    strike: number,
    quoteDate: string
  ) => {
    if (!rollDate.isValid() || !Number.isFinite(strike) || strike <= 0) {
      return;
    }

    if (!quoteDate || !dayjs(quoteDate).isValid()) {
      return;
    }

    setRollPremiumLoading(true);
    try {
      const formattedExpiry = formatExpiryDate(rollDate.format("YYYY-MM-DD"));
      const apiOptionType = order.optionType === "Call" ? "C" : "P";
      const response = await fetchOptionOpenClose(
        order.symbol,
        formattedExpiry,
        strike,
        apiOptionType,
        dayjs(quoteDate).format("YYYY-MM-DD")
      );

      const premium = response.closePrice ?? response.openPrice;
      if (premium === null || !Number.isFinite(premium)) {
        return;
      }

      setRollPopup((previous) => {
        if (!previous.open || !previous.order || previous.order.key !== order.key) {
          return previous;
        }

        return {
          ...previous,
          rollPremium: Number(premium.toFixed(2)),
        };
      });
    } finally {
      setRollPremiumLoading(false);
    }
  };

  const openRollPopup = (order: TradeOrder, targetDate: string) => {
    const basePremium = resolvePremiumForDate(order, targetDate);
    const baseRollDate = dayjs(order.expiry).isValid() ? dayjs(order.expiry) : dayjs(targetDate);
    const nextRollDate = baseRollDate.add(7, "day");
    setRollPopup({
      open: true,
      order,
      targetDate,
      rollDate: nextRollDate,
      strike: order.strike,
      rollPremium: Number(basePremium.toFixed(2)),
    });
    void fetchRollPremiumForPopup(order, nextRollDate, order.strike, targetDate);
  };

  const closeRollPopup = () => {
    setRollPopup({
      open: false,
      order: null,
      targetDate: "",
      rollDate: null,
      strike: 0,
      rollPremium: 0,
    });
  };

  const confirmRollFromPopup = () => {
    if (!rollPopup.order) {
      return;
    }
    if (!rollPopup.rollDate || !rollPopup.rollDate.isValid()) {
      message.info("Select a valid roll date");
      return;
    }
    if (!Number.isFinite(rollPopup.strike) || rollPopup.strike <= 0) {
      message.info("Enter a valid strike price");
      return;
    }
    if (!Number.isFinite(rollPopup.rollPremium) || rollPopup.rollPremium <= 0) {
      message.info("Enter a valid roll premium");
      return;
    }

    handleRollOrder(
      rollPopup.order,
      rollPopup.targetDate,
      rollPopup.rollDate.format("YYYY-MM-DD"),
      rollPopup.strike,
      rollPopup.rollPremium
    );
    closeRollPopup();
  };

  const handleCloseOrder = (order: TradeOrder, targetDate: string) => {
    const closingAction: TradeAction = order.action === "Buy" ? "Sell" : "Buy";
    const nextOrder: TradeOrder = {
      ...order,
      key: `${Date.now()}-${Math.random()}`,
      action: closingAction,
      currentDate: targetDate,
      premium: Number(resolvePremiumForDate(order, targetDate).toFixed(2)),
    };

    setOrders((previous) => [...previous, nextOrder]);
    setSectionPremiumsByDate((previous) => ({
      ...previous,
      [targetDate]: {
        ...(previous[targetDate] ?? {}),
        [nextOrder.key]: nextOrder.premium,
      },
    }));
    message.success("Close trade added");
  };

  const handleSaveSession = () => {
    const payload: PersistedTradeSession = {
      orders,
      sectionPremiumsByDate,
      probableOptions,
      dateSections,
      selectedAction: watchedAction,
      selectedOptionType: watchedOptionType,
    };
    localStorage.setItem(TRADE_SESSION_STORAGE_KEY, JSON.stringify(payload));
    message.success("Session saved");
  };

  const currentDateDisplay =
    watchedCurrentDate && dayjs(watchedCurrentDate).isValid()
      ? dayjs(watchedCurrentDate).format("YYYY-MM-DD")
      : defaultCurrentDate.format("YYYY-MM-DD");

  const normalizedDateSections = sortUniqueDates(dateSections);
  const trackedSectionTwoDate = sectionTwoDate ?? TRADING_DATES[0] ?? null;
  const sectionHeaderDate = trackedSectionTwoDate ?? currentDateDisplay;

  const handleUpdateOrderPricesForDate = async (targetDate: string) => {
    if (orders.length === 0) {
      message.info("No trades available to update");
      return;
    }

    setUpdatingPrices(true);
    try {
      const fetchedPremiumByOrderKey = await Promise.all(
        orders.map(async (order) => {
          try {
            const formattedExpiry = formatExpiryDate(order.expiry);
            const apiOptionType = order.optionType === "Call" ? "C" : "P";
            const response = await fetchOptionOpenClose(
              order.symbol,
              formattedExpiry,
              order.strike,
              apiOptionType,
              targetDate
            );

            const premium = response.closePrice ?? response.openPrice;
            if (premium === null || !Number.isFinite(premium)) {
              return null;
            }

            return [order.key, Number(premium.toFixed(2))] as const;
          } catch {
            return null;
          }
        })
      );

      const validEntries = fetchedPremiumByOrderKey.filter((entry): entry is readonly [string, number] => entry !== null);
      const nextPremiumMapForDate = Object.fromEntries(validEntries);
      setSectionPremiumsByDate((previous) => ({
        ...previous,
        [targetDate]: nextPremiumMapForDate,
      }));

      message.success(`Updated ${validEntries.length} of ${orders.length} trade prices for ${targetDate}`);
    } finally {
      setUpdatingPrices(false);
    }
  };

  const handleSimulateNextDate = async () => {
    const sortedSections = normalizedDateSections.length > 0 ? normalizedDateSections : [sectionHeaderDate];
    const lastSectionDate = sortedSections[sortedSections.length - 1];
    const nextDate = TRADING_DATES.find((tradingDate) => tradingDate > lastSectionDate) ?? "-";

    if (nextDate === "-") {
      message.info("No next trading date available");
      return;
    }

    if (sortedSections.includes(nextDate)) {
      message.info(`Section for ${nextDate} already exists`);
      return;
    }

    setDateSections((previous) => sortUniqueDates([...previous, nextDate]));
    if (!trackedSectionTwoDate) {
      setSectionTwoDate(nextDate);
    }
    await handleUpdateOrderPricesForDate(nextDate);
    message.success(`Added next date section: ${nextDate}`);
  };

  const buildTradeGridColumns = (constantDate: string) => [
    {
      title: "Action",
      dataIndex: "action",
      key: "action",
      render: (value: TradeAction) => (
        <Tag color={value === "Buy" ? "green" : value === "Sell" ? "blue" : "gold"}>{value}</Tag>
      ),
    },
    { title: "Symbol", dataIndex: "symbol", key: "symbol" },
    {
      title: "Current Date",
      dataIndex: "currentDate",
      key: "currentDate",
      render: (_value: string) => constantDate,
    },
    { title: "Type", dataIndex: "optionType", key: "optionType" },
    { title: "Strike", dataIndex: "strike", key: "strike" },
    { title: "Expiry", dataIndex: "expiry", key: "expiry" },
    {
      title: "Long Expiry",
      dataIndex: "longExpiry",
      key: "longExpiry",
      render: (value?: string) => value || "-",
    },
    { title: "Qty", dataIndex: "quantity", key: "quantity" },
    {
      title: "Premium",
      dataIndex: "premium",
      key: "premium",
      render: (value: number, record: TradeOrder) => {
        const localizedPremium = sectionPremiumsByDate[constantDate]?.[record.key];
        if (typeof localizedPremium === "number" && Number.isFinite(localizedPremium)) {
          return localizedPremium;
        }
        return value;
      },
    },
    {
      title: "Actions",
      key: "actions",
      render: (_value: unknown, record: TradeOrder) => (
        <Space size={6}>
          <Button size="small" onClick={() => openRollPopup(record, constantDate)}>
            Roll
          </Button>
          <Button size="small" onClick={() => handleCloseOrder(record, constantDate)}>
            Close
          </Button>
          <Popconfirm
            title="Delete this trade?"
            okText="Delete"
            cancelText="Cancel"
            onConfirm={() => handleDeleteOrder(record.key)}
          >
            <Button danger size="small" icon={<DeleteOutlined />} aria-label="Delete trade" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const sectionOneColumns = buildTradeGridColumns(currentDateDisplay);
  const simulatedDateSections = normalizedDateSections.length > 0 ? normalizedDateSections : [sectionHeaderDate];

  React.useEffect(() => {
    if (normalizedDateSections.length === 0) {
      const initialSectionDate = TRADING_DATES[0] ?? sectionHeaderDate;
      setDateSections([initialSectionDate]);
      if (!sectionTwoDate) {
        setSectionTwoDate(initialSectionDate);
      }
    }
  }, [normalizedDateSections.length, sectionHeaderDate, sectionTwoDate]);

  const buildGridSummary = (constantDate: string) => {
    const totals = orders.reduce(
      (accumulator, order) => {
        const quantity = Number(order.quantity) || 0;
        const localizedPremium = sectionPremiumsByDate[constantDate]?.[order.key];
        const premium = typeof localizedPremium === "number" && Number.isFinite(localizedPremium)
          ? localizedPremium
          : Number(order.premium) || 0;
        const actionMultiplier = order.action === "Sell" ? -1 : order.action === "Buy" ? 1 : 0;

        accumulator.quantity += quantity;
        accumulator.premium += premium * quantity * actionMultiplier;
        return accumulator;
      },
      { quantity: 0, premium: 0 }
    );

    return (
      <Table.Summary>
        <Table.Summary.Row>
          <Table.Summary.Cell index={0} colSpan={7}>
            Total
          </Table.Summary.Cell>
          <Table.Summary.Cell index={7}>{totals.quantity}</Table.Summary.Cell>
          <Table.Summary.Cell index={8}>{totals.premium.toFixed(2)}</Table.Summary.Cell>
          <Table.Summary.Cell index={9} />
        </Table.Summary.Row>
      </Table.Summary>
    );
  };

  React.useEffect(() => {
    if (!autoApiPricing) return;

    const hasRequiredInputs =
      typeof watchedSymbol === "string" && watchedSymbol.trim().length > 0 &&
      typeof watchedOptionType === "string" &&
      typeof watchedStrike === "number" && Number.isFinite(watchedStrike) && watchedStrike > 0 &&
      watchedExpiry && dayjs(watchedExpiry).isValid() &&
      watchedCurrentDate && dayjs(watchedCurrentDate).isValid();

    if (!hasRequiredInputs) return;

    const timer = window.setTimeout(() => {
      void loadPremiumFromApi(false);
    }, 700);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    autoApiPricing,
    watchedCurrentDate,
    watchedExpiry,
    watchedOptionType,
    watchedStrike,
    watchedSymbol,
  ]);

  return (
    <Card>
      <Modal
        open={rollPopup.open}
        title="Confirm Roll"
        onCancel={closeRollPopup}
        footer={[
          <Button key="cancel" onClick={closeRollPopup}>
            Cancel
          </Button>,
          <Button key="submit" type="primary" onClick={confirmRollFromPopup}>
            Submit
          </Button>,
        ]}
      >
        {(() => {
          const popupCurrentDate =
            rollPopup.targetDate && dayjs(rollPopup.targetDate).isValid()
              ? dayjs(rollPopup.targetDate).format("YYYY-MM-DD")
              : "-";
          const popupExpiryDate =
            rollPopup.order?.expiry && dayjs(rollPopup.order.expiry).isValid()
              ? dayjs(rollPopup.order.expiry).format("YYYY-MM-DD")
              : "-";
          const currentPremium = rollPopup.order ? resolvePremiumForDate(rollPopup.order, rollPopup.targetDate) : 0;
          const nextPremium = rollPopup.rollPremium;
          const premiumDiff = nextPremium - currentPremium;
          const premiumLabel = premiumDiff > 0 ? "Credit" : premiumDiff < 0 ? "Debit" : "Flat";
          return (
            <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
              <Text type="secondary">Current date: {popupCurrentDate}</Text>
              <Text type="secondary">Expiry date: {popupExpiryDate}</Text>
              <Text type="secondary">Current option price: {currentPremium.toFixed(2)}</Text>
              <Text type="secondary">New option price: {rollPremiumLoading ? "Loading..." : nextPremium.toFixed(2)}</Text>
              <Text>
                Difference: {Math.abs(premiumDiff).toFixed(2)} {premiumLabel}
              </Text>
            </Space>
          );
        })()}
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <div>
            <Text>New Expiry Date</Text>
            <DatePicker
              value={rollPopup.rollDate}
              onChange={(value) => {
                if (!value || !value.isValid()) {
                  return;
                }
                setRollPopup((previous) => ({ ...previous, rollDate: value }));
                if (rollPopup.order) {
                  void fetchRollPremiumForPopup(rollPopup.order, value, rollPopup.strike, rollPopup.targetDate);
                }
              }}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <div>
            <Text>Strike Price</Text>
            <InputNumber
              min={0.01}
              step={0.5}
              value={rollPopup.strike}
              onChange={(value) => {
                if (typeof value === "number" && Number.isFinite(value)) {
                  setRollPopup((previous) => ({ ...previous, strike: value }));
                  if (rollPopup.order && rollPopup.rollDate && rollPopup.rollDate.isValid()) {
                    void fetchRollPremiumForPopup(rollPopup.order, rollPopup.rollDate, value, rollPopup.targetDate);
                  }
                }
              }}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <div>
            <Text>Roll Premium</Text>
            <InputNumber
              min={0.01}
              step={0.05}
              value={rollPopup.rollPremium}
              onChange={(value) => {
                if (typeof value === "number" && Number.isFinite(value)) {
                  setRollPopup((previous) => ({ ...previous, rollPremium: value }));
                }
              }}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
        </Space>
      </Modal>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Title level={4} style={{ margin: 0 }}>
          Option Trade Entry
        </Title>
        <Text type="secondary">Add buy, sell, or roll option trades using the form below.</Text>
        <Space size={8}>
          <Button onClick={handleSaveSession}>Save Session</Button>
        </Space>

        <Form<TradeFormValues>
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          onValuesChange={persistDraft}
          initialValues={{
            action: "Buy",
            optionType: "Call",
            quantity: 1,
            currentDate: defaultCurrentDate,
            expiry: defaultExpiryDate,
            longExpiry: defaultLongExpiryDate,
          }}
        >
          <Space wrap size={12} align="start">
            <Form.Item label="Action" name="action" rules={[{ required: true }]}> 
              <Select
                style={{ width: 120 }}
                options={[
                  { label: "Buy", value: "Buy" },
                  { label: "Sell", value: "Sell" },
                  { label: "Roll", value: "Roll" },
                ]}
              />
            </Form.Item>

            <Form.Item label="Symbol" name="symbol" rules={[{ required: true, message: "Enter symbol" }]}> 
              <Input placeholder="SPY" style={{ width: 120 }} />
            </Form.Item>

            <Form.Item label="Current Date" name="currentDate" rules={[{ required: true, message: "Select current date" }]}> 
              <DatePicker style={{ width: 150 }} />
            </Form.Item>

            <Form.Item label="Option Type" name="optionType" rules={[{ required: true }]}> 
              <Select
                style={{ width: 120 }}
                options={[
                  { label: "Call", value: "Call" },
                  { label: "Put", value: "Put" },
                ]}
              />
            </Form.Item>

            <Form.Item label="Strike" name="strike" rules={[{ required: true, message: "Enter strike" }]}> 
              <Space direction="vertical" size={6}>
                <Space size={6}>
                  {[0, 1, 5, 10].map((value) => (
                    <Button
                      key={value}
                      size="small"
                      type={strikeStep === value ? "primary" : "default"}
                      onClick={() => {
                        setStrikeStep(value);
                        void adjustStrike(activeAdjustControl, value);
                      }}
                    >
                      {value === 0 ? "Base" : `${value}%`}
                    </Button>
                  ))}
                </Space>
                <Space size={8}>
                  <InputNumber
                    min={0.01}
                    step={0.5}
                    style={{ width: 120 }}
                    value={watchedStrike}
                    onChange={(value) => {
                      if (typeof value === "number" && Number.isFinite(value)) {
                        setStrikeAndPersist(value);
                      }
                    }}
                  />
                  <Button onClick={handleLoadDayClose}>Get Day Close</Button>
                </Space>
                <Space size={8}>
                  <Button
                    type={activeAdjustControl === "up" ? "primary" : "default"}
                    onClick={() => {
                      void adjustStrike("up");
                    }}
                  >
                    +
                  </Button>
                  <Button
                    type={activeAdjustControl === "down" ? "primary" : "default"}
                    onClick={() => {
                      void adjustStrike("down");
                    }}
                  >
                    _
                  </Button>
                </Space>
                {dayClosePrice !== null && (
                  <Text type="secondary">Local close: {dayClosePrice}</Text>
                )}
              </Space>
            </Form.Item>

            <Form.Item label="Expiry" name="expiry" rules={[{ required: true, message: "Select expiry" }]}> 
              <DatePicker style={{ width: 150 }} />
            </Form.Item>

            <Form.Item label="Long Expiry" name="longExpiry">
              <DatePicker style={{ width: 150 }} />
            </Form.Item>

            <Form.Item label="Qty" name="quantity" rules={[{ required: true }]}> 
              <InputNumber min={1} precision={0} style={{ width: 100 }} />
            </Form.Item>

            <Form.Item label="Premium" required>
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Space size={8}>
                <Text strong style={{ fontSize: 16 }}>
                  {typeof watchedPremium === "number" && Number.isFinite(watchedPremium) ? watchedPremium.toFixed(2) : "-"}
                </Text>
                <Space size={6}>
                  <Text type="secondary">Auto API</Text>
                  <Switch checked={autoApiPricing} onChange={setAutoApiPricing} />
                </Space>
                <Button onClick={handleLoadPremiumFromApi} loading={premiumLoading}>
                  Get Premium (Massive)
                </Button>
                </Space>

                {probableLoading && (
                  <Text type="secondary">Finding closest option prices...</Text>
                )}

                {probableOptions.length > 0 && (
                  <Space wrap size={8}>
                    {probableOptions.map((candidate) => (
                      <Button
                        key={`${candidate.strike}-${candidate.premium}`}
                        onClick={() => handleSelectProbableOption(candidate)}
                      >
                        {`Strike ${candidate.strike} â€¢ Premium ${candidate.premium} (${candidate.source})`}
                      </Button>
                    ))}
                  </Space>
                )}
              </Space>
            </Form.Item>

            <Form.Item name="premium" rules={[{ required: true, message: "Get premium first" }]} hidden>
              <InputNumber min={0} step={0.01} />
            </Form.Item>

            <Form.Item label=" ">
              <Button type="primary" htmlType="submit">
                Add Trade
              </Button>
            </Form.Item>
          </Space>
        </Form>

        <Card size="small" title={`Section 1: ${currentDateDisplay}`}>
          <Text strong>Current Date: {currentDateDisplay}</Text>
          <Table<TradeOrder>
            key={`trade-grid-${currentDateDisplay}`}
            rowKey="key"
            size="small"
            pagination={{ pageSize: 6 }}
            dataSource={orders}
            columns={sectionOneColumns}
            summary={() => buildGridSummary(currentDateDisplay)}
            locale={{ emptyText: "No trades added yet" }}
          />
        </Card>

        <Card
          size="small"
          title={`Date: ${sectionHeaderDate}`}
          extra={(
            <Button type="primary" onClick={() => void handleUpdateOrderPricesForDate(sectionHeaderDate)} loading={updatingPrices}>
              Get Updated Prices
            </Button>
          )}
        >
          {/* <Text strong>Next Trading Date: {nextTradingDate}</Text> */}
          <Table<TradeOrder>
            key={`date-grid-${sectionHeaderDate}`}
            rowKey="key"
            size="small"
            pagination={{ pageSize: 6 }}
            dataSource={orders}
            columns={buildTradeGridColumns(sectionHeaderDate)}
            summary={() => buildGridSummary(sectionHeaderDate)}
            locale={{ emptyText: "No trades added yet" }}
          />
        </Card>

        {simulatedDateSections.slice(1).map((date) => (
          <Card
            key={`simulated-${date}`}
            size="small"
            title={`Date: ${date}`}
            extra={(
              <Button type="primary" onClick={() => void handleUpdateOrderPricesForDate(date)} loading={updatingPrices}>
                Get Updated Prices
              </Button>
            )}
          >
            <Table<TradeOrder>
              key={`date-grid-${date}`}
              rowKey="key"
              size="small"
              pagination={{ pageSize: 6 }}
              dataSource={orders}
              columns={buildTradeGridColumns(date)}
              summary={() => buildGridSummary(date)}
              locale={{ emptyText: "No trades added yet" }}
            />
          </Card>
        ))}

        <Space style={{ width: "100%", justifyContent: "flex-end" }}>
          <Button type="primary" onClick={() => void handleSimulateNextDate()}>
            Simulate Next Date
          </Button>
        </Space>
      </Space>
    </Card>
  );
};

export default TradeLinks;























