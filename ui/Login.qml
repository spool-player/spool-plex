// SPDX-License-Identifier: MPL-2.0
import QtQuick
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
        if (servers.length === 0)
            error = "No Plex Media Servers are shared with this account."
        else if (servers.length === 1)
            choose(servers[0])
        else
            Qt.callLater(() => form.focusChoices())
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
                Qt.callLater(() => form.focusChoices())
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
        form.activate()
    }

    Component.onCompleted: newCode()
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
        provider: root.provider
        busy: root.busy
        error: root.error
        code: root.step === "link" ? root.code : ""
        title: root.step === "servers" ? "Choose a Plex server" : root.step === "home" ? "Choose a Plex Home user" :
                                                                                         root.step === "homePin"
                                                                                         ? "PIN for "
                                                                                           + root.selectedHomeUser.name :
                                                                                           "Link your Plex account"
        instructions: root.step === "link"
                      ? "Enter this code at plex.tv/link.\nPlex and the Plex Play logo are trademarks of Plex and used under a license." :
                        root.step === "home" || root.step === "homePin"
                        ? "Plex Home PINs protect this Home, not unrelated accounts signed in to Spool." : ""
        choices: root.step === "home" ? root.homeUsers.map(member => ({
            title: member.name + (member.homeProtected ? " · PIN required" : "")
        })) : root.step === "servers" ? root.servers.map(server => ({
            title: server.name,
            address: server.connections && server.connections.length ? server.connections[0].uri : ""
        })) : []
        pinRequired: root.step === "homePin"
        pinLabel: "Plex Home PIN"
        backText: root.step !== "link" ? "Back" : ""
        onRetryRequested: root.newCode()
        onBackRequested: root.back()
        onChoiceSelected: index => root.step === "home" ? root.chooseHome(root.homeUsers[index]) : root.choose(
                                                              root.servers[index])

        onPinSubmitted: value => root.submitHome(value)
    }
}
