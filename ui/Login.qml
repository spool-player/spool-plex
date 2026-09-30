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
    readonly property string trademark: "Plex and the Plex Play logo are trademarks of Plex and used under a license."
    // Spool builds with a link-aware sign-in screen show plex.tv/link as a
    // link and the notice as small print; older ones get both in the text.
    readonly property bool hostLinks: typeof form.linkUrl === "string"

    readonly property var messages: ({
                                         "server_unreachable":
                                         "Couldn't reach that server. If it has a custom access URL, choose Enter a server address.",
                                         "network_error": "Couldn't reach Plex. Check your connection and try again.",
                                         "http_401": "Plex rejected the sign-in. Request a new code.",
                                         "origin_denied": "That server address is not allowed.",
                                         "home_authentication_failed": "Plex rejected that PIN. Try again.",
                                         "home_identity_mismatch":
                                         "Plex returned a different identity. Link your account again.",
                                         "unsupported_extension": "Update Spool to switch Plex Home users.",
                                         "invalid_address": "Enter an address such as plex.example.com.",
                                         "address_unreachable":
                                         "Couldn't reach a Plex server at that address. Check it and try again.",
                                         "address_not_shared": "That server isn't available to this Plex account."
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
        form.pinText = ""
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
                                 Qt.callLater(() => form.focusChoices())
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
        // Even one server is shown rather than chosen: the addresses plex.tv
        // lists may not work from here, and Enter a server address must stay
        // reachable before anything is tried.
        if (servers.length === 0)
            error = "No Plex Media Servers are shared with this account. You can still enter a server address."
        Qt.callLater(() => form.focusChoices())
    }

    function enterAddress() {
        if (busy)
            return
        error = ""
        step = "address"
        Qt.callLater(() => address.focusRow())
    }

    // A custom access URL, when plex.tv does not list the one that works.
    // The address names its server itself; it is only used if that server
    // is one this account can open.
    function submitAddress(text) {
        const typed = String(text || "").trim()
        if (busy || typed.length === 0)
            return
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : "https://" + typed
        const ticket = ++generation
        busy = true
        error = ""
        provider.allowOrigin(url).then(() => provider.request("identify", {
                                                                  "address": typed
                                                              })).then(result => {
                                                                  if (ticket !== generation)
                                                                      return
                                                                  busy = false
                                                                  const server = servers.find(candidate => candidate.id
                                                                                                           === result.id)
                                                                  if (server)
                                                                      choose(server, result.address)
                                                                  else
                                                                      fail("address_not_shared")
                                                              }, reason => {
                                                                  if (ticket === generation)
                                                                      fail(reason === "invalid_address" || reason
                                                                           === "origin_denied" ? reason :
                                                                                                 "address_unreachable")
                                                              })
    }

    function chooseHome(member) {
        if (busy)
            return
        selectedHomeUser = member
        form.pinText = ""
        error = ""
        if (member.homeProtected) {
            step = "homePin"
            Qt.callLater(() => form.focusPin())
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
                             form.pinText = ""
                             showServers(result)
                         }, reason => {
                             if (ticket === generation) {
                                 form.pinText = ""
                                 fail(reason)
                                 if (step === "homePin")
                                     Qt.callLater(() => form.focusPin())
                             }
                         })
    }

    function choose(server, typedAddress) {
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
                                        "user": root.user,
                                        "address": typedAddress || ""
                                    })
        }).then(account => {
            if (ticket === generation && account)
                provider.complete(account)
        }, reason => {
            if (ticket === generation) {
                fail(reason)
                Qt.callLater(() => form.focusChoices())
            }
        })
    }

    function back() {
        if (step === "link")
            return false
        if (step === "address") {
            ++generation
            busy = false
            error = ""
            step = "servers"
            Qt.callLater(() => form.focusChoices())
            return true
        }
        if (homeUsers.length && (step === "servers" || step === "homePin")) {
            ++generation
            busy = false
            error = ""
            form.pinText = ""
            user = linkedUser
            servers = []
            step = "home"
            Qt.callLater(() => form.focusChoices())
            return true
        }
        newCode()
        return true
    }

    function activate() {
        if (step === "address")
            submitAddress(address.text)
        else
            form.activate()
    }

    Component.onCompleted: {
        if (hostLinks) {
            form.linkUrl = "https://plex.tv/link"
            form.footnote = trademark
        }
        newCode()
    }
    Component.onDestruction: {
        ++generation
        poll.stop()
        user = ({})
        linkedUser = ({})
        form.pinText = ""
    }

    Timer {
        id: poll
        interval: 2000
        repeat: false
        onTriggered: root.checkCode()
    }

    ProviderLinkScreen {
        id: form
        anchors.fill: parent
        visible: root.step !== "address"
        provider: root.provider
        busy: root.busy
        error: root.error
        code: root.step === "link" ? root.code : ""
        title: root.step === "servers" ? "Choose a Plex server" : root.step === "home" ? "Choose a Plex Home user" :
                                                                                         root.step === "homePin"
                                                                                         ? "PIN for "
                                                                                           + root.selectedHomeUser.name :
                                                                                           "Link your Plex account"
        instructions: root.step === "link" ? (root.hostLinks ? "" : "Enter this code at plex.tv/link.\n"
                                                               + root.trademark) : root.step === "home" || root.step
                                             === "homePin"
                                             ? "Plex Home PINs protect this Home, not unrelated accounts signed in to Spool." :
                                               ""
        choices: root.step === "home" ? root.homeUsers.map(member => ({
            title: member.name + (member.homeProtected ? " · PIN required" : "")
        })) : root.step === "servers" ? root.servers.map(server => ({
            title: server.name,
            address: server.connections && server.connections.length ? server.connections[0].uri : ""
        })).concat([
        {
            title: "Enter a server address",
            address: "For a custom access URL, such as plex.example.com"
        }
        ]) : []
        pinRequired: root.step === "homePin"
        pinLabel: "Plex Home PIN"
        backText: root.step !== "link" ? "Back" : ""
        onRetryRequested: root.newCode()
        onBackRequested: root.back()
        onChoiceSelected: index => root.step === "home" ? root.chooseHome(root.homeUsers[index]) : index >= root.servers.length
                                                          ? root.enterAddress() : root.choose(root.servers[index])

        onPinSubmitted: value => root.submitHome(value)
    }

    FocusScope {
        anchors.fill: parent
        visible: root.step === "address"
        ColumnLayout {
            anchors.centerIn: parent
            width: Math.min(parent.width - Metrics.pageMarginPx * 2, Metrics.scaled(720))
            spacing: Metrics.scaled(16)
            AppText {
                Layout.fillWidth: true
                text: "Your server's address"
                font.pixelSize: Metrics.scaled(40)
                font.weight: Font.DemiBold
                wrapMode: Text.WordWrap
            }
            AppText {
                Layout.fillWidth: true
                text: "Use the custom server access URL set in your Plex server's network settings."
                color: Theme.textSecondary
                font.pixelSize: Metrics.scaled(20)
                wrapMode: Text.WordWrap
            }
            TextFieldRow {
                id: address
                Layout.fillWidth: true
                label: "Address"
                placeholderText: "plex.example.com"
                inputMethodHints: Qt.ImhUrlCharactersOnly | Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onAccepted: root.submitAddress(text)
            }
            BusySpinner {
                Layout.alignment: Qt.AlignHCenter
                Layout.preferredWidth: Metrics.scaled(24)
                Layout.preferredHeight: Metrics.scaled(24)
                running: root.busy && root.step === "address"
                visible: running
            }
            SecondaryText {
                Layout.fillWidth: true
                visible: !!root.error
                text: root.error
                color: Theme.errorText
                wrapMode: Text.WordWrap
            }
            Flow {
                Layout.fillWidth: true
                spacing: Metrics.scaled(12)
                ActionButton {
                    kind: "primary"
                    text: "Connect"
                    enabled: !root.busy && address.text.trim().length > 0
                    onClicked: root.submitAddress(address.text)
                }
                ActionButton {
                    kind: "flat"
                    text: "Back"
                    onClicked: root.back()
                }
            }
        }
    }
}
