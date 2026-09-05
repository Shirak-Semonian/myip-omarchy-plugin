import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// MyIP details panel.
//
// Shows the current public IPv4 with country/flag, location and ISP/AS, a
// copy action (fixed Omarchy clipboard IPC) and a manual refresh. The poll
// state is owned by the bar widget (hostWidget.view), so the bar label and
// this panel never disagree. When the widget is offline the panel stays
// calm: it marks the state and keeps showing the last known address. When
// the optional config file is broken, the panel shows a calm
// "config file needs attention" card with reset/open actions and the widget
// keeps running on defaults; config contents are never displayed.
//
// The panel mirrors the bar's persisted address-change
// tracker, so it can show the address family, the moment of the last change
// and the short history of previous public IPs (with a calm empty state
// before the first change ever happens).
//
// showCountry/showFlag from the config gate the country name and the
// flag emoji in every display string; alertOnChange gates the change popup
// (honored by the bar widget, mirrored here as a status row).
Panel {
  id: root
  moduleName: "io.github.shirak-semonian.myip"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color success: "#a3be8c"
  readonly property color warn: "#ebcb8b"
  readonly property color danger: "#bf616a"
  readonly property color surface: Color.popups.background
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var view: hostWidget && hostWidget.view ? hostWidget.view : Model.initialView()
  readonly property var cfg: hostWidget && hostWidget.config ? hostWidget.config : Model.defaults()
  // NOTE: data fields are read inline from root.view.data (never cached into
  // an intermediate property): caching would let a guard see fresh `hasData`
  // while the cached address is still the old/null one during a view change,
  // producing transient "cannot read property of null" warnings.
  readonly property bool hasOk: Model.isOk(root.view)
  readonly property bool hasData: Model.hasData(root.view)

  // Display preferences: showCountry/showFlag are honored in every
  // user-facing string; alertOnChange is honored in the bar widget.
  readonly property bool showCountry: root.cfg.showCountry !== false
  readonly property bool showFlag: root.cfg.showFlag !== false
  readonly property bool alertOnChange: root.cfg.alertOnChange !== false

  // Config attention: mirror the bar's config problem (static text,
  // never file content) and offer reset/open actions.
  readonly property string configError: hostWidget && hostWidget.configError
    ? hostWidget.configError : ""
  readonly property string configPath: hostWidget && hostWidget.configPath
    ? hostWidget.configPath : ""

  readonly property color statusColor: Model.isOk(root.view)
    ? root.success : (Model.isLoading(root.view) ? root.warn : root.danger)

  readonly property string statusText: Model.statusLabel(root.view)
  readonly property string ipText: root.view && root.view.data
    ? root.view.data.ip : "—"
  readonly property string countryLine: {
    // One calm row: country name (when enabled) + flag (when enabled).
    var data = root.view && root.view.data ? root.view.data : null
    if (!data) return ""
    var parts = []
    if (root.showCountry && data.country) parts.push(data.country)
    if (root.showFlag && data.countryCode) {
      var flag = Model.flagEmoji(data.countryCode)
      if (flag) parts.push(flag)
    }
    return parts.join("  ")
  }
  readonly property string locationText: root.showCountry
    ? (root.view && root.view.data ? (Model.locationLine(root.view.data) || "—") : "")
    : ""
  readonly property string ispText: root.view && root.view.data
    ? (root.view.data.isp || root.view.data.org || "—") : "—"
  readonly property string asText: root.view && root.view.data
    ? (root.view.data.as || "—") : "—"
  readonly property string checkedText: root.view.at ? Model.formatTime(root.view.at) : "—"

  // Address-change tracker (mirrored from the bar widget root). The
  // panel reads the same persisted tracker the bar feeds, so the history and
  // the last-change time can never disagree with the notifications.
  readonly property var tracker: hostWidget && hostWidget.tracker
    ? hostWidget.tracker : Model.emptyTracker()
  readonly property var history: Model.historyEntries(root.tracker)
  readonly property bool hasHistory: root.history.length > 0
  readonly property string familyText: root.view && root.view.data && root.view.data.ip
    ? Model.familyOf(root.view.data.ip) : ""
  // Last change time: the moment the current address became current. "never"
  // until the first real change (a fresh baseline is not a change).
  readonly property string changedText: !hasData ? "\u2014"
    : (root.hasHistory && root.tracker.firstSeenAt > 0
      ? Model.formatTime(root.tracker.firstSeenAt) : "never")

  property bool copied: false
  property bool copyFailed: false
  property string _copyFlash: ""

  readonly property string copyButtonText: root.copied ? "Copied \u2713"
    : (root.copyFailed ? "Copy failed" : (hasData ? "Copy IP" : "No address yet"))

  function open() {
    root.controller.show()
  }

  function close() {
    root.controller.hide()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  function refreshNow() {
    if (hostWidget && typeof hostWidget.refreshNow === "function") {
      hostWidget.refreshNow()
    }
  }

  function resetConfigFile() {
    if (hostWidget && typeof hostWidget.resetConfigFile === "function") {
      hostWidget.resetConfigFile()
    }
  }

  function openConfigFile() {
    if (hostWidget && typeof hostWidget.openConfigFile === "function") {
      hostWidget.openConfigFile()
    }
  }

  // Copy the public IPv4 to the Wayland clipboard via Omarchy's fixed
  // clipboard IPC (argv only — no shell, no user-configurable copy command,
  // no interpolation of user input).
  function copyIp() {
    if (!root.view || !root.view.data) return
    var omarchyPath = Quickshell.env("OMARCHY_PATH")
    var binDir = omarchyPath ? omarchyPath + "/bin" : "/usr/bin"
    copyProc.command = Model.copyCommandArgs(binDir, root.view.data.ip)
    copyProc.running = true
  }

  KeyboardPanel {
    id: popup
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(Style.space(360))
    contentHeight: popup.fittedContentHeight(content.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      // The whole panel scrolls when the screen is short (history grows the
      // content); the card keeps its fitted height and the column scrolls
      // inside it instead of overflowing the popup edge.
      Flickable {
        id: panelScroll
        anchors.fill: parent
        contentWidth: content.width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

      Column {
        id: content
        width: panelScroll.width
        spacing: Style.space(12)

        PanelHero {
          id: heroCard
          width: parent.width
          title: "MyIP"
          meta: "Public IP monitor"
          detail: root.statusText.toUpperCase()
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            Image {
              width: heroCard.iconSize
              height: width
              source: Qt.resolvedUrl("assets/icon.png")
              sourceSize.width: 128
              sourceSize.height: 128
              fillMode: Image.PreserveAspectFit
              smooth: true
            }
          }
        }

        // ---- config file needs attention ---------------------------------
        // Calm, static problem text (never raw file content) + the two safe
        // repair actions. The widget keeps working on defaults meanwhile.
        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: root.configError !== ""

          Text {
            width: parent.width
            text: "Config file needs attention"
            color: root.warn
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: true
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            width: parent.width
            text: root.configError
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            width: parent.width
            text: root.configPath
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            width: parent.width
            text: "MyIP is running with defaults. Nothing is lost — your current "
              + "file is kept as a backup before a fresh one is written."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }

          Button {
            width: parent.width
            text: "Reset to defaults"
            iconText: "\uf0c5"
            foreground: root.foreground
            fontFamily: root.fontFamily
            focusable: true
            onClicked: root.resetConfigFile()
          }

          Button {
            width: parent.width
            text: "Open config file"
            iconText: "\uf044"
            foreground: root.foreground
            fontFamily: root.fontFamily
            focusable: true
            onClicked: root.openConfigFile()
          }
        }

        // ---- big address -------------------------------------------------
        Column {
          width: parent.width
          spacing: Style.space(2)
          // While the config file is broken and no address is known yet, the
          // attention card above is the whole story; with a known address we
          // keep showing it calmly underneath.
          visible: root.configError === "" || root.hasData

          Text {
            width: parent.width
            text: root.ipText
            color: root.hasData && hasOk ? root.foreground : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.space(30)
            font.bold: true
            font.letterSpacing: 1.5
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            width: parent.width
            text: root.countryLine
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            horizontalAlignment: Text.AlignHCenter
            visible: text !== ""
          }

          Text {
            width: parent.width
            text: !root.hasOk && root.view.message
              ? root.view.message : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            visible: text !== ""
          }
        }

        // ---- actions -----------------------------------------------------
        Row {
          width: parent.width
          spacing: Style.space(8)

          Button {
            id: copyButton
            width: (parent.width - Style.space(8)) / 2
            text: root.copyButtonText
            iconText: "\uf0c5"
            foreground: root.foreground
            fontFamily: root.fontFamily
            focusable: true
            opacity: root.hasData ? 1.0 : 0.55
            onClicked: root.copyIp()
          }

          Button {
            id: refreshButton
            width: (parent.width - Style.space(8)) / 2
            text: "Check now"
            iconText: "\uf021"
            foreground: root.foreground
            fontFamily: root.fontFamily
            focusable: true
            onClicked: root.refreshNow()
          }
        }

        PanelSeparator {
          foreground: root.foreground
        }

        // ---- details -----------------------------------------------------
        Column {
          width: parent.width
          spacing: Style.space(10)

          InfoPair {
            label: "Status"
            value: root.statusText
            valueColor: root.statusColor
          }
          InfoPair {
            label: "Change alert"
            value: root.alertOnChange ? "on" : "off"
            valueColor: root.alertOnChange ? root.success : root.dim
            visible: root.hasData
          }
          InfoPair {
            label: "Country"
            value: root.countryLine !== "" ? root.countryLine : "\u2014"
            visible: root.hasData
          }
          InfoPair {
            label: "Location"
            value: root.locationText !== "" ? root.locationText : "\u2014"
            visible: root.hasData && root.showCountry
          }
          InfoPair {
            label: "ISP"
            value: root.ispText
            visible: root.hasData
          }
          InfoPair {
            label: "AS"
            value: root.asText
            visible: root.hasData
          }
          InfoPair {
            label: "Address family"
            value: root.familyText !== "" ? root.familyText : "\u2014"
            visible: root.hasData
          }
          InfoPair {
            label: "Last change"
            value: root.changedText
            visible: root.hasData
          }
          InfoPair {
            label: "Last checked"
            value: root.checkedText
            visible: root.hasData
          }
        }

        // ---- address history ---------------------------------------------
        PanelSeparator {
          foreground: root.foreground
          visible: root.hasData
        }

        PanelSectionHeader {
          text: "Address history"
          foreground: root.foreground
          fontFamily: root.fontFamily
          visible: root.hasData
        }

        // Empty history is a calm, instructive state — not an empty column.
        Text {
          width: parent.width
          text: "No changes yet \u2014 your previous public IPs will appear "
            + "here after your address changes."
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          visible: root.hasData && !root.hasHistory
        }

        Column {
          width: parent.width
          spacing: Style.space(2)
          visible: root.hasData && root.hasHistory

          Repeater {
            model: root.history

            delegate: Row {
              width: content.width
              spacing: Style.space(6)
              height: Style.space(18)

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: root.showFlag && modelData.countryCode
                  ? Model.flagEmoji(modelData.countryCode) + "  " + modelData.ip
                  : modelData.ip
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
                width: content.width - Style.space(70)
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: Model.formatTime(modelData.at)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                horizontalAlignment: Text.AlignRight
                width: Style.space(64)
              }
            }
          }
        }

        Text {
          width: parent.width
          text: "Address data: " + Model.PROVIDER_NAME
            + " \u00b7 no key \u00b7 checked every "
            + (hostWidget && hostWidget.config ? hostWidget.config.pollIntervalSeconds
              : Model.DEFAULT_POLL_INTERVAL_SECONDS) + " s"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          horizontalAlignment: Text.AlignHCenter
        }

        Text {
          width: parent.width
          text: !root.hasOk && root.hasData
            ? "Offline \u2014 showing the last known address; the next check happens automatically."
            : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          horizontalAlignment: Text.AlignHCenter
          visible: text !== ""
        }
      }
    }
    }
  }

  Process {
    id: copyProc
    command: []
    onExited: function(exitCode) {
      root.copied = exitCode === 0
      root.copyFailed = exitCode !== 0
      flashResetTimer.restart()
    }
  }

  Timer {
    id: flashResetTimer
    interval: 1600
    running: false
    repeat: false
    onTriggered: {
      root.copied = false
      root.copyFailed = false
    }
  }

  component InfoPair: RowLayout {
    property string label: ""
    property string value: ""
    property color valueColor: root.foreground

    width: parent ? parent.width : implicitWidth
    spacing: Style.space(8)

    Text {
      text: parent.label
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      Layout.fillWidth: true
      text: parent.value
      color: parent.valueColor
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
      horizontalAlignment: Text.AlignRight
    }
  }
}
