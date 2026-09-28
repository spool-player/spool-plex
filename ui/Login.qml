// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

FocusScope {
    id: root

    property var provider
    property string step: "link"
    property string pin: ""
    property string code: ""
    property var user: ({})
    property var servers: []
    property var homeUsers: []
    property var linkedUser: ({})
    property var selectedHomeUser: ({})
    property bool busy: false
    property string error: ""
    property int generation: 0

    readonly property var messages: ({
                                         "server_unreachable":
                                         "Couldn't reach that server. Check that Plex Media Server is running.",
                                         "network_error": "Couldn't reach Plex. Check your connection and try again.",
                                         "http_401": "Plex rejected the sign-in. Request a new code.",
                                         "origin_denied": "That server address is not allowed.",
                                         "home_authentication_failed": "Plex rejected that PIN. Try again.",
                                         "home_identity_mismatch":
                                         "Plex returned a different identity. Link your account again.",
                                         "unsupported_extension": "Update Spool to switch Plex Home users."
                                     })

    function fail(reason) {
        busy = false
        error = messages[reason] || "Couldn't sign in. Please try again."
    }

    function newCode() {
        poll.stop()
        const ticket = ++generation
        step = "link"
        code = ""
        pin = ""
        error = ""
        user = ({})
        linkedUser = ({})
        homeUsers = []
        servers = []
        homePin.text = ""
        busy = true
        provider.request("pinStart").then(result => {
            if (ticket !== generation)
                return
            busy = false
            pin = result.id
            code = result.code
            poll.start()
        }, reason => {
            if (ticket === generation)
                fail(reason)
        })
    }

    function checkCode() {
        const ticket = generation
        provider.request("pinPoll", {
                             "id": pin
                         }).then(result => {
                             if (ticket !== generation || step !== "link")
                                 return
                             if (result.pending) {
                                 poll.start()
                                 return
                             }
                             user = result.user
                             linkedUser = result.user
                             homeUsers = result.homeUsers || []
                             if (homeUsers.length) {
                                 step = "home"
                                 Qt.callLater(() => InputKeys.focus(list))
                             } else {
                                 showServers(result)
                             }
                         }, reason => {
                             if (ticket !== generation)
                                 return
                             if (reason === "http_404")
                                 newCode()
                             else
                                 fail(reason)
                         })
    }
    function showServers(result) {
        user = result.user
        servers = result.servers || []
        step = "servers"
        if (servers.length === 0)
            error = "No Plex Media Servers are shared with this account."
        else if (servers.length === 1)
            choose(servers[0])
        else
            Qt.callLater(() => InputKeys.focus(list))
    }

    function chooseHome(member) {
        if (busy)
            return
        selectedHomeUser = member
        homePin.text = ""
        error = ""
        if (member.homeProtected) {
            step = "homePin"
            Qt.callLater(() => homePin.focusRow())
        } else {
            submitHome("")
        }
    }

    function submitHome(value) {
        if (busy)
            return
        const ticket = ++generation
        busy = true
        error = ""
        provider.request("homeSelect", {
                             "user": linkedUser,
                             "userId": selectedHomeUser.id,
                             "pin": value
                         }).then(result => {
                             if (ticket !== generation)
                                 return
                             busy = false
                             homePin.text = ""
                             showServers(result)
                         }, reason => {
                             if (ticket === generation) {
                                 homePin.text = ""
                                 fail(reason)
                                 if (step === "homePin")
                                     Qt.callLater(() => homePin.focusRow())
                             }
                         })
    }

    function choose(server) {
        if (busy)
            return
        const ticket = generation
        busy = true
        error = ""
        let allowed = Promise.resolve()
        for (const connection of server.connections)
            allowed = allowed.then(() => provider.allowOrigin(connection.uri))
        allowed.then(() => {
            if (ticket !== generation)
                return null
            return provider.request("connect", {
                                        "server": server,
                                        "user": root.user
                                    })
        }).then(account => {
            if (ticket === generation && account)
                provider.complete(account)
        }, reason => {
            if (ticket === generation) {
                fail(reason)
                Qt.callLater(() => InputKeys.focus(list))
            }
        })
    }

    function back() {
        if (step === "link")
            return false
        if (homeUsers.length && (step === "servers" || step === "homePin")) {
            ++generation
            busy = false
            error = ""
            homePin.text = ""
            user = linkedUser
            servers = []
            step = "home"
            Qt.callLater(() => InputKeys.focus(list))
            return true
        }
        newCode()
        return true
    }

    function activate() {
        const item = Window.activeFocusItem
        if (item && typeof item.activate === "function")
            item.activate()
        else if (item && typeof item.clicked === "function")
            item.clicked()
    }

    Component.onCompleted: newCode()
    Component.onDestruction: {
        ++generation
        poll.stop()
        user = ({})
        linkedUser = ({})
        homePin.text = ""
    }

    Timer {
        id: poll
        interval: 2000
        repeat: false
        onTriggered: root.checkCode()
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Metrics.pageMarginPx
        spacing: Metrics.scaled(12)

        SecondaryText {
            Layout.fillWidth: true
            text: "Independent Spool integration for Plex"
            wrapMode: Text.Wrap
        }

        SecondaryText {
            Layout.fillWidth: true
            text: "Plex and the Plex Play logo are trademarks of Plex and used under a license."
            wrapMode: Text.Wrap
        }

        CompatibilityNotice {
            Layout.fillWidth: true
            provider: root.provider
        }

        AppText {
            Layout.alignment: Qt.AlignHCenter
            text: root.step === "servers" ? "Choose a Plex server" : root.step === "home" ? "Choose a Plex Home user" :
                                                                                            root.step === "homePin"
                                                                                            ? "PIN for "
                                                                                              + root.selectedHomeUser.name :
                                                                                              "Link your Plex account"
            font.pixelSize: Metrics.titleSizePx
        }

        AppText {
            Layout.alignment: Qt.AlignHCenter
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
            horizontalAlignment: Text.AlignHCenter
        }

        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: root.step === "servers" || root.step === "home"
            clip: true
            spacing: Metrics.scaled(8)
            model: root.step === "home" ? root.homeUsers : root.servers
            keyNavigationEnabled: true
            delegate: ServerCard {
                required property var modelData
                focused: ListView.isCurrentItem && list.activeFocus
                width: list.width
                title: modelData.name + (root.step === "home" && modelData.homeProtected ? " · PIN required" : "")
                enabled: !root.busy
                onAccepted: root.step === "home" ? root.chooseHome(modelData) : root.choose(modelData)
            }
            function activate() {
                if (currentItem && !root.busy) {
                    if (root.step === "home")
                        root.chooseHome(root.homeUsers[currentIndex])
                    else
                        root.choose(root.servers[currentIndex])
                }
            }
        }
        TextFieldRow {
            id: homePin
            Layout.fillWidth: true
            visible: root.step === "homePin"
            enabled: !root.busy
            label: "Plex Home PIN"
            echoMode: TextInput.Password
            inputMethodHints: Qt.ImhDigitsOnly | Qt.ImhNoPredictiveText
            onAccepted: root.submitHome(text)
        }

        ActionButton {
            visible: root.step === "homePin"
            enabled: !root.busy
            text: "Continue"
            onClicked: root.submitHome(homePin.text)
        }

        SecondaryText {
            Layout.fillWidth: true
            visible: root.step === "home" || root.step === "homePin"
            text: "Plex Home PINs protect this Plex Home, not other providers signed in to Spool."
            wrapMode: Text.Wrap
        }

        ActionButton {
            visible: root.step === "homePin" || root.step === "servers" && root.homeUsers.length > 0
            text: "Back to Home users"
            onClicked: root.back()
        }

        Item {
            Layout.fillHeight: true
            visible: root.step === "link"
        }

        BusySpinner {
            Layout.alignment: Qt.AlignHCenter
            Layout.preferredWidth: Metrics.scaled(24)
            Layout.preferredHeight: Metrics.scaled(24)
            running: root.busy
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

        ActionButton {
            Layout.alignment: Qt.AlignHCenter
            text: root.step !== "link" ? "Use another Plex account" : "Get a new code"
            enabled: !root.busy
            onClicked: root.newCode()
        }
    }
}
