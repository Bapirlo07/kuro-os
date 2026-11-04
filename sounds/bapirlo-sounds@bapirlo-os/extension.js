// Kuro Sounds — gives notifications and login a sound from the "bapirlo" sound theme (GNOME Shell 50).
// GNOME only plays a notification sound when the app asks for one; most apps (Discord, Chrome…) don't,
// so this plays the theme's "message-new-instant" (the sword "shing") for them — politely:
//   · never in Do Not Disturb, never for apps whose "Sound Alerts" are off in Settings → Notifications
//   · never while a fullscreen window is focused (games, videos), never if the app played its own sound
//   · at most one every 2 s
// Login: plays "desktop-login" once when the session starts.
// Off switch: gnome-extensions disable bapirlo-sounds@bapirlo-os
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MIN_GAP_US = 2 * GLib.USEC_PER_SEC;

export default class BapirloSoundsExtension extends Extension {
    enable() {
        this._last = 0;
        this._notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._soundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});

        Main.messageTray.connectObject('source-added', (tray, source) => this._watch(source), this);
        for (const source of Main.messageTray.getSources())
            this._watch(source);

        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject('startup-complete', () => {
                // let the desktop settle a moment so the sound lands with the fade-in
                this._loginId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                    this._loginId = 0;
                    this._play('desktop-login', 'Login');
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
        }
    }

    _watch(source) {
        source.connectObject('notification-added', (src, notification) => this._onNotification(notification), this);
    }

    _onNotification(notification) {
        const policy = notification.source?.policy;
        if (!this._notifSettings.get_boolean('show-banners'))       // Do Not Disturb
            return;
        if (policy && (!policy.enableSound || !policy.showBanners))
            return;
        const own = notification.sound;
        if (own && (own._soundName || own._soundFile))              // app brought its own sound
            return;
        if (global.display.focus_window?.is_fullscreen())
            return;
        const now = GLib.get_monotonic_time();
        if (now - this._last < MIN_GAP_US)
            return;
        this._last = now;
        this._play('message-new-instant', 'Notification', notification.source);
    }

    _play(id, description, source = null) {
        if (!this._soundSettings.get_boolean('event-sounds'))
            return;
        // Kuro Sense (round 25): from where the app's window is, if spatial sounds are on
        if (source && globalThis.kuroSpatial?.playFor(id, source))
            return;
        global.display.get_sound_player().play_from_theme(id, description, null);
    }

    disable() {
        if (this._loginId) {
            GLib.source_remove(this._loginId);
            this._loginId = 0;
        }
        for (const source of Main.messageTray.getSources())
            source.disconnectObject(this);
        Main.messageTray.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._notifSettings = null;
        this._soundSettings = null;
    }
}
