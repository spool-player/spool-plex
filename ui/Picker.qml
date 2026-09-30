// SPDX-License-Identifier: MPL-2.0
import QtQuick
import Spool

ProviderActionPicker {
    id: root
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
