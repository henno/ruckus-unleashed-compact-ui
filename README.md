# Ruckus Unleashed Compact UI

A Tampermonkey userscript that replaces the Ruckus Unleashed dashboard with a dense, single-screen, table-based admin view. Everything is visible at once: access points, clients, WLANs and events. No cards, minimal padding, minimal clicking.

## Features

- **Access points:** status, name, description, model, IP, management VLAN, MAC, client count, uplink speed, uplink errors and drops, traffic, uptime (negative for offline APs), last reboot reason. Sortable columns.
- **Expandable AP details:** network, device, reboot counters, radios per SSID and band (with VLAN), LAN ports, uplink interface, recent events. AP name and description are editable here.
- **Clients:** name, IP, MAC, device type, SSID, VLAN, AP, band and channel, signal, connected time. Click an AP to show only its clients.
- **WLANs:** enable/disable toggle, client count, security, VLAN (dynamic VLAN marked). Blocked clients list with unblock.
- **Events:** timeline with date separators, severity dots, separate AP column, shortened messages.
- **Actions:** restart AP, disconnect client, block/unblock client, toggle WLAN (with confirmations).
- **Global filter** across all tables, change highlighting, toasts when APs go down/up or clients join/leave, tab title shows offline AP count.
- **Uplink counter reset:** remembers a baseline in the browser and shows only the increase since then (the controller itself cannot reset them).
- CSV export, light/dark/auto theme, font and size selection, keyboard shortcuts (`/` search, `r` refresh, `t` theme, `Esc` clear).
- **Original UI** button switches back to the stock Ruckus dashboard.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the [script file](https://raw.githubusercontent.com/henno/ruckus-unleashed-compact-ui/main/ruckus-unleashed-compact-ui.user.js) and click **Install**.
3. Log in to your Unleashed controller and open `https://<controller>/admin/dashboard.jsp`.

Tampermonkey checks this repository for updates automatically.

## Compatibility

Tested on **Unleashed 200.15.6.212.27** (H510, H550, R510, R550 APs). It uses the controller's own XML endpoints (`/admin/_cmdstat.jsp`, `/admin/_conf.jsp`) and its CSRF token (`window.csfrToken`), so other Unleashed versions will likely work but are untested.

The script runs only on pages titled "Unleashed" that expose the CSRF token, so the broad `@match` does not affect other sites.

## How it talks to the controller

All requests go from your browser to the controller with your existing login session. Nothing is sent anywhere else. Configuration writes use the same calls as the stock UI; settings changed with `setconf` are sent as complete elements so other attributes are preserved.

## License

MIT
