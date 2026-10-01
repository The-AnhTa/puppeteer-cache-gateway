# Puppeteer Cache Gateway

Local development with Codex on laptop.
Execution and authenticated browser access on CERGUARDAI.

## Tesla Powerhub offline replay

Powerhub support is separate from the existing SEMS+ tools. Microsoft Edge
must already be logged in to Powerhub. Enable remote debugging manually at
`edge://inspect/#remote-debugging`; the collector then attaches to that
existing Edge session through `DevToolsActivePort`. It does not launch Edge,
create a profile, or request credentials.

The collector is read-only apart from navigating the existing Powerhub tab to
five hard-coded routes: Overview, Map, Sites and Groups, Alerts, and Graphing.
It does not click controls, inspect network headers or browser storage, or
capture Access & Security. Captures default to
`C:\agent-web-cache\tesla-powerhub\snapshots` and are excluded from Git.

```powershell
npm run powerhub:capture
npm run powerhub:build
npm run powerhub:validate
```

The generated replay is written to
`C:\agent-web-cache\tesla-powerhub\replay\latest`. It contains sanitized text
and DOM data plus static screenshots, but no authentication material, live map
tiles, external links, or network-capable code. It works with the network
disabled.

For a non-live fixture test that does not attach to Edge:

```powershell
npm run powerhub:test
```
