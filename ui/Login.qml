// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

FocusScope {
    id: root

    property var provider
    // "resume" while an existing sign-in lists its servers, so linking never
    // shows on the way to a list that was already there.
    property string step: ""
    property string pin: ""
    property string code: ""
    property var user: ({})
    property var servers: []
    property var homeUsers: []
    property var linkedUser: ({})
    property var selectedHomeUser: ({})
    property bool busy: false
    property string error: ""
    // The server being connected and the addresses being tried, in order.
    property var connecting: null
    property var trying: []
    property int generation: 0
    readonly property string trademark: "Plex and the Plex Play logo are trademarks of Plex and used under a license."
    readonly property var setupContext: provider && provider.arguments ? provider.arguments.setupContext || ({}) : ({})
    // Accounts already in Spool from Plex, as user@server.
    readonly property var existing: setupContext.existing || []
    readonly property bool addingServer: setupContext.purpose === "addServer"
    // The account's servers came from a sign-in Spool already had, so a
    // different Plex account is one choice away rather than the only way in.
    property bool resumedSignIn: false

    function added(server) {
        const key = String(user.id || "") + "@" + server.id
        return existing.some(entry => entry.account === key)
    }

    function serverDetail(server) {
        const whose = server.owned ? "Your server" : server.owner ? "Shared by " + server.owner : "Shared with you"
        // An address its owner set up reads better than any plex.direct one.
        const own = (server.connections || []).find(connection => !connection.local && !connection.relay && !
                                                                  /^(Local|Remote) · /.test(connection.label || ""))
        return own ? whose + " · " + own.label : whose
    }

    function addressList(labels) {
        return labels.length <= 1 ? labels.join("") : labels.slice(0, -1).join(", ") + " or " + labels[labels.length
                                                                                                       - 1]
    }

    readonly property var messages: ({
                                         "server_unreachable":
                                         "Couldn't reach that server. If it has a custom access URL, choose Enter a server address.",
                                         "network_error": "Couldn't reach Plex. Check your connection and try again.",
                                         "http_401": "Plex sign-in expired. Request a new code to sign in again.",
                                         "invalid_config":
                                         "Saved Plex credentials are incomplete. Request a new code to reconnect.",
                                         "home_relink_required": "Link your Plex account again. Request a new code.",
                                         "account_mismatch":
                                         "Choose the same Plex user and server to reconnect this profile.",
                                         "origin_denied": "That server address is not allowed.",
                                         "invalid_pin": "Plex rejected that PIN. Try again.",
                                         "home_identity_mismatch":
                                         "Plex returned a different identity. Link your account again.",
                                         "invalid_address": "Enter an address such as plex.example.com.",
                                         "address_unreachable":
                                         "Couldn't reach a Plex server at that address. Check it and try again.",
                                         "address_not_shared": "That server isn't available to this Plex account."
                                     })

    function fail(reason) {
        busy = false
        if (reason === "server_unreachable" && connecting && trying.length)
            error = "Couldn't reach " + connecting.name + " at " + addressList(trying)
                    + ". If it has its own web address, choose Enter a server address."
        else
            error = messages[reason] || "Couldn't sign in. Please try again."
        connecting = null
    }

    function newCode() {
        poll.stop()
        resumedSignIn = false
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
    function linked(result) {
        busy = false
        user = result.user
        linkedUser = result.user
        homeUsers = result.homeUsers || []
        if (homeUsers.length) {
            step = "home"
            Qt.callLater(() => form.focusChoices())
        } else {
            showServers(result)
        }
    }

    function resume() {
        if (!setupContext.accountId || setupContext.purpose === "reconnect") {
            newCode()
            return
        }
        const ticket = ++generation
        step = "resume"
        busy = true
        provider.request("setupResume").then(result => {
            if (ticket !== generation)
                return
            if (result.relink) {
                newCode()
            } else {
                resumedSignIn = true
                linked(result)
            }
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
                             linked(result)
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
        // One server is simply tried. If none of the addresses plex.tv lists
        // answer from here, the list stays up with the error, and Enter a
        // server address is right there.
        if (servers.length === 1 && !added(servers[0])) {
            choose(servers[0])
            return
        }
        if (servers.length === 0)
            error = "No Plex Media Servers are shared with this account. You can still enter a server address."
        else if (addingServer && servers.every(server => added(server)))
            error = "Every server on this Plex account is already in Spool."
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
                             "userId": selectedHomeUser.id,
                             "pin": value,
                             "remember": value.length > 0 && form.remember
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
        if (added(server) && !typedAddress && setupContext.purpose !== "reconnect") {
            error = server.name + " is already in Spool."
            return
        }
        const ticket = generation
        busy = true
        error = ""
        connecting = server
        trying = (typedAddress ? [String(typedAddress).replace(/^https?:\/\//i, "")] : []).concat(server.connections.map(
                                                                                                      connection
                                                                                                      => connection.label
                                                                                                         || connection.uri)).filter(
                    (label, index, all) => all.indexOf(label) === index)
        let allowed = Promise.resolve()
        for (const connection of server.connections)
            allowed = allowed.then(() => provider.allowOrigin(connection.uri))
        allowed.then(() => {
            if (ticket !== generation)
                return null
            return provider.request("connect", {
                                        "serverId": server.id,
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
        if (busy)
            provider.request("setupCancel").catch(() => {})
        connecting = null
        if (step === "link" || step === "resume")
            return false
        if (step === "address") {
            ++generation
            busy = false
            error = ""
            step = "servers"
            Qt.callLater(() => form.focusChoices())
            return true
        }
        // Nothing behind a resumed list but the screen that opened it.
        if (step === "servers" && resumedSignIn && !homeUsers.length)
            return false
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
        form.linkUrl = "https://plex.tv/link"
        form.footnote = trademark
        resume()
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
        title: root.step === "servers" || root.step === "resume" ? (root.addingServer ? "Add a Plex server" :
                                                                                        "Choose a Plex server") :
                                                                   root.step === "home" ? "Choose a Plex Home user" :
                                                                                          root.step === "homePin"
                                                                                          ? "PIN for "
                                                                                            + root.selectedHomeUser.name :
                                                                                            "Link your Plex account"
        instructions: root.step === "home" || root.step === "homePin"
                      ? "Plex Home PINs protect this Home, not unrelated accounts signed in to Spool." : root.busy
                        && root.connecting ? "Connecting to " + root.connecting.name + " · trying " + root.addressList(
                                                 root.trying) : root.step === "resume" && root.busy
                                             ? "Finding the servers on your Plex account…" : ""
        choices: root.step === "home" ? root.homeUsers.map(member => ({
            title: member.name + (member.homeProtected ? " · PIN required" : "")
        })) : root.step === "servers" ? root.servers.map(server => ({
            title: server.name,
            address: root.serverDetail(server),
            badge: root.added(server) ? "Added" : ""
        })).concat([
        {
            title: "Enter a server address",
            address: "For a custom access URL, such as plex.example.com",
            icon: "link"
        }
        ]).concat(root.resumedSignIn ? [
        {
            title: "Use a different Plex account",
            address: "Link another account at plex.tv/link",
            icon: "person_add"
        }
        ] : []) : []
        pinRequired: root.step === "homePin"
        pinLabel: "Plex Home PIN"
        rememberLabel: root.selectedHomeUser.homeManaged ? "" : "Skip this PIN when Spool starts"
        rememberDescription: "Spool opens as this user on this device. Switching users still asks."
        retryVisible: root.step === "link" || !!root.error && root.step === "resume"
        backText: root.step !== "link" && root.step !== "resume" ? "Back" : ""
        onRetryRequested: root.newCode()
        onBackRequested: root.back()
        onChoiceSelected: index => root.step === "home" ? root.chooseHome(root.homeUsers[index]) : index < root.servers.length
                                                          ? root.choose(root.servers[index]) : index
                                                            === root.servers.length ? root.enterAddress() : root.newCode(
                                                                                          )

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
                visible: root.busy && root.step === "address"
                text: root.connecting ? "Connecting to " + root.connecting.name + " · trying " + root.addressList(
                                            root.trying) : "Checking " + address.text.trim().replace(/^https?:\/\//i,
                                                                                                     "") + "…"
                wrapMode: Text.WordWrap
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
