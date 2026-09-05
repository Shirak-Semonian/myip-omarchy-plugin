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
// Quiet by design (DS-7 lesson):
//   * one heartbeat Timer + ONE reusable Process — at most one curl request
//     in flight, at most one per poll interval (default 60 s);
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
  Timer {
    id: pollTimer
    interval: 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.tick()
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
