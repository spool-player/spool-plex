// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

FocusScope {
    id: root

    property var provider
    property bool homeSupported: false
    property var home: ({})
    property bool busy: false
    property string error: ""
    readonly property bool automaticSignIn: {
        const options = provider ? provider.activationConfiguration : null
        return options && typeof options.homeAutomaticSignIn === "boolean"
            ? options.homeAutomaticSignIn : Boolean(home.automaticSignIn)
    }

    function loadHome() {
        provider.request("extensionStatus").then(status => {
            homeSupported = status.enabled["spool.account-activation"] === 1
            if (homeSupported)
                return provider.request("homeSettings").then(result => home = result)
        }).catch(() => error = "Couldn't load Plex Home settings.")
    }

    function toggleAutomatic() {
        if (busy || !home.writable)
            return
        busy = true
        error = ""
        provider.request("homeAutomaticSignIn", { "enabled": !root.automaticSignIn }).then(() => {
            busy = false
            loadHome()
        }, () => {
            busy = false
            error = "Couldn't change automatic sign-in."
        })
    }

    Component.onCompleted: {
        loadHome()
        Qt.callLater(() => InputKeys.focus(closeButton))
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Metrics.pageMarginPx
        spacing: Metrics.scaled(12)

        AppText {
            Layout.fillWidth: true
            text: "Plex settings"
            font.pixelSize: Metrics.titleSizePx
            font.weight: Font.DemiBold
        }

        CompatibilityNotice {
            Layout.fillWidth: true
            provider: root.provider
        }

        AppText {
            Layout.fillWidth: true
            text: "Playback and appearance preferences are available in Spool settings."
            wrapMode: Text.WordWrap
        }
        SecondaryText {
            Layout.fillWidth: true
            visible: root.homeSupported
            text: root.home.available
                  ? "Plex Home protects this Home, not unrelated accounts signed in to Spool. Automatic sign-in is local to this device and skips only the last-used user's startup PIN. Switching protected users still requires their PIN."
                  : "To use Plex Home, add an account and link it at plex.tv/link. Existing server-only accounts keep ordinary playback."
            wrapMode: Text.WordWrap
        }

        ActionButton {
            visible: root.homeSupported && root.home.available && root.home.writable
            enabled: !root.busy
            text: "Automatic sign-in: " + (root.automaticSignIn ? "On" : "Off")
            onClicked: root.toggleAutomatic()
        }

        SecondaryText {
            Layout.fillWidth: true
            visible: root.homeSupported && root.home.available && !root.home.writable
            text: "Only an authenticated regular Plex Home account can change automatic sign-in."
            wrapMode: Text.WordWrap
        }

        SecondaryText {
            Layout.fillWidth: true
            visible: root.error.length > 0
            text: root.error
            color: Theme.errorText
            wrapMode: Text.WordWrap
        }

        Item { Layout.fillHeight: true }

        ActionButton {
            id: closeButton
            Layout.alignment: Qt.AlignRight
            text: "Close"
            onClicked: root.provider.close()
        }
    }
}
