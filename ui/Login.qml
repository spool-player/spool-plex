// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

// Signing in to Plex: a code to enter at plex.tv/link, then one of the
// account's servers.
FocusScope {
    id: root

    property var provider
    property string step: "link"
    property string pin: ""
    property string code: ""
    property var user: ({})
    property var servers: []
    property bool busy: false
    property string error: ""

    readonly property var messages: ({
                                         "server_unreachable": "Couldn't reach that server",
                                         "network_error": "Couldn't reach Plex"
                                     })

    function fail(reason) {
        busy = false
        error = messages[reason] || "Something went wrong"
    }

    function newCode() {
        code = ""
        error = ""
        provider.request("pinStart").then(result => {
            pin = result.id
            code = result.code
            poll.start()
        }, fail)
    }

    function linked(result) {
        poll.stop()
        user = result.user
        servers = result.servers || []
        if (servers.length === 1)
            choose(servers[0])
        else if (servers.length === 0)
            error = "No servers on this Plex account"
        else
            step = "servers"
    }

    // Every address the server has is allowed, then the first that answers
    // is the one the account keeps.
    function choose(server) {
        busy = true
        error = ""
        let allowed = Promise.resolve()
        for (const connection of server.connections)
            allowed = allowed.then(() => provider.allowOrigin(connection.uri))
        allowed.then(() => provider.request("connect", {
                                                "server": server,
                                                "user": root.user
                                            })).then(account => provider.complete(account), fail)
    }

    function back() {
        if (step === "link")
            return false
        step = "link"
        newCode()
        return true
    }

    function activate() {
        const item = Window.activeFocusItem
        if (item && typeof item.activate === "function")
            item.activate()
    }

    Component.onCompleted: newCode()

    Timer {
        id: poll
        interval: 2000
        repeat: true
        onTriggered: root.provider.request("pinPoll", {
                                               "id": root.pin
                                           }).then(result => {
                                               if (!result.pending)
                                                   root.linked(result)
                                           }, reason => {
                                               // An expired code is gone; show a fresh one.
                                               if (reason === "http_404") {
                                                   poll.stop()
                                                   root.newCode()
                                               }
                                           })
    }

    ColumnLayout {
        x: Math.max(Metrics.pageMarginPx, (parent.width - width) / 2)
        y: Metrics.pageMarginPx
        width: Math.min(root.width - Metrics.pageMarginPx * 2, Metrics.scaled(560))
        spacing: Metrics.scaled(12)

        AppText {
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: Metrics.scaled(12)
            visible: root.step === "link" && root.code.length > 0
            text: root.code
            font.pixelSize: Metrics.scaled(56)
            font.weight: Font.DemiBold
            font.letterSpacing: Metrics.scaled(8)
        }

        SecondaryText {
            Layout.fillWidth: true
            visible: root.step === "link" && root.code.length > 0
            text: "Enter this code at plex.tv/link"
            color: Theme.textMuted
            horizontalAlignment: Text.AlignHCenter
        }

        Repeater {
            id: list
            model: root.step === "servers" ? root.servers : []
            delegate: ServerCard {
                id: card
                required property var modelData
                required property int index
                Layout.fillWidth: true
                title: modelData.name
                onAccepted: root.choose(modelData)
                Component.onCompleted: if (index === 0)
                                           Qt.callLater(() => InputKeys.focus(card))
            }
        }

        BusySpinner {
            Layout.alignment: Qt.AlignHCenter
            Layout.preferredWidth: Metrics.scaled(24)
            Layout.preferredHeight: Metrics.scaled(24)
            running: root.busy || (root.step === "link" && root.code.length === 0 && root.error.length === 0)
            visible: running
        }

        SecondaryText {
            Layout.fillWidth: true
            visible: root.error.length > 0
            text: root.error
            color: Theme.errorText
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
        }
    }
}
