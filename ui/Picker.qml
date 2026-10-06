// SPDX-License-Identifier: MPL-2.0
import QtQuick
import Spool

Loader {
    id: picker
    property var provider
    readonly property bool downloading: provider && String(provider.arguments.kind || "").indexOf("download") === 0
    sourceComponent: downloading ? downloadPicker : actionPicker
    Component {
        id: downloadPicker
        FocusScope {
            id: downloadScope
            Column {
                id: downloadColumn
                anchors.fill: parent
                spacing: Metrics.scaled(12)
                AppText {
                    text: picker.provider.arguments.kind === "downloadPart" ? "Choose part" : "Choose version"
                    font.pixelSize: Metrics.titleSizePx
                }
                SecondaryText {
                    text: String(picker.provider.arguments.modeLabel || "")
                }
                ListView {
                    id: downloadChoices
                    width: parent.width
                    height: Math.max(0, parent.height - y)
                    clip: true
                    keyNavigationEnabled: true
                    model: picker.provider.arguments.choices
                    delegate: MenuRow {
                        required property var modelData
                        width: ListView.view.width
                        highlighted: ListView.isCurrentItem && downloadChoices.activeFocus
                        label: modelData.label + (modelData.unavailable ? " · File unavailable on server" : "")
                        enabled: !modelData.unavailable
                        onActivated: picker.provider.complete({
                                                                  variantId: modelData.variantId,
                                                                  partId: modelData.partId
                                                              })
                    }
                    function activate() {
                        if (currentItem && currentItem.enabled)
                            currentItem.activated()
                    }
                }
            }
            Component.onCompleted: Qt.callLater(() => InputKeys.focus(downloadChoices))
        }
    }
    Component {
        id: actionPicker
        ProviderActionPicker {
            id: root
            provider: picker.provider
            pinLabel: "Plex Home PIN"
            pinExplanation: "Enter this user's PIN. Cancelling keeps your current account active."
            sortChoices: [
                {
                    label: "Release date",
                    value: 0
                },
                {
                    label: "Alphabetical",
                    value: 1
                },
                {
                    label: "Custom",
                    value: 2
                }
            ]
            remoteControls: Component {
                ProviderRemoteControls {
                    provider: root.provider
                    commandKey: "control"
                    valueKey: "text"
                    textCapability: "textInput"
                    textCommand: "text"
                    mirrorCommand: "mirror"
                    instructions:
                        "These commands control the selected Plex player, not this device. Refresh after focusing a text field on the player. Secure text fields are not mirrored."
                    errorMessages: ({
                                        target_unauthorized:
                                        "This player rejected control. Your Plex server account is still signed in.",
                                        remote_target_changed:
                                        "The selected player changed. Close this panel and select the player again.",
                                        remote_not_connected:
                                        "The selected player changed. Close this panel and select the player again.",
                                        remote_play_unavailable:
                                        "This server or player cannot securely open these details. Transport controls remain available."
                                    })
                }
            }
        }
    }
}
