import asyncio
import logging
import os
import hmac
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from uuid import UUID, uuid4

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .analysis import analyze_enquiry, greet_customer
from .bot import generate_workflow, normalize_text, route_message, send_sms_message, starter_workflow, whatsapp_purchase_link
from .database import Base, SessionLocal, engine, get_session
from .models import (
    BotBusinessProfile,
    BotCampaign,
    BotCampaignTarget,
    BotContact,
    BotConversation,
    BotProduct,
    BotWorkflow,
    Followup,
)
from .schemas import (
    AnalysisResult,
    AnalyzeRequest,
    BotDashboardRead,
    BotCampaignCreate,
    BotCampaignRead,
    BotContactRead,
    BotContactUpsert,
    BotBusinessProfileRead,
    BotBusinessProfileUpdate,
    BotGenerateRequest,
    BotProductCreate,
    BotProductRead,
    BotSimulationRequest,
    BotSimulationResult,
    GatewaySendRequest,
    GatewayWebhookCreate,
    BotWorkflowRead,
    BotWorkflowUpdate,
    FollowupCreate,
    FollowupRead,
)
from .smsgate import (
    SMSGateError,
    connection_info as smsgate_connection_info,
    health as smsgate_health,
    is_configured as smsgate_is_configured,
    list_devices as smsgate_list_devices,
    list_inbox as smsgate_list_inbox,
    list_messages as smsgate_list_messages,
    request_json as smsgate_request,
    send_sms_message as smsgate_send_sms,
)
from .subscriptions import router as subscriptions_router
from .marketplace import UPLOAD_DIR, purge_expired_search_queries, router as marketplace_router


production_mode = os.getenv("APP_ENV", "production").strip().casefold() == "production"
logger = logging.getLogger(__name__)
search_query_cleanup_task: asyncio.Task[None] | None = None
app = FastAPI(
    title="ZimShop AI API",
    version="1.0.0",
    docs_url=None if production_mode else "/docs",
    redoc_url=None if production_mode else "/redoc",
    openapi_url=None if production_mode else "/openapi.json",
)
allowed_origins = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:4176,http://localhost:5173",
).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in allowed_origins if origin.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)
app.include_router(subscriptions_router)
app.include_router(marketplace_router)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="product-images")

SMS_STOP_COMMANDS = {
    "stop",
    "stop all",
    "unsubscribe",
    "cancel",
    "end",
    "quit",
    "mira",
    "mira zvese",
    "rambai",
    "nyarara",
    "mira henyu",
}
SMS_START_COMMANDS = {"start", "tanga", "resume", "tangazve"}


@app.on_event("startup")
def initialize_database() -> None:
    if production_mode:
        sms_enabled = (
            os.getenv("SMS_SENDING_ENABLED", "false")
            .strip()
            .casefold() == "true"
        )

        required = [
            "DATABASE_URL",
            "CORS_ORIGINS",
        ]

        if sms_enabled:
            required.extend([
                "SMSGATE_USERNAME",
                "SMSGATE_PASSWORD",
                "SMSGATE_WEBHOOK_TOKEN",
            ])

        missing = [
            key for key in required
            if not os.getenv(key, "").strip()
        ]

        if missing:
            raise RuntimeError(
                f"Missing required production settings: {', '.join(missing)}"
            )
        if not os.getenv("DATABASE_URL", "").startswith(("postgresql://", "postgresql+")):
            raise RuntimeError("Production requires PostgreSQL; SQLite is not supported.")
        if sms_enabled and not re.fullmatch(
            r"[A-Za-z0-9_-]{32,}",
            os.getenv("SMSGATE_WEBHOOK_TOKEN", "")
        ):
            raise RuntimeError(
                "SMSGATE_WEBHOOK_TOKEN must be at least 32 URL-safe characters."
            )
        allowed_production_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
        if not allowed_production_origins or any(not origin.startswith("https://") for origin in allowed_production_origins):
            raise RuntimeError("Production CORS_ORIGINS must contain only explicit HTTPS origins.")
        gateway_mode = os.getenv("SMSGATE_MODE", "cloud").strip().casefold()
        if gateway_mode not in {"cloud", "private", "local"}:
            raise RuntimeError("SMSGATE_MODE must be cloud, private, or local.")
        gateway_url = os.getenv("SMSGATE_API_URL", "").strip()
        if gateway_mode in {"private", "local"} and not gateway_url:
            raise RuntimeError("SMSGATE_API_URL is required for Private Server and Local Server modes.")
        if gateway_mode in {"cloud", "private"} and gateway_url and not gateway_url.startswith("https://"):
            raise RuntimeError("Cloud and Private Server SMSGATE_API_URL values must use HTTPS.")
        if gateway_mode == "local" and gateway_url and not gateway_url.startswith(("http://", "https://")):
            raise RuntimeError("Local Server SMSGATE_API_URL must start with http:// or https://.")

    Base.metadata.create_all(bind=engine)
    from .migrations import (
        migrate_bot_product_image_schema,
        migrate_marketplace_terms_schema,
        migrate_sms_schema,
        migrate_subscription_schema,
    )

    migrate_sms_schema(engine)
    migrate_subscription_schema(engine)
    migrate_marketplace_terms_schema(engine)
    migrate_bot_product_image_schema(engine)
    with SessionLocal() as session:
        purge_expired_search_queries(session)
        session.commit()
    global search_query_cleanup_task
    if search_query_cleanup_task is None or search_query_cleanup_task.done():
        search_query_cleanup_task = asyncio.get_running_loop().create_task(
            search_query_retention_loop()
        )


async def search_query_retention_loop() -> None:
    while True:
        await asyncio.sleep(60 * 60 * 24)
        try:
            await asyncio.to_thread(purge_expired_search_queries_from_database)
        except Exception:
            logger.exception("Could not remove expired Smart Match search queries.")


def purge_expired_search_queries_from_database() -> None:
    with SessionLocal() as session:
        purge_expired_search_queries(session)
        session.commit()


@app.on_event("shutdown")
async def stop_search_query_retention_loop() -> None:
    global search_query_cleanup_task
    if search_query_cleanup_task is not None:
        search_query_cleanup_task.cancel()
        try:
            await search_query_cleanup_task
        except asyncio.CancelledError:
            pass
        search_query_cleanup_task = None
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/gateway/status")
def get_gateway_status() -> dict:
    info = smsgate_connection_info()
    status_result = {
        **info,
        "sending_enabled": os.getenv("SMS_SENDING_ENABLED", "false").strip().casefold() == "true",
        "connected": False,
        "health": None,
        "devices": [],
        "error": None,
    }
    if not smsgate_is_configured():
        status_result["error"] = "Configure SMSGate credentials on the API server."
        return status_result
    try:
        status_result["health"] = smsgate_health()
        status_result["devices"] = smsgate_list_devices()
        health_status = status_result["health"].get("status") if isinstance(status_result["health"], dict) else None
        status_result["connected"] = health_status != "fail"
    except SMSGateError as exc:
        status_result["error"] = str(exc)
    return status_result


@app.get("/api/v1/gateway/devices")
def get_gateway_devices() -> list[dict]:
    try:
        return smsgate_list_devices()
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.delete("/api/v1/gateway/devices/{device_id}")
def remove_gateway_device(device_id: str):
    if os.getenv("SMSGATE_MODE", "cloud").strip().casefold() == "local":
        raise HTTPException(status_code=409, detail="Device account management is not available in Local Server mode.")
    try:
        return smsgate_request("DELETE", f"devices/{quote(device_id, safe='')}")
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/v1/gateway/messages")
def get_gateway_messages(limit: int = 50, offset: int = 0):
    if not 1 <= limit <= 500 or offset < 0:
        raise HTTPException(status_code=422, detail="Invalid message pagination.")
    try:
        return smsgate_list_messages(limit=limit, offset=offset)
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.delete("/api/v1/gateway/messages/{message_id}")
def cancel_gateway_message(message_id: str):
    try:
        return smsgate_request("DELETE", f"messages/{quote(message_id, safe='')}")
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/v1/gateway/inbox")
def get_gateway_inbox(limit: int = 50, offset: int = 0, session: Session = Depends(get_session)) -> list[dict]:
    if not 1 <= limit <= 500 or offset < 0:
        raise HTTPException(status_code=422, detail="Invalid inbox pagination.")
    try:
        if os.getenv("SMSGATE_MODE", "cloud").strip().casefold() == "local":
            return smsgate_list_inbox(limit=limit, offset=offset)
        statement = (
            select(BotConversation, BotContact)
            .join(BotContact, BotConversation.contact_id == BotContact.id)
            .where(BotConversation.direction == "in")
            .order_by(BotConversation.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        return [
            {
                "id": str(conversation.id),
                "sender": contact.phone_number,
                "message": conversation.message,
                "received_at": conversation.created_at,
                "device_id": None,
            }
            for conversation, contact in session.execute(statement)
        ]
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/v1/gateway/inbox/refresh", status_code=status.HTTP_202_ACCEPTED)
def refresh_gateway_inbox(request: dict):
    try:
        return smsgate_request("POST", "inbox/refresh", payload=request)
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/v1/gateway/settings")
def get_gateway_settings():
    try:
        return smsgate_request("GET", "settings")
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.patch("/api/v1/gateway/settings")
def update_gateway_settings(request: dict):
    try:
        return smsgate_request("PATCH", "settings", payload=request)
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/v1/gateway/webhooks")
def get_gateway_webhooks():
    try:
        return smsgate_request("GET", "webhooks")
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/v1/gateway/webhooks", status_code=status.HTTP_201_CREATED)
def create_gateway_webhook(request: GatewayWebhookCreate):
    payload = request.model_dump(exclude_none=True, by_alias=True)
    if "device_id" in payload:
        payload["device_id"] = payload.pop("device_id")
    try:
        return smsgate_request("POST", "webhooks", payload=payload)
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.delete("/api/v1/gateway/webhooks/{webhook_id}")
def delete_gateway_webhook(webhook_id: str):
    try:
        return smsgate_request("DELETE", f"webhooks/{webhook_id}")
    except SMSGateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/v1/gateway/send", status_code=status.HTTP_202_ACCEPTED)
def send_gateway_message(request: GatewaySendRequest, session: Session = Depends(get_session)) -> dict[str, str]:
    if os.getenv("SMS_SENDING_ENABLED", "false").strip().casefold() != "true":
        raise HTTPException(status_code=409, detail="SMS sending is disabled until production launch checks are complete.")
    phone_number = "".join(character for character in request.phone_number if character.isdigit() or character == "+")
    contact = session.scalar(select(BotContact).where(BotContact.phone_number == phone_number))
    if contact is None or not contact.sms_consent or (contact.state or {}).get("opted_out"):
        raise HTTPException(status_code=403, detail="A contact with current SMS consent is required before sending.")
    conversation = BotConversation(
        contact_id=contact.id,
        direction="out",
        message=request.message.strip(),
        provider_message_id=str(uuid4()),
        delivery_status="pending",
    )
    session.add(conversation)
    session.commit()
    try:
        provider_id = smsgate_send_sms(
            phone_number,
            conversation.message,
            conversation.provider_message_id,
            request.device_id,
            request.sim_number,
        )
    except SMSGateError as exc:
        conversation.delivery_status = "queue_failed"
        session.commit()
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    conversation.provider_message_id = provider_id
    conversation.delivery_status = "queued"
    session.commit()
    return {"id": provider_id, "status": "queued"}


@app.post("/api/v1/analyze", response_model=AnalysisResult)
def analyze(request: AnalyzeRequest) -> AnalysisResult:
    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Customer message cannot be blank.")
    try:
        result = analyze_enquiry(message, request.customer.strip())
        result["reply"] = greet_customer(result["reply"], request.customer)
        return AnalysisResult(**result)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Analysis failed. Check the AI service configuration and try again.",
        ) from exc


@app.get("/api/v1/followups", response_model=list[FollowupRead])
def list_followups(session: Session = Depends(get_session)) -> list[Followup]:
    statement = select(Followup).order_by(Followup.created_at.desc()).limit(100)
    return list(session.scalars(statement))


@app.post(
    "/api/v1/followups",
    response_model=FollowupRead,
    status_code=status.HTTP_201_CREATED,
)
def save_followup(
    request: FollowupCreate,
    session: Session = Depends(get_session),
) -> Followup:
    followup = Followup(**request.model_dump())
    session.add(followup)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This follow-up has already been saved.",
        ) from exc
    session.refresh(followup)
    return followup


def sms_gateway_is_configured() -> bool:
    return bool(
        os.getenv("SMS_SENDING_ENABLED", "false").strip().casefold() == "true"
        and os.getenv("SMSGATE_USERNAME", "").strip()
        and os.getenv("SMSGATE_PASSWORD", "")
        and os.getenv("SMSGATE_WEBHOOK_TOKEN", "").strip()
    )


def gateway_device_is_connected(workflow: BotWorkflow | None) -> bool:
    if workflow is None or not workflow.gateway_device_id or workflow.gateway_last_seen is None:
        return False
    last_seen = workflow.gateway_last_seen
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - last_seen <= timedelta(minutes=5)


def validate_workflow(workflow: list[dict]) -> None:
    node_ids = [node["id"] for node in workflow]
    if len(node_ids) != len(set(node_ids)):
        raise HTTPException(status_code=422, detail="Workflow node IDs must be unique.")
    node_set = set(node_ids)
    triggers = [node for node in workflow if node["kind"] == "trigger"]
    if len(triggers) != 1:
        raise HTTPException(status_code=422, detail="A workflow must have exactly one incoming-message trigger.")
    if not triggers[0].get("next"):
        raise HTTPException(status_code=422, detail="Connect the incoming-message trigger to a workflow step.")
    for node in workflow:
        if node["kind"] == "decision" and not node.get("choices"):
            raise HTTPException(status_code=422, detail=f"Decision '{node['title']}' needs at least one choice.")
        targets = ([node["next"]] if node.get("next") else [])
        targets.extend(choice["next"] for choice in node.get("choices", []))
        if any(target not in node_set or target == node["id"] for target in targets):
            raise HTTPException(status_code=422, detail=f"Node '{node['title']}' points to a missing node.")
        if any(next(node for node in workflow if node["id"] == target)["kind"] == "trigger" for target in targets):
            raise HTTPException(status_code=422, detail="Workflow steps cannot route back to the incoming-message trigger.")


def campaign_read(campaign: BotCampaign, session: Session) -> dict:
    targets = list(session.scalars(
        select(BotCampaignTarget).where(BotCampaignTarget.campaign_id == campaign.id)
    ))
    return {
        "id": campaign.id,
        "name": campaign.name,
        "category": campaign.category,
        "message": campaign.message,
        "interest_filter": campaign.interest_filter,
        "scheduled_at": campaign.scheduled_at,
        "status": campaign.status,
        "queued_count": sum(target.status == "queued" for target in targets),
        "sent_count": sum(target.status in {"sent", "delivered"} for target in targets),
        "delivered_count": sum(target.status == "delivered" for target in targets),
        "failed_count": sum(target.status == "failed" for target in targets),
        "reply_count": sum(target.replied_at is not None for target in targets),
        "created_at": campaign.created_at,
        "completed_at": campaign.completed_at,
    }


def dispatch_due_campaigns(session: Session, record: BotWorkflow) -> None:
    if not sms_gateway_is_configured() or not gateway_device_is_connected(record):
        return
    now = datetime.now(timezone.utc)
    due_campaigns = list(session.scalars(
        select(BotCampaign)
        .where(BotCampaign.status.in_(["scheduled", "sending"]), BotCampaign.scheduled_at <= now)
        .order_by(BotCampaign.scheduled_at.asc())
    ))
    for campaign in due_campaigns:
        if campaign.status == "scheduled":
            for contact in session.scalars(select(BotContact)):
                eligible = contact.marketing_consent if campaign.category in {"promotion", "seasonal"} else contact.sms_consent
                if not eligible or (contact.state or {}).get("opted_out"):
                    continue
                if campaign.interest_filter and campaign.interest_filter.casefold() not in {
                    interest.casefold() for interest in (contact.interests or [])
                }:
                    continue
                exists = session.scalar(
                    select(BotCampaignTarget.id).where(
                        BotCampaignTarget.campaign_id == campaign.id,
                        BotCampaignTarget.contact_id == contact.id,
                    )
                )
                if exists is not None:
                    continue
                message_id = str(uuid4())
                session.add_all([
                    BotCampaignTarget(
                        campaign_id=campaign.id,
                        contact_id=contact.id,
                        provider_message_id=message_id,
                        status="pending",
                    ),
                    BotConversation(
                        contact_id=contact.id,
                        direction="out",
                        message=campaign.message,
                        provider_message_id=message_id,
                        result={"campaign_id": str(campaign.id)},
                        delivery_status="pending",
                    ),
                ])
            campaign.status = "sending"
            session.commit()

        pending_targets = list(session.scalars(
            select(BotCampaignTarget)
            .where(BotCampaignTarget.campaign_id == campaign.id, BotCampaignTarget.status == "pending")
            .order_by(BotCampaignTarget.created_at.asc())
            .limit(50)
        ))
        for target in pending_targets:
            contact = session.get(BotContact, target.contact_id)
            if contact is None or (contact.state or {}).get("opted_out") or not (
                contact.marketing_consent if campaign.category in {"promotion", "seasonal"} else contact.sms_consent
            ):
                target.status = "skipped"
                session.commit()
                continue
            outgoing = session.scalar(
                select(BotConversation).where(
                    BotConversation.provider_message_id == target.provider_message_id
                )
            )
            if outgoing is None:
                target.status = "failed"
                target.error = "Campaign message record is missing."
                session.commit()
                continue
            try:
                provider_id = send_sms_message(
                    contact.phone_number,
                    campaign.message,
                    target.provider_message_id or str(uuid4()),
                    record.gateway_device_id,
                )
            except RuntimeError as exc:
                target.status = "failed"
                target.error = str(exc)[:500]
                outgoing.delivery_status = "queue_failed"
            else:
                target.provider_message_id = provider_id
                target.status = "queued"
                outgoing.provider_message_id = provider_id
                outgoing.delivery_status = "queued"
            session.commit()
        remaining = session.scalar(
            select(func.count()).select_from(BotCampaignTarget).where(
                BotCampaignTarget.campaign_id == campaign.id,
                BotCampaignTarget.status == "pending",
            )
        ) or 0
        campaign.status = "completed" if remaining == 0 else "sending"
        campaign.completed_at = datetime.now(timezone.utc) if campaign.status == "completed" else None
        session.commit()


def dispatch_due_campaigns_background() -> None:
    with Session(bind=engine) as session:
        record = session.get(BotWorkflow, 1)
        if record is not None:
            dispatch_due_campaigns(session, record)


def contact_read(contact: BotContact) -> dict:
    state = contact.state or {}
    return {
        "id": contact.id,
        "phone_number": contact.phone_number,
        "profile_name": contact.profile_name,
        "sms_consent": contact.sms_consent,
        "marketing_consent": contact.marketing_consent,
        "consent_updated_at": contact.consent_updated_at,
        "interests": contact.interests or [],
        "lead_status": state.get("lead_status", "new"),
        "inquiry_count": state.get("inquiry_count", 0),
        "created_at": contact.created_at,
    }


def capture_customer_interest(contact: BotContact, message: str) -> None:
    state = dict(contact.state or {})
    state["inquiry_count"] = int(state.get("inquiry_count", 0)) + 1
    state["last_inquiry"] = message[:300]
    normalized = message.casefold()
    purchase_terms = ("buy", "order", "purchase", "pay", "price", "cost", "quote")
    interest_terms = ("product", "catalog", "catalogue", "available", "stock", "size", "interested")
    if any(term in normalized for term in purchase_terms):
        state["lead_status"] = "ready_to_buy"
    elif any(term in normalized for term in interest_terms):
        state["lead_status"] = "interested"
    contact.state = state
    words = [word.strip(".,!?;:()[]{}\"'")[:50] for word in normalized.split()]
    contact.interests = sorted(set(contact.interests or []) | {word for word in words if len(word) > 3})[:20]


def enrich_customer_reply(result: dict, message: str, contact: BotContact, session: Session) -> dict:
    normalized = message.casefold()
    route = str(result.get("route", "")).casefold()
    profile = session.get(BotBusinessProfile, 1)
    state = dict(result.get("state", {}))
    if route in {"human help", "human_handoff", "opt_out", "opted_out"}:
        return result
    if route == "support" and state.get("waiting_for") == "support_type":
        return result
    support_fields = (
        (("hour", "open", "close"), "Business hours", profile.business_hours if profile else ""),
        (("where", "location", "address"), "Location", profile.location if profile else ""),
        (("deliver", "shipping"), "Delivery", profile.delivery_policy if profile else ""),
        (("return", "refund", "exchange"), "Returns", profile.returns_policy if profile else ""),
        (("pay", "payment"), "Payment", profile.payment_instructions if profile else ""),
        (("contact", "call", "phone"), "Contact", profile.support_contact if profile else ""),
    )
    asks_support = route == "support" or any(
        term in normalized
        for terms, _, _ in support_fields
        for term in terms
    )
    if asks_support:
        answers = [f"{label}: {value}" for terms, label, value in support_fields if value and any(term in normalized for term in terms)]
        if answers:
            result["replies"] = [" ".join(answers)[:1500]] 
            result["route"] = "support"
            state.pop("needs_human", None)
            result["state"] = state
        else:
            state["needs_human"] = True
            result["state"] = state
            result["replies"] = ["I don't have confirmed details for that yet. A team member will help you shortly."]
            result["route"] = "human_handoff"
        return result

    products = list(session.scalars(select(BotProduct).where(BotProduct.active.is_(True)).order_by(BotProduct.name.asc())))
    order_intent = route == "order" or any(term in normalized for term in ("buy", "order", "purchase", "pay"))
    product_intent = route == "products" or any(term in normalized for term in ("product", "catalog", "catalogue", "price", "cost", "available", "stock"))
    if product_intent or order_intent:
        product_matches = [
            product for product in products
            if product.name.casefold() in normalized
            or any(tag.casefold() in normalized for tag in product.interests)
        ]
        generic_catalog_request = any(term in normalized for term in ("product", "catalog", "catalogue", "available", "stock"))
        selected_products = product_matches or (products[:5] if generic_catalog_request else [])
        if selected_products:
            lines = [
                f"{product.name}: {product.price or 'Ask us for the current price'}; {product.availability}. {product.description}".strip()
                + (f" Buy: {whatsapp_purchase_link(product.purchase_url, product)}" if product.purchase_url else "")
                for product in selected_products
            ]
            response = "\n".join(lines)
            if order_intent and profile and profile.payment_instructions:
                response += f" Payment: {profile.payment_instructions}"
            result["replies"] = [response[:1500]]
        elif product_intent:
            state["needs_human"] = True
            result["state"] = state
            result["replies"] = ["I don't have a confirmed catalog yet. A team member will send current product details and prices."]
            result["route"] = "human_handoff"
    return result


@app.get("/api/v1/bot", response_model=BotDashboardRead)
def get_bot_dashboard(session: Session = Depends(get_session)) -> dict:
    workflow = session.get(BotWorkflow, 1)
    return {
        "workflow": workflow,
        "contacts": session.scalar(select(func.count()).select_from(BotContact)) or 0,
        "messages": session.scalar(select(func.count()).select_from(BotConversation)) or 0,
        "sms_gateway_configured": sms_gateway_is_configured(),
        "sms_connected": gateway_device_is_connected(workflow),
        "phone_number": workflow.phone_number if workflow else None,
        "sms_mode": workflow.sms_mode if workflow else "android",
    }


@app.get("/api/v1/bot/conversations")
def list_bot_conversations(session: Session = Depends(get_session)) -> list[dict]:
    statement = (
        select(BotConversation, BotContact)
        .join(BotContact, BotConversation.contact_id == BotContact.id)
        .order_by(BotConversation.created_at.desc())
        .limit(50)
    )
    return [
        {
            "id": str(conversation.id),
            "contact": contact.profile_name or contact.phone_number,
            "phone_number": contact.phone_number,
            "direction": conversation.direction,
            "message": conversation.message,
            "needs_human": bool(contact.state.get("needs_human")),
            "delivery_status": conversation.delivery_status,
            "created_at": conversation.created_at,
        }
        for conversation, contact in session.execute(statement)
    ]


@app.get("/api/v1/bot/contacts", response_model=list[BotContactRead])
def list_bot_contacts(session: Session = Depends(get_session)) -> list[dict]:
    contacts = session.scalars(select(BotContact).order_by(BotContact.created_at.desc()).limit(500))
    return [contact_read(contact) for contact in contacts]


@app.post("/api/v1/bot/contacts", response_model=BotContactRead, status_code=status.HTTP_201_CREATED)
def save_bot_contact(request: BotContactUpsert, session: Session = Depends(get_session)) -> dict:
    phone_number = "".join(character for character in request.phone_number if character.isdigit() or character == "+")
    if request.marketing_consent and not request.sms_consent:
        raise HTTPException(status_code=422, detail="Marketing consent requires SMS consent.")
    contact = session.scalar(select(BotContact).where(BotContact.phone_number == phone_number))
    if contact is not None and contact.state.get("opted_out") and request.sms_consent:
        raise HTTPException(status_code=409, detail="This contact must text START to restore SMS consent.")
    if contact is None:
        contact = BotContact(phone_number=phone_number, profile_name=request.profile_name.strip())
        session.add(contact)
    contact.profile_name = request.profile_name.strip()
    contact.sms_consent = request.sms_consent
    contact.marketing_consent = request.marketing_consent
    contact.interests = sorted({interest.strip()[:100] for interest in request.interests if interest.strip()})
    contact.consent_updated_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(contact)
    return contact_read(contact)


@app.get("/api/v1/bot/campaigns", response_model=list[BotCampaignRead])
def list_bot_campaigns(session: Session = Depends(get_session)) -> list[dict]:
    campaigns = session.scalars(select(BotCampaign).order_by(BotCampaign.created_at.desc()).limit(100))
    return [campaign_read(campaign, session) for campaign in campaigns]


@app.post("/api/v1/bot/campaigns", response_model=BotCampaignRead, status_code=status.HTTP_201_CREATED)
def create_bot_campaign(request: BotCampaignCreate, session: Session = Depends(get_session)) -> dict:
    scheduled_at = request.scheduled_at
    if scheduled_at.tzinfo is None:
        raise HTTPException(status_code=422, detail="Campaign time must include a timezone.")
    message = request.message.strip()
    normalized_message = message.casefold()
    if request.category in {"promotion", "seasonal"} and not any(
        instruction in normalized_message for instruction in ("reply stop", "text stop", "send stop")
    ):
        message = f"{message} Reply STOP or MIRA to opt out."
    if len(message) > 1600:
        raise HTTPException(status_code=422, detail="The message is too long after adding opt-out instructions.")
    campaign = BotCampaign(
        name=request.name.strip(),
        category=request.category,
        message=message,
        interest_filter=request.interest_filter.strip() if request.interest_filter else None,
        scheduled_at=scheduled_at,
        status="scheduled",
    )
    session.add(campaign)
    session.commit()
    session.refresh(campaign)
    return campaign_read(campaign, session)


@app.get("/api/v1/bot/reports")
def get_bot_reports(session: Session = Depends(get_session)) -> dict:
    contacts = list(session.scalars(select(BotContact)))
    messages = list(session.scalars(select(BotConversation)))
    campaigns = list(session.scalars(select(BotCampaign)))
    return {
        "contacts": len(contacts),
        "opted_in": sum(contact.sms_consent for contact in contacts),
        "marketing_opted_in": sum(contact.marketing_consent for contact in contacts),
        "leads": sum((contact.state or {}).get("lead_status") in {"interested", "ready_to_buy"} for contact in contacts),
        "messages_sent": sum(message.direction == "out" and message.delivery_status in {"queued", "sent", "delivered"} for message in messages),
        "customer_replies": sum(message.direction == "in" for message in messages),
        "delivered": sum(message.direction == "out" and message.delivery_status == "delivered" for message in messages),
        "campaigns": [campaign_read(campaign, session) for campaign in campaigns],
        "sales_tracking": "Connect a sales or order system to attribute purchases and conversions.",
    }


@app.get("/api/v1/bot/products", response_model=list[BotProductRead])
def list_bot_products(session: Session = Depends(get_session)) -> list[BotProduct]:
    return list(session.scalars(select(BotProduct).order_by(BotProduct.created_at.desc()).limit(500)))


@app.post("/api/v1/bot/products", response_model=BotProductRead, status_code=status.HTTP_201_CREATED)
def create_bot_product(request: BotProductCreate, session: Session = Depends(get_session)) -> BotProduct:
    product = BotProduct(**request.model_dump())
    session.add(product)
    session.commit()
    session.refresh(product)
    return product


@app.put("/api/v1/bot/products/{product_id}", response_model=BotProductRead)
def update_bot_product(product_id: UUID, request: BotProductCreate, session: Session = Depends(get_session)) -> BotProduct:
    product = session.get(BotProduct, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    for key, value in request.model_dump().items():
        setattr(product, key, value)
    session.commit()
    session.refresh(product)
    return product


@app.delete("/api/v1/bot/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bot_product(product_id: UUID, session: Session = Depends(get_session)) -> None:
    product = session.get(BotProduct, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    session.delete(product)
    session.commit()


@app.get("/api/v1/bot/business-profile", response_model=BotBusinessProfileRead | None)
def get_bot_business_profile(session: Session = Depends(get_session)) -> BotBusinessProfile | None:
    return session.get(BotBusinessProfile, 1)


@app.put("/api/v1/bot/business-profile", response_model=BotBusinessProfileRead)
def save_bot_business_profile(request: BotBusinessProfileUpdate, session: Session = Depends(get_session)) -> BotBusinessProfile:
    profile = session.get(BotBusinessProfile, 1)
    if profile is None:
        profile = BotBusinessProfile(id=1, **request.model_dump())
        session.add(profile)
    else:
        for key, value in request.model_dump().items():
            setattr(profile, key, value)
    session.commit()
    session.refresh(profile)
    return profile


@app.put("/api/v1/bot", response_model=BotWorkflowRead)
def save_bot_workflow(
    request: BotWorkflowUpdate,
    session: Session = Depends(get_session),
) -> BotWorkflow:
    values = request.model_dump()
    workflow_nodes = values["workflow"]
    validate_workflow(workflow_nodes)
    record = session.get(BotWorkflow, 1)
    if values["active"] and values["sms_mode"] == "iphone_manual":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="iPhone manual mode does not support automatic bot activation. Save the flow as a draft and use suggested replies manually.",
        )
    if values["active"] and (
        not sms_gateway_is_configured()
        or not gateway_device_is_connected(record)
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Configure SMS Gateway credentials and connect an Android phone before activating.",
        )
    if record is None:
        record = BotWorkflow(id=1, **values)
        session.add(record)
    else:
        for key, value in values.items():
            setattr(record, key, value)
    session.commit()
    session.refresh(record)
    return record


@app.post("/api/v1/bot/generate", response_model=BotWorkflowUpdate)
def create_bot_workflow(request: BotGenerateRequest) -> dict:
    try:
        nodes = generate_workflow(request.business_name, request.description)
        from .schemas import BotNode

        validated_nodes = [BotNode.model_validate(node).model_dump() for node in nodes]
        validate_workflow(validated_nodes)
        return {
            "business_name": request.business_name,
            "description": request.description,
            "workflow": validated_nodes,
            "active": False,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Could not generate a workflow. Try a shorter business description.") from exc


@app.post("/api/v1/bot/test", response_model=BotSimulationResult)
def simulate_bot_message(
    request: BotSimulationRequest,
    session: Session = Depends(get_session),
) -> dict:
    record = session.get(BotWorkflow, 1)
    workflow = [node.model_dump() for node in request.workflow] if request.workflow else record.workflow if record else starter_workflow()
    return route_message(workflow, request.message, request.state)


@app.post("/api/v1/sms/webhook/{webhook_token}")
async def receive_sms_webhook(
    webhook_token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    expected_token = os.getenv("SMSGATE_WEBHOOK_TOKEN", "").strip()
    if not expected_token or not hmac.compare_digest(webhook_token, expected_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid SMS gateway webhook token.")
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > 16_384:
                raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="SMS webhook payload is too large.")
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid content length.") from exc
    try:
        body = await request.body()
        if len(body) > 16_384:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="SMS webhook payload is too large.")
        envelope = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid SMS gateway webhook payload.") from exc
    if not isinstance(envelope, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid SMS gateway webhook payload.")

    event = envelope.get("event")
    data = envelope.get("payload") or {}
    if not isinstance(event, str) or not isinstance(data, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid SMS gateway event payload.")

    record = session.get(BotWorkflow, 1)
    device_id = str(envelope.get("deviceId") or "")
    if event == "app:started":
        if record is None:
            record = BotWorkflow(
                id=1,
                business_name="ZimShop",
                description="",
                workflow=starter_workflow(),
                active=False,
                sms_mode="android",
            )
            session.add(record)
        if device_id:
            record.gateway_device_id = device_id
        record.gateway_last_seen = datetime.now(timezone.utc)
        sim_cards = data.get("simCards") or envelope.get("simCards") or []
        if sim_cards and isinstance(sim_cards[0], dict) and sim_cards[0].get("phoneNumber"):
            record.phone_number = str(sim_cards[0]["phoneNumber"])[:40]
        session.commit()
        background_tasks.add_task(dispatch_due_campaigns_background)
        return {"status": "connected"}

    if event == "system:ping":
        if record and device_id and record.gateway_device_id == device_id:
            record.gateway_last_seen = datetime.now(timezone.utc)
            session.commit()
            background_tasks.add_task(dispatch_due_campaigns_background)
        return {"status": "recorded"}

    status_by_event = {
        "sms:sent": "sent",
        "sms:delivered": "delivered",
        "sms:failed": "failed",
        "sms:cancelled": "cancelled",
    }
    if event in status_by_event:
        provider_id = data.get("messageId")
        if provider_id:
            outgoing = session.scalar(
                select(BotConversation).where(BotConversation.provider_message_id == str(provider_id))
            )
            if outgoing is not None:
                outgoing.delivery_status = status_by_event[event]
                outgoing.result = {**(outgoing.result or {}), "failure_reason": data.get("reason")}
                target = session.scalar(
                    select(BotCampaignTarget).where(
                        BotCampaignTarget.provider_message_id == str(provider_id)
                    )
                )
                if target is not None:
                    target.status = "delivered" if event == "sms:delivered" else "sent" if event == "sms:sent" else "failed"
                    target.error = str(data.get("reason") or "")[:500] or None
                session.commit()
        return {"status": "recorded"}

    if event != "sms:received":
        return {"status": "ignored"}
    if not record or record.sms_mode != "android":
        return {"status": "ignored"}
    if not device_id or not record.gateway_device_id or device_id != record.gateway_device_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="SMS was received by an unpaired device.")

    raw_sender = data.get("sender")
    raw_text = data.get("message")
    gateway_message_id = data.get("messageId") or envelope.get("id")
    if not isinstance(raw_sender, str) or not isinstance(raw_text, str):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SMS event is missing sender or message.")
    if not isinstance(gateway_message_id, (str, int)) or isinstance(gateway_message_id, bool):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SMS event is missing a valid message ID.")
    sender = raw_sender.strip()
    sender = re.sub(r"[ ()-]", "", sender)
    text = raw_text.strip()
    if not sender or not text or not gateway_message_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SMS event is missing sender, message, or ID.")
    if len(sender) > 40 or not re.fullmatch(r"\+?[0-9][0-9 ()-]{6,38}", sender):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SMS sender number is invalid.")
    if len(text) > 2_000 or len(str(gateway_message_id)) > 180:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="SMS message or ID is too long.")
    event_id = f"{device_id}:{gateway_message_id}"[:200]
    command = normalize_text(text).strip(".!?,")
    is_stop_command = command in SMS_STOP_COMMANDS
    is_start_command = command in SMS_START_COMMANDS
    if not record.active and not is_stop_command and not is_start_command:
        return {"status": "ignored"}
    record.gateway_last_seen = datetime.now(timezone.utc)
    recipient = data.get("recipient")
    if recipient and record and not record.phone_number:
        record.phone_number = str(recipient)[:40]
    contact = session.scalar(select(BotContact).where(BotContact.phone_number == sender))
    if contact is None:
        contact = BotContact(phone_number=sender[:40], profile_name="", state={})
        session.add(contact)
        session.flush()

    conversation = session.scalar(
        select(BotConversation).where(BotConversation.provider_message_id == event_id)
    )
    if conversation is None:
        if not is_stop_command and not is_start_command:
            capture_customer_interest(contact, text)
        if is_start_command and not record.active:
            state = dict(contact.state or {})
            state.pop("opted_out", None)
            result = {"replies": [], "state": state, "route": "start"}
        else:
            result = route_message(record.workflow, text, contact.state)
        if is_stop_command:
            contact.sms_consent = False
            contact.marketing_consent = False
            contact.consent_updated_at = datetime.now(timezone.utc)
        elif is_start_command:
            contact.sms_consent = True
            contact.marketing_consent = False
            contact.consent_updated_at = datetime.now(timezone.utc)
        result = enrich_customer_reply(result, text, contact, session)
        contact.state = result["state"]
        if not is_stop_command and not is_start_command:
            campaign_target = session.scalar(
                select(BotCampaignTarget)
                .where(
                    BotCampaignTarget.contact_id == contact.id,
                    BotCampaignTarget.replied_at.is_(None),
                    BotCampaignTarget.status.in_(["queued", "sent", "delivered"]),
                    BotCampaignTarget.created_at >= datetime.now(timezone.utc) - timedelta(days=7),
                )
                .order_by(BotCampaignTarget.created_at.desc())
            )
            if campaign_target is not None:
                campaign_target.replied_at = datetime.now(timezone.utc)
        conversation = BotConversation(
            contact_id=contact.id,
            direction="in",
            message=text,
            provider_message_id=event_id,
            result=result,
            delivery_status="received",
        )
        session.add(conversation)
        session.commit()
    else:
        result = conversation.result or {"replies": [], "state": contact.state, "route": "retry"}

    outgoing_messages = list(session.scalars(
        select(BotConversation)
        .where(BotConversation.in_reply_to == event_id)
        .order_by(BotConversation.created_at.asc())
    ))
    replies = result.get("replies", []) if os.getenv("SMS_SENDING_ENABLED", "false").strip().casefold() == "true" else []
    for index, reply in enumerate(replies):
        outgoing = outgoing_messages[index] if index < len(outgoing_messages) else None
        if outgoing and outgoing.delivery_status != "queue_failed":
            continue
        if outgoing is None:
            outgoing = BotConversation(
                contact_id=contact.id,
                direction="out",
                message=reply,
                provider_message_id=str(uuid4()),
                in_reply_to=event_id,
                delivery_status="pending",
            )
            session.add(outgoing)
            session.commit()
        try:
            provider_id = await run_in_threadpool(
                send_sms_message,
                sender,
                reply,
                outgoing.provider_message_id or str(outgoing.id),
                device_id or record.gateway_device_id,
            )
        except RuntimeError as exc:
            outgoing.delivery_status = "queue_failed"
            session.commit()
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
        outgoing.provider_message_id = provider_id
        if outgoing.delivery_status in {"pending", "queue_failed"}:
            outgoing.delivery_status = "queued"
        session.commit()

    return {"status": "received"}
