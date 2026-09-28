// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

// Provider-owned playlist/collection management, with explicit sort changes.
FocusScope {
    id: root

    property var provider
    readonly property string kind: provider ? String(provider.arguments.kind || "") : ""
    readonly property bool choosing: kind === "playlist" || kind === "collection"
    readonly property bool naming: choosing || kind === "renameCollection"
    property string error: ""
    property string cursor: ""
    property bool exhausted: true
    property bool busy: false
    function submitPin() {
        const value = homePin.text
        homePin.text = ""
        provider.complete({ "pin": value })
    }

    function loadTargets(append) {
        if (busy)
            return
        busy = true
        provider.requestList("targets", {
                                 "kind": kind,
                                 "itemId": provider.arguments.itemId,
                                 "playlistType": provider.arguments.playlistType || "video",
                                 "cursor": append ? cursor : undefined
                             }, append).then(result => {
                                 cursor = String(result.cursor || "")
                                 exhausted = result.exhausted === true
                                 busy = false
                             }).catch(() => {
                                 busy = false
                                 error = "Couldn't load destinations. Check your connection and permissions."
                             })
    }

    function activate() {
        const item = Window.activeFocusItem
        if (item && typeof item.activate === "function")
            item.activate()
        else if (item && typeof item.clicked === "function")
            item.clicked()
    }

    Component.onCompleted: {
        if (choosing)
            loadTargets(false)
        if (kind === "renameCollection")
            name.text = String(provider.arguments.title || "")
        if (kind !== "remoteControls")
            Qt.callLater(() => kind === "homePin" ? homePin.focusRow()
                         : naming ? name.focusRow() : kind === "collectionSort"
                         ? InputKeys.focus(sortRelease) : InputKeys.focus(confirm))
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Metrics.pageMarginPx
        spacing: Metrics.scaled(12)

        CompatibilityNotice {
            Layout.fillWidth: true
            provider: root.kind === "homePin" ? null : root.provider
        }

        AppText {
            text: ({
                       "playlist": "Add to playlist",
                       "collection": "Add to collection",
                       "renameCollection": "Rename collection",
                       "collectionSort": "Collection order",
                       "confirm": "Delete from the server?",
                       "remoteControls": "Plex player controls",
                       "homePin": "Unlock " + String(root.provider.arguments.title || "Plex Home")
                   })[root.kind] || ""
            font.pixelSize: Metrics.titleSizePx
            font.weight: Font.DemiBold
        }

        SecondaryText {
            Layout.fillWidth: true
            visible: root.error.length > 0
            text: root.error
            color: Theme.errorText
            wrapMode: Text.Wrap
        }

        Loader {
            Layout.fillWidth: true
            Layout.fillHeight: true
            active: root.kind === "remoteControls"
            visible: active
            sourceComponent: Component {
                RemoteControls { provider: root.provider }
            }
        }
        TextFieldRow {
            id: homePin
            Layout.fillWidth: true
            visible: root.kind === "homePin"
            label: "Plex Home PIN"
            echoMode: TextInput.Password
            inputMethodHints: Qt.ImhDigitsOnly | Qt.ImhNoPredictiveText
            onAccepted: root.submitPin()
        }

        SecondaryText {
            Layout.fillWidth: true
            visible: root.kind === "homePin"
            text: "Enter this user's PIN. Cancelling keeps your current account active."
            wrapMode: Text.Wrap
        }

        ActionButton {
            visible: root.kind === "homePin"
            text: "Unlock"
            onClicked: root.submitPin()
        }

        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: root.choosing
            clip: true
            model: root.provider ? root.provider.rows : null
            focus: true
            keyNavigationEnabled: true
            delegate: MenuRow {
                required property var record
                required property int index
                width: list.width
                label: record.title
                iconName: root.kind === "collection" ? "video_library" : "playlist_play"
                highlighted: ListView.isCurrentItem && list.activeFocus
                onHovered: list.currentIndex = index
                onActivated: root.provider.complete({
                                                        "targetId": record.id,
                                                        "targetName": record.title
                                                    })
            }
            function activate() {
                if (currentItem)
                    currentItem.activated()
            }
        }

        ActionButton {
            visible: root.choosing && !root.exhausted
            enabled: !root.busy
            text: root.busy ? "Loading…" : "Load more"
            onClicked: root.loadTargets(true)
        }

        ColumnLayout {
            visible: root.kind === "collectionSort"
            Layout.fillWidth: true
            SecondaryText {
                Layout.fillWidth: true
                text: "Choose Custom to enable moving entries. Changing order affects this collection on the server."
                wrapMode: Text.Wrap
            }
            ActionButton {
                id: sortRelease
                text: "Release date"
                onClicked: root.provider.complete({ "sort": 0 })
            }
            ActionButton {
                text: "Alphabetical"
                onClicked: root.provider.complete({ "sort": 1 })
            }
            ActionButton {
                text: "Custom"
                onClicked: root.provider.complete({ "sort": 2 })
            }
        }

        TextFieldRow {
            id: name
            Layout.fillWidth: true
            visible: root.naming
            label: root.kind === "renameCollection" ? "Collection name"
                   : root.kind === "collection" ? "New collection" : "New playlist"
            onAccepted: if (text.trim().length > 0)
                            root.provider.complete({
                                                       "newName": text.trim()
                                                   })
        }

        RowLayout {
            Layout.alignment: Qt.AlignRight
            spacing: Metrics.scaled(10)
            ActionButton {
                text: root.kind === "remoteControls" ? "Close" : "Cancel"
                kind: "flat"
                onClicked: root.provider.close()
            }
            ActionButton {
                id: confirm
                visible: root.kind === "confirm" || root.naming && name.text.trim().length > 0
                enabled: !root.busy
                kind: root.kind === "confirm" ? "danger" : "primary"
                text: root.kind === "confirm" ? "Delete" : root.kind === "renameCollection" ? "Save" : "Create"
                onClicked: root.provider.complete(root.kind === "confirm" ? {
                                                                                "confirmed": true
                                                                            } : {
                                                      "newName": name.text.trim()
                                                  })
            }
        }
    }
}
