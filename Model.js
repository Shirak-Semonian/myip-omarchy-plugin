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
var MIN_POLL_INTERVAL_SECONDS = 30;   // DS-7 guard: never poll faster than this
var MAX_POLL_INTERVAL_SECONDS = 3600; // sane upper bound (an hour is plenty)
var DEFAULT_REQUEST_TIMEOUT_SECONDS = 8;
var MIN_REQUEST_TIMEOUT_SECONDS = 3;
var MAX_REQUEST_TIMEOUT_SECONDS = 30;
var MAX_RESPONSE_BYTES = 65536; // 64 KiB — curl --max-filesize + parser cap
var OFFLINE_AFTER_CONSECUTIVE_FAILURES = 2;

// MI-3: key-less display/behaviour preferences. Everything has a default and
// the config file is optional, so an absent or empty config just works.
var DEFAULT_ALERT_ON_CHANGE = true;
var DEFAULT_SHOW_COUNTRY = true;
var DEFAULT_SHOW_FLAG = true;

// MI-2: public-IP change tracking. The widget keeps the last known address
// (plus a short history) in a tiny state file and notifies once per real
// change. The first sighting is a silent baseline — a fresh install (or a
// cleared state file) never rings.
var STATE_FILE_VERSION = 1;
var HISTORY_LIMIT = 6;          // previous addresses kept in the state file
var CHANGE_GATE_TTL_SECONDS = 120; // dedupe window for twin bar instances
var GLYPH = "\uf0ac"; // globe — shown as the notification glyph (Nerd Font)
var MAX_IP_LENGTH = 45;         // longest legal IPv6 address

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
    requestTimeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS,
    alertOnChange: DEFAULT_ALERT_ON_CHANGE,
    showCountry: DEFAULT_SHOW_COUNTRY,
    showFlag: DEFAULT_SHOW_FLAG
  };
}

// ---------------------------------------------------------------------------
// MI-3: config file (~/.config/myip/config.json)
// ---------------------------------------------------------------------------
// The config is entirely optional and key-less:
//   * a missing or empty file simply means "defaults";
//   * a valid file may set pollIntervalSeconds (>= 30 s, clamped),
//     requestTimeoutSeconds, alertOnChange, showCountry and/or showFlag;
//   * a *broken* file (invalid JSON / wrong shape / wrong field type) must
//     never crash the widget and never surface raw file content: the panel
//     shows a calm problem line plus a "reset to defaults" action
//     (DS-5 lesson: no content/key leak in UI or errors).
//
// parseConfig returns
//   { ok: true, config: {...} }
// or
//   { ok: false, kind: "empty"|"parse"|"shape"|"field", error, hint }
// `error` is a fixed sentence and `hint` is a fixed suggestion; neither ever
// contains the raw config text (DS-5: engine JSON error messages can quote
// the offending content and are therefore never surfaced verbatim).

function configKindText(kind) {
  if (kind === "empty") return "config file is empty";
  if (kind === "parse") return "config file is not valid JSON";
  if (kind === "shape") return "config file must contain a JSON object";
  return "config file has an invalid value";
}

// Keep a numeric config field inside [min, max]; missing/NaN falls back.
function clampNumber(value, fallback, min, max) {
  var n = Number(value);
  if (!isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.round(n);
}

// True when the config value is a finite number or a numeric string.
function isNumericConfigValue(value) {
  if (typeof value === "number") return isFinite(value);
  if (typeof value !== "string") return false;
  return value.trim() !== "" && isFinite(Number(value));
}

// Parse and validate config.json text. Returns { ok, config|error|hint }.
function parseConfig(raw) {
  var text = String(raw == null ? "" : raw);
  if (text.trim() === "") {
    return { ok: true, config: defaults(), kind: "empty" };
  }
  var parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Never surface the engine error (it can echo file content, DS-5).
    return { ok: false, kind: "parse", error: configKindText("parse"),
      hint: "Check the double quotes, commas and braces." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, kind: "shape", error: configKindText("shape"),
      hint: "The file should look like {\"pollIntervalSeconds\": 60}." };
  }
  var cfg = defaults();
  if (parsed.pollIntervalSeconds !== undefined) {
    if (!isNumericConfigValue(parsed.pollIntervalSeconds)) {
      return { ok: false, kind: "field", error: configKindText("field"),
        hint: "\"pollIntervalSeconds\" must be a number between "
          + MIN_POLL_INTERVAL_SECONDS + " and "
          + MAX_POLL_INTERVAL_SECONDS + "." };
    }
    cfg.pollIntervalSeconds = clampNumber(parsed.pollIntervalSeconds,
      DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS,
      MAX_POLL_INTERVAL_SECONDS);
  }
  if (parsed.requestTimeoutSeconds !== undefined) {
    if (!isNumericConfigValue(parsed.requestTimeoutSeconds)) {
      return { ok: false, kind: "field", error: configKindText("field"),
        hint: "\"requestTimeoutSeconds\" must be a number between "
          + MIN_REQUEST_TIMEOUT_SECONDS + " and "
          + MAX_REQUEST_TIMEOUT_SECONDS + "." };
    }
    cfg.requestTimeoutSeconds = clampNumber(parsed.requestTimeoutSeconds,
      DEFAULT_REQUEST_TIMEOUT_SECONDS, MIN_REQUEST_TIMEOUT_SECONDS,
      MAX_REQUEST_TIMEOUT_SECONDS);
  }
  // Booleans are strict: a wrong type is a calm "field" problem the panel can
  // offer to reset (like DeepSpend's notificationsEnabled). Numbers clamp.
  var boolKeys = ["alertOnChange", "showCountry", "showFlag"];
  for (var bi = 0; bi < boolKeys.length; bi++) {
    var key = boolKeys[bi];
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] !== "boolean") {
      return { ok: false, kind: "field", error: configKindText("field"),
        hint: "\"" + key + "\" must be true or false." };
    }
    cfg[key] = parsed[key];
  }
  return { ok: true, config: cfg };
}

// Calm, fixed-language explanation of a config problem for the panel/tooltip.
// `problem` is the { ok:false, kind, error, hint } object from parseConfig.
function configProblemText(problem) {
  if (!problem || problem.ok) return "";
  var kind = problem.kind || "parse";
  var base = problem.error || configKindText(kind);
  var text = base;
  if (problem.hint) text += " " + problem.hint;
  return text;
}

// argv: bash -c script dir; backs up any existing config to config.json.bak-<ts>
// and writes the defaults template in its place (mode 600 via umask 077,
// atomic tmp+mv). Never touches shell syntax with file content: the template
// travels as an argv element, and config values are never echoed.
function resetConfigCommandArgs(dir, template) {
  var d = String(dir == null ? "" : dir);
  var t = String(template == null ? "" : template);
  var script = "umask 077;"
    + " mkdir -p -- \"$1\" || exit 1;"
    + " f=\"$1/config.json\";"
    + " if [ -f \"$f\" ]; then"
    + "   ts=$(date +%s)-$$; cp -a -- \"$f\" \"$f.bak-$ts\" || exit 1;"
    + " fi;"
    + " tmp=\"$f.tmp.$$\";"
    + " printf '%s' \"$2\" > \"$tmp\" || exit 1;"
    + " mv -f -- \"$tmp\" \"$f\" || exit 1;"
    + " chmod 600 \"$f\" || exit 1;"
    + " echo reset";
  return ["bash", "-c", script, "myip-reset-config", d, t];
}

// Defaults template written by "reset to defaults". Static text: no secrets,
// no user data; the widget then reloads and runs with these values.
function templateConfigText() {
  var d = defaults();
  return "{\n"
    + "  \"pollIntervalSeconds\": " + d.pollIntervalSeconds + ",\n"
    + "  \"requestTimeoutSeconds\": " + d.requestTimeoutSeconds + ",\n"
    + "  \"alertOnChange\": " + d.alertOnChange + ",\n"
    + "  \"showCountry\": " + d.showCountry + ",\n"
    + "  \"showFlag\": " + d.showFlag + "\n"
    + "}\n";
}

// ---------------------------------------------------------------------------
// Copy action (MI-3): fixed Omarchy clipboard IPC, never a shell command.
// ---------------------------------------------------------------------------
// The public IP travels as a *positional argument* to Omarchy's own
// clipboard-paste tool (`--copy-only`), which pipes it into wl-copy. There is
// no copyCommand config and no shell interpolation of user input anywhere.
function copyCommandArgs(binDir, ip) {
  var dir = String(binDir == null ? "" : binDir);
  return [dir + "/omarchy-clipboard-paste-text", "--copy-only",
    String(ip == null ? "" : ip)];
}

// ---------------------------------------------------------------------------
// Display prefs: showCountry / showFlag / alertOnChange
// ---------------------------------------------------------------------------
// Bar flag emoji only when the user wants flags and the country is known.
function barFlag(view, cfg) {
  if (!isOk(view) || !view.data || !cfg || cfg.showFlag === false) return "";
  return flagEmoji(view.data.countryCode);
}

// Country/flag fragment used by the tooltip's ok/offline text.
function countryFragment(data, cfg) {
  if (!data) return "";
  var showCountry = !cfg || cfg.showCountry !== false;
  var showFlag = !cfg || cfg.showFlag !== false;
  var parts = [];
  if (showCountry) {
    if (data.country) parts.push(data.country);
    else if (data.countryCode) parts.push(data.countryCode);
  }
  if (showFlag && data.countryCode) {
    var flag = flagEmoji(data.countryCode);
    if (flag) parts.push(flag);
  }
  return parts.join(" ");
}

// The argv-vector for one poll request. No shell, no environment, no secrets:
// the endpoint is public and key-less. --max-filesize makes curl exit 63 when
// the body exceeds the cap; the marker is appended so a truncated body can
// never be mistaken for a complete JSON document.
function buildFetchCommand(config) {
  var timeout = DEFAULT_REQUEST_TIMEOUT_SECONDS;
  if (config && isFinite(config.requestTimeoutSeconds)) {
    var t = Math.round(Number(config.requestTimeoutSeconds));
    if (t >= MIN_REQUEST_TIMEOUT_SECONDS
      && t <= MAX_REQUEST_TIMEOUT_SECONDS) timeout = t;
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
// published worldwide). `intervalOrCfg` is either the poll interval in
// seconds (legacy) or the parsed config object; showCountry/showFlag gate
// the country name / flag emoji when a config object is passed.
function tooltipText(view, intervalOrCfg) {
  var cfg = null;
  var interval = DEFAULT_POLL_INTERVAL_SECONDS;
  if (intervalOrCfg !== null && typeof intervalOrCfg === "object") {
    cfg = intervalOrCfg;
    if (isFinite(cfg.pollIntervalSeconds)) {
      interval = Math.round(Number(cfg.pollIntervalSeconds));
    }
  } else if (isFinite(Number(intervalOrCfg))) {
    interval = Math.round(Number(intervalOrCfg));
  }
  if (isLoading(view)) return "MyIP \u2014 checking your public IP\u2026";
  if (isOffline(view)) {
    var tip = "MyIP \u2014 offline \u00b7 no public IP reachable \u00b7 retrying every " + interval + " s";
    if (view.data) {
      var known = view.data.ip;
      var showCountryCfg = !cfg || cfg.showCountry !== false;
      if (showCountryCfg && view.data.countryCode) {
        known += " (" + view.data.countryCode + ")";
      }
      tip += " \u00b7 last known " + known;
    }
    if (view.at) tip += " \u00b7 last check " + formatTime(view.at);
    return tip;
  }
  if (isOk(view) && view.data) {
    var parts = [view.data.ip];
    var geo = countryFragment(view.data, cfg);
    if (geo) parts.push(geo);
    if (view.data.isp) parts.push(view.data.isp);
    var text = "MyIP \u2014 " + parts.join(" \u00b7 ");
    if (view.message) {
      text += " \u00b7 last check failed at " + formatTime(view.at)
        + " (" + view.message + ")";
    } else if (view.at) {
      text += " \u00b7 last check " + formatTime(view.at);
    }
    return text;
  }
  return "MyIP \u2014 checking your public IP\u2026";
}

// ---------------------------------------------------------------------------
// MI-2: address-change tracking, history + notifications (pure logic)
// ---------------------------------------------------------------------------
//
// Tracker state (persisted as JSON under $XDG_STATE_HOME/myip/state.json):
//   { version, lastIp, country, countryCode, firstSeenAt, history[] }
//     lastIp       — the address currently believed to be public
//     country/…    — geo of that address (for rendering + notification)
//     firstSeenAt  — ms epoch when lastIp became current (baseline time on a
//                    fresh start, otherwise the moment of the last change)
//     history      — previous addresses, newest first, each capped to the
//                    HISTORY_LIMIT newest entries:
//                    { ip, country, countryCode, at }
//                    `at` = ms epoch when that address was replaced.
//
// Baseline rule (the widget never rings on startup):
//   * the very first observation with no persisted lastIp is recorded as the
//     baseline and emits no event — a state reset + start stays silent;
//   * a later observation of the SAME address is always a no-op;
//   * only a genuinely different address emits one { kind: "changed" } event.
// Because lastIp is persisted, a shell restart cannot re-announce an
// unchanged address; an address that really changed while the widget was
// off still notifies once (the change is real, not a false start alert).

function emptyTracker() {
  return {
    version: STATE_FILE_VERSION,
    lastIp: "",
    country: "",
    countryCode: "",
    firstSeenAt: 0,
    history: []
  };
}

// Normalized copy of a tracker with only the persisted fields (history capped).
function cleanTracker(state) {
  var st = emptyTracker();
  if (!state || typeof state !== "object") return st;
  st.lastIp = stringField(state.lastIp);
  st.country = stringField(state.country);
  st.countryCode = stringField(state.countryCode).toUpperCase();
  var at = Number(state.firstSeenAt);
  st.firstSeenAt = isFinite(at) && at > 0 ? at : 0;
  if (Array.isArray(state.history)) {
    var out = [];
    for (var i = 0; i < state.history.length && out.length < HISTORY_LIMIT; i++) {
      var h = state.history[i];
      if (!h || typeof h !== "object") continue;
      var ip = stringField(h.ip);
      if (!isLikelyIp(ip)) continue;
      var ts = Number(h.at);
      if (!isFinite(ts) || ts <= 0) continue;
      out.push({
        ip: ip,
        country: stringField(h.country),
        countryCode: stringField(h.countryCode).toUpperCase(),
        at: ts
      });
    }
    st.history = out;
  }
  return st;
}

// Loose sanity check for an address-shaped string (IPv4 dotted quad or
// IPv6-ish with colons and hex digits). This is display/persistence hygiene,
// not a security boundary — the file is local and user-writable.
function isLikelyIp(value) {
  if (typeof value !== "string") return false;
  var v = value.trim();
  if (v.length < 3 || v.length > MAX_IP_LENGTH) return false;
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(v)) return true;
  if (v.indexOf(":") > 0 && /^[0-9a-fA-F:.%]+$/.test(v)) return true;
  return false;
}

// "IPv4" | "IPv6" for an address string ("" when unknown).
function familyOf(ip) {
  if (!isLikelyIp(ip)) return "";
  return ip.indexOf(":") > 0 ? "IPv6" : "IPv4";
}

function sameTracker(a, b) {
  return trackerToText(a) === trackerToText(b);
}

// Serialize a tracker to the JSON that the state file stores.
function trackerToText(state) {
  var st = cleanTracker(state);
  return JSON.stringify({
    version: STATE_FILE_VERSION,
    lastIp: st.lastIp,
    country: st.country,
    countryCode: st.countryCode,
    firstSeenAt: st.firstSeenAt,
    history: st.history
  });
}

// Parse the state file back into a tracker. Anything unreadable degrades to
// a fresh empty tracker (the next observation then becomes the silent
// baseline) — a corrupt state file must never block the widget.
function trackerFromText(text) {
  if (typeof text !== "string" || text.trim() === "") return emptyTracker();
  var obj = null;
  try {
    obj = JSON.parse(text);
  } catch (error) {
    return emptyTracker();
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return emptyTracker();
  if (!isLikelyIp(obj.lastIp)) {
    // A state file without a usable lastIp is as good as no state file.
    return emptyTracker();
  }
  return cleanTracker(obj);
}

// True when the tracker holds a usable last-known address (the widget only
// judges changes once a baseline exists).
function trackerHasBaseline(state) {
  return !!state && isLikelyIp(state.lastIp);
}

function historyEntries(state) {
  return trackerHasBaseline(state) && Array.isArray(state.history)
    ? state.history : [];
}

function historyCount(state) {
  return historyEntries(state).length;
}

// Pure transition: feed one fresh observation (ip + optional geo at a ms
// epoch) into the tracker. Returns
//   { state, events: [ { kind: "changed", from, to, at } ] }
// Baseline sightings and unchanged addresses produce no events.
function trackObservation(state, obs) {
  var st = cleanTracker(state);
  if (!obs || typeof obs !== "object") return { state: st, events: [] };
  var ip = stringField(obs.ip);
  if (!isLikelyIp(ip)) return { state: st, events: [] };
  var at = Number(obs.at);
  if (!isFinite(at) || at <= 0) at = Date.now();
  var country = stringField(obs.country);
  var countryCode = stringField(obs.countryCode).toUpperCase();
  var events = [];

  if (st.lastIp === "") {
    // First concrete observation = silent baseline.
    st.lastIp = ip;
    st.country = country;
    st.countryCode = countryCode;
    st.firstSeenAt = at;
    return { state: st, events: events };
  }
  if (st.lastIp === ip) {
    // Same address: never a change, nothing to record.
    return { state: st, events: events };
  }
  // Real change: push the address that just stopped being current to the top
  // of the history (at = the moment it was replaced), then remember the new
  // address. One event per transition — a poll that re-observes the new
  // address later is a no-op, so an unchanged address can never re-notify.
  var oldIp = st.lastIp;
  var oldCountry = st.country;
  var oldCountryCode = st.countryCode;
  var entry = {
    ip: oldIp,
    country: oldCountry,
    countryCode: oldCountryCode,
    at: at
  };
  var history = st.history.slice(0, HISTORY_LIMIT - 1);
  history.unshift(entry);
  st.lastIp = ip;
  st.country = country;
  st.countryCode = countryCode;
  st.firstSeenAt = at;
  st.history = history;
  events.push({
    kind: "changed",
    from: { ip: oldIp, country: oldCountry, countryCode: oldCountryCode },
    to: { ip: ip, country: country, countryCode: countryCode },
    at: at
  });
  return { state: st, events: events };
}

// Human strings for one IP-change event (used by the widget to send one
// Omarchy notification per event). `cfg` (optional) gates the country name /
// flag emoji with showCountry/showFlag; alertOnChange is enforced by the
// caller before the event is even queued.
function changeNotificationParts(event, cfg) {
  if (!event || event.kind !== "changed") return {};
  var fromIp = (event.from && event.from.ip) || "";
  var toIp = (event.to && event.to.ip) || "";
  if (!fromIp || !toIp) return {};
  var body = "IP changed: " + fromIp + " \u2192 " + toIp;
  var geo = countryFragment(event.to, cfg);
  if (geo) body += " (" + geo + ")";
  return {
    summary: "MyIP \u2014 IP changed",
    body: body,
    urgency: "normal",
    glyph: GLYPH
  };
}

// Dedupe key for a change event. The new address is the identity: when the
// address moves to X, twins that observe the same move share this key and
// only the first may notify.
function changeGateKey(event) {
  if (!event || event.kind !== "changed") return "";
  return "ip-change|" + String((event.to && event.to.ip) || "");
}

// argv: bash -c script name stateFile key ttlSeconds; prints "send" or
// "skip". Atomic flock record of "{key} {unixSeconds}" so that when Omarchy
// runs twin widget instances (one per monitor) only the first instance to
// reach the gate sends the notification; flock failures degrade to "skip"
// (no notification) — never to a duplicate.
function notifGateCommandArgs(stateFile, key, ttlSeconds) {
  var ttl = Number(ttlSeconds);
  if (!isFinite(ttl) || ttl < 1) ttl = CHANGE_GATE_TTL_SECONDS;
  var script = "f=$1; key=$2; ttl=$3;"
    + " dir=$(dirname -- \"$f\"); mkdir -p -- \"$dir\" 2>/dev/null || { echo skip; exit 0; };"
    + " lock=\"$f.lock\"; exec 9>\"$lock\" || { echo skip; exit 0; };"
    + " flock 9 2>/dev/null || { echo skip; exit 0; };"
    + " now=$(date +%s); prev=\"\"; prevts=0;"
    + " if [ -f \"$f\" ]; then read -r prev prevts < \"$f\" 2>/dev/null || true; fi;"
    + " if [ \"$prev\" = \"$key\" ] && [ -n \"$prevts\" ]"
    + "   && [ \"$(( now - prevts ))\" -lt \"$ttl\" ]; then echo skip;"
    + " else printf '%s %s\\n' \"$key\" \"$now\" > \"$f\"; echo send; fi";
  return ["bash", "-c", script, "myip-notif-gate",
    String(stateFile == null ? "" : stateFile), String(key == null ? "" : key), String(ttl)];
}

// argv for the atomic state-file write (mode 600 from the first byte via
// umask 077; unique temp file + mv). The state file contains no secrets,
// but it does hold the user's address history — keep it private.
function writeFileCommandArgs(path, text) {
  var f = String(path == null ? "" : path);
  var t = String(text == null ? "" : text);
  var script = "umask 077; f=$1; d=$(dirname -- \"$f\");"
    + " mkdir -p -- \"$d\" 2>/dev/null || exit 1;"
    + " tmp=\"$f.tmp.$$\"; printf '%s' \"$2\" > \"$tmp\" || exit 1;"
    + " mv -f -- \"$tmp\" \"$f\" || exit 1;";
  return ["bash", "-c", script, "myip-write-state", f, t];
}

if (typeof module !== "undefined") {
  module.exports = {
    PROVIDER_NAME: PROVIDER_NAME,
    ENDPOINT: ENDPOINT,
    QUERY_FIELDS: QUERY_FIELDS,
    HTTP_MARKER: HTTP_MARKER,
    DEFAULT_POLL_INTERVAL_SECONDS: DEFAULT_POLL_INTERVAL_SECONDS,
    MIN_POLL_INTERVAL_SECONDS: MIN_POLL_INTERVAL_SECONDS,
    MAX_POLL_INTERVAL_SECONDS: MAX_POLL_INTERVAL_SECONDS,
    DEFAULT_REQUEST_TIMEOUT_SECONDS: DEFAULT_REQUEST_TIMEOUT_SECONDS,
    MIN_REQUEST_TIMEOUT_SECONDS: MIN_REQUEST_TIMEOUT_SECONDS,
    MAX_REQUEST_TIMEOUT_SECONDS: MAX_REQUEST_TIMEOUT_SECONDS,
    DEFAULT_ALERT_ON_CHANGE: DEFAULT_ALERT_ON_CHANGE,
    DEFAULT_SHOW_COUNTRY: DEFAULT_SHOW_COUNTRY,
    DEFAULT_SHOW_FLAG: DEFAULT_SHOW_FLAG,
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    OFFLINE_AFTER_CONSECUTIVE_FAILURES: OFFLINE_AFTER_CONSECUTIVE_FAILURES,
    defaults: defaults,
    parseConfig: parseConfig,
    configKindText: configKindText,
    configProblemText: configProblemText,
    resetConfigCommandArgs: resetConfigCommandArgs,
    templateConfigText: templateConfigText,
    copyCommandArgs: copyCommandArgs,
    barFlag: barFlag,
    countryFragment: countryFragment,
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
    tooltipText: tooltipText,
    STATE_FILE_VERSION: STATE_FILE_VERSION,
    HISTORY_LIMIT: HISTORY_LIMIT,
    CHANGE_GATE_TTL_SECONDS: CHANGE_GATE_TTL_SECONDS,
    GLYPH: GLYPH,
    MAX_IP_LENGTH: MAX_IP_LENGTH,
    emptyTracker: emptyTracker,
    cleanTracker: cleanTracker,
    isLikelyIp: isLikelyIp,
    familyOf: familyOf,
    sameTracker: sameTracker,
    trackerToText: trackerToText,
    trackerFromText: trackerFromText,
    trackerHasBaseline: trackerHasBaseline,
    historyEntries: historyEntries,
    historyCount: historyCount,
    trackObservation: trackObservation,
    changeNotificationParts: changeNotificationParts,
    changeGateKey: changeGateKey,
    notifGateCommandArgs: notifGateCommandArgs,
    writeFileCommandArgs: writeFileCommandArgs
  };
}
