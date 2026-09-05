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

console.log("Model.js: all checks passed")
