# Put Calendar Spread (Roll) User Guide

This guide explains all user inputs and prompts available in the `PutCalendarSpreadRoll` component, and how to use them end-to-end.

## 1) What this screen does

The screen simulates a put calendar spread strategy with optional rolling:
- Buys a longer-dated put and sells a shorter-dated put at the same strike.
- Tracks option prices, theta/day, and cumulative strategy P&L by trading date.
- Supports manual roll and assisted auto-roll candidate selection.

## 2) Main inputs and prompts

These controls appear at the top of the screen inside **Put Calendar Spread (Roll)**.

### Start Date
- Label: `Start Date`
- Type: Date picker
- Purpose: First date used to begin simulation (aligned to first available trading date on/after this date).
- Required: Yes

### Short Expiry Date (optional)
- Label: `Short Expiry Date (optional)`
- Type: Date picker
- Placeholder prompt: `Auto 15-75 DTE`
- Purpose: Preferred short put expiry date.
- If left blank: Component auto-selects a short expiry in 15-75 DTE window with available put data.

### Long Expiry Date (optional)
- Label: `Long Expiry Date (optional)`
- Type: Date picker
- Placeholder prompt: `Auto 150-400 DTE`
- Purpose: Preferred long put expiry date.
- If left blank: Component auto-selects a long expiry in 150-400 DTE window with available put data.

### Stock ticker
- Label: `Stock ticker`
- Type: Text input
- Placeholder prompt: `SPY`
- Default value in component: `MSFT`
- Purpose: Underlying symbol used for stock and options data.

### Run button
- Label: `Run Put Calendar Spread`
- Action: Clears manual roll schedule and runs a fresh simulation.

### Auto-roll mode toggle
- Label format: `Auto Roll Weekly: ON/OFF`
- Purpose: Enables weekly auto-roll logic during simulation.
- OFF: Simulation generally follows initial short expiry and manual rolls.
- ON: Simulation can keep extending via auto-roll logic when conditions are met.

### View toggles
- `Hide/Show Summary`
- `Hide/Show Chart`
- `Hide/Show Grid`
- Purpose: Show or hide major output sections.

### Runtime status prompts
- `Processed simulations: <count>`
- `Auto-saved checkpoint: <date> | Short Put <value> | Long Put <value>`
- Purpose: Progress and latest saved option snapshot for the current run.

## 3) Outputs and how to read them

## Summary card
Shows:
- Start Date / End Date
- Stock Start Price / Stock End Price
- Option Investment
- Stock Return (amount and %)
- Option Strategy Return (amount and %)

Color convention:
- Green = positive
- Red = negative

## Option Price Chart
Line chart by date:
- `Short Put Price` (red)
- `Long Put Price` (blue)

## Records grid
Key columns:
- `Closing Price | Short Expiry | Strike | DTE`
- `Put Price (Short | Long)`
- `Theta/Day (Short | Long)` with net theta in parentheses
- `Cumulative P&L (Roll Credit/Debit)`
- `Action`

Row action buttons:
- `Roll` (manual roll modal)
- `Auto Roll 1W` (popover with probable candidates)

## 4) Manual roll flow

1. In a row, click `Roll`.
2. In **Roll Short Put** modal, review:
- `Current Row Date`
- `New Short Expiry` date picker
- `New Strike` input (step 5)
3. Optional strike quick actions:
- `ATM`
- `-1%`
- `-5%`
- `-10%`
4. Review **Roll Preview**:
- `Current Short Put Premium`
- `New Short Put Premium`
- `Net Roll (Credit/Debit)`
5. Click `Confirm Roll`.

Result:
- Roll is scheduled for the next trading date after the selected row.
- Simulation reruns with updated roll plan.

## 5) Auto-roll candidate flow (row-level)

1. In a row, click `Auto Roll 1W`.
2. Popover opens with **Auto Roll Candidates** table.
3. Candidate columns:
- `New Short Expiry`
- `New DTE`
- `Strike`
- `New Premium`
- `Net Credit/Debit`
- `Action` (`Apply`)
4. Click `Apply` to schedule selected candidate on next trading day and rerun simulation.

Notes:
- Candidate list favors net credit/debit in range -10 to +10 when available.
- If no candidates fit range, component shows closest available options.
- Apply button is disabled if candidate credit is below minimum target.

## 6) Put leg detail and rolling ideas

From `Put Price (Short | Long)`, click either price to open **Put Leg Details** modal.

Shown fields:
- Trade Date
- Expiry Date
- Strike
- Premium
- Status

Also shows **Rolling Options** table with probable alternatives:
- New Short Expiry
- Strike
- New Premium
- Net Credit/Debit

## 7) Validation and error prompts you may see

Common validation messages:
- `Stock ticker is required`
- `Start date is invalid`
- `Short expiry date is invalid`
- `Long expiry date is invalid`
- `No trading date found on or after the start date`
- `No stock close price found for <symbol> on <date>`
- `Long expiry date must be after the latest short expiry date`
- `No trading dates found between <start> and <end>`
- `Please choose a valid short expiry date`
- `Please choose a valid strike price`
- `No next trading date available for this roll`

Rate limit prompt:
- `Rate limit hit (429). Waiting 2 seconds before retry <n>.`

Auto-roll stop warnings:
- No next trading date available.
- No target meeting minimum auto-roll credit.
- Simulation reached short expiry stop point.

## 8) Practical usage pattern

1. Set `Start Date`, ticker, and optional expiries.
2. Click `Run Put Calendar Spread`.
3. Review Summary, chart, and records.
4. Use `Roll` for precise manual adjustments.
5. Use `Auto Roll 1W` for assisted candidate-based rolling.
6. Toggle `Auto Roll Weekly: ON` if you want continuous rolling behavior.
7. Re-run and compare cumulative P&L changes.

## 9) Important simulation limits and defaults

- Trading dates come from bundled trading date datasets.
- Max simulation rows per run: 50 trading days.
- Strike rounding: nearest 5.
- Manual roll scheduling applies on the next trading date after selected row.
- Auto-roll minimum credit target in logic: 0.20.

## 10) Quick troubleshooting

- If all option values show `-`: chosen date/expiry/strike may not have data; try nearby dates.
- If simulation ends earlier than expected: check short expiry and auto-roll eligibility conditions.
- If frequent rate limit warnings appear: rerun after brief pause or reduce repeated rapid runs.
