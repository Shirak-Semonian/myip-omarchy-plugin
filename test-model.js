// Node test suite for Model.js — plain assert, no framework.
// Run: node test-model.js
const assert = require("assert")
const M = require("./Model.js")

const eq = (a, b, msg) => assert.strictEqual(a, b, msg)
const ok = (v, msg) => assert.ok(v, msg)
const has = (haystack, needle, msg) => assert.ok(String(haystack).includes(needle), msg)

// --- constants / defaults ------------------------------------------------
eq(M.PROVIDER_NAME, "ip-api.com", "provider name")
eq(M.DEFAULT_POLL_INTERVAL_SECONDS, 60, "calm 60 s default poll")
eq(M.OFFLINE_AFTER_CONSECUTIVE_FAILURES, 2, "offline after two consecutive failures")
eq(M.MAX_RESPONSE_BYTES, 65536, "response cap 64 KiB")
eq(M.defaults().pollIntervalSeconds, 60, "defaults poll interval")
eq(M.defaults().requestTimeoutSeconds, 8, "defaults request timeout")

// --- fetch command -------------------------------------------------------
const cmd = M.buildFetchCommand(M.defaults())
has(cmd[0], "curl", "uses curl")
ok(cmd.includes("--max-time") && cmd.includes("8"), "bounded timeout")
ok(cmd.includes("--max-filesize") && cmd.includes(String(M.MAX_RESPONSE_BYTES)), "response cap on the curl command")
has(cmd.join(" "), "http://ip-api.com/json/?fields=", "single public endpoint")
has(cmd.join(" "), "status,message,country,countryCode,regionName,city,isp,org,as,query", "trimmed fields (no lat/lon)")
ok(!cmd.join(" ").includes("lat") && !cmd.join(" ").includes("lon"), "never fetches precise coordinates")
ok(!cmd.join(" ").includes("token") && !cmd.join(" ").includes("api-key"), "no secret material in argv")
eq(M.buildFetchCommand({ requestTimeoutSeconds: 999 }).includes("999"), false, "timeout clamped")
eq(M.buildFetchCommand({ requestTimeoutSeconds: 4 }).includes("4"), true, "custom timeout honored")

// --- parsing: success ----------------------------------------------------
const sampleBody = JSON.stringify({
  status: "success", country: "The Netherlands", countryCode: "NL",
  regionName: "Example Region", city: "Exampleville", zip: "0000",
  isp: "Example ISP B.V.", org: "", as: "AS64500 Example ISP B.V.",
  query: "203.0.113.7"
})
let r = M.parseFetchResult(0, sampleBody + M.HTTP_MARKER + "200")
eq(r.ok, true, "success parse ok")
eq(r.data.ip, "203.0.113.7", "ip parsed")
eq(r.data.countryCode, "NL", "country code parsed")
eq(r.data.isp, "Example ISP B.V.", "isp parsed")

// --- parsing: failures ---------------------------------------------------
eq(M.parseFetchResult(6, "x").ok, false, "curl DNS exit -> fail")
eq(M.parseFetchResult(6, "x").message, "could not resolve the API host", "curl 6 text")
eq(M.parseFetchResult(7, "x").message, "connection failed", "curl 7 text")
eq(M.parseFetchResult(28, "x").message, "request timed out", "curl 28 text")
eq(M.parseFetchResult(63, "x").message, "response too large (over 64 KiB)", "curl 63 text")
eq(M.parseFetchResult(99, "x").message, "request failed (curl exit 99)", "unknown curl text")
eq(M.parseFetchResult(0, "").kind, "empty", "empty output")
eq(M.parseFetchResult(0, "garbage no marker").kind, "parse", "missing marker")
eq(M.parseFetchResult(0, "{not json}" + M.HTTP_MARKER + "200").kind, "parse", "invalid json")
eq(M.parseFetchResult(0, "{}" + M.HTTP_MARKER + "500").message, "provider server error (HTTP 500)", "http 500 text")
eq(M.parseFetchResult(0, "{}" + M.HTTP_MARKER + "429").message, "rate limited (too many requests)", "http 429 text")
const apiFail = M.parseFetchResult(0, JSON.stringify({ status: "fail", message: "reserved range" }) + M.HTTP_MARKER + "200")
eq(apiFail.ok, false, "provider fail -> fail")
eq(apiFail.kind, "api", "provider fail kind")
eq(M.parseFetchResult(0, JSON.stringify({ status: "success", query: "" }) + M.HTTP_MARKER + "200").kind, "parse", "missing ip -> parse fail")

// --- state reducer -------------------------------------------------------
let v = M.initialView()
eq(v.status, "loading", "starts loading")
v = M.reduce(v, { type: "fetchStart" })
eq(v.status, "loading", "fetchStart keeps loading")
const d1 = { ip: "203.0.113.7", country: "The Netherlands", countryCode: "NL", regionName: "Example Region", city: "Exampleville", isp: "X", org: "", as: "AS1" }
v = M.reduce(v, { type: "fetchSuccess", data: d1, at: 1000 })
eq(v.status, "ok", "first success -> ok")
eq(v.consecutiveFailures, 0, "success resets failures")
eq(M.barValueText(v), "203.0.113.7", "bar shows the ip when ok")

// stale success (older than current data) is dropped
const vBefore = v
v = M.reduce(v, { type: "fetchSuccess", data: { ...d1, ip: "198.51.100.9" }, at: 500 })
eq(v.data.ip, "203.0.113.7", "stale success dropped (guard)")
eq(v, vBefore, "stale success leaves state untouched")

// one failure with data: keep showing the last known ip, remember the message
v = M.reduce(v, { type: "fetchFail", kind: "network", message: "request timed out", at: 2000 })
eq(v.status, "ok", "first failure keeps ok while data exists")
eq(v.consecutiveFailures, 1, "failure counter 1")
eq(M.barValueText(v), "203.0.113.7", "bar still shows the ip after one failure")
has(M.tooltipText(v, 60), "last check failed", "tooltip mentions the failed check")

// second consecutive failure without recovery -> offline (data kept for panel)
v = M.reduce(v, { type: "fetchFail", kind: "network", message: "connection failed", at: 3000 })
eq(v.status, "offline", "second consecutive failure -> offline")
eq(M.barValueText(v), "offline", "bar shows offline")
eq(M.isDimmed(v), true, "offline is dimmed")
has(M.tooltipText(v, 60), "offline", "tooltip says offline")
has(M.tooltipText(v, 60), "last known 203.0.113.7", "tooltip keeps last known")
eq(M.hasData(v), true, "data retained for the panel")

// failure with no data at all -> offline immediately
let w = M.initialView()
w = M.reduce(w, { type: "fetchFail", kind: "network", message: "connection failed", at: 1 })
eq(w.status, "offline", "no data -> offline after one failure")

// recovery
v = M.reduce(v, { type: "fetchSuccess", data: d1, at: 4000 })
eq(v.status, "ok", "success recovers from offline")
eq(v.message, "", "message cleared on success")
eq(v.consecutiveFailures, 0, "counter reset on success")

// --- flags ---------------------------------------------------------------
eq(M.flagEmoji("NL"), "\u{1F1F3}\u{1F1F1}", "NL flag emoji")
eq(M.flagEmoji("nl"), "\u{1F1F3}\u{1F1F1}", "lowercase code accepted")
eq(M.flagEmoji("USA"), "", "three letters -> no flag")
eq(M.flagEmoji(""), "", "empty -> no flag")
eq(M.flagEmoji(null), "", "null -> no flag")

// --- display strings -----------------------------------------------------
const okView = { status: "ok", at: 0, data: { ...d1, countryCode: "NL" }, message: "", consecutiveFailures: 0 }
eq(M.barValueText(M.initialView()), "\u2026", "loading bar value")
eq(M.barValueText({ status: "ok", data: d1 }), "203.0.113.7", "ok bar value")
eq(M.statusLabel(okView), "Online", "panel status label online")
eq(M.statusLabel(M.initialView()), "Checking\u2026", "panel status label checking")
eq(M.statusLabel({ status: "offline" }), "Offline", "panel status label offline")
eq(M.locationLine(d1), "Exampleville, Example Region, The Netherlands", "location line")
eq(M.locationLine({}), "", "empty location line")
has(M.tooltipText(okView, 60), "The Netherlands", "tooltip has country")
has(M.tooltipText(okView, 60), "MyIP", "tooltip starts with the name")
eq(M.formatTime(0), "", "no timestamp -> empty")
ok(/^\d{2}:\d{2}:\d{2}$/.test(M.formatTime(Date.now())), "time format hh:mm:ss")
eq(M.statusLine(okView), "online", "status line ok")

// --- fetch-start never flickers an existing state ------------------------
const beforeTick = okView
const afterTick = M.reduce(okView, { type: "fetchStart" })
eq(afterTick.status, "ok", "fetchStart leaves an ok state alone (no flicker)")
eq(afterTick, beforeTick, "fetchStart is a no-op for ok")

// =========================================================================
// MI-2: address-change detection, history + notifications
// =========================================================================

// --- tracker basics -------------------------------------------------------
const fresh = M.emptyTracker()
eq(fresh.lastIp, "", "fresh tracker has no address")
eq(fresh.history.length, 0, "fresh tracker has no history")

// --- baseline: first observation never alerts -----------------------------
let tr = M.emptyTracker()
let res = M.trackObservation(tr, { ip: "203.0.113.7", country: "Example", countryCode: "ex", at: 1000 })
eq(res.events.length, 0, "first observation is a silent baseline (no event)")
eq(res.state.lastIp, "203.0.113.7", "baseline records the address")
eq(res.state.countryCode, "EX", "baseline country code normalized")
eq(res.state.firstSeenAt, 1000, "baseline records first-seen time")
eq(res.state.history.length, 0, "baseline starts with empty history")
ok(!M.trackerHasBaseline(M.emptyTracker()), "empty tracker has no baseline")
ok(M.trackerHasBaseline(res.state), "tracker with an address has a baseline")

// --- same address again: no event, no history -----------------------------
res = M.trackObservation(res.state, { ip: "203.0.113.7", country: "Example", countryCode: "EX", at: 2000 })
eq(res.events.length, 0, "unchanged address never alerts")
eq(res.state.history.length, 0, "unchanged address adds no history")
eq(res.state.firstSeenAt, 1000, "unchanged address keeps first-seen time")

// --- real change: one event + history entry -------------------------------
res = M.trackObservation(res.state, { ip: "198.51.100.9", country: "Test", countryCode: "ZZ", at: 3000 })
eq(res.events.length, 1, "real change emits exactly one event")
const ev = res.events[0]
eq(ev.kind, "changed", "change event kind")
eq(ev.from.ip, "203.0.113.7", "change from is the previous address")
eq(ev.to.ip, "198.51.100.9", "change to is the new address")
eq(ev.at, 3000, "change carries the observation time")
eq(res.state.lastIp, "198.51.100.9", "state follows the new address")
eq(res.state.firstSeenAt, 3000, "firstSeenAt moves to the change time")
eq(res.state.history.length, 1, "history holds the replaced address")
eq(res.state.history[0].ip, "203.0.113.7", "history entry is the old address")
eq(res.state.history[0].at, 3000, "history entry time = when it was replaced")
eq(M.historyCount(res.state), 1, "historyCount")

// --- another change back: newest-first ordering ---------------------------
res = M.trackObservation(res.state, { ip: "203.0.113.7", country: "Example", countryCode: "EX", at: 4000 })
eq(res.events.length, 1, "change back also emits one event")
eq(res.events[0].from.ip, "198.51.100.9", "change-back from")
eq(res.state.history.length, 2, "two history entries")
eq(res.state.history[0].ip, "198.51.100.9", "newest replacement first")
eq(res.state.history[1].ip, "203.0.113.7", "older replacement second")

// --- repeated observation of the same new address stays quiet -------------
res = M.trackObservation(res.state, { ip: "203.0.113.7", country: "Example", countryCode: "EX", at: 5000 })
eq(res.events.length, 0, "same address after change stays quiet (no repeat notify)")
eq(res.state.history.length, 2, "no duplicate history on repeat observation")

// --- history cap ----------------------------------------------------------
let capped = M.emptyTracker()
for (let i = 0; i < M.HISTORY_LIMIT + 3; i++) {
  capped = M.trackObservation(capped, { ip: "192.0.2." + (i % 240), at: 6000 + i }).state
}
eq(capped.history.length, M.HISTORY_LIMIT, "history capped at HISTORY_LIMIT")
eq(capped.history[0].ip, "192.0.2." + (M.HISTORY_LIMIT + 1) % 240, "oldest entries dropped, newest kept")

// --- invalid observations are no-ops --------------------------------------
const noIp = M.trackObservation(res.state, { ip: "", at: 7000 })
eq(noIp.events.length, 0, "empty ip emits nothing")
eq(noIp.state.lastIp, res.state.lastIp, "empty ip leaves state untouched")
eq(M.trackObservation(res.state, null).state.lastIp, res.state.lastIp, "null observation leaves state untouched")
const weird = M.trackObservation(res.state, { ip: "not-an-ip!", at: 7000 })
eq(weird.events.length, 0, "non-address string emits nothing")

// --- serialization round trip ---------------------------------------------
const text = M.trackerToText(res.state)
ok(text.startsWith("{") && text.includes("\"lastIp\":\"203.0.113.7\""), "serialized tracker contains lastIp")
const parsed = M.trackerFromText(text)
eq(parsed.lastIp, res.state.lastIp, "round-trip lastIp")
eq(parsed.firstSeenAt, res.state.firstSeenAt, "round-trip firstSeenAt")
eq(parsed.history.length, res.state.history.length, "round-trip history length")
eq(M.trackerToText(parsed), text, "round-trip is stable JSON")
ok(M.sameTracker(res.state, parsed), "sameTracker true for round-trip")

// --- corrupt state file degrades to empty tracker -------------------------
eq(M.trackerFromText("").lastIp, "", "empty file -> empty tracker")
eq(M.trackerFromText("not json").lastIp, "", "garbage file -> empty tracker")
eq(M.trackerFromText("[1,2]").lastIp, "", "array file -> empty tracker")
eq(M.trackerFromText("{\"lastIp\":\"\"}").lastIp, "", "file without address -> empty tracker")
eq(M.trackerFromText("{\"lastIp\":12345}").lastIp, "", "non-string address -> empty tracker")
eq(M.trackerFromText(null).lastIp, "", "null file -> empty tracker")
const tooLongIp = "203.0.113.7".padEnd(200, "x")
eq(M.trackerFromText(JSON.stringify({ lastIp: tooLongIp })).lastIp, "", "oversized address rejected")

// --- history entries survive serialization but stay capped -----------------
const capText = M.trackerToText(capped)
eq(M.trackerFromText(capText).history.length, M.HISTORY_LIMIT, "capped history round-trips")
const overText = JSON.stringify({
  lastIp: "203.0.113.7", firstSeenAt: 1,
  history: Array.from({ length: 20 }, (_, i) => ({ ip: "198.51.100." + i, at: i + 1 }))
})
eq(M.trackerFromText(overText).history.length, M.HISTORY_LIMIT, "oversized history file is capped on read")

// --- notification copy -----------------------------------------------------
const parts = M.changeNotificationParts(ev)
eq(parts.summary, "MyIP \u2014 IP changed", "notification summary")
ok(parts.body.includes("IP changed: 203.0.113.7 \u2192 198.51.100.9"), "notification body old -> new")
ok(parts.body.includes("(Test") && parts.body.includes(")"), "notification mentions the new country when known")
eq(parts.urgency, "normal", "change alert is normal urgency (calm but visible)")
const nlParts = M.changeNotificationParts({ kind: "changed", from: { ip: "203.0.113.7" }, to: { ip: "203.0.113.7", country: "The Netherlands", countryCode: "NL" } })
ok(nlParts.body.includes("The Netherlands \uD83C\uDDF3\uD83C\uDDF1"), "notification shows flag with the new country")
eq(M.changeNotificationParts({ kind: "other" }).summary, undefined, "non-change event has no notification")
const noCountryEvent = { kind: "changed", from: { ip: "203.0.113.7" }, to: { ip: "198.51.100.9" } }
eq(M.changeNotificationParts(noCountryEvent).body, "IP changed: 203.0.113.7 \u2192 198.51.100.9", "no country -> plain body")

// --- gate key + command ----------------------------------------------------
eq(M.changeGateKey(ev), "ip-change|198.51.100.9", "gate key identifies the new address")
const gateArgs = M.notifGateCommandArgs("/tmp/notif.gate", "ip-change|198.51.100.9", 25)
eq(gateArgs[0], "bash", "gate uses bash")
has(gateArgs.join(" "), "flock", "gate uses flock")
has(gateArgs.join(" "), "myip-notif-gate", "gate argv name")
ok(gateArgs.join(" ").includes("25"), "ttl passed to gate")

// --- family + write helper -------------------------------------------------
eq(M.familyOf("203.0.113.7"), "IPv4", "dot address is IPv4")
eq(M.familyOf("2001:db8::1"), "IPv6", "colon address is IPv6")
eq(M.familyOf(""), "", "empty -> no family")
eq(M.isLikelyIp("203.0.113.7"), true, "ipv4 accepted")
eq(M.isLikelyIp("2001:db8::1"), true, "ipv6 accepted")
eq(M.isLikelyIp("203.0.113.7 "), true, "trailing space tolerated")
eq(M.isLikelyIp("80.60.128"), false, "short ip rejected")
const wArgs = M.writeFileCommandArgs("/tmp/x/state.json", "{}")
has(wArgs.join(" "), "mkdir -p", "write helper creates the dir")
has(wArgs.join(" "), "umask 077", "write helper is private by default")
has(wArgs.join(" "), ".tmp.$$", "write helper is atomic (tmp + mv)")
has(wArgs.join(" "), "mv -f", "write helper renames into place")

// =========================================================================
// MI-3: config parsing, guards, recovery and display preferences
// =========================================================================

// --- config defaults + interval guards ------------------------------------
eq(M.DEFAULT_ALERT_ON_CHANGE, true, "default alertOnChange true")
eq(M.DEFAULT_SHOW_COUNTRY, true, "default showCountry true")
eq(M.DEFAULT_SHOW_FLAG, true, "default showFlag true")
eq(M.MIN_POLL_INTERVAL_SECONDS, 30, "poll interval min 30 s")
eq(M.MAX_POLL_INTERVAL_SECONDS, 3600, "poll interval max 3600 s")
eq(M.MIN_REQUEST_TIMEOUT_SECONDS, 3, "timeout min 3 s")
eq(M.MAX_REQUEST_TIMEOUT_SECONDS, 30, "timeout max 30 s")
const def = M.defaults()
eq(def.pollIntervalSeconds, 60, "default interval")
eq(def.requestTimeoutSeconds, 8, "default timeout")
eq(def.alertOnChange, true, "default alert")
eq(def.showCountry, true, "default country")
eq(def.showFlag, true, "default flag")

// --- parseConfig: missing / empty / whitespace = defaults ------------------
for (const emptyInput of [null, undefined, "", "   \n  "]) {
  const p = M.parseConfig(emptyInput)
  eq(p.ok, true, "empty config is ok")
  eq(p.kind, "empty", "empty config kind")
  eq(p.config.pollIntervalSeconds, 60, "empty -> default interval")
  eq(p.config.showFlag, true, "empty -> default flag")
}

// --- parseConfig: valid files ----------------------------------------------
const full = M.parseConfig(JSON.stringify({
  pollIntervalSeconds: 45,
  requestTimeoutSeconds: 5,
  alertOnChange: false,
  showCountry: false,
  showFlag: false
}))
eq(full.ok, true, "valid config parses")
eq(full.config.pollIntervalSeconds, 45, "interval honored")
eq(full.config.requestTimeoutSeconds, 5, "timeout honored")
eq(full.config.alertOnChange, false, "alert honored")
eq(full.config.showCountry, false, "showCountry honored")
eq(full.config.showFlag, false, "showFlag honored")

const partial = M.parseConfig(JSON.stringify({ pollIntervalSeconds: 120 }))
eq(partial.ok, true, "partial config parses")
eq(partial.config.pollIntervalSeconds, 120, "partial interval")
eq(partial.config.showCountry, true, "partial keeps default showCountry")
eq(partial.config.alertOnChange, true, "partial keeps default alert")

// unknown keys are ignored (forward compatible)
const unknown = M.parseConfig(JSON.stringify({ pollIntervalSeconds: 90, futureKey: "x", copyCommand: "echo pwn" }))
eq(unknown.ok, true, "unknown keys ignored")
eq(unknown.config.pollIntervalSeconds, 90, "known key still parsed")
eq(unknown.config.showFlag, true, "unknown keys do not disturb defaults")

// --- parseConfig: interval guards (clamp, never faster than min) -----------
eq(M.parseConfig(JSON.stringify({ pollIntervalSeconds: 5 })).config.pollIntervalSeconds, 30, "below-min clamps to 30")
eq(M.parseConfig(JSON.stringify({ pollIntervalSeconds: 0 })).config.pollIntervalSeconds, 30, "zero clamps to 30")
eq(M.parseConfig(JSON.stringify({ pollIntervalSeconds: 99999 })).config.pollIntervalSeconds, 3600, "huge clamps to 3600")
eq(M.parseConfig(JSON.stringify({ pollIntervalSeconds: "75" })).config.pollIntervalSeconds, 75, "numeric string honored")
eq(M.parseConfig(JSON.stringify({ pollIntervalSeconds: 30.6 })).config.pollIntervalSeconds, 31, "fraction rounds")
eq(M.parseConfig(JSON.stringify({ requestTimeoutSeconds: 1 })).config.requestTimeoutSeconds, 3, "timeout below-min clamps to 3")
eq(M.parseConfig(JSON.stringify({ requestTimeoutSeconds: 99 })).config.requestTimeoutSeconds, 30, "timeout huge clamps to 30")
eq(M.parseConfig(JSON.stringify({ pollIntervalSeconds: "fast" })).ok, false, "non-numeric interval is a field error")
eq(M.parseConfig(JSON.stringify({ pollIntervalSeconds: true })).ok, false, "boolean interval is a field error")

// --- parseConfig: invalid JSON / wrong shape (DS-5: no content leak) -------
const secret = "sk-myip-super-secret-value-123456"
const garbage = "not json " + secret + " {"
const badParse = M.parseConfig(garbage)
eq(badParse.ok, false, "invalid json -> error")
eq(badParse.kind, "parse", "invalid json kind")
ok(!badParse.error.includes(secret) && !badParse.hint.includes(secret), "parse error never echoes file content")
ok(!M.configProblemText(badParse).includes(secret), "problem text never echoes file content")

eq(M.parseConfig("[1,2]").ok, false, "array root -> error")
eq(M.parseConfig("42").ok, false, "number root -> error")
eq(M.parseConfig("\"str\"").ok, false, "string root -> error")

// --- parseConfig: wrong boolean type is a calm field error ------------------
const badBool = M.parseConfig(JSON.stringify({ showFlag: "yes" }))
eq(badBool.ok, false, "wrong boolean type -> error")
eq(badBool.kind, "field", "wrong boolean kind")
ok(!M.configProblemText(badBool).includes("yes"), "field error does not echo the value")
eq(M.parseConfig(JSON.stringify({ alertOnChange: 1 })).ok, false, "number alert -> error")
eq(M.parseConfig(JSON.stringify({ showCountry: "true" })).ok, false, "string boolean -> error")

// --- template + reset command ----------------------------------------------
const tpl = M.templateConfigText()
const tplParsed = M.parseConfig(tpl)
eq(tplParsed.ok, true, "defaults template is valid config")
eq(tplParsed.config.pollIntervalSeconds, 60, "template interval is the default")
eq(tplParsed.config.showCountry, true, "template showCountry default")
ok(!tpl.includes("secret") && !tpl.includes("key"), "template has no secret placeholder")

const resetArgs = M.resetConfigCommandArgs("/home/u/.config/myip", tpl)
eq(resetArgs[0], "bash", "reset uses bash")
has(resetArgs.join(" "), "mkdir -p", "reset creates the dir")
has(resetArgs.join(" "), "umask 077", "reset is private by default")
has(resetArgs.join(" "), ".bak-$", "reset backs up the broken file")
has(resetArgs.join(" "), "chmod 600", "reset enforces mode 600")
has(resetArgs.join(" "), "printf '%s' \"$2\"", "reset writes template via argv")
ok(!resetArgs[2].includes(tpl), "template never interpolated into the shell script text")

// --- copy argv: fixed Omarchy IPC, no shell, no user-configurable command --
const copy = M.copyCommandArgs("/usr/bin", "203.0.113.7")
eq(copy[0], "/usr/bin/omarchy-clipboard-paste-text", "fixed Omarchy clipboard tool")
eq(copy[1], "--copy-only", "copy-only flag")
eq(copy[2], "203.0.113.7", "ip is a plain positional argument")
ok(copy.indexOf("bash") === -1 && copy.indexOf("-c") === -1, "copy never goes through a shell")
const weirdIp = "1.2.3.4; rm -rf /"
const weirdCopy = M.copyCommandArgs("/usr/bin", weirdIp)
eq(weirdCopy[2], weirdIp, "value travels as one argv element, never interpolated")

// --- barFlag / countryFragment honour showCountry/showFlag -------------------
const cfgShowAll = { pollIntervalSeconds: 60, showCountry: true, showFlag: true }
const cfgNoFlag = { pollIntervalSeconds: 60, showCountry: true, showFlag: false }
const cfgNoCountry = { pollIntervalSeconds: 60, showCountry: false, showFlag: true }
const cfgMinimal = { pollIntervalSeconds: 60, showCountry: false, showFlag: false }
const geoView = { status: "ok", at: 0, data: { ip: "203.0.113.7", country: "The Netherlands", countryCode: "NL", isp: "X" }, message: "", consecutiveFailures: 0 }
eq(M.barFlag(geoView, cfgShowAll), "\u{1F1F3}\u{1F1F1}", "bar flag shown when showFlag")
eq(M.barFlag(geoView, cfgNoFlag), "", "bar flag hidden when showFlag=false")
eq(M.barFlag(geoView, cfgNoCountry), "\u{1F1F3}\u{1F1F1}", "bar flag independent of showCountry")
eq(M.barFlag({ status: "offline", data: geoView.data }, cfgShowAll), "", "no flag while offline")
eq(M.barFlag(M.initialView(), cfgShowAll), "", "no flag while loading")

eq(M.countryFragment(geoView.data, cfgShowAll), "The Netherlands \u{1F1F3}\u{1F1F1}", "country + flag")
eq(M.countryFragment(geoView.data, cfgNoFlag), "The Netherlands", "country without flag")
eq(M.countryFragment(geoView.data, cfgNoCountry), "\u{1F1F3}\u{1F1F1}", "flag without country text")
eq(M.countryFragment(geoView.data, cfgMinimal), "", "no geo in minimal mode")
eq(M.countryFragment(null, cfgShowAll), "", "null data -> empty")

// --- tooltip edge cases: states, prefs, last check --------------------------
// Construct timestamps in LOCAL time so the hh:mm:ss expectation is TZ-proof.
const atMorning = new Date(2026, 0, 2, 9, 5, 7).getTime()
const tOkAll = M.tooltipText({ ...geoView, at: atMorning }, cfgShowAll)
has(tOkAll, "203.0.113.7", "tooltip has the ip")
has(tOkAll, "The Netherlands", "tooltip has the country")
has(tOkAll, "\u{1F1F3}\u{1F1F1}", "tooltip has the flag")
has(tOkAll, "last check 09:05:07", "tooltip has the last check time")
ok(!M.tooltipText(geoView, cfgNoFlag).includes("\u{1F1F3}\u{1F1F1}"), "no flag in tooltip when disabled")
ok(!M.tooltipText(geoView, cfgNoCountry).includes("The Netherlands"), "no country text in tooltip when disabled")

const tLoading = M.tooltipText(M.initialView(), cfgShowAll)
has(tLoading, "checking", "loading tooltip calm")

const offlineView = { status: "offline", at: atMorning, data: geoView.data, message: "connection failed", consecutiveFailures: 2 }
const tOff = M.tooltipText(offlineView, cfgShowAll)
has(tOff, "offline", "offline tooltip says offline")
has(tOff, "retrying every 60 s", "offline tooltip names the retry interval")
has(tOff, "last known 203.0.113.7", "offline tooltip keeps last known")
has(tOff, "last check 09:05:07", "offline tooltip has last check time")
const tOffNoCountry = M.tooltipText(offlineView, cfgMinimal)
ok(!tOffNoCountry.includes("(NL)"), "offline tooltip hides country code when disabled")

// fetch edge states map to calm messages (no IP / no network / timeout / rate limit)
has(M.parseFetchResult(0, JSON.stringify({ status: "success", query: "" }) + M.HTTP_MARKER + "200").message, "did not include an IP", "empty query message")
has(M.parseFetchResult(0, "").message, "empty response", "empty output message")
has(M.tooltipText({ status: "offline", at: 1, data: null, message: "rate limited (too many requests)", consecutiveFailures: 2 }, cfgShowAll), "offline", "rate limit keeps calm offline state")
has(M.parseFetchResult(0, "{}" + M.HTTP_MARKER + "429").message, "rate limited", "http 429 text")
has(M.parseFetchResult(0, "{}" + M.HTTP_MARKER + "500").message, "HTTP 500", "http 500 text")

console.log("Model.js: all checks passed")
