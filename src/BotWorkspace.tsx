import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown, ArrowRight, Bot, CircleAlert, CircleHelp,
  BarChart3, CalendarClock, Clock3, GitBranch, LoaderCircle, MessageCircle, MessageSquareText,
  Plus, RefreshCw, Save, Send, Sparkles, Tag, Trash2, UserRound, UsersRound, WandSparkles,
} from "lucide-react";

type Choice = { label: string; keywords: string[]; next: string };
type NodeKind = "trigger" | "message" | "decision" | "action";
type BotNode = { id: string; kind: NodeKind; title: string; body: string; next: string | null; choices: Choice[] };
type BotWorkflow = { business_name: string; description: string; sms_mode: "android" | "iphone_manual"; phone_number?: string | null; gateway_device_id?: string | null; gateway_last_seen?: string | null; workflow: BotNode[]; active: boolean; updated_at?: string };
type Dashboard = { workflow: BotWorkflow | null; contacts: number; messages: number; sms_gateway_configured: boolean; sms_connected: boolean; phone_number: string | null; sms_mode: "android" | "iphone_manual" };
type Conversation = { id: string; contact: string; phone_number: string; direction: string; message: string; needs_human: boolean; delivery_status: string; created_at: string };
type Simulation = { replies: string[]; state: Record<string, string>; route: string; input?: string };
type Contact = { id: string; phone_number: string; profile_name: string; sms_consent: boolean; marketing_consent: boolean; consent_updated_at: string | null; interests: string[]; lead_status: string; inquiry_count: number; created_at: string };
type CampaignCategory = "promotion" | "seasonal" | "reminder" | "follow_up";
type Campaign = { id: string; name: string; category: CampaignCategory; message: string; interest_filter: string | null; scheduled_at: string; status: string; queued_count: number; sent_count: number; delivered_count: number; failed_count: number; reply_count: number; created_at: string; completed_at: string | null };
type Reports = { contacts: number; opted_in: number; marketing_opted_in: number; leads: number; messages_sent: number; customer_replies: number; delivered: number; campaigns: Campaign[]; sales_tracking: string };
type Product = { id: string; name: string; description: string; price: string; availability: string; purchase_url: string | null; interests: string[]; active: boolean; created_at: string };
type BusinessProfile = { business_hours: string; location: string; delivery_policy: string; returns_policy: string; payment_instructions: string; support_contact: string };
export type BotView = "bots" | "contacts" | "campaigns" | "catalog" | "reports";

const emptyBusinessProfile: BusinessProfile = { business_hours: "", location: "", delivery_policy: "", returns_policy: "", payment_instructions: "", support_contact: "" };
const initialSchedule = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);

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
  return response.json() as Promise<T>;
}

function freshNode(kind: NodeKind, index: number): BotNode {
  const id = `${kind}-${Date.now()}-${index}`;
  return { id, kind, title: kind === "message" ? "New reply" : kind === "action" ? "Human handoff" : kind === "decision" ? "Customer choice" : "New step", body: kind === "action" ? "A team member will take over this conversation." : kind === "decision" ? "Choose a reply to route the customer." : "Add a message for your customers.", next: null, choices: [] };
}

export default function BotWorkspace({ view = "bots", onOpenGateway }: { view?: BotView; onOpenGateway: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [reports, setReports] = useState<Reports | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile>(emptyBusinessProfile);
  const [contactDraft, setContactDraft] = useState({ phone_number: "", profile_name: "", interests: "", sms_consent: false, marketing_consent: false });
  const [campaignDraft, setCampaignDraft] = useState({ name: "", category: "promotion" as CampaignCategory, message: "", interest_filter: "", scheduled_at: initialSchedule() });
  const [productDraft, setProductDraft] = useState({ name: "", description: "", price: "", availability: "Available", purchase_url: "", interests: "" });
  const [workflow, setWorkflow] = useState<BotWorkflow | null>(null);
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [testState, setTestState] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Simulation | null>(null);
  const hasLoadedWorkflow = useRef(false);

  async function refresh() {
    try {
      const [data, messages, customerRecords, campaignRecords, reportData, productRecords, profile] = await Promise.all([
        request<Dashboard>("/api/v1/bot"),
        request<Conversation[]>("/api/v1/bot/conversations"),
        request<Contact[]>("/api/v1/bot/contacts"),
        request<Campaign[]>("/api/v1/bot/campaigns"),
        request<Reports>("/api/v1/bot/reports"),
        request<Product[]>("/api/v1/bot/products"),
        request<BusinessProfile | null>("/api/v1/bot/business-profile"),
      ]);
      setDashboard(data);
      if (!hasLoadedWorkflow.current) {
        if (data.workflow) setWorkflow(data.workflow);
        hasLoadedWorkflow.current = true;
      }
      setConversations(messages);
      setContacts(customerRecords);
      setCampaigns(campaignRecords);
      setReports(reportData);
      setProducts(productRecords);
      setBusinessProfile(profile || emptyBusinessProfile);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load the bot workspace.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  function updateNode(id: string, patch: Partial<BotNode>) {
    setWorkflow((current) => current ? { ...current, workflow: current.workflow.map((node) => node.id === id ? { ...node, ...patch } : node) } : current);
  }

  function selectSmsMode(sms_mode: BotWorkflow["sms_mode"]) {
    setWorkflow((current) => current ? { ...current, sms_mode, active: sms_mode === "iphone_manual" ? false : current.active } : {
      business_name: "ZimShop",
      description: "",
      sms_mode,
      workflow: [
        { id: "incoming", kind: "trigger", title: "Incoming SMS", body: "Customer texts your business SIM number", next: "welcome", choices: [] },
        { id: "welcome", kind: "message", title: "Welcome", body: "Welcome! What would you like help with?", next: null, choices: [] },
      ],
      active: false,
    });
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const workflowDescription = description.trim() || workflow?.description.trim() || "";
    if (!workflowDescription) return;
    setBusy("generate");
    setNotice("");
    try {
      const generated = await request<BotWorkflow>("/api/v1/bot/generate", {
        method: "POST", body: JSON.stringify({ business_name: workflow?.business_name || "ZimShop", description: workflowDescription }),
      });
      setWorkflow(generated);
      setTestState({});
      setTestResult(null);
      setNotice("A draft flow is ready. Review every reply before saving.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not generate a workflow.");
    } finally {
      setBusy("");
    }
  }

  async function save(active = false) {
    if (!workflow) return;
    setBusy(active ? "activate" : "save");
    setNotice("");
    try {
      const saved = await request<BotWorkflow>("/api/v1/bot", {
        method: "PUT", body: JSON.stringify({ ...workflow, active }),
      });
      setWorkflow(saved);
      setDashboard((current) => current ? { ...current, workflow: saved } : current);
      setNotice(active ? "SMS bot is live on your connected Android phone." : "Workflow saved as a draft.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save the workflow.");
    } finally {
      setBusy("");
    }
  }

  async function test(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workflow || !testMessage.trim()) return;
    setBusy("test");
    try {
      const result = await request<Simulation>("/api/v1/bot/test", {
        method: "POST", body: JSON.stringify({ message: testMessage, state: testState, workflow: workflow.workflow }),
      });
      setTestState(result.state);
      setTestResult({ ...result, input: testMessage });
      setTestMessage("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not test this message.");
    } finally {
      setBusy("");
    }
  }

  async function saveContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("contact");
    try {
      await request<Contact>("/api/v1/bot/contacts", {
        method: "POST",
        body: JSON.stringify({ ...contactDraft, interests: contactDraft.interests.split(",").map((interest) => interest.trim()).filter(Boolean) }),
      });
      setContactDraft({ phone_number: "", profile_name: "", interests: "", sms_consent: false, marketing_consent: false });
      await refresh();
      setNotice("Customer saved with the selected consent settings.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save this customer.");
    } finally {
      setBusy("");
    }
  }

  async function scheduleCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("campaign");
    try {
      await request<Campaign>("/api/v1/bot/campaigns", {
        method: "POST",
        body: JSON.stringify({ ...campaignDraft, interest_filter: campaignDraft.interest_filter.trim() || null, scheduled_at: new Date(campaignDraft.scheduled_at).toISOString() }),
      });
      setCampaignDraft((current) => ({ ...current, name: "", message: "", interest_filter: "", scheduled_at: initialSchedule() }));
      await refresh();
      setNotice("Campaign scheduled. Eligible, consented contacts receive it when the gateway next connects.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not schedule this campaign.");
    } finally {
      setBusy("");
    }
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("product");
    try {
      await request<Product>("/api/v1/bot/products", {
        method: "POST",
        body: JSON.stringify({ ...productDraft, purchase_url: productDraft.purchase_url.trim() || null, interests: productDraft.interests.split(",").map((interest) => interest.trim()).filter(Boolean) }),
      });
      setProductDraft({ name: "", description: "", price: "", availability: "Available", purchase_url: "", interests: "" });
      await refresh();
      setNotice("Product added to the catalog.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save this product.");
    } finally {
      setBusy("");
    }
  }

  async function toggleProduct(product: Product) {
    try {
      await request<Product>(`/api/v1/bot/products/${product.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...product, active: !product.active }),
      });
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update this product.");
    }
  }

  async function saveBusinessProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("profile");
    try {
      const saved = await request<BusinessProfile & { updated_at: string }>("/api/v1/bot/business-profile", {
        method: "PUT", body: JSON.stringify(businessProfile),
      });
      setBusinessProfile(saved);
      setNotice("Verified business details saved for automatic replies.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save business details.");
    } finally {
      setBusy("");
    }
  }

  const nodes = workflow?.workflow || [];
  const pageTitles: Record<BotView, string> = {
    bots: "Marketing",
    contacts: "Contacts and consent",
    campaigns: "Schedule a message",
    catalog: "Catalog and shop details",
    reports: "SMS results (analysis)",
  };
  const pageDescriptions: Record<BotView, string> = {
    bots: "Build and test a customer flow for messages to your business number.",
    contacts: "Manage customer details, interests, and recorded messaging consent.",
    campaigns: "Plan promotions, seasonal offers, reminders, and follow-ups.",
    catalog: "Maintain the confirmed products and shop information used in replies.",
    reports: "Review audience, message delivery, replies, and lead activity.",
  };

  return (
    <div className="bot-page">
      <header className="bot-page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> AUTOMATION / SMS</div><h1>{pageTitles[view]}<span>.</span></h1><p>{pageDescriptions[view]}</p></div>
        {view === "bots" && workflow && <div className={`bot-live-status ${workflow.active ? "is-live" : "is-draft"}`}><span />{workflow.active ? "LIVE" : "DRAFT"}</div>}
      </header>

      {notice && <div className="notice bot-notice" role="status"><CircleAlert size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}

      {view === "bots" && <>
      <section className={`whatsapp-connect ${dashboard?.sms_connected ? "connected" : "not-connected"}`}>
        <div className="whatsapp-symbol"><MessageCircle size={19} /></div>
        <div className="whatsapp-connect-copy"><strong>{dashboard?.sms_connected ? `SMSGate device connected${dashboard.phone_number ? ` · ${dashboard.phone_number}` : ""}` : workflow?.sms_mode === "iphone_manual" ? "Manual SMS mode" : "SMSGate connection required"}</strong><p>{workflow?.sms_mode === "iphone_manual" ? "Prepare suggested replies in the Enquiry desk and send them manually." : "ZimShop connects to your existing SMSGate Cloud, Private Server, or Local Server from the Python backend. Install and register the official SMSGate app separately on the Android phone."}</p></div>
        <span className="connect-indicator"><i />{dashboard?.sms_connected ? "CONNECTED" : "NOT CONNECTED"}</span>
        <div className="gateway-setup-actions">
          <button className="button button-secondary" type="button" onClick={onOpenGateway}>Manage Integration</button>
        </div>
      </section>

      <section className="sms-platform-guidance">
        <div className="sms-platform-choice">
          <span className="field-label">PHONE INTEGRATION</span>
          <div className="sms-platform-options">
            <button className={`sms-platform-option ${workflow?.sms_mode !== "iphone_manual" ? "selected" : ""}`} type="button" onClick={() => selectSmsMode("android")}><strong>Android · automatic</strong><small>SMS is received and sent through your business SIM.</small></button>
            <button className={`sms-platform-option ${workflow?.sms_mode === "iphone_manual" ? "selected" : ""}`} type="button" onClick={() => selectSmsMode("iphone_manual")}><strong>iPhone · manual</strong><small>Paste customer texts into Enquiry desk for suggested replies; iOS background SMS automation is not assumed.</small></button>
          </div>
        </div>
        <div className="sms-flow-steps"><strong>Message path</strong><span>1. Customer texts the registered SIM</span><span>2. SMSGate sends a webhook to the ZimShop backend</span><span>3. Python checks bot rules, consent, and sending controls</span><span>4. SMSGate queues the reply to its registered Android device</span></div>
      </section>

      <div className="bot-metrics">
        <div><span>CONTACTS</span><strong>{dashboard?.contacts ?? "—"}</strong><small>Customers who messaged your business</small></div>
        <div><span>MESSAGES</span><strong>{dashboard?.messages ?? "—"}</strong><small>Inbound and bot replies</small></div>
        <div><span>WORKFLOW STEPS</span><strong>{nodes.length || "—"}</strong><small>Nodes in the current flow</small></div>
      </div>

      <div className="bot-layout">
        <main className="bot-builder-column">
          <section className="bot-generator">
            <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> BOT GENERATOR</span><h2>Describe the customer experience</h2></div><Sparkles size={18} /></div>
            <form onSubmit={generate}>
              <label className="field-label" htmlFor="bot-business">BUSINESS NAME</label>
              <input id="bot-business" className="text-input" value={workflow?.business_name || ""} onChange={(event) => setWorkflow((current) => current ? { ...current, business_name: event.target.value } : { business_name: event.target.value, description, sms_mode: "android", workflow: [], active: false })} placeholder="ZimShop" maxLength={200} />
              <label className="field-label" htmlFor="bot-description">WHAT SHOULD YOUR BOT DO?</label>
              <textarea id="bot-description" className="bot-description-input" value={description || workflow?.description || ""} onChange={(event) => { setDescription(event.target.value); setWorkflow((current) => current ? { ...current, description: event.target.value } : current); }} placeholder="Welcome shoppers, show the clothing catalog, help customers place an order, and transfer questions to a person." maxLength={4000} />
              <div className="bot-generator-footer"><span>AI creates a draft. Your edits and approval are required before activation.</span><button className="button button-primary" type="submit" disabled={busy === "generate" || !(description || workflow?.description || "").trim()}>{busy === "generate" ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}{busy === "generate" ? "Generating" : "Generate flow"}</button></div>
            </form>
          </section>

          <section className="flow-section">
            <div className="bot-section-heading flow-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> VISUAL FLOW BUILDER</span><h2>{workflow?.business_name || "Your bot"} flow</h2></div>            <div className="flow-actions"><select className="flow-add-select" aria-label="Add a workflow step" value="" onChange={(event) => { const kind = event.target.value as NodeKind; setWorkflow((current) => { if (!current) return current; const node = freshNode(kind, current.workflow.length); if (kind === "decision") node.choices = [{ label: "Option", keywords: ["option"], next: current.workflow.find((item) => item.kind === "message")?.id || current.workflow[0].id }]; return { ...current, workflow: [...current.workflow, node] }; }); }}><option value="" disabled>Add step</option><option value="message">Message</option><option value="decision">Decision</option><option value="action">Human handoff</option></select><button className="icon-button" title="Save draft" aria-label="Save draft" onClick={() => void save(false)} disabled={!workflow || !!busy}><Save size={16} /></button><button className="button button-primary" type="button" onClick={() => void save(!workflow?.active)} disabled={!workflow || !!busy || (!workflow.active && (workflow.sms_mode === "iphone_manual" || !dashboard?.sms_gateway_configured || !dashboard.sms_connected))}>{busy === "activate" ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{workflow?.active ? "Pause bot" : workflow?.sms_mode === "iphone_manual" ? "Manual mode" : "Activate bot"}</button></div></div>
            {!workflow || loading ? <div className="flow-empty"><Bot size={24} /><strong>{loading ? "Loading your workflow" : "No workflow saved yet"}</strong><p>{loading ? "Fetching your SMS bot configuration." : "Describe your bot above, or start with the clothing-shop example."}</p>{!loading && <button type="button" className="text-action" onClick={() => { setWorkflow({ business_name: "ZimShop", description: "", sms_mode: "android", workflow: [{ id: "incoming", kind: "trigger", title: "Incoming SMS", body: "Customer texts your business SIM number", next: "welcome", choices: [] }, { id: "welcome", kind: "message", title: "Welcome", body: "Welcome! What would you like help with? Reply Products, Order, or Human help.", next: null, choices: [] }], active: false }); }}>Start with a welcome flow <ArrowRight size={14} /></button>}</div> : <div className="flow-canvas">
              {nodes.map((node, index) => <div className="flow-node-wrap" key={node.id}>
                <article className={`flow-node flow-node-${node.kind}`}>
                  <div className="flow-node-top"><span className="flow-node-icon">{node.kind === "trigger" ? <MessageCircle size={16} /> : node.kind === "decision" ? <GitBranch size={16} /> : node.kind === "action" ? <UserRound size={16} /> : <MessageSquareText size={16} />}</span><span className="flow-node-type">{node.kind}</span><span className="flow-node-number">{String(index + 1).padStart(2, "0")}</span>{node.kind !== "trigger" && <button className="icon-button delete-node" title="Delete step" aria-label={`Delete ${node.title}`} onClick={() => setWorkflow((current) => current ? { ...current, workflow: current.workflow.filter((item) => item.id !== node.id).map((item) => ({ ...item, next: item.next === node.id ? null : item.next, choices: item.choices.filter((choice) => choice.next !== node.id) })) } : current)}><Trash2 size={14} /></button>}</div>
                  <input className="node-title-input" aria-label={`${node.title} node title`} value={node.title} onChange={(event) => updateNode(node.id, { title: event.target.value })} maxLength={100} />
                  {node.kind !== "decision" && <textarea className="node-body-input" aria-label={`${node.title} message`} value={node.body} onChange={(event) => updateNode(node.id, { body: event.target.value })} maxLength={2000} rows={2} />}
                  {node.kind === "decision" && <div className="decision-options">{node.choices.map((choice, choiceIndex) => <div className="decision-option" key={`${node.id}-${choiceIndex}`}><input aria-label="Choice label" value={choice.label} onChange={(event) => updateNode(node.id, { choices: node.choices.map((item, idx) => idx === choiceIndex ? { ...item, label: event.target.value } : item) })} /><span>keywords</span><input aria-label="Choice keywords" value={choice.keywords.join(", ")} onChange={(event) => updateNode(node.id, { choices: node.choices.map((item, idx) => idx === choiceIndex ? { ...item, keywords: event.target.value.split(",").map((word) => word.trim()).filter(Boolean) } : item) })} /><select aria-label={`Route for ${choice.label}`} value={choice.next} onChange={(event) => updateNode(node.id, { choices: node.choices.map((item, idx) => idx === choiceIndex ? { ...item, next: event.target.value } : item) })}>{nodes.filter((target) => target.id !== node.id && target.kind !== "trigger").map((target) => <option value={target.id} key={target.id}>{target.title}</option>)}</select><button className="icon-button" type="button" title="Remove choice" aria-label={`Remove ${choice.label} choice`} onClick={() => updateNode(node.id, { choices: node.choices.filter((_, idx) => idx !== choiceIndex) })}><Trash2 size={13} /></button></div>)}<button className="text-action add-choice" type="button" onClick={() => updateNode(node.id, { choices: [...node.choices, { label: "New choice", keywords: ["keyword"], next: nodes.find((target) => target.kind === "message")?.id || node.id }] })}><Plus size={13} /> Add choice</button></div>}
                  {node.kind !== "decision" && <label className="node-next-label">NEXT STEP<select value={node.next || ""} onChange={(event) => updateNode(node.id, { next: event.target.value || null })}><option value="">End flow</option>{nodes.filter((target) => target.id !== node.id && target.kind !== "trigger").map((target) => <option value={target.id} key={target.id}>{target.title}</option>)}</select></label>}
                </article>
                {index < nodes.length - 1 && <div className="flow-connector"><span /><ArrowDown size={14} /></div>}
              </div>)}
            </div>}
          </section>
        </main>

        <aside className="bot-side-column">
          <section className="bot-simulator">
            <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> TEST CONVERSATION</span><h2>Try the flow</h2></div><button className="icon-button" title="Restart test conversation" aria-label="Restart test conversation" onClick={() => { setTestState({}); setTestResult(null); }}><RefreshCw size={15} /></button></div>
            <div className="simulator-conversation"><div className="simulator-empty"><Bot size={18} /><span>Test messages never reach a real customer.</span></div>{testResult && <><div className="simulator-incoming"><span>YOU · {testResult.route.toUpperCase()}</span><p>{testResult.input}</p></div>{testResult.replies.map((reply, index) => <div className="simulator-reply" key={`${reply}-${index}`}><span>BOT REPLY</span><p>{reply}</p></div>)}</>}</div>
            <form className="simulator-form" onSubmit={test}><input aria-label="Test customer message" value={testMessage} onChange={(event) => setTestMessage(event.target.value)} placeholder={testState.waiting_for ? "Try Products, Order, or Help" : "Type a customer message"} maxLength={2000} /><button type="submit" title="Send test message" aria-label="Send test message" disabled={!workflow || !testMessage.trim() || busy === "test"}>{busy === "test" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button></form>
          </section>

          <section className="bot-conversations"><div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> LIVE INBOX</span><h2>Recent conversations</h2></div><button className="icon-button" title="Refresh conversations" aria-label="Refresh conversations" onClick={() => void refresh()}><RefreshCw size={15} /></button></div>
            {conversations.length ? <div className="conversation-list">{conversations.slice(0, 12).map((item) => <article className={`conversation-item ${item.direction}`} key={item.id}><span className="conversation-avatar">{item.direction === "in" ? (item.contact[0] || "?").toUpperCase() : <Bot size={14} />}</span><div className="conversation-copy"><div><strong>{item.contact}</strong><time>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(item.created_at))}</time></div><p>{item.message}</p>{item.direction === "out" && <span className={`delivery-status ${item.delivery_status}`}>{item.delivery_status}</span>}{item.needs_human && item.direction === "in" && <span className="handoff-badge">HUMAN FOLLOW-UP</span>}</div></article>)}</div> : <div className="conversation-empty"><MessageSquareText size={18} /><p>Conversations appear here after customers text your connected business number.</p></div>}
          </section>

          <div className="connection-help"><CircleHelp size={16} /><p>SMS Gateway for Android is required to activate an automatic bot. Install it on the business phone, use Cloud mode, grant the required permissions, and verify the SIM can send and receive SMS. Server credentials, webhooks, and a recent device connection are also required. iPhone bots remain manual.</p></div>
        </aside>
      </div>
      </>}

      {view === "contacts" && <section id="sms-contacts" className="sms-operations-section">
        <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> CUSTOMER MANAGEMENT</span><h2>Contacts and consent</h2></div><UsersRound size={18} /></div>
        <div className="sms-operations-grid">
          <form className="sms-tool-form" onSubmit={saveContact}>
            <label className="field-label" htmlFor="contact-phone">PHONE NUMBER</label>
            <input id="contact-phone" className="text-input" type="tel" value={contactDraft.phone_number} onChange={(event) => setContactDraft((current) => ({ ...current, phone_number: event.target.value }))} placeholder="+263 77 000 0000" required minLength={7} maxLength={40} />
            <label className="field-label" htmlFor="contact-name">CUSTOMER NAME</label>
            <input id="contact-name" className="text-input" value={contactDraft.profile_name} onChange={(event) => setContactDraft((current) => ({ ...current, profile_name: event.target.value }))} placeholder="Name" maxLength={200} />
            <label className="field-label" htmlFor="contact-interests">INTERESTS</label>
            <input id="contact-interests" className="text-input" value={contactDraft.interests} onChange={(event) => setContactDraft((current) => ({ ...current, interests: event.target.value }))} placeholder="jeans, school uniforms" />
            <label className="sms-check-row"><input type="checkbox" checked={contactDraft.sms_consent} onChange={(event) => setContactDraft((current) => ({ ...current, sms_consent: event.target.checked, marketing_consent: event.target.checked && current.marketing_consent }))} /><span><strong>SMS consent recorded</strong><small>Required for reminders and follow-ups.</small></span></label>
            <label className="sms-check-row"><input type="checkbox" checked={contactDraft.marketing_consent} disabled={!contactDraft.sms_consent} onChange={(event) => setContactDraft((current) => ({ ...current, marketing_consent: event.target.checked }))} /><span><strong>Marketing consent recorded</strong><small>Required for promotions and seasonal offers.</small></span></label>
            <button className="button button-primary" type="submit" disabled={busy === "contact"}>{busy === "contact" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Save contact</button>
          </form>
          <div className="sms-record-list">
            <div className="sms-record-list-head"><strong>{contacts.length} customers</strong><span>NEWEST FIRST</span></div>
            {contacts.length ? contacts.slice(0, 12).map((contact) => <article className="sms-contact-row" key={contact.id}><div><strong>{contact.profile_name || contact.phone_number}</strong><small>{contact.phone_number} · {contact.lead_status.replaceAll("_", " ")}</small><small>{contact.interests.slice(0, 4).join(", ") || `${contact.inquiry_count} inquiries`}</small></div><div className="sms-consent-tags"><span className={contact.sms_consent ? "enabled" : "disabled"}>SMS {contact.sms_consent ? "ON" : "OFF"}</span><span className={contact.marketing_consent ? "enabled" : "disabled"}>OFFERS {contact.marketing_consent ? "ON" : "OFF"}</span></div></article>) : <p className="sms-empty-copy">Customers appear here after they message your business number or you add them.</p>}
          </div>
        </div>
      </section>}

      {view === "campaigns" && <section id="sms-campaigns" className="sms-operations-section">
        <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> CAMPAIGNS / REMINDERS</span><h2>Schedule a message</h2></div><CalendarClock size={18} /></div>
        <div className="sms-operations-grid">
          <form className="sms-tool-form" onSubmit={scheduleCampaign}>
            <label className="field-label" htmlFor="campaign-name">CAMPAIGN NAME</label>
            <input id="campaign-name" className="text-input" value={campaignDraft.name} onChange={(event) => setCampaignDraft((current) => ({ ...current, name: event.target.value }))} placeholder="New arrivals - October" required maxLength={120} />
            <label className="field-label" htmlFor="campaign-category">MESSAGE TYPE</label>
            <select id="campaign-category" className="text-input" value={campaignDraft.category} onChange={(event) => setCampaignDraft((current) => ({ ...current, category: event.target.value as CampaignCategory }))}><option value="promotion">Promotion</option><option value="seasonal">Holiday / seasonal</option><option value="reminder">Order / appointment reminder</option><option value="follow_up">Lead / repeat-sale follow-up</option></select>
            <label className="field-label" htmlFor="campaign-message">SMS MESSAGE</label>
            <textarea id="campaign-message" className="node-body-input" value={campaignDraft.message} onChange={(event) => setCampaignDraft((current) => ({ ...current, message: event.target.value }))} placeholder="New arrivals are here. Reply for prices and sizes." required maxLength={1600} rows={4} />
            <div className="sms-inline-fields"><div><label className="field-label" htmlFor="campaign-interest">INTEREST FILTER</label><input id="campaign-interest" className="text-input" value={campaignDraft.interest_filter} onChange={(event) => setCampaignDraft((current) => ({ ...current, interest_filter: event.target.value }))} placeholder="Optional, e.g. jeans" maxLength={100} /></div><div><label className="field-label" htmlFor="campaign-time">SEND AT</label><input id="campaign-time" className="text-input" type="datetime-local" value={campaignDraft.scheduled_at} onChange={(event) => setCampaignDraft((current) => ({ ...current, scheduled_at: event.target.value }))} required /></div></div>
            <p className="sms-form-note">Promotions and seasonal campaigns go only to marketing opt-ins. Reminders and follow-ups require SMS consent. Due messages send when the Android gateway next checks in.</p>
            <button className="button button-primary" type="submit" disabled={busy === "campaign"}>{busy === "campaign" ? <LoaderCircle className="spin" size={15} /> : <CalendarClock size={15} />}Schedule campaign</button>
          </form>
          <div className="sms-record-list">
            <div className="sms-record-list-head"><strong>Campaign performance</strong><span>RECENT</span></div>
            {campaigns.length ? campaigns.slice(0, 10).map((campaign) => <article className="sms-campaign-row" key={campaign.id}><div><strong>{campaign.name}</strong><small>{campaign.category.replaceAll("_", " ")} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(campaign.scheduled_at))}</small><small>{campaign.message}</small></div><div className="sms-campaign-stats"><span>{campaign.queued_count} queued</span><span>{campaign.sent_count} sent</span><span>{campaign.delivered_count} delivered</span><span>{campaign.reply_count} replies</span><span>{campaign.failed_count} failed · {campaign.status}</span></div></article>) : <p className="sms-empty-copy">Scheduled campaigns and their delivery results appear here.</p>}
          </div>
        </div>
      </section>}

      {view === "catalog" && <section id="sms-catalog" className="sms-operations-section">
        <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> SALES / SUPPORT KNOWLEDGE</span><h2>Catalog and shop details</h2></div><Tag size={18} /></div>
        <div className="sms-operations-grid">
          <div className="sms-knowledge-column">
            <form className="sms-tool-form" onSubmit={saveProduct}>
              <h3>Add a product</h3>
              <label className="field-label" htmlFor="product-name">PRODUCT NAME</label>
              <input id="product-name" className="text-input" value={productDraft.name} onChange={(event) => setProductDraft((current) => ({ ...current, name: event.target.value }))} required maxLength={120} />
              <div className="sms-inline-fields"><div><label className="field-label" htmlFor="product-price">PRICE</label><input id="product-price" className="text-input" value={productDraft.price} onChange={(event) => setProductDraft((current) => ({ ...current, price: event.target.value }))} placeholder="$15" maxLength={80} /></div><div><label className="field-label" htmlFor="product-stock">AVAILABILITY</label><input id="product-stock" className="text-input" value={productDraft.availability} onChange={(event) => setProductDraft((current) => ({ ...current, availability: event.target.value }))} maxLength={80} /></div></div>
              <label className="field-label" htmlFor="product-description">DESCRIPTION</label>
              <textarea id="product-description" className="node-body-input" value={productDraft.description} onChange={(event) => setProductDraft((current) => ({ ...current, description: event.target.value }))} rows={2} maxLength={1000} />
              <label className="field-label" htmlFor="product-url">PURCHASE / WHATSAPP LINK</label>
              <input id="product-url" className="text-input" type="url" value={productDraft.purchase_url} onChange={(event) => setProductDraft((current) => ({ ...current, purchase_url: event.target.value }))} placeholder="https://wa.me/263771234567" maxLength={500} />
              <p className="sms-form-note">Paste a WhatsApp Business catalog or product link to open it directly. A wa.me chat link opens with this product name and a request for your catalog; the customer taps Send in WhatsApp.</p>
              <label className="field-label" htmlFor="product-tags">CUSTOMER INTERESTS</label>
              <input id="product-tags" className="text-input" value={productDraft.interests} onChange={(event) => setProductDraft((current) => ({ ...current, interests: event.target.value }))} placeholder="jeans, denim" />
              <button className="button button-primary" type="submit" disabled={busy === "product"}>{busy === "product" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Add product</button>
            </form>
            <div className="sms-record-list sms-product-list"><div className="sms-record-list-head"><strong>{products.length} catalog items</strong><span>ACTIVE ITEMS CAN BE QUOTED</span></div>{products.length ? products.slice(0, 10).map((product) => <article className="sms-product-row" key={product.id}><div><strong>{product.name}</strong><small>{product.price || "Price not set"} · {product.availability}</small></div><button className="icon-button" type="button" title={product.active ? "Pause product" : "Activate product"} aria-label={`${product.active ? "Pause" : "Activate"} ${product.name}`} onClick={() => void toggleProduct(product)}>{product.active ? <Send size={14} /> : <RefreshCw size={14} />}</button></article>) : <p className="sms-empty-copy">Add confirmed prices, availability, and purchase links for accurate replies.</p>}</div>
          </div>
          <form className="sms-tool-form" onSubmit={saveBusinessProfile}>
            <h3>Verified shop information</h3>
            <p className="sms-form-note">Only details you enter here are used to answer routine support questions.</p>
            <label className="field-label" htmlFor="business-hours">BUSINESS HOURS</label>
            <textarea id="business-hours" className="node-body-input" value={businessProfile.business_hours} onChange={(event) => setBusinessProfile((current) => ({ ...current, business_hours: event.target.value }))} rows={2} maxLength={1000} />
            <label className="field-label" htmlFor="business-location">LOCATION</label>
            <textarea id="business-location" className="node-body-input" value={businessProfile.location} onChange={(event) => setBusinessProfile((current) => ({ ...current, location: event.target.value }))} rows={2} maxLength={1000} />
            <label className="field-label" htmlFor="delivery-policy">DELIVERY POLICY</label>
            <textarea id="delivery-policy" className="node-body-input" value={businessProfile.delivery_policy} onChange={(event) => setBusinessProfile((current) => ({ ...current, delivery_policy: event.target.value }))} rows={2} maxLength={2000} />
            <label className="field-label" htmlFor="returns-policy">RETURNS / EXCHANGES</label>
            <textarea id="returns-policy" className="node-body-input" value={businessProfile.returns_policy} onChange={(event) => setBusinessProfile((current) => ({ ...current, returns_policy: event.target.value }))} rows={2} maxLength={2000} />
            <label className="field-label" htmlFor="payment-details">PAYMENT INSTRUCTIONS</label>
            <textarea id="payment-details" className="node-body-input" value={businessProfile.payment_instructions} onChange={(event) => setBusinessProfile((current) => ({ ...current, payment_instructions: event.target.value }))} rows={2} maxLength={2000} />
            <label className="field-label" htmlFor="support-contact">SUPPORT CONTACT</label>
            <input id="support-contact" className="text-input" value={businessProfile.support_contact} onChange={(event) => setBusinessProfile((current) => ({ ...current, support_contact: event.target.value }))} maxLength={200} />
            <button className="button button-primary" type="submit" disabled={busy === "profile"}>{busy === "profile" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Save shop details</button>
          </form>
        </div>
      </section>}

      {view === "reports" && <section id="sms-reports" className="sms-operations-section">
        <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> PERFORMANCE</span><h2>SMS results (analysis)</h2></div><BarChart3 size={18} /></div>
        <div className="sms-report-grid">
          <div><span>CUSTOMERS</span><strong>{reports?.contacts ?? "—"}</strong></div><div><span>MARKETING OPT-INS</span><strong>{reports?.marketing_opted_in ?? "—"}</strong></div><div><span>LEADS</span><strong>{reports?.leads ?? "—"}</strong></div><div><span>MESSAGES SENT</span><strong>{reports?.messages_sent ?? "—"}</strong></div><div><span>DELIVERED</span><strong>{reports?.delivered ?? "—"}</strong></div><div><span>CUSTOMER REPLIES</span><strong>{reports?.customer_replies ?? "—"}</strong></div>
        </div>
        <p className="sms-form-note">{reports?.sales_tracking || "Conversion attribution requires a connected sales or order system."}</p>
      </section>}

      {view === "bots" && <div className="bot-safety-note"><Clock3 size={14} /><span>SMS replies use the business SIM and its carrier bundle. Review and test your flow before activation; STOP and UNSUBSCRIBE requests disable automated replies.</span></div>}
    </div>
  );
}