# Companion module for Google Sheet Proxy

A [Bitfocus Companion](https://bitfocus.io/companion) module that controls Google Sheet Proxy from a Stream Deck or any other Companion surface:

- Turn automatic refresh from Google on and off, for one spreadsheet or all of them
- Change the refresh interval, or step it up and down
- Fetch new data now, check Google, and clear errors
- See on the buttons whether auto refresh is running or has errors: green live, grey paused, orange or red on errors, dark red when the proxy can't be reached

It comes with ready-made presets for each spreadsheet in the proxy. [companion/HELP.md](companion/HELP.md) lists every preset, action, feedback and variable. Companion shows the same help in the connection's help.

The module talks to the proxy's own admin API, the same one its web interface uses, so it needs nothing extra on the proxy.

## Requirements

- Companion 5.1 or newer. The module uses module API 2.2.
- Google Sheet Proxy reachable from the computer running Companion.

## Install

Build the module package, then import it into Companion:

```bash
cd companion-module
npm install
npm run package
```

This writes `googlesheetproxy-<version>.tgz`. In Companion, open **Modules**, import the `.tgz` file, then add a **Google Sheet Proxy** connection on the **Connections** page.

For development you can instead load the module straight from this folder: in the Companion launcher, open the cog (Advanced Settings), set **Developer modules path** to the folder that contains `companion-module`, and turn on developer modules. Run `npm install` first. Companion reloads the module when a file changes.

## Connection settings

| Setting | |
|---|---|
| Proxy address | The computer running the proxy, e.g. `127.0.0.1` when it runs on the same computer as Companion |
| Port | The port of the proxy's web interface, `3000` by default |
| Use HTTPS | Only when the proxy sits behind an HTTPS reverse proxy |
| Status update every (ms) | How often Companion asks the proxy for its status, 1000 by default. This does not change how often the proxy asks Google. |
| Admin password | Only when the proxy was started with `ADMIN_PASSWORD` |

The connection status in Companion is OK while the proxy answers, a warning while any spreadsheet with auto refresh on has errors from Google, and an error when the proxy can't be reached or the password is wrong.

## Test

`npm test` runs the module against a running proxy without Companion. It turns auto refresh off and on and changes intervals, then puts them back, so use a test copy of the proxy rather than one in use during a show:

```bash
PORT=3997 CONFIG_FILE=./test-config.json node ../server.js
PROXY_PORT=3997 npm test
```
