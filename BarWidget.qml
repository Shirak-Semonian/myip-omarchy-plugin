import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// MyIP — public IP + country/flag bar widget.
//
// The bar shows the custom MyIP icon, the widget name and the live public IP
// with its flag emoji: `[icon] MyIP 203.0.113.7 🇳🇱`. Hovering gives a calm
// tooltip (status + country + ISP). Left/right click toggles the details
// panel; middle click forces an immediate check.
//
// MI-2 (address-change detection): every successful check feeds a tiny
// persistent tracker (state file + short history). The first sighting after
// a state reset is a silent baseline — a fresh install or a shell restart
// with an unchanged address never rings. When the public IP really changes,
// the widget sends exactly one quiet Omarchy notification
// ("IP changed: OLD → NEW", country included when known), deduped across
// twin bar instances with a flock gate.
//
// Quiet by design (DS-7 lesson):
//   * one heartbeat Timer + one reusable fetch Process — at most one curl
//     request in flight, at most one per poll interval (default 60 s);
//     the extra Processes only run when an address change happens (state
//     write + notification), never on the polling cadence;
//   * _dueAt is a `double` epoch (Date.now() ~1.7e12) — an `int` would wrap
//     at 2^31 and turn the dueAt guard into polling-spam;
//   * after every attempt (success OR failure) the next poll is scheduled a
//     full interval away, so offline never spams retries;
//   * a poll result that belongs to an older run (stale-result guard, epoch
//     check) is dropped; the Model reducer additionally drops out-of-order
//     events.
//
// Polling lives here (never in the panel) so every bar instance and the
// panel share one source of truth.
BarWidget {
  id: root
  moduleName: "io.github.shirak-semonian.myip"

  // ---- config / state ----------------------------------------------------
  property var config: Model.defaults()
  property var view: Model.initialView()
  // Millisecond epoch (Date.now() ~1.7e12): must be double, never int.
  property double _dueAt: 0
  property int _epoch: 0
  property string _output: ""
  property string _logKey: ""

  // ---- MI-2: address-change tracker + notifications ----------------------
  // The tracker (last known address + short history) lives in a tiny JSON
  // state file so a restart can never re-announce an unchanged address and
  // the panel can show the history. Loaded once at startup; observations
  // that arrive before the file resolves are queued and drained after.
  property var tracker: Model.emptyTracker()
  property bool _trackerLoaded: false
  property var _pendingObservations: []
  property string _trackerWriteText: ""
  property var _notifQueue: []
  property var _notifPending: null
  property bool _notifGateMode: false
  property string _notifOut: ""

  readonly property string stateFile: {
    var base = Quickshell.env("XDG_STATE_HOME")
    if (!base) base = (Quickshell.env("HOME") || "") + "/.local/state"
    return base + "/myip/state.json"
  }
  readonly property string notifGateFile: {
    var base = Quickshell.env("XDG_STATE_HOME")
    if (!base) base = (Quickshell.env("HOME") || "") + "/.local/state"
    return base + "/myip/notifications.gate"
  }

  // ---- display helpers ---------------------------------------------------
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool hasOk: Model.isOk(root.view)
  readonly property bool loading: Model.isLoading(root.view)
  readonly property bool offline: Model.isOffline(root.view)
  readonly property bool dimmed: Model.isDimmed(root.view)

  readonly property string valueText: Model.barValueText(root.view)
  readonly property string flagText: Model.isOk(root.view) && root.view.data
    ? Model.flagEmoji(root.view.data.countryCode) : ""

  // ---- panel popup. Shape contract for shell summon/hide/toggle routing:
  //      Bar.findPanelWidget requires open/close/opened on the bar-widget
  //      root, so those are forwarded to the loaded Panel.qml.
  readonly property bool opened: panelLoader.item
    ? panelLoader.item.opened === true
    : false
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true
    : false

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function handlePressed(buttonCode) {
    if (buttonCode === Qt.MiddleButton) root.refreshNow()
    else root.togglePanel()
  }

  // Manual refresh (middle click / panel button). Forces a fetch on the next
  // heartbeat when the process is idle; a busy process keeps its single
  // in-flight request and fetches right after it finishes.
  function refreshNow() {
    root._dueAt = 0
    root.tick()
  }

  // Copy the current public IPv4 to the clipboard. Exposed so the shell IPC
  // (`omarchy-shell shell <id> copy`) and the panel share one path.
  function copyIp() {
    var target = panelLoader.item
    if (target && typeof target.copyIp === "function") target.copyIp()
  }

  // One heartbeat tick. Starts a fetch only when the process is idle AND the
  // poll interval has elapsed — the actual polling cadence.
  function tick() {
    if (proc.running) return
    if (Date.now() < root._dueAt) return
    root.view = Model.reduce(root.view, { type: "fetchStart" })
    root._output = ""
    var cmd = Model.buildFetchCommand(root.config)
    if (!cmd || cmd.length === 0) return
    proc.runEpoch = ++root._epoch
    proc.command = cmd
    proc.running = true
  }

  function handleExited(exitCode) {
    var intervalMs = (root.config ? root.config.pollIntervalSeconds
      : Model.DEFAULT_POLL_INTERVAL_SECONDS) * 1000
    // Whatever the outcome, the next poll is a full interval away: a failing
    // endpoint never turns this into a retry loop.
    root._dueAt = Date.now() + intervalMs
    // Stale-result guard: if a newer poll started while this request was
    // finishing, its own exit will deliver the fresh result; drop this one.
    if (proc.runEpoch !== root._epoch) return
    var output = String(probeStdout.text || root._output || "")
    var result = Model.parseFetchResult(exitCode, output)
    var at = Date.now()
    var next = result.ok
      ? Model.reduce(root.view, {
          type: "fetchSuccess", data: result.data, at: at
        })
      : Model.reduce(root.view, {
          type: "fetchFail", kind: result.kind, message: result.message, at: at
        })
    var key = next.status + "|" + (next.message || "")
    if (key !== root._logKey) {
      root._logKey = key
      console.log("MyIP: " + Model.statusLine(next))
    }
    root.view = next
    // A fresh successful check feeds the address-change tracker (baseline,
    // history, one notification per real change). Failed checks never touch
    // the tracker: they cannot erase or re-announce anything.
    if (result.ok) root.observeAddress(result.data, at)
  }

  // ---- MI-2: address-change tracking -------------------------------------
  // Feeds one fresh observation into the pure Model reducer, persists the
  // tracker when it moved (baseline or change) and queues a notification for
  // every real change event. The reducer emits at most one event per
  // transition, so a poll that re-observes the same address stays silent.
  function observeAddress(data, at) {
    if (!data || !data.ip) return
    if (!root._trackerLoaded) {
      root._pendingObservations.push({ data: data, at: at })
      return
    }
    var res = Model.trackObservation(root.tracker, {
      ip: data.ip, country: data.country,
      countryCode: data.countryCode, at: at
    })
    if (!Model.sameTracker(root.tracker, res.state)) {
      root.tracker = res.state
      root._trackerWriteText = Model.trackerToText(root.tracker)
      root.kickTrackerWrite()
    }
    for (var i = 0; i < res.events.length; i++) {
      root.enqueueChangeNotification(res.events[i])
    }
  }

  function loadTracker(raw) {
    var text = String(raw == null ? "" : raw)
    root.tracker = text.trim() === ""
      ? Model.emptyTracker()
      : Model.trackerFromText(text)
    root._trackerLoaded = true
    var pending = root._pendingObservations
    root._pendingObservations = []
    for (var i = 0; i < pending.length; i++) {
      root.observeAddress(pending[i].data, pending[i].at)
    }
  }

  function drainPendingTrackerLoad() {
    if (root._trackerLoaded) return
    trackerFile.reload()
  }

  // Atomic state-file writer with coalescing: at most one write in flight,
  // the latest tracker text wins. A write that fails is simply retried on
  // the next state change (the in-memory tracker stays authoritative).
  function kickTrackerWrite() {
    if (trackerWriteProc.running) return
    if (root._trackerWriteText === "") return
    var text = root._trackerWriteText
    root._trackerWriteText = ""
    trackerWriteProc.command = Model.writeFileCommandArgs(root.stateFile, text)
    trackerWriteProc.running = true
  }

  // One Omarchy notification per real IP change, deduped across twin bar
  // instances through the flock gate (Model.notifGateCommandArgs): the first
  // instance to reach the gate sends; twins that observed the same change
  // skip. Gate failures degrade to "skip" — never to a duplicate.
  function enqueueChangeNotification(event) {
    var parts = Model.changeNotificationParts(event)
    if (!parts || !parts.summary) return
    var args = []
    var omarchyPath = Quickshell.env("OMARCHY_PATH")
    if (omarchyPath) args.push(omarchyPath + "/bin/omarchy-notification-send")
    else args.push("/usr/bin/omarchy-notification-send")
    args = args.concat(["--app-name", "MyIP", "-u", parts.urgency,
      "-g", parts.glyph, parts.summary, parts.body])
    root._notifQueue.push({ event: event, args: args })
    root.runNextChangeNotification()
  }

  function runNextChangeNotification() {
    if (notifProc.running) return
    if (root._notifQueue.length === 0) return
    var entry = root._notifQueue[0]
    root._notifQueue = root._notifQueue.slice(1)
    root._notifPending = entry
    root._notifGateMode = true
    root._notifOut = ""
    notifProc.command = Model.notifGateCommandArgs(root.notifGateFile,
      Model.changeGateKey(entry.event), Model.CHANGE_GATE_TTL_SECONDS)
    notifProc.running = true
  }

  function finishChangeNotification(exitCode, output) {
    if (root._notifGateMode) {
      root._notifGateMode = false
      var gate = String(output == null ? "" : output).trim()
      var entry = root._notifPending
      root._notifPending = null
      if (gate === "send" && entry && entry.args) {
        var parts = Model.changeNotificationParts(entry.event)
        console.log("MyIP: notification — "
          + (parts && parts.body ? parts.body : "IP changed"))
        notifProc.command = entry.args
        notifProc.running = true
        return
      }
      Qt.callLater(root.runNextChangeNotification)
      return
    }
    root._notifPending = null
    Qt.callLater(root.runNextChangeNotification)
  }

  // Reserve the natural width of the composed label so the bar slot matches
  // the visible content (icon + name + value + optional flag).
  implicitWidth: iconImage.width + Style.space(6) + nameText.implicitWidth
    + Style.space(6) + valueText.implicitWidth
    + (flagTextItem.visible ? Style.space(5) + flagTextItem.implicitWidth : 0)
    + Style.space(16)
  implicitHeight: root.barSize

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  // Heartbeat. Runs the tick gate once per second; tick() itself decides
  // when a request may actually start (idle process + interval elapsed).
  // Before the tracker file has been resolved (or confirmed missing) the
  // tick is paused so the first observation can never race the baseline.
  Timer {
    id: pollTimer
    interval: 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: {
      if (!root._trackerLoaded) {
        root.drainPendingTrackerLoad()
        return
      }
      root.tick()
    }
  }

  // The persisted address-change tracker (last known IP + short history).
  // watchChanges is off on purpose: the file is only read once at startup;
  // every write goes through the coalescing writer below, never through
  // this view. A missing file resolves immediately to the silent-baseline
  // empty tracker.
  FileView {
    id: trackerFile
    path: root.stateFile
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadTracker(text())
    onLoadFailed: root.loadTracker("")
  }

  Process {
    id: proc
    property int runEpoch: -1
    command: []
    stdout: StdioCollector {
      id: probeStdout
      waitForEnd: true
      onStreamFinished: root._output = text
    }
    onExited: function(exitCode) {
      root.handleExited(exitCode)
    }
  }

  // State-file writer (coalesced, atomic). See kickTrackerWrite().
  Process {
    id: trackerWriteProc
    command: []
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        console.warn("MyIP: could not write the address state file")
      }
      root.kickTrackerWrite()
    }
  }

  // Change-notification dispatcher: first the cross-instance flock gate
  // (prints "send"/"skip"), then — only on "send" — the real
  // omarchy-notification-send call. See runNextChangeNotification().
  Process {
    id: notifProc
    command: []
    stdout: StdioCollector {
      id: notifStdout
      waitForEnd: true
      onStreamFinished: root._notifOut = text
    }
    onExited: function(exitCode) {
      var output = String(notifStdout.text || root._notifOut || "")
      root._notifOut = ""
      root.finishChangeNotification(exitCode, output)
    }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // Shell IPC: `omarchy-shell shell summon|hide|toggle <id>` routes here.
  IpcHandler {
    target: root.moduleName
    function refresh(): void { root.refreshNow() }
    function copy(): void { root.copyIp() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  // Full-size interaction layer. Its own label is hidden; the composed
  // content below (plain visuals — they do not consume mouse events) sits on
  // top, so hover/press/tooltip all still land on this button.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: " "
    labelVisible: false
    tooltipText: Model.tooltipText(root.view,
      root.config ? root.config.pollIntervalSeconds : Model.DEFAULT_POLL_INTERVAL_SECONDS)
    onPressed: function(buttonCode) {
      root.handlePressed(buttonCode)
    }
  }

  Item {
    id: contentRow
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.leftMargin: Style.space(8)
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    opacity: root.dimmed ? 0.6 : 1.0

    Behavior on opacity {
      NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
    }

    Image {
      id: iconImage
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      width: 16
      height: 16
      source: Qt.resolvedUrl("assets/icon.png")
      sourceSize.width: 128
      sourceSize.height: 128
      fillMode: Image.PreserveAspectFit
      smooth: true
    }

    Text {
      id: nameText
      anchors.left: iconImage.right
      anchors.leftMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: "MyIP"
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      verticalAlignment: Text.AlignVCenter
    }

    Text {
      id: valueText
      anchors.left: nameText.right
      anchors.leftMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: root.valueText
      color: root.hasOk ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      verticalAlignment: Text.AlignVCenter

      Behavior on color {
        enabled: !root.bar || root.bar.foregroundAnimationEnabled
        ColorAnimation { duration: 160 }
      }
    }

    // Flag emoji (regional indicators, e.g. 🇳🇱). Rendered by the Qt color
    // emoji font fallback; empty while there is no fresh country to show.
    Text {
      id: flagTextItem
      anchors.left: valueText.right
      anchors.leftMargin: Style.space(5)
      anchors.verticalCenter: parent.verticalCenter
      text: root.flagText
      visible: text !== ""
      font.pixelSize: Style.font.body
      verticalAlignment: Text.AlignVCenter
    }
  }
}
