import { useEffect, useState, type FormEvent } from "react";
import { CalendarClock, Check, CircleAlert, CreditCard, LoaderCircle, RefreshCw, Settings2, ShieldCheck } from "lucide-react";

type Plan = {
  id: string;
  name: string;
  amount: string;
  currency: string;
  billing_period: string;
  description: string;
};

type Payment = {
  invoice_reference: string;
  plan: string;
  amount: string;
  currency: string;
  payment_status: string;
  subscription_status: string;
  instructions: string;
  expires_at: string | null;
  renewal_reminder_at: string | null;
};

type Trial = {
  eligible: boolean;
  subscription_status: string;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  expires_at: string | null;
};

type SubscriptionSettings = {
  enabled: boolean;
};

const apiBase = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const storageKey = "zimshop-subscription-reference";
const trialEmailKey = "zimshop-subscription-trial-email";

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

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "Not active";
}

export default function SubscriptionWorkspace() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState("starter");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [settings, setSettings] = useState<SubscriptionSettings | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    const savedEmail = localStorage.getItem(trialEmailKey);
    void Promise.all([
      request<Plan[]>("/api/v1/subscriptions/plans"),
      request<SubscriptionSettings>("/api/v1/subscriptions/settings"),
      Promise.resolve(localStorage.getItem(storageKey)),
      Promise.resolve(savedEmail),
    ]).then(async ([availablePlans, currentSettings, reference, savedTrialEmail]) => {
      if (!mounted) return;
      setPlans(availablePlans);
      setSettings(currentSettings);
      if (currentSettings.enabled && savedTrialEmail) {
        setEmail(savedTrialEmail);
        const savedTrial = await request<Trial>("/api/v1/subscriptions/trial", {
          method: "POST",
          body: JSON.stringify({ email: savedTrialEmail }),
        });
        if (mounted) setTrial(savedTrial);
      }
      if (reference) {
        try {
          setPayment(await request<Payment>(`/api/v1/subscriptions/${encodeURIComponent(reference)}`));
        } catch {
          localStorage.removeItem(storageKey);
        }
      }
    }).catch((error: unknown) => {
      if (mounted) setNotice(error instanceof Error ? error.message : "Could not load subscription plans.");
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!payment || payment.payment_status !== "pending") return;
    let active = true;
    const timer = window.setInterval(() => {
      void request<Payment>(`/api/v1/subscriptions/${encodeURIComponent(payment.invoice_reference)}`)
        .then((updated) => { if (active) setPayment(updated); })
        .catch((error: unknown) => { if (active) setNotice(error instanceof Error ? error.message : "Could not check payment status."); });
    }, 8000);
    return () => { active = false; window.clearInterval(timer); };
  }, [payment?.invoice_reference, payment?.payment_status]);

  async function startTrial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const started = await request<Trial>("/api/v1/subscriptions/trial", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      localStorage.setItem(trialEmailKey, email.trim().toLowerCase());
      setEmail(email.trim().toLowerCase());
      setTrial(started);
      if (!started.trial_started_at) setNotice("This email has already used its free trial.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start the free trial.");
    } finally {
      setBusy(false);
    }
  }

  async function startCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const created = await request<Payment>("/api/v1/subscriptions/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: selectedPlan, email, phone_number: phone }),
      });
      localStorage.setItem(storageKey, created.invoice_reference);
      setPayment(created);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start the EcoCash payment.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshPayment() {
    if (!payment) return;
    setBusy(true);
    setNotice("");
    try {
      setPayment(await request<Payment>(`/api/v1/subscriptions/${encodeURIComponent(payment.invoice_reference)}`));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not check payment status.");
    } finally {
      setBusy(false);
    }
  }

  async function updateSubscriptionSettings() {
    if (!settings) return;
    setAdminBusy(true);
    setNotice("");
    try {
      const updated = await request<SubscriptionSettings>("/api/v1/subscriptions/admin/settings", {
        method: "PUT",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ enabled: !settings.enabled }),
      });
      setSettings(updated);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update subscription settings.");
    } finally {
      setAdminBusy(false);
    }
  }

  const selected = plans.find((plan) => plan.id === selectedPlan);

  return (
    <div className="bot-page subscription-page">
      <header className="bot-page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> ACCOUNT / BILLING</div><h1>Subscriptions<span>.</span></h1><p>{settings?.enabled ? "Choose a monthly plan and approve its EcoCash request from your phone." : settings ? "Use ZimShop AI for free while paid subscriptions are paused." : "Checking billing availability with the API."}</p></div>
      </header>

      <section className="sms-operations-section subscription-admin">
        <button className="button button-secondary subscription-admin-toggle" type="button" onClick={() => setAdminOpen((open) => !open)} aria-expanded={adminOpen}><Settings2 size={15} />{adminOpen ? "Close admin controls" : "Admin controls"}</button>
        {adminOpen && <div className="subscription-admin-content">
          <div><strong>Global monetisation</strong><p>Changes apply to new checkouts immediately and are saved across restarts.</p></div>
          <label className="field-label" htmlFor="subscription-admin-token">ADMIN TOKEN</label>
          <input id="subscription-admin-token" className="text-input" type="password" autoComplete="off" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Enter the API server's admin token" />
          <button className="button button-primary" type="button" onClick={() => void updateSubscriptionSettings()} disabled={adminBusy || loading || !settings || !adminToken.trim()}>{adminBusy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}{adminBusy ? "Saving" : settings?.enabled ? "Pause paid subscriptions" : "Enable paid subscriptions"}</button>
        </div>}
      </section>

      {notice && <div className="notice bot-notice" role="status"><CircleAlert size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}

      <section className="subscription-price-note"><ShieldCheck size={17} /><p>{settings?.enabled ? <>Plans are billed monthly in proposed USD; confirm your Paynow merchant account supports USD before paying. Renewals are manual, so you can cancel by not making another payment. Refunds and statutory cancellation rights are handled under the <a href="/terms/" target="_blank" rel="noreferrer">Terms and Conditions</a>; contact <a href="/contact/" target="_blank" rel="noreferrer">support</a> for help.</> : settings ? "Free access is enabled. Paid subscriptions and new checkout requests are currently paused." : "Subscription status is unavailable. Billing actions are hidden until the API status can be confirmed."}</p></section>

      <div className="subscription-layout">
        <section className="sms-operations-section subscription-plans">
          <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> MONTHLY PLANS</span><h2>{settings?.enabled ? "Select a plan" : "Free access"}</h2></div><CreditCard size={18} /></div>
          {loading ? <div className="gateway-empty"><LoaderCircle className="spin" size={17} /><p>Loading plans…</p></div> : settings?.enabled ? <div className="subscription-plan-list">{plans.map((plan) => <button key={plan.id} className={`subscription-plan ${selectedPlan === plan.id ? "selected" : ""}`} type="button" onClick={() => setSelectedPlan(plan.id)} aria-pressed={selectedPlan === plan.id}><span className="subscription-plan-check">{selectedPlan === plan.id && <Check size={14} />}</span><span className="subscription-plan-copy"><strong>{plan.name}</strong><small>{plan.description}</small></span><span className="subscription-plan-price"><strong>${Number(plan.amount).toFixed(2)}</strong><small>{plan.currency} / month</small></span></button>)}</div> : settings ? <div className="subscription-free-state"><strong>All features are available for free</strong><p>Businesses can register and list products without a paid plan. Product matching and other workspaces remain available.</p></div> : <div className="subscription-free-state"><strong>Billing status unavailable</strong><p>Subscription settings could not be loaded. Paid checkout remains unavailable until the API status is confirmed.</p></div>}
        </section>

        <section className="sms-operations-section subscription-checkout">
          <div className="bot-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> ECOCASH / PAYNOW</span><h2>{payment?.payment_status === "paid" ? "Subscription active" : settings?.enabled ? "Start checkout" : "Subscriptions paused"}</h2></div><CalendarClock size={18} /></div>
          {payment ? <div className="subscription-payment-state">
            <span className={`subscription-status ${payment.payment_status}`}>{payment.payment_status === "paid" ? "PAYMENT VERIFIED" : payment.payment_status.toUpperCase()}</span>
            <strong>{payment.plan[0].toUpperCase() + payment.plan.slice(1)} · ${Number(payment.amount).toFixed(2)} {payment.currency}</strong>
            <p>{payment.payment_status === "paid" ? "Your subscription is active. Renew manually before it expires to continue." : payment.instructions || "Approve the EcoCash prompt on your phone. The plan activates only after Paynow verifies payment."}</p>
            <small>Invoice {payment.invoice_reference}</small>
            {payment.subscription_status === "active" && <div className="subscription-dates"><span>EXPIRES <strong>{date(payment.expires_at)}</strong></span><span>RENEWAL REMINDER <strong>{date(payment.renewal_reminder_at)}</strong></span></div>}
            {payment.payment_status === "pending" && <button className="button button-secondary" type="button" onClick={() => void refreshPayment()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Check payment status</button>}
            {payment.payment_status !== "pending" && <button className="button button-secondary" type="button" onClick={() => { setPayment(null); localStorage.removeItem(storageKey); }}>Choose another plan</button>}
          </div> : loading ? <div className="gateway-empty"><LoaderCircle className="spin" size={17} /><p>Loading billing status…</p></div> : settings === null ? <div className="subscription-free-state"><strong>Billing status unavailable</strong><p>Checkout is hidden until subscription settings can be loaded.</p></div> : !settings.enabled ? <div className="subscription-free-state"><strong>No payment required</strong><p>Paid plans are paused. Your existing payment records remain available, and new checkouts are disabled.</p></div> : trial?.trial_started_at ? <>
            <div className="subscription-trial-state">
              <span className={`subscription-status ${trial.subscription_status === "trialing" ? "paid" : "failed"}`}>{trial.subscription_status === "trialing" ? "FREE TRIAL ACTIVE" : "TRIAL ENDED"}</span>
              <strong>7 days, no payment required</strong>
              <p>{trial.subscription_status === "trialing" ? "Your trial is active. Choose a monthly plan below and pay when you are ready." : "Your seven-day trial has ended. Choose a plan to continue with a paid subscription."}</p>
              <small>Trial ends {date(trial.trial_ends_at)}</small>
            </div>
            <form className="sms-tool-form" onSubmit={startCheckout}>
              <input type="hidden" value={email} readOnly />
              <label className="field-label" htmlFor="subscription-phone">ECOCASH NUMBER</label><input id="subscription-phone" className="text-input" type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="077 123 4567" minLength={10} maxLength={20} required />
              <p className="sms-form-note">Paynow will send a payment request to this number. Your paid plan starts only after Paynow verifies payment.</p>
              <button className="button button-primary" type="submit" disabled={busy || loading || !selected}>{busy ? <LoaderCircle className="spin" size={15} /> : <CreditCard size={15} />}{busy ? "Sending request" : `Pay $${Number(selected?.amount || 0).toFixed(2)} / month`}</button>
            </form>
          </> : <form className="sms-tool-form" onSubmit={startTrial}>
            <label className="field-label" htmlFor="subscription-email">BILLING EMAIL</label><input id="subscription-email" className="text-input" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@business.co.zw" maxLength={320} required />
            <p className="sms-form-note">Start with seven days free. No EcoCash number or payment is needed to begin. One trial is available per email address.</p>
            <button className="button button-primary" type="submit" disabled={busy || loading}>{busy ? <LoaderCircle className="spin" size={15} /> : <CalendarClock size={15} />}{busy ? "Starting trial" : "Start 7-day free trial"}</button>
          </form>}
        </section>
      </div>
      <p className="subscription-footnote">The trial is available once per email. A paid renewal reminder date is recorded five days before expiry; automatic email or SMS reminders require a configured notification service and customer consent.</p>
    </div>
  );
}
