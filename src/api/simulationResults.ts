export interface PutCalendarSimulationResult {
  recordedAt: string;
  strategy: "Put Calendar Spread Roll" | "3 Tier" | "Call Calendar Spread Roll" | "Strangle Calendar";
  ticker: string;
  requestedStartDate: string;
  actualStartDate: string;
  endDate: string;
  shortExpiryDate: string;
  sellExpiryDate: string | null;
  longExpiryDate: string;
  shortStrike: number;
  sellStrike: number | null;
  longStrike: number;
  fivePercentStrike: boolean;
  autoRoll: boolean;
  processedDays: number;
  stockStartPrice: number;
  stockEndPrice: number | null;
  stockReturn: number | null;
  stockReturnPct: number | null;
  optionInvestment: number | null;
  optionStrategyReturn: number;
  optionStrategyReturnPct: number | null;
  stopReason: string | null;
  sourceUrl: string;
  inputParams: Record<string, string>;
  gridData: {
    rows: Array<Record<string, string | number | null>>;
  };
  resultSummary: {
    startDate: string;
    endDate: string;
    stockStartPrice: number;
    stockEndPrice: number | null;
    optionInvestment: number | null;
    stockReturn: number | null;
    stockReturnPct: number | null;
    optionStrategyReturn: number;
    optionStrategyReturnPct: number | null;
  };
}

const DEFAULT_RESULTS_API_URL =
  "https://script.google.com/macros/s/AKfycbwLhXXwSGfmOkxcE8uk5pdxuwvZ28_vTbHqjI8jxxDRamJ-wjjJ3dSCeCWcKzWZbJoy/exec";
const RESULTS_API_URL =
  import.meta.env.VITE_GOOGLE_SHEETS_WEB_APP_URL?.trim() || DEFAULT_RESULTS_API_URL;

export const isSimulationResultsApiConfigured = (): boolean => Boolean(RESULTS_API_URL);

export async function appendPutCalendarSimulationResult(
  result: PutCalendarSimulationResult
): Promise<void> {
  if (!RESULTS_API_URL) {
    throw new Error("VITE_GOOGLE_SHEETS_WEB_APP_URL is not configured");
  }

  await fetch(RESULTS_API_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(result),
  });
}

export async function fetchPutCalendarSimulationResults(): Promise<
  PutCalendarSimulationResult[]
> {
  if (!RESULTS_API_URL) {
    throw new Error("VITE_GOOGLE_SHEETS_WEB_APP_URL is not configured");
  }

  const response = await fetch(`${RESULTS_API_URL}?action=list`);
  if (!response.ok) {
    throw new Error(`Failed to fetch simulation results (status ${response.status})`);
  }

  const payload = await response.json();
  if (!payload || payload.ok !== true || !Array.isArray(payload.results)) {
    if (payload && payload.ok === true && !("results" in payload)) {
      throw new Error(
        "The deployed Apps Script web app is missing the \"action=list\" handler. Redeploy Code.gs as a new version."
      );
    }
    throw new Error(payload?.error || "Unexpected response from simulation results API");
  }

  return payload.results as PutCalendarSimulationResult[];
}

export interface PutCalendarSimulationInput {
  strategy: PutCalendarSimulationResult["strategy"];
  ticker: string;
  requestedStartDate: string;
  shortExpiryDate: string;
  sellExpiryDate: string | null;
  longExpiryDate: string;
  shortStrike: number;
  sellStrike: number | null;
  longStrike: number;
}

const normalizeDate = (value: string | null | undefined): string =>
  value ? value.slice(0, 10) : "";

const sameNullableNumber = (left: number | null, right: number | null): boolean =>
  left === right || (left === null && right === null);

export async function findExistingPutCalendarSimulation(
  input: PutCalendarSimulationInput
): Promise<PutCalendarSimulationResult | null> {
  const results = await fetchPutCalendarSimulationResults();
  const normalizedTicker = input.ticker.trim().toUpperCase();

  return results.find((result) =>
    result.strategy === input.strategy &&
    result.ticker.trim().toUpperCase() === normalizedTicker &&
    normalizeDate(result.requestedStartDate) === normalizeDate(input.requestedStartDate) &&
    normalizeDate(result.shortExpiryDate) === normalizeDate(input.shortExpiryDate) &&
    normalizeDate(result.longExpiryDate) === normalizeDate(input.longExpiryDate) &&
    result.shortStrike === input.shortStrike &&
    result.longStrike === input.longStrike &&
    normalizeDate(result.sellExpiryDate) === normalizeDate(input.sellExpiryDate) &&
    sameNullableNumber(result.sellStrike, input.sellStrike)
  ) ?? null;
}

export const appendCallCalendarSimulationResult = appendPutCalendarSimulationResult;