const SPREADSHEET_ID = "1aAN8mmMhXhlG7jmqO62DvEothIz2ELW4JWpLSRMbX7Y";
const RESULTS_SHEET_NAME = "Simulation Results";
const RESULT_COLUMNS = [
  ["Start Date", "actualStartDate"],
  ["Short Expiry Date", "shortExpiryDate"],
  ["Long Expiry Date", "longExpiryDate"],
  ["Short Strike Price", "shortStrike"],
  ["Long Strike Price", "longStrike"],
  ["End Date", "endDate"],
  ["Stock Start Price", "stockStartPrice"],
  ["Stock End Price", "stockEndPrice"],
  ["Option Investment", "optionInvestment"],
  ["Stock Return ($)", "stockReturn"],
  ["Stock Return (%)", "stockReturnPct"],
  ["Option Strategy Return ($)", "optionStrategyReturn"],
  ["Option Strategy Return (%)", "optionStrategyReturnPct"],
  ["Recorded At", "recordedAt"],
  ["Strategy", "strategy"],
  ["Ticker", "ticker"],
  ["Requested Start Date", "requestedStartDate"],
  ["Sell Expiry Date", "sellExpiryDate"],
  ["Sell Strike Price", "sellStrike"],
  ["5% Lower Strike", "fivePercentStrike"],
  ["Auto Roll", "autoRoll"],
  ["Processed Days", "processedDays"],
  ["Stop Reason", "stopReason"],
  ["Source URL", "sourceUrl"],
  ["Input Params", "inputParams"],
  ["Grid Data", "gridData"],
  ["Result Summary", "resultSummary"],
];

function doGet(event) {
  const action = event && event.parameter ? event.parameter.action : null;
  if (action === "list") {
    return jsonResponse(listResults());
  }
  return jsonResponse({ ok: true, sheet: RESULTS_SHEET_NAME });
}

function listResults() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(RESULTS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, results: [] };
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();

  const keyByHeader = {};
  RESULT_COLUMNS.forEach(([header, key]) => {
    keyByHeader[header] = key;
  });
  const jsonKeys = new Set(["inputParams", "gridData", "resultSummary"]);

  const results = rows.map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      const key = keyByHeader[header] || header;
      const value = row[index];
      if (jsonKeys.has(key) && typeof value === "string" && value) {
        try {
          record[key] = JSON.parse(value);
        } catch (error) {
          record[key] = value;
        }
      } else {
        record[key] = value;
      }
    });
    return record;
  });

  return { ok: true, results };
}

function doPost(event) {
  try {
    const result = JSON.parse(event.postData.contents);
    validateResult(result);

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);

    try {
      const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
      let sheet = spreadsheet.getSheetByName(RESULTS_SHEET_NAME);
      if (!sheet) {
        sheet = spreadsheet.insertSheet(RESULTS_SHEET_NAME);
      }

      ensureResultSheetLayout(sheet);

      sheet.appendRow(
        RESULT_COLUMNS.map(([, key]) => toCellValue(result[key]))
      );
    } finally {
      lock.releaseLock();
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error) });
  }
}

function validateResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("A JSON result object is required");
  }
  if (!result.recordedAt || !result.strategy || !result.ticker) {
    throw new Error("recordedAt, strategy, and ticker are required");
  }
}

function toCellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function ensureResultSheetLayout(sheet) {
  const desiredHeaders = RESULT_COLUMNS.map(([header]) => header);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, desiredHeaders.length).setValues([desiredHeaders]);
    sheet.setFrozenRows(1);
    return;
  }

  const existingColumnCount = sheet.getLastColumn();
  const existingHeaders = sheet
    .getRange(1, 1, 1, existingColumnCount)
    .getValues()[0];
  const layoutMatches = desiredHeaders.every(
    (header, index) => existingHeaders[index] === header
  );

  if (!layoutMatches) {
    const dataRowCount = Math.max(sheet.getLastRow() - 1, 0);
    const existingRows = dataRowCount > 0
      ? sheet.getRange(2, 1, dataRowCount, existingColumnCount).getValues()
      : [];
    const sourceIndexes = RESULT_COLUMNS.map(([header, key]) => {
      const displayIndex = existingHeaders.indexOf(header);
      return displayIndex >= 0 ? displayIndex : existingHeaders.indexOf(key);
    });
    const reorderedRows = existingRows.map((row) =>
      sourceIndexes.map((sourceIndex) =>
        sourceIndex >= 0 ? row[sourceIndex] : ""
      )
    );

    sheet.clearContents();
    sheet.getRange(1, 1, 1, desiredHeaders.length).setValues([desiredHeaders]);
    if (reorderedRows.length > 0) {
      sheet
        .getRange(2, 1, reorderedRows.length, desiredHeaders.length)
        .setValues(reorderedRows);
    }
  }

  sheet.setFrozenRows(1);
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}