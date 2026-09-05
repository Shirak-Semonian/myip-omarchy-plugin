// Pure logic for the MyIP bar widget: public-IP discovery, response parsing,
// quiet-polling state transitions and display strings.
//
// This file is plain ECMAScript shared by two runtimes:
//   - BarWidget.qml / Panel.qml import it as a QML JS module;
//   - test-model.js requires it from Node (see the module.exports guard at
//     the bottom).
//
// ---------------------------------------------------------------------------
// Public-IP API decision (MI-1, 2026-09-05, verified live from this machine)
// ---------------------------------------------------------------------------
// Primary endpoint: ip-api.com — http://ip-api.com/json/?fields=...
//
// Why ip-api.com:
//   * ONE endpoint returns everything the widget needs: the caller's public
//     IPv4 plus country / region / city / ISP / AS. No token, no sign-up.
//   * Free tier allows 45 requests/min from one IP with no monthly cap; the
//     widget uses at most 1 request per 60 s poll (~1440/day), far inside
//     the budget. Non-commercial use only — appropriate for a personal bar.
//   * The request body is trimmed with the `fields` parameter to the few
//     fields we render (no lat/lon are fetched, so no precise location is
//     ever stored or displayed).
//
// Why not the other candidates:
//   * ipify.org — returns the IP only; geo/ISP would need a second service
//     (a second request per poll). Rejected: keep it to one request.
//   * ipinfo.io — key-less /json works but is capped at ~50k requests per
//     month; at a 60 s poll that is ~43k/month, so a full month of uptime
//     would hit the cap. Full details also want an API token.
//   * ipwho.is — https and rich fields, but the free tier is ~10k
//     requests/month; a 60 s poll would exhaust it in about a week.
//
// Privacy trade-off, documented: ip-api.com's free tier is HTTP only (its
// HTTPS endpoint answers "SSL unavailable ... order a key"). The payload is
// the public IP + coarse geo that the endpoint learns anyway when we ask it
// for our own address; the plugin sends no other data and keeps no history.
// The response cap below (64 KiB) limits what a compromised endpoint could
// push at the widget.
//
// The parser only understands the ip-api.com shape; switching providers is a
// one-function change (normalizeData + the fetch command), which is exactly
// what a later MI-issue can do if the service policy ever changes.
// ---------------------------------------------------------------------------

var PROVIDER_NAME = "ip-api.com";
var ENDPOINT = "http://ip-api.com/json/";
// `query` is the caller's public IPv4. No lat/lon: we never fetch or show a
// precise location.
var QUERY_FIELDS = "status,message,country,countryCode,regionName,city,isp,org,as,query";

// curl write-out marker appended after the body: "\n__MYIP_HTTP__200".
var HTTP_MARKER = "\n__MYIP_HTTP__";

var DEFAULT_POLL_INTERVAL_SECONDS = 60;
var DEFAULT_REQUEST_TIMEOUT_SECONDS = 8;
var MAX_RESPONSE_BYTES = 65536; // 64 KiB — curl --max-filesize + parser cap
var OFFLINE_AFTER_CONSECUTIVE_FAILURES = 2;

// Curl exit codes that describe a reachability problem, with a calm,
// human-readable description.
var CURL_ERROR_TEXT = {
  6: "could not resolve the API host",
  7: "connection failed",
  22: "HTTP page not retrieved",
  28: "request timed out",
  35: "TLS/SSL problem",
  56: "connection reset by peer",
  63: "response too large (over 64 KiB)"
};

function defaults() {
  return {
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    requestTimeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS
  };
}

// The argv-vector for one poll request. No shell, no environment, no secrets:
// the endpoint is public and key-less. --max-filesize makes curl exit 63 when
// the body exceeds the cap; the marker is appended so a truncated body can
// never be mistaken for a complete JSON document.
function buildFetchCommand(config) {
  var timeout = DEFAULT_REQUEST_TIMEOUT_SECONDS;
  if (config && isFinite(config.requestTimeoutSeconds)) {
    var t = Math.round(Number(config.requestTimeoutSeconds));
    if (t >= 3 && t <= 30) timeout = t;
  }
  return [
    "curl", "-sS",
    "--max-time", String(timeout),
    "--max-filesize", String(MAX_RESPONSE_BYTES),
    "-w", HTTP_MARKER + "%{http_code}",
    ENDPOINT + "?fields=" + QUERY_FIELDS
  ];
}

// Defensive string guard for fields coming from the network.
function stringField(value) {
  if (typeof value !== "string") return "";
  return value.length > 120 ? value.substring(0, 120) : value;
}

function initialView() {
  return {
    status: "loading", // loading | ok | offline
    at: 0,             // last check time (ms epoch) — always double/var, never int
    data: null,        // last successful { ip, country, countryCode, ... } or null
    message: "",       // calm human-readable problem while not fully offline
    consecutiveFailures: 0
  };
}

function isLoading(view) {
  return !view || view.status === "loading";
}

function isOk(view) {
  return !!view && view.status === "ok";
}

function isOffline(view) {
  return !!view && view.status === "offline";
}

// True when a previous successful answer exists (panel can show "last known").
function hasData(view) {
  return !!view && !!view.data;
}

// True when the bar should look dimmed: nothing usable yet or offline.
function isDimmed(view) {
  return !view || view.status !== "ok";
}

function describeCurlError(code) {
  var n = Number(code);
  var text = CURL_ERROR_TEXT[n];
  if (text) return text;
  return "request failed (curl exit " + n + ")";
}

function describeHttpStatus(code) {
  var n = Number(code);
  if (n === 429) return "rate limited (too many requests)";
  if (n >= 500) return "provider server error (HTTP " + n + ")";
  if (n >= 400) return "provider rejected the request (HTTP " + n + ")";
  return "unexpected HTTP status " + n;
}

// Map one ip-api.com success payload onto the small normalized shape the
// widget renders.
function normalizeData(raw) {
  if (!raw || typeof raw !== "object") return null;
  var ip = stringField(raw.query);
  if (!ip) return null;
  return {
    ip: ip,
    country: stringField(raw.country),
    countryCode: stringField(raw.countryCode).toUpperCase(),
    regionName: stringField(raw.regionName),
    city: stringField(raw.city),
    isp: stringField(raw.isp),
    org: stringField(raw.org),
    as: stringField(raw.as)
  };
}

// Split curl output at the write-out marker. Returns { body, code } or null
// when the marker is absent. The defensive cap keeps a hostile/large body
// from being JSON.parsed whole.
function splitMarker(text) {
  if (typeof text !== "string") return null;
  if (text.length > MAX_RESPONSE_BYTES + 64) {
    text = text.substring(0, MAX_RESPONSE_BYTES + 64);
  }
  var idx = text.indexOf(HTTP_MARKER);
  if (idx < 0) return null;
  return {
    body: text.substring(0, idx).trim(),
    code: text.substring(idx + HTTP_MARKER.length).trim()
  };
}

// Interpret one finished poll. exitCode is the curl exit code; output is the
// collected stdout. Returns { ok:true, data } or { ok:false, kind, message }.
function parseFetchResult(exitCode, output) {
  if (exitCode !== 0) {
    return { ok: false, kind: "network", message: describeCurlError(exitCode) };
  }
  var text = String(output == null ? "" : output);
  if (text.trim() === "") {
    return { ok: false, kind: "empty", message: "empty response" };
  }
  var split = splitMarker(text);
  if (!split) {
    return { ok: false, kind: "parse", message: "unreadable response" };
  }
  if (split.code !== "200") {
    return { ok: false, kind: "http", message: describeHttpStatus(split.code) };
  }
  var obj = null;
  try {
    obj = JSON.parse(split.body);
  } catch (error) {
    return { ok: false, kind: "parse", message: "invalid JSON response" };
  }
  if (!obj || obj.status === "fail") {
    var apiMessage = obj && stringField(obj.message)
      ? stringField(obj.message) : "provider rejected the request";
    return { ok: false, kind: "api", message: apiMessage };
  }
  var data = normalizeData(obj);
  if (!data) {
    return { ok: false, kind: "parse", message: "response did not include an IP" };
  }
  return { ok: true, data: data };
}

// State reducer. Events:
//   { type: "fetchStart" }                      — no visual change (keeps the
//                                                 current calm state while a
//                                                 poll is in flight; a bar that
//                                                 already shows an IP keeps it)
//   { type: "fetchSuccess", data, at }          — fresh answer
//   { type: "fetchFail", kind, message, at }    — one failed poll
//
// Stale-result guard: an event carrying an `at` that is not newer than the
// state's last applied check time is dropped, so a result that arrives out of
// order can never overwrite fresher state.
function reduce(view, event) {
  if (!view) view = initialView();
  if (!event) return view;
  if (event.type === "fetchSuccess") {
    if (!event.data) return view;
    if (view.at !== 0 && event.at != null && event.at <= view.at) return view;
    return {
      status: "ok",
      at: event.at != null ? event.at : Date.now(),
      data: event.data,
      message: "",
      consecutiveFailures: 0
    };
  }
  if (event.type === "fetchFail") {
    if (view.at !== 0 && event.at != null && event.at <= view.at) return view;
    var failures = (view.consecutiveFailures || 0) + 1;
    var offline = failures >= OFFLINE_AFTER_CONSECUTIVE_FAILURES || !view.data;
    return {
      status: offline ? "offline" : view.status,
      at: event.at != null ? event.at : Date.now(),
      data: view.data,
      message: event.message || "",
      consecutiveFailures: failures
    };
  }
  return view;
}

// Country code -> flag emoji ("NL" -> "🇳🇱"). Empty string for anything that
// is not exactly two ASCII letters, so invalid data never renders a flag.
function flagEmoji(countryCode) {
  if (typeof countryCode !== "string") return "";
  var cc = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(
    0x1F1E6 + cc.charCodeAt(0) - 65,
    0x1F1E6 + cc.charCodeAt(1) - 65
  );
}

// The short value the bar label shows between the name and the flag.
function barValueText(view) {
  if (isLoading(view)) return "\u2026"; // …
  if (isOffline(view)) return "offline";
  if (isOk(view) && view.data) return view.data.ip;
  return "\u2026";
}

// Human status label for the panel ("Online" / "Checking…" / "Offline").
function statusLabel(view) {
  if (isLoading(view)) return "Checking\u2026";
  if (isOffline(view)) return "Offline";
  return "Online";
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

// Local clock time for the "last checked" row.
function formatTime(ts) {
  if (!ts) return "";
  var d = new Date(ts);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

// "Exampleville, Example Region, The Netherlands" — non-empty parts only.
function locationLine(data) {
  if (!data) return "";
  var parts = [];
  if (data.city) parts.push(data.city);
  if (data.regionName) parts.push(data.regionName);
  if (data.country) parts.push(data.country);
  return parts.join(", ");
}

function statusLine(view) {
  if (isLoading(view)) return "checking\u2026";
  if (isOffline(view)) return "offline" + (view.message ? " \u2014 " + view.message : "");
  if (isOk(view)) return "online";
  return "unknown";
}

// Calm bar tooltip. English (user-facing texts are English; the plugin is
// published worldwide).
function tooltipText(view, pollIntervalSeconds) {
  var interval = isFinite(pollIntervalSeconds) ? Math.round(Number(pollIntervalSeconds)) : DEFAULT_POLL_INTERVAL_SECONDS;
  if (isLoading(view)) return "MyIP \u2014 checking your public IP\u2026";
  if (isOffline(view)) {
    var tip = "MyIP \u2014 offline \u00b7 no public IP reachable \u00b7 retrying every " + interval + " s";
    if (view.data) {
      var known = view.data.ip;
      if (view.data.countryCode) known += " (" + view.data.countryCode + ")";
      tip += " \u00b7 last known " + known;
    }
    return tip;
  }
  if (isOk(view) && view.data) {
    var parts = [view.data.ip];
    if (view.data.country) {
      var countryPart = view.data.country;
      var flag = flagEmoji(view.data.countryCode);
      if (flag) countryPart += " " + flag;
      parts.push(countryPart);
    }
    if (view.data.isp) parts.push(view.data.isp);
    var text = "MyIP \u2014 " + parts.join(" \u00b7 ");
    if (view.message) text += " \u00b7 last check failed (" + view.message + ")";
    return text;
  }
  return "MyIP \u2014 checking your public IP\u2026";
}

if (typeof module !== "undefined") {
  module.exports = {
    PROVIDER_NAME: PROVIDER_NAME,
    ENDPOINT: ENDPOINT,
    QUERY_FIELDS: QUERY_FIELDS,
    HTTP_MARKER: HTTP_MARKER,
    DEFAULT_POLL_INTERVAL_SECONDS: DEFAULT_POLL_INTERVAL_SECONDS,
    DEFAULT_REQUEST_TIMEOUT_SECONDS: DEFAULT_REQUEST_TIMEOUT_SECONDS,
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    OFFLINE_AFTER_CONSECUTIVE_FAILURES: OFFLINE_AFTER_CONSECUTIVE_FAILURES,
    defaults: defaults,
    buildFetchCommand: buildFetchCommand,
    initialView: initialView,
    isLoading: isLoading,
    isOk: isOk,
    isOffline: isOffline,
    hasData: hasData,
    isDimmed: isDimmed,
    describeCurlError: describeCurlError,
    describeHttpStatus: describeHttpStatus,
    normalizeData: normalizeData,
    parseFetchResult: parseFetchResult,
    reduce: reduce,
    flagEmoji: flagEmoji,
    barValueText: barValueText,
    statusLabel: statusLabel,
    formatTime: formatTime,
    locationLine: locationLine,
    statusLine: statusLine,
    tooltipText: tooltipText
  };
}
