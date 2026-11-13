
# ZimShop AI

ZimShop AI helps Zimbabwean buyers discover local product listings and helps businesses manage product listings alongside customer enquiries and SMS workflows. It is a web application built with React and TypeScript, backed by FastAPI and PostgreSQL.

## Run locally

1. For Docker Compose, copy `.env.example` to the repository-root `.env`, set `APP_ENV=development`, and set a URL-safe `POSTGRES_PASSWORD`. For direct local API runs, set backend values in `backend/.env`; the API loads that file automatically. Keep real credentials out of `.env.example`.
2. Set an AI key in the backend environment. The backend supports Gemini, OpenAI-compatible APIs, Groq, and Cloudflare Workers AI. If none is configured or a provider is unavailable, it falls back to the built-in multilingual rules/default workflow.
3. Start Docker Desktop and run `docker compose up --build`.
4. In another terminal, run `npm install` and `npm run dev`.
5. Open `http://localhost:4176`. The Vite development server proxies API requests to the backend at `http://localhost:8000`; interactive API docs are at `http://localhost:8000/docs`.

Recommended settings:

Provider order when multiple keys are set is OpenAI, Groq, Cloudflare AI, then Gemini. Keys are read only by the backend; Cloudflare requires both an API token with Workers AI access and the account ID. The OpenAI-compatible base URL defaults to `https://api.openai.com/v1` and its model defaults to `gpt-4o-mini`.

## Smart Match Marketplace

The public landing page at `/` and Smart Match search are available without signing in. The landing page's **Log in**, **Create account**, and **List your business** links open the seller workspace. Creating an account or logging in opens the protected business dashboard; signing out returns the app to seller sign-in. Buyers can search registered seller listings by product, maximum budget/currency, Zimbabwean location, and new/used condition. The backend can use a configured AI provider to extract product terms from a natural-language request, then filters and ranks only real database listings. Without an available AI provider it falls back to keyword matching. AI does not supply or invent sellers, stock, or prices. Buyers can sort matching offers by listed price and contact sellers by phone or SMS.

Businesses select **Sell on ZimShop** to create a free seller account, maintain their business location, private physical address and delivery coverage, and publish products with price, condition, stock, and a product photo. Registration records acceptance of the dated Terms and Conditions, and collects legal status plus applicable registration details. Physical address and registration details are not included in public Smart Match results. Product descriptions should disclose mandatory extra charges such as delivery fees and taxes. Sellers can mark listings as new, used, refurbished, reconditioned or grey market, and can edit or pause listings and explicitly confirm their price and stock; Smart Match displays that confirmation date. Photos can be uploaded as JPEG, PNG, or WebP files up to 5 MB, or supplied as a public HTTPS image URL. Buyers can use **Place Order via SMS** on a result to open their messaging app with the seller, product, listed price, quantity, and search location prefilled. The buyer reviews and sends the SMS; carrier charges may apply. This is only an order enquiry, not a completed purchase, and the seller must confirm availability, final price, additional charges and delivery.

The public landing page links to the [Terms and Conditions](./public/terms/index.html), [Privacy Policy](./public/privacy/index.html), and [Contact Us](./public/contact/index.html) pages. Privacy requests and support enquiries can be directed to 0782029738. The Privacy Policy describes the information handled by the current application, including that some stored contact and conversation data does not yet have automatic expiry.

Marketplace products are stored separately from the existing SMS bot catalog. Adding a product to **Catalog and shop details** does not publish it to Smart Match; sellers must create a marketplace listing as well. Seller accounts use password-backed sessions, but email ownership and business identities are not independently verified. Listings and stock are seller-reported, so buyers should confirm current details and payment arrangements directly with the business. Smart Match does not collect payments or guarantee transactions.

## Subscriptions and Paynow

Paid subscriptions are paused by default. Customers and businesses can use the application for free, while subscription plans, trial and payment records, Paynow checkout, and payment callbacks remain in the project. Set `SUBSCRIPTIONS_ENABLED=true` to make paid plans available by default. The Billing workspace reflects the backend setting, and the API independently rejects new checkouts while paid subscriptions are paused.

The Billing workspace includes protected admin controls. Set `SUBSCRIPTIONS_ADMIN_TOKEN` to a private random value of at least 32 characters on the API server, then enter that token in the workspace to enable or pause paid subscriptions. The token is sent only to the backend in an Authorization header and is not saved in browser storage. Admin changes are persisted in the database and take precedence over `SUBSCRIPTIONS_ENABLED`; that environment variable supplies the initial/default value until an admin setting has been saved. Keep the token secret and use HTTPS in production.

When enabled, the Billing workspace starts with one seven-day free trial per billing email, without requesting payment details. Businesses then choose Starter ($5/month), Business ($15/month), or Premium ($30/month), currently configured as proposed USD prices. Confirm the currency enabled on your Paynow merchant account before accepting live payments. Add `PAYNOW_INTEGRATION_ID`, `PAYNOW_INTEGRATION_KEY`, `PAYNOW_RETURN_URL`, and `PAYNOW_RESULT_URL` to the backend environment. The return and result URLs must be public HTTPS URLs; the result URL should point to `/api/v1/subscriptions/paynow-result` on the API. Paynow's Python SDK starts the EcoCash prompt, and the backend activates a plan only after server-side transaction polling verifies payment and amount. Checkout is rejected unless a trial has been recorded for that email.

Pausing subscriptions blocks new checkouts but does not cancel pending Paynow transactions or disable payment verification/status endpoints. Resolve existing pending payments through the normal Paynow flow before pausing if they should not complete. The current application does not yet gate product listing, AI usage, or other features on subscription status; the switch controls monetisation availability and billing UI, not feature entitlements.

### Important payment security

Before accepting live payments, follow these requirements:

- Never activate a subscription only because the customer returned to your website; the return URL is not proof of payment.
- Verify each transaction with Paynow's poll URL on the server.
- Validate Paynow notification hashes before accepting server notifications.
- Make payment processing idempotent so duplicate notifications or status checks cannot apply a payment more than once.
- Match the verified payment amount against the amount recorded for the original invoice.
- Persist transaction references and payment history for reconciliation and support.
- Keep `PAYNOW_INTEGRATION_KEY` exclusively on the backend; never expose it to frontend code.

See Paynow's [Status Update documentation](https://developers.paynow.co.zw/docs/paynow/status_update/) for server notifications and transaction verification. The backend validates notification hashes, matches the notification and polled reference, amount, and poll URL to the stored invoice, and uses database row locks to prevent duplicate payment activation. Production uses PostgreSQL, which supports the row-level locking required for concurrent processing.

Subscriptions renew manually; no recurring charge is made. The system records an in-app renewal reminder date five days before paid expiry, but sending an email or SMS reminder requires a notification service and customer consent. Seller accounts authenticate the marketplace workspace, but subscription status is not yet connected to feature access and is not an access-control boundary. Trial eligibility is keyed to email and can be bypassed with another address until account ownership verification is added; do not rely on it as a fraud-resistant trial limit or to protect paid features.

## SMS bots

Open **SMS bots** in the workspace to describe a bot, generate a draft flow, edit message and decision nodes, and test customer replies without sending them. Save the draft and review it before activating. The starter workflow includes product, order, and human-help routes. Conversations are stored in PostgreSQL.

### SMSGate integration

ZimShop is a web dashboard and Python control plane. It does not contain or install a custom Android gateway app. Install the official [SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway/releases) separately on the phone with the SIM; ZimShop connects to that existing SMSGate service through its API. In the workspace, open **SMS Gateway** to view the live connection, registered devices and SIMs, inbox/outbox, webhooks, and provider settings.

Configure the connection only on the Python API server:

- `SMSGATE_MODE=cloud` uses `https://api.sms-gate.app/3rdparty/v1` by default. Set `SMSGATE_USERNAME` and `SMSGATE_PASSWORD` from the SMSGate account. The backend obtains and rotates scoped JWT tokens; no gateway credential or token is sent to browser JavaScript.
- `SMSGATE_MODE=private` uses the private server's HTTPS API. Set `SMSGATE_API_URL` to its origin or `/api/3rdparty/v1` URL, plus the account credentials. The backend normalizes the Private Server API path and uses JWT authentication.
- `SMSGATE_MODE=local` uses the phone's reachable local API URL, for example `http://192.168.1.40:8080`. Local Server supports Basic Auth rather than JWT and must be reachable from the Python backend on the same network. Device account management and provider inbox history may be unavailable in this mode.

The SMSGate page reads provider devices, messages, settings, and webhooks; Cloud/Private inbox conversations appear from webhooks, while direct provider inbox retrieval is Local-mode only. Webhook registration uses the selected provider API. Register `sms:received`, `sms:sent`, `sms:delivered`, `sms:failed`, `sms:cancelled`, `app:started`, and `system:ping` to `https://YOUR_API_HOST/api/v1/sms/webhook/YOUR_SMSGATE_WEBHOOK_TOKEN`. The receiver validates its secret URL token and payload/device data and deduplicates webhook retries. Use HTTPS and redact the token path in proxy logs.

Single-recipient compose requires an existing contact with SMS consent. Sending is disabled unless `SMS_SENDING_ENABLED=true` is set on the API server; the default is `false`. Device removal may delete provider-side messages and is confirmed in the UI. SMSGate status values distinguish queue acceptance from handset delivery.

### iPhone manual mode

iPhone users can save and test flows, but the app does not claim unrestricted background SMS access. Use the Enquiry desk to paste an incoming text and prepare a suggested reply, then send it manually from Messages. Automatic bot activation is disabled in this mode.

AI-generated flows are drafts and should be reviewed before use. If no provider is configured or available, generation uses the built-in clothing-shop starter flow. Customers can reply `STOP` or `UNSUBSCRIBE` to disable automated replies and `START` to resume.

For local Python development, create a virtual environment, install `requirements.txt`, and start PostgreSQL 16. In PowerShell, set `APP_ENV=development` and a local `DATABASE_URL` before starting the API, for example:

```powershell
$env:APP_ENV = "development"
$env:DATABASE_URL = "postgresql+psycopg://zimshop:YOUR_LOCAL_PASSWORD@localhost:5432/zimshop"
python -m uvicorn backend.app.main:app --reload
```

Run the backend tests with `python -m unittest discover -v`.
## Production SMS deployment

The production API requires `APP_ENV=production`, PostgreSQL, SMS Gateway credentials, and a long random webhook token. `SMS_SENDING_ENABLED` defaults to `false`; while disabled, the API refuses outbound SMS, blocks automatic bot activation, and suppresses replies while continuing to record inbound STOP/START and conversation events. The application has no admin login: protect the dashboard and API with an authenticating reverse proxy, VPN, or equivalent network access control before deployment. The API container binds to localhost, but do not expose it directly to the internet. The SMS webhook remains protected by its secret URL token. API docs are disabled in production. Serve the frontend and API over HTTPS; set `CORS_ORIGINS` to exact HTTPS frontend origin(s), not `*` or localhost.

### Commercial launch gates

Do not enable outbound SMS or onboard commercial customers until these items are signed off. This is an operational checklist, not legal advice or confirmation of POTRAZ/operator approval.

- Obtain Zimbabwean legal advice on Cyber and Data Protection Act duties, SI 155 of 2024 licensing/DPO requirements, automated-processing notices, and cross-border transfers. Confirm applicability and filings with POTRAZ or qualified counsel.
- Obtain written permission from each mobile operator for the intended automated commercial traffic, volume, SIM, and sender identity. The SMS Gateway project warns against batch sending; this app currently has no operator-approved throughput limiter or campaign approval workflow.
- Document whether the gateway uses Local, Public Cloud, or Private Server mode, every processor and transfer, the retention terms, and the incident/credential-revocation procedure. The configured default is the Public Cloud API, and this backend currently sends gateway API requests using Basic authentication.
- Treat this release as a **single-business workspace only**. The database and API do not consistently scope contacts, conversations, campaigns, products, or settings by tenant; do not onboard multiple independent businesses until tenant isolation is implemented and tested.
- Consent fields are manually set booleans with a timestamp, not auditable consent evidence. Do not import contacts as opted-in. Before campaigns, record the business, purpose, source, wording/version, timestamp, and proof of consent; keep marketing consent separate from service-message consent. STOP clears both flags; START restores SMS consent only, not marketing consent.
- Review the OpenAI API data-processing terms and transfer safeguards before sending customer text to OpenAI. Enquiry analysis sends the customer message but omits the separately supplied customer name; messages themselves may still contain personal information. Confirm privacy notices and processor agreements with each business.
- Define and implement retention, deletion, backup/restore, access review, and incident-response procedures. Assess applicable breach notices, including the 24-hour and 72-hour timelines described in SI 155, with qualified counsel.
- Complete the real-device test matrix across Econet, NetOne, and Telecel with written operator approval; verify STOP/START, duplicate webhooks, multipart messages, delivery versus handset receipt, outage recovery, rate/volume limits, and OpenAI failure behavior.

Keep `SMS_SENDING_ENABLED=false` until the launch gates that apply to your deployment are complete. To enable sending after sign-off, set `SMS_SENDING_ENABLED=true` in the API environment and recreate the API service. Keep the switch off for development and test deployments.

1. Copy `.env.example` to `.env`. Use a long URL-safe random value for `POSTGRES_PASSWORD`, SMS Gateway credentials, and a separate `SMSGATE_WEBHOOK_TOKEN` generated with a cryptographically secure random generator (for example `python -c "import secrets; print(secrets.token_urlsafe(48))"`). Never commit `.env`. If you ever ran a prior version using the old sample database password, rotate that database credential before going live.
2. Set `APP_ENV=production`, `CORS_ORIGINS` to your HTTPS frontend origin, and configure AI provider keys only if you intend to send customer messages to that provider.
3. Configure the Android gateway webhook events as described above, using the public HTTPS address of your reverse proxy. Restrict its body size and redact the webhook-token path from access logs. Require proxy authentication or VPN/network access for the dashboard and API, while allowing only the token-protected SMS webhook route through as needed. The Docker API and database ports bind to localhost; do not expose them directly to the internet.
4. Start the services with `docker compose up --build -d`, put a TLS reverse proxy in front of the frontend/API, and verify protected dashboard access, inbound SMS, STOP/START, delivery reports, and provider/database outage behavior before enabling the bot.
5. Back up PostgreSQL, test restoring a backup, monitor failed message delivery and webhook errors, and define a retention/deletion policy for customer contacts and conversation history.

Incoming texts are not automatically copied into the learned-phrase table anymore: the phrase miner did not improve routing and could retain parts of customer messages. Review and remove any phrases collected by older versions before launch. The app persists SMS conversation history for its dashboard; it does not yet automatically expire or erase that history.

STOP and IsiShona opt-out phrases are handled for inbound messages even if the bot is inactive; START/tangazve can restore SMS consent without restoring marketing consent. Conversation history remains stored in PostgreSQL without automatic expiry; implement and verify a retention/deletion process before launch.

Run `npm run build` to create the production frontend in `dist`. When frontend and API use different origins, set `VITE_API_URL` to the API's HTTPS URL and configure that exact frontend origin in `CORS_ORIGINS`.

