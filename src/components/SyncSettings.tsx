import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { PairingOffer, SyncDevice, SyncStatus } from "../types";
import { Icon } from "./Icon";

type Props = {
  status: SyncStatus | null;
  onStatusChange: (status: SyncStatus) => void;
  onNotebookChanged: () => Promise<void>;
  onNotice: (message: string) => void;
};

type PairView = "host" | "join" | "waiting" | null;

export default function SyncSettings({ status, onStatusChange, onNotebookChanged, onNotice }: Props) {
  const [busy, setBusy] = useState(false);
  const [pairView, setPairView] = useState<PairView>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [activeJoinCode, setActiveJoinCode] = useState("");
  const [pairMessage, setPairMessage] = useState("");
  const [deviceName, setDeviceName] = useState(status?.localDeviceName || "");
  const [revoke, setRevoke] = useState<SyncDevice | null>(null);
  const polling = useRef(false);

  useEffect(() => { if (status?.localDeviceName) setDeviceName(status.localDeviceName); }, [status?.localDeviceName]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Android keyboards can send Escape while dismissing themselves. Keep a
      // half-entered pairing code intact instead of closing the whole sheet.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (revoke) setRevoke(null);
      else if (pairView) setPairView(null);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [pairView, revoke]);

  const refreshStatus = async () => {
    const next = await api.getSyncStatus();
    onStatusChange(next);
    return next;
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      onStatusChange({ ...(status || await api.getSyncStatus()), status: "Syncing" });
      const next = await api.syncNow();
      onStatusChange(next); await onNotebookChanged();
      onNotice(next.status === "Synced" ? "Notebook synced" : next.status);
    } catch (error) { onNotice(error instanceof Error ? error.message : "Could not sync right now."); }
    finally { setBusy(false); }
  };

  const copyPairingCode = async () => {
    if (!offer) return;
    try {
      await navigator.clipboard.writeText(offer.code);
      onNotice("Pairing code copied");
    } catch {
      setPairMessage("Copy is unavailable here. Select the code below and copy it manually.");
    }
  };

  const startHostPairing = async () => {
    setBusy(true); setPairMessage("Creating a private one-time code…");
    try {
      const next = await api.startPairing();
      setOffer(next);
      const QRCode = await import("qrcode");
      setQrCode(await QRCode.default.toDataURL(next.code, { width: 244, margin: 1, color: { dark: "#252a32", light: "#ffffff" }, errorCorrectionLevel: "M" }));
      setPairMessage("Scan this on the device you want to add."); setPairView("host");
    } catch (error) { onNotice(error instanceof Error ? error.message : "Could not create a pairing code."); setPairView(null); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (pairView !== "host" || !offer) return;
    const check = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const progress = await api.completePairing(offer.code);
        setPairMessage(progress.message);
        if (progress.ready) {
          setPairView(null); setOffer(null); setQrCode("");
          await refreshStatus(); await onNotebookChanged(); onNotice("New device paired");
        }
      } catch (error) { setPairMessage(error instanceof Error ? error.message : "Pairing paused."); }
      finally { polling.current = false; }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 2200);
    return () => window.clearInterval(timer);
  }, [pairView, offer]);

  const submitJoin = async (value = joinCode) => {
    const code = value.trim(); if (!code) return;
    setBusy(true); setPairMessage("Contacting your other device…");
    try {
      const progress = await api.acceptPairing(code);
      setActiveJoinCode(code); setPairMessage(progress.message); setPairView("waiting");
    } catch (error) { onNotice(error instanceof Error ? error.message : "That pairing code could not be used."); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (pairView !== "waiting" || !activeJoinCode) return;
    const check = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const progress = await api.finishPairing(activeJoinCode);
        setPairMessage(progress.message);
        if (progress.ready) {
          setPairView(null); setActiveJoinCode(""); setJoinCode("");
          await refreshStatus(); await onNotebookChanged(); onNotice("Notebook paired and ready");
        }
      } catch (error) { setPairMessage(error instanceof Error ? error.message : "Still waiting for the other device…"); }
      finally { polling.current = false; }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 2200);
    return () => window.clearInterval(timer);
  }, [pairView, activeJoinCode]);

  const scanCode = async () => {
    setBusy(true);
    try {
      const scanner = await import("@tauri-apps/plugin-barcode-scanner");
      let permission = await scanner.checkPermissions();
      if (permission === "prompt") permission = await scanner.requestPermissions();
      if (permission !== "granted") throw new Error("Camera access is needed to scan the pairing code. You can paste the code instead.");
      const result = await scanner.scan({ cameraDirection: "back", formats: [scanner.Format.QRCode] });
      setJoinCode(result.content); await submitJoin(result.content);
    } catch (error) { onNotice(error instanceof Error ? error.message : "Could not scan that code."); }
    finally { setBusy(false); }
  };

  const renameDevice = async () => {
    const name = deviceName.trim(); if (!name || name === status?.localDeviceName) return;
    setBusy(true);
    try { onStatusChange(await api.renameSyncDevice(name)); onNotice("Device renamed"); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Could not rename this device."); }
    finally { setBusy(false); }
  };

  const removeDevice = async () => {
    if (!revoke) return;
    setBusy(true);
    try { onStatusChange(await api.removeSyncDevice(revoke.id)); setRevoke(null); onNotice(`${revoke.displayName} removed`); void syncNow(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Could not remove that device."); }
    finally { setBusy(false); }
  };

  const activeDevices = status?.devices.filter((device) => !device.revokedAt) || [];
  const pairedDevices = activeDevices.filter((device) => !device.isCurrentDevice);
  const statusClass = status?.status.toLowerCase().replaceAll(" ", "-") || "offline";
  const syncLabel = status?.status === "Offline" && pairedDevices.length === 0 ? "Not set up" : status?.status || "Checking…";

  return <>
    <section className="sync-section settings-card-section">
      <div className="settings-section-heading">
        <span className="settings-icon"><Icon name="share" size={18} /></span>
        <div><strong>Sync</strong><span>Private, end-to-end encrypted device sync.</span></div>
      </div>
      <div className="sync-overview">
        <div className={`sync-state ${statusClass}`}><i /><span>{syncLabel}</span></div>
        <button className="secondary-button" disabled={busy} onClick={() => void syncNow()}><Icon name="undo" size={16} />{busy ? "Working…" : "Sync Now"}</button>
      </div>
      <div className="sync-facts">
        <span>{status?.lastSuccessfulSync ? `Last synced ${relativeTime(status.lastSuccessfulSync)}` : "Not synced yet"}</span>
        <span>{status?.pendingOutgoingChanges ? `${status.pendingOutgoingChanges} change${status.pendingOutgoingChanges === 1 ? "" : "s"} ready to upload` : "No changes waiting"}</span>
      </div>
      {status?.attentionMessage && <div className="sync-attention">{status.attentionMessage}</div>}

      <div className="device-name-row">
        <label><span>This device</span><input value={deviceName} maxLength={80} onChange={(event) => setDeviceName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void renameDevice(); }} /></label>
        <button className="text-action" disabled={busy || !deviceName.trim() || deviceName.trim() === status?.localDeviceName} onClick={() => void renameDevice()}>Save</button>
      </div>

      <div className="device-list" aria-label="Paired devices">
        {activeDevices.map((device) => <div className="device-row" key={device.id}>
          <span className="device-glyph"><Icon name="file" size={17} /></span>
          <div><strong>{device.displayName}</strong><span>{device.isCurrentDevice ? "This device" : device.lastSeenAt ? `Seen ${relativeTime(device.lastSeenAt)}` : "Paired device"}</span></div>
          {!device.isCurrentDevice && <button className="remove-device" onClick={() => setRevoke(device)}>Remove</button>}
        </div>)}
        {pairedDevices.length === 0 && <div className="empty-devices"><span>Your notes are local to this device. Add another device to turn on sync.</span></div>}
      </div>

      <div className="pair-actions">
        <button className="primary-button" disabled={busy} onClick={() => void startHostPairing()}><Icon name="plus" size={17} />Add Device</button>
        <button className="secondary-button" disabled={busy} onClick={() => setPairView("join")}><Icon name="link" size={17} />Pair Existing Notebook</button>
      </div>
    </section>

    {pairView && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPairView(null); }}>
      <div className="pair-dialog" role="dialog" aria-modal="true" aria-labelledby="pair-title">
        <button className="dialog-close" onClick={() => setPairView(null)} aria-label="Close pairing"><span>×</span></button>
        {pairView === "host" && <>
          <span className="dialog-kicker">Add a device</span><h2 id="pair-title">Scan to pair</h2>
          <p>{pairMessage}</p>
          <div className="qr-frame">{qrCode ? <img src={qrCode} alt="One-time Papyrus pairing QR code" /> : <span>Creating code…</span>}</div>
          <div className="pair-expiry"><i />Code expires in about 5 minutes and works once.</div>
          <button className="secondary-button wide" onClick={() => void copyPairingCode()}><Icon name="copy" size={16} />Copy code instead</button>
          <label className="pair-code-fallback"><span>Or select this code to paste on the new device</span><textarea className="pair-code-input" aria-label="Pairing code" rows={3} value={offer?.code || ""} readOnly autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
        </>}
        {pairView === "join" && <>
          <span className="dialog-kicker">Pair this device</span><h2 id="pair-title">Bring your notebook here</h2>
          <p>Scan the one-time code shown on your other Papyrus device, or paste it below.</p>
          <p className="pair-merge-note">Nothing is replaced: the notes already on this device join that notebook, and sync out to its other devices.</p>
          <button className="scan-button" disabled={busy} onClick={() => void scanCode()}><span className="scan-corners"><i /><i /><i /><i /></span><strong>Scan QR code</strong><small>Uses your camera only for this scan</small></button>
          <div className="pair-divider"><span>or paste the code</span></div>
          <textarea className="pair-code-input" rows={3} value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="papyrus-pair-v1:…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <button className="primary-button wide pair-continue" disabled={busy || !joinCode.trim()} onClick={() => void submitJoin()}>{busy ? "Connecting…" : "Continue"}</button>
        </>}
        {pairView === "waiting" && <div className="pair-waiting">
          <span className="waiting-pulse"><i /><i /><i /></span><span className="dialog-kicker">Secure handoff</span><h2 id="pair-title">Almost there</h2><p>{pairMessage}</p><small>Keep Papyrus open on both devices for a moment.</small>
        </div>}
      </div>
    </div>}

    {revoke && <div className="modal-backdrop" role="presentation">
      <div className="pair-dialog compact" role="alertdialog" aria-modal="true" aria-labelledby="revoke-title">
        <span className="dialog-kicker danger">Remove device</span><h2 id="revoke-title">Remove {revoke.displayName}?</h2>
        <p>It will stop receiving new changes. Papyrus cannot erase notes that were already downloaded to that device.</p>
        <div className="dialog-actions"><button className="secondary-button" onClick={() => setRevoke(null)}>Cancel</button><button className="danger-button" disabled={busy} onClick={() => void removeDevice()}>{busy ? "Removing…" : "Remove Device"}</button></div>
      </div>
    </div>}
  </>;
}
