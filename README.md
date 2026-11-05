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
  - a **cache time** in seconds (5 by default): how long the proxy reuses Google's answer before asking again
  - an **Auto refresh** switch
- Each sheet card has an **Auto refresh** switch, so you can pause and resume without opening the edit dialog:
  - **Live:** data is re-read from Google whenever the cache time has passed.
  - **Paused:** vMix keeps receiving the last fetched data, and Google is not called. Use this to lock graphics while someone edits the sheet. **Fetch latest once** updates the held data a single time without turning live refresh back on.
  - If the proxy restarts while a sheet is paused, it fetches once on the first request and then holds that data.
- For each sheet, every tab is listed with its JSON URL, a **Copy** button and a **Preview** that shows exactly what vMix will see.

## Using it in vMix

In vMix, go to **Settings → Data Sources**. Click **Add → JSON**, paste a tab URL such as `http://localhost:3000/sheet/results/Scores`, and set the auto-refresh interval.

If vMix runs on another machine, replace `localhost` with the proxy machine's IP address.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /sheet/<sheet>/<tab>` | All rows as `[{ "Header": "value", ... }]` |
| `GET /sheet/<sheet>/<tab>/<n>` | Only data row *n* (1 = first row under the header), still wrapped in an array |
| `GET /sheet/<sheet>` | The spreadsheet title and its tabs |
| `GET /sheets` | The configured sheets |
| `GET /tab/<tab>` | Shortcut to the first configured sheet. This keeps URLs from the single-sheet version working. |
| `GET /health` | `{ "ok": true }` |

- `<sheet>` is the sheet's URL name.
- `<tab>` is the tab name, URL-encoded (for example `Lower%20Thirds`). The match is case-insensitive, and you can also use the tab's 0-based position (`/sheet/results/0`).

### Query options for tab URLs

| Option | Effect |
|---|---|
| `?range=A1:D20` | Read only this range. The first row of the range is used as the header. |
| `?row=3` | Same as `/sheet/<sheet>/<tab>/3` |
| `?limit=10` | Return only the first N rows |
| `?raw` | Return the raw 2D array of cells, with no header mapping |
| `?render=unformatted` | Return raw numbers instead of the sheet's display formatting. `formula` returns the formulas. |
| `?empty=1` | Keep blank rows. By default they are skipped. |

## Notes

- **Security:** the interface and the `/api/*` endpoints can change settings. Set `ADMIN_PASSWORD` in `.env` to put them behind a browser login. The JSON data URLs stay open so vMix can read them. API keys are never sent back to the browser in full.
- **Caching:** Google responses are cached per sheet for that sheet's cache time. Many vMix inputs polling every second still use about one API call per tab per cache period, which keeps you under the Sheets API quota of 300 reads per minute per Google Cloud project. If Google can't be reached, the proxy keeps serving the last good data so your graphics don't go blank.
- **Header row:** blank headers become column letters (`A`, `B`, …). Duplicate headers get a suffix (`Name`, `Name_2`). Every row has every key, so vMix columns stay consistent.
