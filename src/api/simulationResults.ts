export interface PutCalendarSimulationResult {
  recordedAt: string;
  strategy: "Put Calendar Spread Roll" | "3 Tier";
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