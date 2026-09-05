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
// copy action (wl-copy) and a manual refresh. The poll state is owned by the
// bar widget (hostWidget.view), so the bar label and this panel never
// disagree. When the widget is offline the panel stays calm: it marks the
// state and keeps showing the last known address.
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
  readonly property var address: view.data
  readonly property bool hasOk: Model.isOk(root.view)
  readonly property bool hasData: Model.hasData(root.view)

  readonly property color statusColor: Model.isOk(root.view)
    ? root.success : (Model.isLoading(root.view) ? root.warn : root.danger)

  readonly property string statusText: Model.statusLabel(root.view)
  readonly property string ipText: hasData ? address.ip : (Model.isLoading(root.view) ? "\u2014" : "\u2014")
  readonly property string countryText: hasData
    ? (address.country ? address.country + (address.countryCode ? "  " + Model.flagEmoji(address.countryCode) : "") : (address.countryCode || "\u2014"))
    : "\u2014"
  readonly property string flagGlyph: hasData && address.countryCode ? Model.flagEmoji(address.countryCode) : ""
  readonly property string locationText: hasData ? (Model.locationLine(address) || "\u2014") : "\u2014"
  readonly property string ispText: hasData ? (address.isp || address.org || "\u2014") : "\u2014"
  readonly property string asText: hasData ? (address.as || "\u2014") : "\u2014"
  readonly property string checkedText: root.view.at ? Model.formatTime(root.view.at) : "\u2014"

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

  // Copy the public IPv4 to the Wayland clipboard. The address only ever
  // travels as a positional argument to a fixed printf/wl-copy chain (the
  // address is validated by Model.normalizeData, digits/dots only).
  function copyIp() {
    if (!hasData) return
    copyProc.command = [
      "bash", "-c",
      "printf '%s' \"$1\" | wl-copy --type text/plain",
      "myip-copy", address.ip
    ]
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

      Column {
        id: content
        width: parent ? parent.width : implicitWidth
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

        // ---- big address -------------------------------------------------
        Column {
          width: parent.width
          spacing: Style.space(2)

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
            text: root.flagGlyph !== ""
              ? root.flagGlyph + "  " + address.country
              : (hasData ? address.country : "")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            horizontalAlignment: Text.AlignHCenter
            visible: hasData && address.country !== ""
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
            label: "Country"
            value: root.countryText
          }
          InfoPair {
            label: "Location"
            value: root.locationText
          }
          InfoPair {
            label: "ISP"
            value: root.ispText
          }
          InfoPair {
            label: "AS"
            value: root.asText
          }
          InfoPair {
            label: "Last checked"
            value: root.checkedText
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
