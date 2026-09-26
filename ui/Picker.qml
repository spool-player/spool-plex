// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

// Finishes an item action: which playlist to add to (or a new one), or
// confirming a delete. Completes with the choice.
FocusScope {
    id: root

    property var provider
    readonly property string kind: provider ? String(provider.arguments.kind || "") : ""
    readonly property bool choosing: kind === "playlist"
    property string error: ""

    function activate() {
        const item = Window.activeFocusItem
        if (item && typeof item.activate === "function")
            item.activate()
        else if (item && typeof item.clicked === "function")
            item.clicked()
    }

    Component.onCompleted: {
        if (choosing)
            provider.requestList("targets", {
                                     "kind": kind,
                                     "playlistType": provider.arguments.playlistType || "video"
                                 }).catch(() => error = "Couldn't load playlists. You can still create one.")
        Qt.callLater(() => choosing ? name.focusRow() : InputKeys.focus(confirm))
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Metrics.pageMarginPx
        spacing: Metrics.scaled(12)

        AppText {
            text: ({
                       "playlist": "Add to playlist",
                       "confirm": "Delete from the server?"
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
                iconName: "playlist_play"
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

        TextFieldRow {
            id: name
            Layout.fillWidth: true
            visible: root.choosing
            label: "New playlist"
            onAccepted: if (text.trim().length > 0)
                            root.provider.complete({
                                                       "newName": text.trim()
                                                   })
        }

        RowLayout {
            Layout.alignment: Qt.AlignRight
            spacing: Metrics.scaled(10)
            ActionButton {
                text: "Cancel"
                kind: "flat"
                onClicked: root.provider.close()
            }
            ActionButton {
                id: confirm
                visible: root.kind === "confirm" || name.text.trim().length > 0
                kind: root.kind === "confirm" ? "danger" : "primary"
                text: root.kind === "confirm" ? "Delete" : "Create"
                onClicked: root.provider.complete(root.kind === "confirm" ? {
                                                                                "confirmed": true
                                                                            } : {
                                                      "newName": name.text.trim()
                                                  })
            }
        }
    }
}
