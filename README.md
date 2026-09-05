# MyIP

**MyIP** is an Omarchy bar widget that shows your **public IP address with its
country flag** at a glance — so you always see which IP you are reaching the
internet with, straight from the bar.

![icon](assets/icon.png)

## Features

- **Live public IPv4 in the bar**: the widget shows your current public IP with
  its country flag next to a custom MyIP icon, refreshed quietly every 60
  seconds. The widget name stays visible so the bar always reads clearly.
- **Calm states**: a short *checking…* moment on first start, then either the
  address or a quiet *offline* state (dimmed icon, informative tooltip). A
  single failed check never hides the last known address; the widget only
  reports *offline* after repeated failures, and it never retries faster than
  the poll interval.
- **Details panel**: click the widget (left or right) to open a panel with the
  address, country/flag, city/region, ISP and AS, the last-checked time, a
  **Copy IP** action (Wayland `wl-copy`) and a manual **Check now**.
- **Custom icon**: a calm navy globe tile (128×128) in the visual language of
  the Nvag Pulse / DeepSpend plugins, shown both in the bar and in the panel.

## Install

```sh
omarchy plugin add https://github.com/Shirak-Semonian/myip-omarchy-plugin --enable --yes
omarchy bar put io.github.shirak-semonian.myip
omarchy restart shell
```

For local development you can copy the folder instead:

```sh
cp -r . ~/.config/omarchy/plugins/io.github.shirak-semonian.myip
omarchy bar put io.github.shirak-semonian.myip
omarchy restart shell
```

## How it works

- One heartbeat drives a **single reusable fetch process**: at most one
  request in flight, at most one per poll interval (default 60 s).
- Poll timestamps are floating-point epochs (`Date.now()` is ~1.7e12 ms) —
  never 32-bit integers, which would overflow and cause polling spam.
- After every attempt — success or failure — the next poll is scheduled a
  full interval away, so an offline network never turns into a retry loop.
- The widget shows the **last known address** while a check is in flight or
  after a single failure, so the bar never flickers.

## Privacy and the address service

MyIP asks one public service, **ip-api.com** (free tier), for its own public
address and coarse geo data:

- One request per poll, **no key, no account**, no monthly cap at this rate
  (free tier: 45 requests/minute; MyIP uses ~1/minute).
- The request is limited to the fields the widget renders (`fields=…` — no
  coordinates are fetched or stored).
- The response is capped at 64 KiB both on the curl command line and before
  JSON parsing.
- The free tier is **HTTP only**; that trade-off is accepted because the
  payload is the public address and coarse country the service learns anyway
  when we ask it for our own IP. No other data is sent.
- MyIP keeps **no history** of addresses and never writes the address to any
  file; only short status lines go to the shell journal.

Alternatives were evaluated during development (ipify.org returns only the IP;
ipinfo.io and ipwho.is free tiers carry monthly caps that a 60 s poll would
exhaust) — the choice is documented in `Model.js`.

## Development

```sh
node test-model.js        # pure-logic tests
omarchy plugin validate . # manifest/schema validation
```

Layout: `Model.js` holds all pure logic (shared between QML and Node tests);
`BarWidget.qml` owns polling and the bar label; `Panel.qml` shows details and
actions; `assets/icon.png` is the custom icon (`icon-source.svg` is its
source).

## License

MIT
