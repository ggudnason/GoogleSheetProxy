# Google Sheet Proxy for vMix

Connect one or more Google Sheets and serve every tab as its own JSON endpoint, in the shape vMix Data Sources expects: an array of row objects, with the tab's first row used as column names. You add and manage sheets in a web interface.

No dependencies. You need Node.js 18 or newer.

## Setup

1. **Get an API key** for each sheet. Several sheets can share the same key.
   - In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
   - Go to *APIs & Services → Library*, find **Google Sheets API** and enable it.
   - Go to *APIs & Services → Credentials → Create credentials → API key*. You can restrict the key to the Google Sheets API.
2. **Share each sheet** as **"Anyone with the link → Viewer"**. An API key can only read sheets shared that way.
3. **Start the proxy:**
   ```bash
   npm start
   ```
4. **Open http://localhost:3000** and click **+ Add sheet** for each spreadsheet. Enter its URL and the API key to use for it.

Sheets and their settings, including API keys, are saved in `config.json`. Keep that file private. Optionally, copy `.env.example` to `.env` to change the port or set an interface password.

## The interface

- **Sheets:** add, edit or remove spreadsheets. Each sheet has:
  - a name
  - the spreadsheet URL or ID
  - a *URL name* (slug) used in its JSON URLs
  - its own Google API key. The key is required when you add a sheet and is shown masked once saved. When editing, leave the key field blank to keep the saved key.
  - a **cache time** in seconds (5 by default): how often the proxy re-reads the sheet from Google
  - an **Auto refresh** switch
- Each sheet card has an **Auto refresh** switch, so you can pause and resume without opening the edit dialog:
  - **Live:** the proxy re-reads the sheet from Google every cache period in the background, whether or not vMix is asking.
  - **Paused:** vMix keeps receiving the last fetched data, and Google is not called. Use this to lock graphics while someone edits the sheet. **Fetch latest once** updates the held data a single time without turning live refresh back on.
  - If the proxy restarts while a sheet is paused, it fetches once on the first request and then holds that data.
- For each sheet, every tab is listed with its JSON URL, a **Copy** button and a **Preview** that shows exactly what vMix will see.
- With more than one sheet, the cards start collapsed to one line each, showing the sheet's name, status and Live/Paused. Every card header also shows a status dot and how long ago the data vMix gets was last updated, counting up every second:
  - The dot is green when polling is working, amber when Google is failing and vMix gets the last good data, red when there's no data at all, and dimmed when the sheet is paused. It pulses each time new data arrives from Google.
  - While Google is failing, the header also shows when the next retry is. The age turns amber when updates have stopped coming through for more than a few poll periods.
  - Click a card's header to open or close it, or use **Expand all** / **Collapse all**. The page remembers which cards you opened, separately in each browser.
- The page updates itself every 3 seconds, so you see problems as they happen. This doesn't use any Google requests.
- At the top, the page estimates how many Google requests per minute all live sheets use, and warns when that's close to Google's limit.

## When Google has problems

The proxy is built so that a Google problem never blanks your graphics or stops updates for good:

- **vMix never waits on Google.** Every request is answered from the proxy's cache straight away. While Google is failing, vMix keeps getting the last good data.
- **Polling never stops.** If a read fails, the proxy waits a moment and tries again: 2 seconds, then 4, 8, 16, and then every 30 seconds until it works. Once Google answers, normal polling resumes and the new data is picked up automatically.
- **The sheet card shows what's wrong**, in plain words, while it happens:
  - A yellow notice means Google isn't answering but vMix still has data. It says what's wrong, how old the data vMix is getting is, and when the next try is.
  - A red notice means there's no data yet for vMix (for example a new sheet with a wrong API key). vMix gets an error for that sheet until it works.
  - After recovery, a smaller note shows how many errors there were in the last 10 minutes.
- **Messages you may see:** Google not responding within 10 seconds, no internet connection, the connection being cut off, Google's request limit being reached, an invalid API key, access being refused (sheet not shared or Sheets API not enabled), the spreadsheet not being found, or a temporary Google server problem. When Google gave its own explanation, it's shown underneath.
- **Cache time suggestions:** if Google fails 3 or more times in 10 minutes, the card suggests a longer cache time with a one-click **Use Ns** button. A longer cache time means fewer requests, which is the fix for "request limit reached" errors and makes the proxy ask less often during unreliable connections. Suggestions only count errors since the cache time was last changed. No suggestion is shown for errors a cache time can't fix, such as a wrong API key.
- **Check** tries Google right away instead of waiting for the next retry. On a paused sheet it only re-reads the tab list, so the held data stays as it is.
- **Fetch latest once** keeps the previous data if Google fails, and tells you why.

## Using it in vMix

In vMix, go to **Settings → Data Sources**. Click **Add → JSON**, paste a tab URL such as `http://localhost:3000/sheet/results/Scores`, and set the auto-refresh interval.

To get everything from one data source instead, use `http://localhost:3000/all` (every tab of every sheet) or `http://localhost:3000/all/<sheet>` (every tab of one sheet). vMix only accepts a single array of rows, so these return every row in one table. Extra columns show where each row came from:
- `Tab`: the tab name
- `Row`: the row's number within its tab, the same number `/sheet/<sheet>/<tab>/<n>` uses
- `Sheet`: the sheet's URL name (only on `/all`)

For graphics that should always show one tab's rows, the per-tab URLs are simpler.

If vMix runs on another machine, replace `localhost` with the proxy machine's IP address.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /sheet/<sheet>/<tab>` | All rows as `[{ "Header": "value", ... }]` |
| `GET /sheet/<sheet>/<tab>/<n>` | Only data row *n* (1 = first row under the header), still wrapped in an array |
| `GET /all` | Every row of every sheet in one array, with `Sheet`, `Tab` and `Row` columns |
| `GET /all/<sheet>` | Every row of one sheet in one array, with `Tab` and `Row` columns |
| `GET /sheet/<sheet>` | The spreadsheet title and its tabs |
| `GET /sheets` | The configured sheets |
| `GET /tab/<tab>` | Shortcut to the first configured sheet. This keeps URLs from the single-sheet version working. |
| `GET /health` | `{ "ok": true }` |

- `<sheet>` is the sheet's URL name.
- `<tab>` is the tab name, URL-encoded (for example `Lower%20Thirds`). The match is case-insensitive, and you can also use the tab's 0-based position (`/sheet/results/0`).

The combined array has every column from every tab. A row gets an empty value for any column its tab doesn't have. If a sheet has its own column named `Sheet`, `Tab` or `Row`, that column is renamed with a `_2` suffix.

Add `?format=object` to get the grouped shape instead: `{ "<sheet>": { "<tab>": [rows] } }` on `/all`, or `{ "<tab>": [rows] }` on `/all/<sheet>`. This is useful for other tools, but vMix can't read it.

On `/all`, a sheet that fails to load (wrong key, missing spreadsheet) is left out, and the other sheets still come through. With `?format=object`, the reason is listed under `_errors`.

The `/all` endpoints fetch every tab of a sheet in a single Google API call, and they follow each sheet's cache time and Auto refresh setting. They share the per-tab cache, so `/all` and the single-tab URLs always serve the same data.

### Column names

vMix reads JSON through XML internally. Column names containing spaces, `#`, `/`, `|`, brackets, line breaks and similar characters are renamed by vMix to `a:item`, and all but the first such column are dropped. To avoid that, the proxy converts every column name to letters, digits and `_`:

| In the sheet | In the JSON |
|---|---|
| `Start Time` | `Start_Time` |
| `SESSION #` | `SESSION_Number` |
| `DURATION` + line break + `hh:mm:ss` | `DURATION_hh_mm_ss` |
| `DATA \| Countdown` | `DATA_Countdown` |
| `Q&A`, `Fjöldi %` | `Q_and_A`, `Fjoldi_Percent` |
| `Nafn ræðumanns` | `Nafn_raedumanns` |
| `2nd Speaker` | `_2nd_Speaker` (names can't start with a digit) |

vMix also treats `Name` and `NAME` as the same column, so names are made unique ignoring case. In `/all`, columns from different tabs that differ only in case (for example `Date` and `DATE`) are merged into one.

The Preview shows the names vMix sees, with the sheet's own name underneath when it differs. Add `?keys=original` to any URL to get the sheet's names unchanged (for tools other than vMix).

### Query options for tab URLs

| Option | Effect |
|---|---|
| `?range=A1:D20` | Read only this range. The first row of the range is used as the header. |
| `?row=3` | Same as `/sheet/<sheet>/<tab>/3` |
| `?limit=10` | Return only the first N rows |
| `?raw` | Return the raw 2D array of cells, with no header mapping |
| `?render=unformatted` | Return raw numbers instead of the sheet's display formatting. `formula` returns the formulas. |
| `?empty=1` | Keep blank rows. By default they are skipped. |
| `?keys=original` | Use the sheet's column names exactly as written, instead of vMix-safe names |

`/all` and `/all/<sheet>` accept `limit` (applied to each tab), `render`, `empty`, `keys` and `format=object`. `raw` implies `format=object`.

## Notes

- **Security:** the interface and the `/api/*` endpoints can change settings. Set `ADMIN_PASSWORD` in `.env` to put them behind a browser login. The JSON data URLs stay open so vMix can read them. API keys are never sent back to the browser in full.
- **Google requests:** each live sheet uses one Google request per cache period to read all its tabs, plus one a minute to re-read its tab list. This doesn't depend on how many vMix inputs are polling. Google allows 300 read requests per minute per Google Cloud project, shared by every sheet whose API key belongs to that project. A request with `?range=` or `?render=` is read separately on demand, using the same cache time.
- **Header row:** blank headers become column letters (`A`, `B`, …). Duplicate headers get a suffix (`Name`, `Name_2`). Every row has every key, so vMix columns stay consistent.
