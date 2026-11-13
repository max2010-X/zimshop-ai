import { useEffect, useState, type FormEvent } from "react";
import { Activity, CircleAlert, Download, LoaderCircle, MessageSquareText, Plus, Radio, RefreshCw, Send, Settings2, Smartphone, Trash2 } from "lucide-react";

type GatewayDevice = Record<string, unknown> & { id?: string; deviceId?: string; name?: string; model?: string; lastSeen?: string; simCards?: Array<Record<string, unknown>> };
type GatewayStatus = { mode: string; api_url: string; auth_type: string; configured: boolean; sending_enabled: boolean; connected: boolean; health: unknown; devices: GatewayDevice[]; error: string | null };
type Conversation = { id: string; contact: string; phone_number: string; direction: string; message: string; delivery_status: string; created_at: string };
type ProviderMessage = Record<string, unknown> & { id?: string; state?: string; phoneNumbers?: string[]; textMessage?: { text?: string }; createdAt?: string };
type Webhook = Record<string, unknown> & { id?: string; url?: string; event?: string };

const apiBase = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function rows<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)[key])) {
    return (value as Record<string, T[]>)[key];
  }
  return [];
}

function display(value: unknown, empty = "Not reported") {
  return typeof value === "string" && value ? value : empty;
}

export default function GatewayWorkspace() {
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [providerMessages, setProviderMessages] = useState<ProviderMessage[]>([]);
  const [inbox, setInbox] = useState<Record<string, unknown>[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [settingsText, setSettingsText] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEvent, setWebhookEvent] = useState("sms:received");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [selectedDevice, setSelectedDevice] = useState("");
  const [selectedSim, setSelectedSim] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  async function refresh() {
    setLoading(true);
    setNotice("");
    try {
      const status = await request<GatewayStatus>("/api/v1/gateway/status");
      setGateway(status);
      const results = await Promise.allSettled([
        request<Conversation[]>("/api/v1/bot/conversations"),
        request<unknown>("/api/v1/gateway/messages?limit=50"),
        request<unknown>("/api/v1/gateway/inbox?limit=50"),
        request<unknown>("/api/v1/gateway/webhooks"),
        request<unknown>("/api/v1/gateway/settings"),
      ]);
      if (results[0].status === "fulfilled") setConversations(results[0].value);
      if (results[1].status === "fulfilled") setProviderMessages(rows<ProviderMessage>(results[1].value, "messages"));
      if (results[2].status === "fulfilled") setInbox(rows<Record<string, unknown>>(results[2].value, "messages"));
      if (results[3].status === "fulfilled") setWebhooks(rows<Webhook>(results[3].value, "webhooks"));
      if (results[4].status === "fulfilled") {
        setSettingsText(JSON.stringify(results[4].value, null, 2));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not connect to the SMSGate API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function registerWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("webhook");
    setNotice("");
    try {
      await request("/api/v1/gateway/webhooks", {
        method: "POST",
        body: JSON.stringify({ url: webhookUrl, event: webhookEvent }),
      });
      setWebhookUrl("");
      await refresh();
      setNotice("Webhook registered with SMSGate.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not register webhook.");
    } finally {
      setBusy("");
    }
  }

  async function removeWebhook(id: string) {
    setBusy(id);
    try {
      await request(`/api/v1/gateway/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
      setNotice("Webhook removed.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove webhook.");
    } finally {
      setBusy("");
    }
  }

  async function removeDevice(id: string) {
    if (!window.confirm("Remove this SMSGate device? The provider warns this can delete its associated messages.")) return;
    setBusy(id);
    try {
      await request(`/api/v1/gateway/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
      setNotice("Device removed from SMSGate.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove this device.");
    } finally {
      setBusy("");
    }
  }

  async function cancelMessage(id: string) {
    setBusy(id);
    try {
      await request(`/api/v1/gateway/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
      setNotice("Cancellation requested. The SMSGate device may already have started sending.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not cancel this message.");
    } finally {
      setBusy("");
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("settings");
    try {
      const payload = JSON.parse(settingsText) as Record<string, unknown>;
      const updated = await request<unknown>("/api/v1/gateway/settings", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setSettingsText(JSON.stringify(updated, null, 2));
      setNotice("Gateway settings updated.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Settings must be valid JSON and accepted by SMSGate.");
    } finally {
      setBusy("");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("send");
    setNotice("");
    try {
      await request("/api/v1/gateway/send", {
        method: "POST",
        body: JSON.stringify({
          phone_number: recipient,
          message,
          device_id: selectedDevice || null,
          sim_number: selectedSim ? Number(selectedSim) : null,
        }),
      });
      setRecipient("");
      setMessage("");
      await refresh();
      setNotice("SMS accepted into the SMSGate queue.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not queue this SMS.");
    } finally {
      setBusy("");
    }
  }

  const devices = gateway?.devices || [];
  const received = conversations.filter((item) => item.direction === "in");
  const sent = conversations.filter((item) => item.direction === "out");
  const pending = sent.filter((item) => ["pending", "queued"].includes(item.delivery_status));
  const failed = sent.filter((item) => ["failed", "queue_failed", "cancelled"].includes(item.delivery_status));

  return (
    <div className="bot-page gateway-page">
      <header className="bot-page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> SMSGATE / CONTROL PLANE</div><h1>Integration<span>.</span></h1><p>Manage the existing SMSGate service without exposing gateway credentials to the browser.</p></div>
        <div className="gateway-heading-actions"><a className="button button-secondary" href="https://github.com/capcom6/android-sms-gateway/releases/latest/download/app-release.apk"><Download size={15} />Download Android APK</a><button className="button button-secondary" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} />{loading ? "Refreshing" : "Refresh"}</button></div>
      </header>

      {notice && <div className="notice bot-notice" role="status"><CircleAlert size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}

      <section className="whatsapp-connect gateway-status-panel">
        <div className="whatsapp-symbol"><Radio size={19} /></div>
        <div className="whatsapp-connect-copy"><strong>{gateway?.configured ? `${gateway.mode} gateway ${gateway.connected ? "reachable" : "unavailable"}` : "Gateway connection not configured"}</strong><p>{gateway?.error || (gateway?.configured ? `${gateway.api_url} · ${gateway.auth_type.toUpperCase()} authentication · ${gateway.sending_enabled ? "sending enabled" : "sending disabled"}` : "Set SMSGATE_MODE, SMSGATE_API_URL when needed, and SMSGATE_USERNAME / SMSGATE_PASSWORD on the Python API server. Credentials and JWTs never enter frontend code.")}</p></div>
        <span className={`connect-indicator ${gateway?.connected ? "gateway-online" : ""}`}><i />{gateway?.connected ? "API ONLINE" : "OFFLINE"}</span>
      </section>

      {!gateway?.sending_enabled && <div className="bot-safety-note"><Activity size={14} /><span>Outbound SMS is disabled by the server launch switch. Device, inbox, and settings views remain read-only until it is enabled.</span></div>}

      <section className="bot-metrics gateway-metrics">
        <div><span>CONNECTED DEVICES</span><strong>{loading ? "—" : devices.length}</strong><small>Live SMSGate API response</small></div>
        <div><span>INCOMING</span><strong>{received.length}</strong><small>Messages recorded by ZimShop</small></div>
        <div><span>OUTGOING</span><strong>{sent.length}</strong><small>Queued and status events recorded</small></div>
        <div><span>NEEDS ATTENTION</span><strong>{pending.length + failed.length}</strong><small>{pending.length} pending · {failed.length} failed</small></div>
      </section>

      <section className="sms-operations-section gateway-section">
        <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> REGISTERED DEVICES</span><h2>Connected Android devices</h2></div><Smartphone size={18} /></div>
        {devices.length ? <div className="gateway-device-grid">{devices.map((device, index) => {
          const deviceId = String(device.id || device.deviceId || `device-${index}`);
          const simCards = Array.isArray(device.simCards) ? device.simCards : [];
                  return <article className="gateway-device" key={deviceId}><div className="gateway-device-top"><span><Smartphone size={17} /></span><span className="gateway-device-state">{display(device.status, "REGISTERED")}</span></div><strong>{display(device.name || device.model, `Gateway device ${index + 1}`)}</strong><small>{deviceId}</small>{simCards.length ? <div className="gateway-sims">{simCards.map((sim, simIndex) => <span key={`${deviceId}-sim-${simIndex}`}>SIM {display(sim.simNumber, String(simIndex + 1))} · {display(sim.carrierName, "Carrier unknown")} · {display(sim.phoneNumber, "Number unavailable")}</span>)}</div> : <p>SIM details aren’t reported by this gateway mode or device.</p>}<small>Last seen: {display(device.lastSeen, "Not reported")}</small>{gateway?.mode !== "local" && <button className="button button-quiet" type="button" onClick={() => void removeDevice(deviceId)} disabled={busy === deviceId}><Trash2 size={14} />Remove device</button>}</article>;
        })}</div> : <div className="gateway-empty"><Smartphone size={18} /><p>{loading ? "Loading registered devices…" : gateway?.mode === "local" ? "Local Server mode does not provide account device listing; use the local health status and webhook events." : "No devices were returned by SMSGate. Start the official SMSGate app and register this phone with the configured account."}</p></div>}
      </section>

      <div className="gateway-workspace-grid">
        <section className="sms-operations-section gateway-section">
          <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> INBOX / RECENT</span><h2>Incoming messages</h2></div><MessageSquareText size={18} /></div>
          {inbox.length ? <div className="gateway-message-list">{inbox.slice(0, 20).map((item, index) => <article key={String(item.id || index)}><strong>{display(item.sender || item.phone_number, "Unknown sender")}</strong><time>{display(item.receivedAt || item.received_at || item.createdAt)}</time><p>{display(item.message || item.contentPreview)}</p></article>)}</div> : <div className="gateway-empty"><MessageSquareText size={18} /><p>Incoming messages appear after the configured webhook reaches ZimShop; SMSGate Local mode can also return its local inbox.</p></div>}
        </section>

        <section className="sms-operations-section gateway-section">
          <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> OUTBOX / PROVIDER</span><h2>Recent SMSGate messages</h2></div><Activity size={18} /></div>
          {providerMessages.length ? <div className="gateway-message-list">{providerMessages.slice(0, 20).map((item, index) => <article key={String(item.id || index)}><strong>{display(item.phoneNumbers?.join(", "), "Recipient unavailable")}</strong><time>{display(item.createdAt)}</time><p>{display(item.textMessage?.text, "Message content unavailable")}</p><small>{display(item.state, "Status unknown")}</small>{String(item.state).toLowerCase() === "pending" && item.id && <button className="button button-quiet" type="button" onClick={() => void cancelMessage(item.id!)} disabled={busy === item.id}>Cancel pending SMS</button>}</article>)}</div> : <div className="gateway-empty"><Activity size={18} /><p>{loading ? "Loading provider messages…" : "No messages were returned by the provider API."}</p></div>}
        </section>
      </div>

      <div className="gateway-workspace-grid">
        <section className="sms-operations-section gateway-section">
          <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> COMPOSE / SINGLE RECIPIENT</span><h2>Send SMS</h2></div><Send size={18} /></div>
          <form className="sms-tool-form" onSubmit={sendMessage}>
            {devices.length > 0 && <><label className="field-label" htmlFor="gateway-device">DEVICE</label><select id="gateway-device" className="text-input" value={selectedDevice} onChange={(event) => { setSelectedDevice(event.target.value); setSelectedSim(""); }}><option value="">Automatic device selection</option>{devices.map((device, index) => <option value={String(device.id || device.deviceId || "")} key={String(device.id || device.deviceId || index)}>{display(device.name || device.model, `Gateway device ${index + 1}`)}</option>)}</select>{selectedDevice && (() => { const device = devices.find((item) => String(item.id || item.deviceId) === selectedDevice); const sims = Array.isArray(device?.simCards) ? device.simCards : []; return sims.length ? <><label className="field-label" htmlFor="gateway-sim">SIM SLOT</label><select id="gateway-sim" className="text-input" value={selectedSim} onChange={(event) => setSelectedSim(event.target.value)}><option value="">Device default SIM</option>{sims.map((sim, index) => <option value={String(sim.simNumber || index + 1)} key={index}>SIM {display(sim.simNumber, String(index + 1))} · {display(sim.carrierName, "Carrier unknown")}</option>)}</select></> : null; })()}</>}
            <label className="field-label" htmlFor="gateway-recipient">RECIPIENT NUMBER</label><input id="gateway-recipient" className="text-input" type="tel" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="+263 77 000 0000" required minLength={7} maxLength={40} />
            <label className="field-label" htmlFor="gateway-message">MESSAGE</label><textarea id="gateway-message" className="node-body-input" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1600} rows={4} required /><small>{message.length} / 1600 characters. Recipient must already have SMS consent recorded. Sending also requires the server launch switch.</small>
            <button className="button button-primary" type="submit" disabled={busy === "send" || !gateway?.sending_enabled}>{busy === "send" ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{busy === "send" ? "Queueing" : "Queue SMS"}</button>
          </form>
        </section>

        <section className="sms-operations-section gateway-section">
          <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> PROVIDER WEBHOOKS</span><h2>Webhook registrations</h2></div><Settings2 size={18} /></div>
          <form className="sms-tool-form gateway-webhook-form" onSubmit={registerWebhook}>
            <label className="field-label" htmlFor="gateway-webhook-url">HTTPS CALLBACK URL</label><input id="gateway-webhook-url" className="text-input" type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://your-domain/api/v1/sms/webhook/..." required />
            <label className="field-label" htmlFor="gateway-webhook-event">EVENT</label><select id="gateway-webhook-event" className="text-input" value={webhookEvent} onChange={(event) => setWebhookEvent(event.target.value)}>{["sms:received", "sms:sent", "sms:delivered", "sms:failed", "sms:cancelled", "app:started", "system:ping"].map((event) => <option value={event} key={event}>{event}</option>)}</select>
            <button className="button button-secondary" type="submit" disabled={busy === "webhook"}>{busy === "webhook" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Register webhook</button>
          </form>
          <div className="gateway-webhooks">{webhooks.map((webhook, index) => <article key={String(webhook.id || index)}><div><strong>{display(webhook.event, "Webhook")}</strong><small>{display(webhook.url)}</small></div>{webhook.id && <button className="icon-button" type="button" title="Remove webhook" aria-label="Remove webhook" onClick={() => void removeWebhook(webhook.id!)} disabled={busy === webhook.id}><Trash2 size={15} /></button>}</article>)}</div>
                  <details className="gateway-settings"><summary>Gateway settings</summary><p>Settings are read from SMSGate; secret/write-only values may be omitted by the provider.</p><form className="sms-tool-form" onSubmit={saveSettings}><textarea className="node-body-input" value={settingsText} onChange={(event) => setSettingsText(event.target.value)} rows={12} aria-label="SMSGate settings JSON" /><button className="button button-secondary" type="submit" disabled={busy === "settings" || !settingsText}>{busy === "settings" ? <LoaderCircle className="spin" size={15} /> : <Settings2 size={15} />}Save settings</button></form></details>
        </section>
      </div>
    </div>
  );
}
