# Google Sheets simulation results API

`Code.gs` is deployed as a Google Apps Script web app bound to the route-parameter workbook.
It accepts JSON simulation summaries through `POST` and appends them to the `Simulation Results`
sheet, creating that sheet and its header row when necessary.

`GET ?action=list` returns `{ ok: true, results: [...] }` with every row from the sheet, parsing
the `inputParams`, `gridData`, and `resultSummary` JSON columns back into objects. The React
client's "Simulation Results" tab uses this endpoint to render the recorded runs in a table.

The React client uses the deployed URL in `src/api/simulationResults.ts`. Override it for another
spreadsheet or deployment with:

```text
VITE_GOOGLE_SHEETS_WEB_APP_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
```

Only simulations initiated by the `run=true` route parameter are published. Manual runs and reruns
caused by roll actions are not sent.

After changing `Code.gs`, create a new Apps Script deployment version. Configure the web app to
execute as the spreadsheet owner and allow access to `Anyone` so the static frontend can post.