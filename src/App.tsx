import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownToLine, ArrowUpRight, BarChart3, Cable, CalendarClock, Check, ChevronDown, CircleAlert, Clock3,
  Copy, CreditCard, Headphones, Inbox, LoaderCircle, Megaphone, MessageSquareText, Plus, Send, Tag, UsersRound,
  Search, Sparkles, WandSparkles,
} from "lucide-react";
  import MarketplaceWorkspace from "./MarketplaceWorkspace";
import BotWorkspace, { type BotView } from "./BotWorkspace";
import GatewayWorkspace from "./GatewayWorkspace";
import SubscriptionWorkspace from "./SubscriptionWorkspace";

type Analysis = {
  intent: string;
  priority: "High" | "Medium" | "Low";
  next_step: string;
  reply: string;
  mode: string;
};

type Followup = Analysis & {
  id: string;
  customer: string;
  message: string;
  created_at: string;
};

type ActiveView = "marketplace" | "enquiries" | "gateway" | "billing" | BotView;
const apiBase = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const zimshopLogo = "/ZimShop-sticker.png";
const exampleMessage = "Hi, I need 20 T-shirts printed for an event next Friday. How much would it cost?";

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
  return response.json() as Promise<T>;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

export default function App() {
  const [customer, setCustomer] = useState("");
  const [message, setMessage] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [draft, setDraft] = useState("");
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [followupsLoading, setFollowupsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("marketplace");
  const [authChecked, setAuthChecked] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    void request<{ id: string }>("/api/v1/marketplace/seller/account")
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false))
      .finally(() => setAuthChecked(true));
  }, []);

  const viewLabels: Record<ActiveView, string> = {
    marketplace: "Smart Match",
    enquiries: "Enquiry desk",
    gateway: "Integration",
    billing: "Subscriptions",
    bots: "Marketing",
    contacts: "Contacts and consent",
    campaigns: "Schedule a message",
    catalog: "Catalog and shop details",
    reports: "SMS results (analysis)",
  };

  async function refreshFollowups(): Promise<boolean> {
    setFollowupsLoading(true);
    try {
      setFollowups(await request<Followup[]>("/api/v1/followups"));
      return true;
    } catch {
      setNotice("Connect to the ZimShop AI API to load your follow-up queue.");
      return false;
    } finally {
      setFollowupsLoading(false);
    }
  }

  useEffect(() => {
    if (activeView === "enquiries") void refreshFollowups();
  }, [activeView]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim()) {
      setNotice("Add a customer message before analyzing.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const result = await request<Analysis>("/api/v1/analyze", {
        method: "POST", body: JSON.stringify({ customer, message }),
      });
      setAnalysis(result);
      setDraft(result.reply);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Analysis failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveFollowup() {
    if (!analysis) return;
    setSaving(true);
    setNotice("");
    try {
      await request<Followup>("/api/v1/followups", {
        method: "POST",
        body: JSON.stringify({
          ...analysis, customer: customer.trim() || "Unknown customer",
          message: message.trim(), reply: draft,
        }),
      });
      if (await refreshFollowups()) setNotice("Follow-up saved to your queue.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save this follow-up.");
    } finally {
      setSaving(false);
    }
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice("Clipboard access is unavailable on this device.");
    }
  }

  async function copySavedReply(item: Followup) {
    try {
      await navigator.clipboard.writeText(item.reply);
      setNotice(`Reply for ${item.customer} copied.`);
    } catch {
      setNotice("Clipboard access is unavailable on this device.");
    }
  }

  function newEnquiry() {
    setCustomer("");
    setMessage("");
    setAnalysis(null);
    setDraft("");
    setNotice("");
  }

  if (!authChecked) return <main className="workspace-auth-loading">Checking your business account…</main>;
  if (!signedIn) return <MarketplaceWorkspace initialMode="seller" onAuthenticated={() => setSignedIn(true)} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="ZimShop AI home">
          <img className="brand-mark" src={zimshopLogo} alt="" />
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">Z</span>
          <span className="workspace-name"><strong>ZimShop</strong><small>Customer operations</small></span>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          <a className={`nav-item ${activeView === "marketplace" ? "active" : ""}`} href="#marketplace" aria-label="Smart Match" title="Smart Match" onClick={(event) => { event.preventDefault(); setActiveView("marketplace"); }}><Search size={17} /><span>Smart Match</span></a>
          <a className={`nav-item ${activeView === "enquiries" ? "active" : ""}`} href="#inbox" aria-label="Enquiry desk" title="Enquiry desk" onClick={(event) => { event.preventDefault(); setActiveView("enquiries"); }}><Inbox size={17} /><span>Enquiry desk</span><span className="nav-count"></span></a>
          <a className={`nav-item ${activeView === "reports" ? "active" : ""}`} href="#sms-reports" aria-label="SMS results (analysis)" title="SMS results (analysis)" onClick={(event) => { event.preventDefault(); setActiveView("reports"); }}><BarChart3 size={17} /><span>SMS results (analysis)</span></a>
          <a className={`nav-item ${activeView === "catalog" ? "active" : ""}`} href="#sms-catalog" aria-label="Catalog and shop details" title="Catalog and shop details" onClick={(event) => { event.preventDefault(); setActiveView("catalog"); }}><Tag size={17} /><span>Catalog and shop details</span></a>
          <a className={`nav-item ${activeView === "bots" ? "active" : ""}`} href="#bots" aria-label="Marketing" title="Marketing" onClick={(event) => { event.preventDefault(); setActiveView("bots"); }}><Megaphone size={17} /><span>Marketing</span></a>
          <a className={`nav-item ${activeView === "gateway" ? "active" : ""}`} href="#sms-gateway" aria-label="Integration" title="Integration" onClick={(event) => { event.preventDefault(); setActiveView("gateway"); }}><Cable size={17} /><span>Integration</span></a>
          <a className={`nav-item ${activeView === "billing" ? "active" : ""}`} href="#subscriptions" aria-label="Subscriptions" title="Subscriptions" onClick={(event) => { event.preventDefault(); setActiveView("billing"); }}><CreditCard size={17} /><span>Subscriptions</span></a>
          <div className="nav-label nav-group-label">SMS WORKSPACE</div>
          <a className={`nav-item ${activeView === "contacts" ? "active" : ""}`} href="#sms-contacts" aria-label="Contacts and consent" title="Contacts and consent" onClick={(event) => { event.preventDefault(); setActiveView("contacts"); }}><UsersRound size={17} /><span>Contacts and consent</span></a>
          <a className={`nav-item ${activeView === "campaigns" ? "active" : ""}`} href="#sms-campaigns" aria-label="Schedule a message" title="Schedule a message" onClick={(event) => { event.preventDefault(); setActiveView("campaigns"); }}><CalendarClock size={17} /><span>Schedule a message</span></a>
        </nav>
        <div className="sidebar-bottom">
          <div className="support-card"><span className="support-icon"><Headphones size={16} /></span><div><strong>Need a hand?</strong><small>Visit the help centre</small></div><ArrowUpRight size={14} /></div>
          <div className="profile"><span className="profile-avatar">Z</span><div><strong>ZimShop workspace</strong><small>Customer operations</small></div><ChevronDown size={15} /></div>
        </div>
      </aside>

      <main id="home" className="main-content">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> <strong>{viewLabels[activeView]}</strong></div>
          <div className="topbar-right"><span className="connection-dot" /> Web workspace <span className="topbar-divider" /><span className="date-label">ZIMBABWE / WORKSPACE</span></div>
        </header>

        <div className={`page-wrap ${activeView !== "enquiries" ? "bot-page-wrap" : ""}`}>
          {activeView === "marketplace" ? <MarketplaceWorkspace onUnauthenticated={() => setSignedIn(false)} /> : activeView === "gateway" ? <GatewayWorkspace /> : activeView === "billing" ? <SubscriptionWorkspace /> : activeView !== "enquiries" ? <BotWorkspace view={activeView} onOpenGateway={() => setActiveView("gateway")} /> : <>
          <div className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-line" /> CUSTOMER OPERATIONS / 01</div><h1>Enquiry desk<span>.</span></h1><p>Make every customer message a clear next step.</p></div>
            <button className="button button-quiet" type="button" onClick={newEnquiry}><Plus size={16} /> New enquiry</button>
          </div>

          {notice && <div className="notice" role="status"><CircleAlert size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}

          <div className="workspace-grid">
            <section id="inbox" className="compose-column">
              <form className="panel compose-panel" onSubmit={analyze}>
                <div className="panel-heading"><div><span className="step-index">01</span><div><h2>New enquiry</h2><p>Paste a customer message to get started.</p></div></div><span className="private-label">PRIVATE</span></div>
                <label className="field-label" htmlFor="customer">CUSTOMER <span>OPTIONAL</span></label>
                <input id="customer" className="text-input" value={customer} onChange={(event) => setCustomer(event.target.value)} placeholder="Name of the customer" maxLength={200} />
                <div className="field-heading"><label className="field-label" htmlFor="message">MESSAGE</label><button type="button" className="text-action" onClick={() => { setCustomer("Alex"); setMessage(exampleMessage); }}>Use example <ArrowUpRight size={13} /></button></div>
                <textarea id="message" className="message-input" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Paste the customer’s message here…" maxLength={10000} required />
                <div className="compose-footer"><span><MessageSquareText size={14} /> {message.length} / 10,000</span><button type="submit" className="button button-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{busy ? "Analyzing" : "Analyze enquiry"}<ArrowUpRight size={15} /></button></div>
              </form>

              <section className="activity-panel"><div className="activity-title"><span className="activity-pulse" /><h2>Activity</h2><span className="activity-caption">THIS SESSION</span></div><div className="activity-row"><span className="activity-symbol"><Inbox size={14} /></span><p>Enquiry desk ready <time>just now</time></p><span className="activity-status">READY</span></div>{analysis && <div className="activity-row"><span className="activity-symbol violet"><Sparkles size={14} /></span><p>Analysis complete <time>{analysis.mode}</time></p><span className="activity-status done">DONE</span></div>}</section>
            </section>

            <section className="results-column" aria-live="polite">
              <div className="results-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> AI WORKSPACE / 02</span><h2>Suggested response</h2></div>{analysis && <span className="mode-tag"><span />{analysis.mode}</span>}</div>
              {analysis ? <>
                <div className="analysis-summary"><div className="summary-intent"><span className="summary-label">DETECTED INTENT</span><strong>{analysis.intent}</strong></div><div className="priority-block"><span className="summary-label">PRIORITY</span><span className={`priority-pill ${analysis.priority.toLowerCase()}`}><span />{analysis.priority}</span></div></div>
                <div className="next-step"><span className="next-step-icon"><ArrowDownToLine size={16} /></span><div><span className="summary-label">RECOMMENDED NEXT STEP</span><p>{analysis.next_step}</p></div></div>
                <div className="reply-card"><div className="reply-card-heading"><span><span className="reply-heading-icon"><MessageSquareText size={14} /></span> REPLY DRAFT</span><span className="draft-only">DRAFT ONLY</span></div><textarea aria-label="Reply draft" value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="reply-card-footer"><span>Review before sending. Nothing is sent automatically.</span><button type="button" className="copy-button" onClick={copyDraft} title="Copy reply" aria-label="Copy reply">{copied ? <Check size={15} /> : <Copy size={15} />}</button></div></div>
                <div className="result-actions"><button type="button" className="button button-primary save-button" onClick={saveFollowup} disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Clock3 size={16} />}{saving ? "Saving" : "Save to follow-up queue"}</button><button type="button" className="button button-secondary" onClick={newEnquiry}><Plus size={15} /> New</button></div>
              </> : <div className="empty-analysis"><div className="empty-illustration"><span className="empty-orbit orbit-one" /><span className="empty-orbit orbit-two" /><span className="empty-icon"><WandSparkles size={22} /></span></div><h3>Your next step starts here.</h3><p>Run an analysis to surface customer intent, priority, and a reply draft.</p><div className="empty-footnote"><span /> ENQUIRIES STAY PRIVATE</div></div>}
            </section>
          </div>

          <section id="queue" className="queue-section" aria-busy={followupsLoading}><div className="queue-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> KEEP THINGS MOVING / 03</span><h2>Follow-up queue <span className="queue-count">{followups.length.toString().padStart(2, "0")}</span></h2></div><span className="queue-sort">Newest first <ChevronDown size={14} /></span></div>
            {followupsLoading ? <div className="queue-empty"><span className="queue-empty-icon"><LoaderCircle className="spin" size={17} /></span><div><strong>Loading your queue…</strong><p>Fetching saved customer enquiries.</p></div></div> : followups.length ? <div className="queue-table"><div className="queue-table-head"><span>CUSTOMER / MESSAGE</span><span>INTENT</span><span>PRIORITY</span><span>CREATED</span><span /></div>{followups.map((item) => <article className="queue-row" key={item.id}><div className="queue-customer"><span className="customer-avatar">{(item.customer[0] || "?").toUpperCase()}</span><div><strong>{item.customer}</strong><p>{item.message}</p></div></div><span className="queue-intent">{item.intent}</span><span className={`priority-pill ${item.priority.toLowerCase()}`}><span />{item.priority}</span><time>{formatTime(item.created_at)}</time><button className="row-action" title="Copy saved reply" aria-label={`Copy reply for ${item.customer}`} onClick={() => void copySavedReply(item)}><Send size={15} /></button></article>)}</div> : <div className="queue-empty"><span className="queue-empty-icon"><Clock3 size={17} /></span><div><strong>Your queue is clear.</strong><p>Save an analyzed enquiry and it will be ready for follow-up here.</p></div></div>}
          </section>
          <footer className="page-footer"><span>ZimShop AI <span className="footer-slash">/</span> CUSTOMER OPERATIONS</span><span>AI drafts only. Your team stays in control.</span></footer>
          </>}
        </div>
      </main>
    </div>
  );
}