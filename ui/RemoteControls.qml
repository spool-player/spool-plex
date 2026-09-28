// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

FocusScope {
    id: root
    required property var provider
    property var controls: []
    property bool textInput: false
    property bool mirror: false
    property bool busy: false
    property string problem: ""
    property int generation: 0
    readonly property string targetId: provider ? String(provider.arguments.targetId || "") : ""

    function message(reason) {
        const code = String(reason && (reason.code || reason.message) || reason)
        if (code.indexOf("target_unauthorized") >= 0)
            return "This player rejected control. Your Plex server account is still signed in."
        if (code.indexOf("remote_target_changed") >= 0 || code.indexOf("remote_not_connected") >= 0)
            return "The selected player changed. Close this panel and select the player again."
        if (code.indexOf("remote_play_unavailable") >= 0)
            return "This server or player cannot securely open these details. Transport controls remain available."
        return "Couldn't control this player. Check the connection and refresh."
    }
    function refresh() {
        if (busy)
            return
        const ticket = ++generation
        busy = true
        problem = ""
        provider.request("remoteControls", {
                             "targetId": targetId
                         }).then(result => {
                             if (ticket !== generation)
                                 return
                             controls = result.controls || []
                             textInput = result.textInput === true
                             mirror = result.mirror === true
                             busy = false
                             Qt.callLater(() => controls.length ? InputKeys.focus(commands) : InputKeys.focus(
                                                                      refreshButton))
                         }, reason => {
                             if (ticket !== generation)
                                 return
                             problem = message(reason)
                             busy = false
                         })
    }
    function send(control, value) {
        if (busy)
            return
        const ticket = ++generation
        busy = true
        problem = ""
        provider.request("remoteControl", {
                             "targetId": targetId,
                             "control": control,
                             "text": value
                         }).then(() => {
                             if (ticket !== generation)
                                 return
                             busy = false
                             if (control === "text")
                                 remoteText.text = ""
                         }, reason => {
                             if (ticket !== generation)
                                 return
                             problem = message(reason)
                             busy = false
                         })
    }
    Component.onCompleted: refresh()
    Component.onDestruction: ++generation

    ColumnLayout {
        anchors.fill: parent
        spacing: Metrics.scaled(12)
        SecondaryText {
            Layout.fillWidth: true
            text: "These commands control the selected Plex player, not this device. Refresh after focusing a text field on the player. Secure text fields are not mirrored."
            wrapMode: Text.Wrap
        }
        SecondaryText {
            Layout.fillWidth: true
            visible: root.problem.length > 0
            text: root.problem
            color: Theme.errorText
            wrapMode: Text.Wrap
        }
        ListView {
            id: commands
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            model: root.controls
            keyNavigationEnabled: true
            KeyNavigation.down: remoteText.visible ? remoteText : mirrorButton.visible ? mirrorButton : refreshButton
            delegate: MenuRow {
                required property var modelData
                required property int index
                width: commands.width
                label: modelData.label
                enabled: !root.busy
                highlighted: ListView.isCurrentItem && commands.activeFocus
                onHovered: commands.currentIndex = index
                onActivated: root.send(modelData.id, undefined)
            }
            function activate() {
                if (currentItem && !root.busy)
                    currentItem.activated()
            }
        }
        TextFieldRow {
            id: remoteText
            Layout.fillWidth: true
            visible: root.textInput
            enabled: !root.busy
            label: "Text for the focused player field"
            KeyNavigation.up: commands
            KeyNavigation.down: sendText
            onAccepted: root.send("text", remoteText.text)
        }
        ActionButton {
            id: sendText
            visible: root.textInput
            enabled: !root.busy
            text: "Send text"
            onClicked: root.send("text", remoteText.text)
            KeyNavigation.up: remoteText
            KeyNavigation.down: mirrorButton.visible ? mirrorButton : refreshButton
        }
        ActionButton {
            id: mirrorButton
            visible: root.mirror
            enabled: !root.busy
            text: "Show current item details on player"
            onClicked: root.send("mirror", undefined)
            KeyNavigation.up: sendText.visible ? sendText : commands
            KeyNavigation.down: refreshButton
        }
        ActionButton {
            id: refreshButton
            enabled: !root.busy
            text: root.busy ? "Working…" : "Refresh player controls"
            onClicked: root.refresh()
            KeyNavigation.up: mirrorButton.visible ? mirrorButton : sendText.visible ? sendText : commands
        }
    }
}
