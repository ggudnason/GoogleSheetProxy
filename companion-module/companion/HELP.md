## Google Sheet Proxy

Controls [Google Sheet Proxy](https://github.com/ggudnason/GoogleSheetProxy), which serves Google Sheets as JSON data sources for vMix. From Companion you can turn automatic refresh from Google on and off, change how often it refreshes, fetch new data now, and see on your buttons whether refresh is running or has errors.

### Setup

- **Proxy address** and **Port**: the computer running the proxy and the port of its web interface (3000 unless you changed it).
- **Admin password**: only when the proxy was started with `ADMIN_PASSWORD`.
- **Status update every (ms)**: how often Companion asks the proxy for its status. It does not change how often the proxy asks Google.

The module reads your spreadsheets from the proxy. When you add, rename or remove a spreadsheet in the proxy, the actions, variables and presets follow automatically.

### Presets

There is a section for **All spreadsheets** and one for each spreadsheet.

- **Toggle auto refresh**: press to turn auto refresh on or off. The button shows the status and is colored by it.
- **Auto refresh on / off**: separate buttons, lit when that state is active.
- **Interval −5s / +5s**, **Show interval**, and **Every 5s, 10s, 30s, 1m**: change how often the proxy asks Google. The fixed interval buttons light up when active.
- **Status and last update**: status and how long ago the data last changed. Press to check Google now.
- **Errors**: failed tries in a row and when the next try is. Turns red while Google is failing. Press to clear the errors.
- **Fetch latest now**: read every sheet from Google straight away, also when auto refresh is off.

### Status colors

| Color | Status | Meaning |
|---|---|---|
| Green | Live | Auto refresh is on and working |
| Grey | Paused | Auto refresh is off. The proxy keeps serving the data it has |
| Yellow | Starting | Waiting for the first answer from Google |
| Orange | Error, old data | Google is failing, but older data is still served |
| Red | Error | Google is failing and there is no data |
| Dark red | Proxy offline | Companion can't reach the proxy |

**All spreadsheets** shows the worst status of the spreadsheets that have auto refresh on, and Paused only when all are paused.

### Actions

- **Auto refresh: on, off or toggle**: for one spreadsheet or all. Toggle for all turns them all off if any is on, otherwise all on.
- **Refresh interval: set**: seconds between refreshes, 1 to 86400.
- **Refresh interval: increase or decrease**: add seconds, or subtract with a negative number. Stays within 1 to 86400.
- **Fetch latest data now**, **Check connection to Google**, **Clear errors**.

### Feedbacks

- **Status color**: colors the button by status (see the table above).
- **Auto refresh is on**, **Has errors**, **Status is…**, **Refresh interval is…**, **Proxy is reachable**.

### Variables

For the whole proxy: `connected`, `status`, `sheet_count`, `live_count`, `error_count`, `last_error`.

For each spreadsheet, named after its URL name (for example `news` from `/sheet/news`; dashes become underscores):

| Variable | Example |
|---|---|
| `news_name` | Evening News |
| `news_refresh` | On |
| `news_status` | Live |
| `news_interval` | 30 |
| `news_interval_text` | 30s |
| `news_updated` | 12s ago |
| `news_updated_time` | 14:05:32 |
| `news_failures` | 0 |
| `news_errors_10min` | 0 |
| `news_error` | The last error from Google, while failing |
| `news_next_retry` | in 12s |
