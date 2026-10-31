import { useState } from "react";
import { notificationSupport, useBrowserAlertPrefs } from "../hooks/useBrowserAlerts";
import { ToggleRow } from "./SettingRows";

const NOTES = {
  insecure:
    "Desktop notifications need HTTPS or localhost; this page is served over plain HTTP. Reach it through an SSH tunnel, Tailscale Serve or an HTTPS reverse proxy, or add an ntfy channel under Alert notifications instead.",
  unsupported: "Desktop notifications are not available in this browser.",
  blocked: "Notifications are blocked for this site. Allow them in the browser's site settings and switch this on again.",
  refused: "The browser rejected the request for notification permission.",
  revoked: "Notification permission has since been revoked in the browser, so nothing will appear until it is allowed again.",
} as const;

/**
 * Settings rows for the tab badge and desktop notifications. These live in
 * this browser's localStorage and save on click, separately from the server
 * settings saved by the dialog. Both follow the Overview exceptions strip.
 */
export function BrowserAlertsSettings() {
  const [prefs, setPrefs] = useBrowserAlertPrefs();
  const [requesting, setRequesting] = useState(false);
  const [clickNote, setClickNote] = useState<string | null>(null);
  const support = notificationSupport();

  const enableDesktop = async () => {
    if (support !== "ok") return;
    setRequesting(true);
    try {
      // Request permission only here, inside the click: prompts without a user
      // gesture are ignored or penalised by browsers.
      let permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission === "granted") {
        setPrefs({ ...prefs, desktop: true });
        setClickNote(null);
      } else {
        setClickNote(NOTES.blocked);
      }
    } catch {
      setClickNote(NOTES.refused);
    } finally {
      setRequesting(false);
    }
  };

  const onDesktop = () => {
    if (!prefs.desktop) {
      void enableDesktop();
      return;
    }
    setPrefs({ ...prefs, desktop: false });
    setClickNote(null);
  };

  let note: string | null = clickNote;
  if (note === null) {
    if (support === "insecure") note = NOTES.insecure;
    else if (support === "unsupported") note = NOTES.unsupported;
    else if (prefs.desktop && Notification.permission === "denied") note = NOTES.revoked;
  }

  return (
    <>
      <ToggleRow
        title="Tab badge"
        help="Shows the number of Overview exceptions in the tab title, e.g. “(2) sparkDash”, and puts a red (critical) or amber dot on the tab icon. Stored in this browser and applied at once."
        checked={prefs.tabBadge}
        onChange={(next) => setPrefs({ ...prefs, tabBadge: next })}
      />
      <ToggleRow
        title="Desktop notifications"
        help={
          <>
            Pops up a system notification when an exception starts while this page is open. Stored in this browser and applied at once.
            {note ? (
              <span role="note" className="set-row__note">
                {note}
              </span>
            ) : null}
          </>
        }
        checked={support === "ok" && prefs.desktop}
        disabled={requesting || support !== "ok"}
        onChange={onDesktop}
      />
    </>
  );
}
