import hashlib
import hmac
import os
import re
import uuid
from calendar import monthrange
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from paynow import Paynow
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import get_session
from .models import Subscription, SubscriptionPayment, SubscriptionSetting
from .schemas import (
    SubscriptionCheckout,
    SubscriptionPaymentRead,
    SubscriptionPlanRead,
    SubscriptionSettingRead,
    SubscriptionSettingUpdate,
    SubscriptionTrialCreate,
    SubscriptionTrialRead,
)


router = APIRouter(prefix="/api/v1/subscriptions", tags=["subscriptions"])

PLANS = {
    "starter": {
        "id": "starter",
        "name": "Starter",
        "amount": Decimal("5.00"),
        "currency": "USD",
        "billing_period": "Monthly",
        "description": "For getting started with ZimShop AI.",
    },
    "business": {
        "id": "business",
        "name": "Business",
        "amount": Decimal("15.00"),
        "currency": "USD",
        "billing_period": "Monthly",
        "description": "For growing customer operations.",
    },
    "premium": {
        "id": "premium",
        "name": "Premium",
        "amount": Decimal("30.00"),
        "currency": "USD",
        "billing_period": "Monthly",
        "description": "For teams handling higher volumes.",
    },
}
MONETISATION_SETTING_KEY = "enabled"


def _environment_subscriptions_enabled() -> bool:
    value = os.getenv("SUBSCRIPTIONS_ENABLED", "false").strip().casefold()
    if value in {"true", "1", "yes", "on"}:
        return True
    if value in {"false", "0", "no", "off", ""}:
        return False
    raise RuntimeError("SUBSCRIPTIONS_ENABLED must be a boolean value.")


def _subscriptions_enabled(session: Session) -> bool:
    setting = session.get(SubscriptionSetting, MONETISATION_SETTING_KEY)
    return setting.enabled if setting is not None else _environment_subscriptions_enabled()


def _authorize_subscription_admin(authorization: str | None) -> None:
    admin_token = os.getenv("SUBSCRIPTIONS_ADMIN_TOKEN", "").strip()
    if len(admin_token) < 32:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Subscription admin controls are not configured on the API server.",
        )
    expected = f"Bearer {admin_token}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid subscription admin token.")


def _configured_paynow() -> Paynow:
    integration_id = os.getenv("PAYNOW_INTEGRATION_ID", "").strip()
    integration_key = os.getenv("PAYNOW_INTEGRATION_KEY", "").strip()
    return_url = os.getenv("PAYNOW_RETURN_URL", "").strip()
    result_url = os.getenv("PAYNOW_RESULT_URL", "").strip()
    if not all((integration_id, integration_key, return_url, result_url)):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Paynow is not configured on the API server.",
        )
    if not return_url.startswith("https://") or not result_url.startswith("https://"):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Paynow return and result URLs must use HTTPS.",
        )
    return Paynow(integration_id, integration_key, return_url, result_url)


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _add_month(value: datetime) -> datetime:
    month_index = value.month
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    return value.replace(year=year, month=month, day=min(value.day, monthrange(year, month)[1]))


def _payment_read(payment: SubscriptionPayment, subscription: Subscription) -> dict[str, Any]:
    return {
        "invoice_reference": payment.reference,
        "plan": payment.plan,
        "amount": payment.amount,
        "currency": payment.currency,
        "payment_status": payment.status,
        "subscription_status": subscription.status,
        "instructions": payment.instructions,
        "expires_at": subscription.expires_at,
        "renewal_reminder_at": subscription.renewal_reminder_at,
    }


def _trial_read(subscription: Subscription) -> dict[str, Any]:
    eligible = subscription.trial_started_at is None and subscription.period_starts_at is None
    return {
        "eligible": eligible,
        "subscription_status": subscription.status,
        "trial_started_at": subscription.trial_started_at,
        "trial_ends_at": subscription.trial_ends_at,
        "expires_at": subscription.expires_at,
    }


def start_subscription_trial(email: str, session: Session) -> dict[str, Any]:
    normalized_email = email.strip().casefold()
    subscription = session.scalar(select(Subscription).where(Subscription.email == normalized_email))
    now = datetime.now(timezone.utc)
    if subscription is None:
        trial_end = now + timedelta(days=7)
        subscription = Subscription(
            id=uuid.uuid4(),
            email=normalized_email,
            phone_number="",
            plan="trial",
            status="trialing",
            trial_started_at=now,
            trial_ends_at=trial_end,
            expires_at=trial_end,
            renewal_reminder_at=trial_end - timedelta(days=2),
        )
        session.add(subscription)
    elif subscription.trial_started_at is None:
        if subscription.status == "active" or subscription.period_starts_at is not None:
            return _trial_read(subscription)
        trial_end = now + timedelta(days=7)
        subscription.plan = "trial"
        subscription.status = "trialing"
        subscription.trial_started_at = now
        subscription.trial_ends_at = trial_end
        subscription.expires_at = trial_end
        subscription.renewal_reminder_at = trial_end - timedelta(days=2)
    elif subscription.status == "trialing" and subscription.trial_ends_at and _as_utc(subscription.trial_ends_at) <= now:
        subscription.status = "expired"

    session.commit()
    return _trial_read(subscription)


def _trial_subscription_for_checkout(email: str, session: Session) -> Subscription:
    subscription = session.scalar(
        select(Subscription)
        .where(Subscription.email == email)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if subscription is None or subscription.trial_started_at is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Start your seven-day free trial before subscribing.")
    return subscription


def _parse_paynow_notification(body: bytes, integration_key: str) -> dict[str, str]:
    try:
        pairs = parse_qsl(body.decode("utf-8"), keep_blank_values=True, strict_parsing=True)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Paynow notification.") from exc

    fields: dict[str, str] = {}
    for key, value in pairs:
        if not key or key in fields:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Paynow notification fields.")
        fields[key] = value

    provided_hash = fields.get("hash", "")
    if not provided_hash or not integration_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Paynow notification hash is missing.")
    hash_input = "".join(value for key, value in pairs if key != "hash") + integration_key
    expected_hash = hashlib.sha512(hash_input.encode("utf-8")).hexdigest().upper()
    if not hmac.compare_digest(provided_hash.upper(), expected_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Paynow notification hash is invalid.")
    return fields


def _amount_matches(reported_amount: Any, expected_amount: Decimal) -> bool:
    try:
        amount = Decimal(str(reported_amount))
    except Exception:
        return False
    return amount.is_finite() and amount == Decimal(str(expected_amount))


def _verify_payment(
    payment: SubscriptionPayment,
    session: Session,
    notification: dict[str, str] | None = None,
) -> None:
    if notification is not None:
        if notification.get("reference") != payment.reference:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Paynow reference does not match the invoice.")
        if not _amount_matches(notification.get("amount"), payment.amount):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Paynow notification amount does not match the invoice.")
        if not payment.poll_url or notification.get("pollurl") != payment.poll_url:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Paynow poll URL does not match the invoice.")

    if payment.status != "pending" or not payment.poll_url:
        return
    try:
        provider_status = _configured_paynow().check_transaction_status(payment.poll_url)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Paynow could not verify this payment. Try checking again shortly.",
        ) from exc

    if getattr(provider_status, "reference", None) != payment.reference:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Paynow returned an unexpected payment reference.")
    if not _amount_matches(getattr(provider_status, "amount", None), payment.amount):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Paynow returned an unexpected payment amount.")

    locked_payment = session.scalar(
        select(SubscriptionPayment)
        .where(SubscriptionPayment.id == payment.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked_payment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment record not found.")
    if locked_payment.status != "pending":
        return

    subscription = session.get(
        Subscription,
        locked_payment.subscription_id,
        with_for_update=True,
        populate_existing=True,
    )
    if subscription is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription record not found.")
    if bool(getattr(provider_status, "paid", False)):
        now = datetime.now(timezone.utc)
        previous_end = _as_utc(subscription.expires_at) if subscription.expires_at else now
        period_start = max(now, previous_end)
        subscription.plan = locked_payment.plan
        subscription.status = "active"
        subscription.period_starts_at = period_start
        subscription.expires_at = _add_month(period_start)
        subscription.renewal_reminder_at = subscription.expires_at - timedelta(days=5)
        locked_payment.status = "paid"
        locked_payment.paid_at = now
    elif str(getattr(provider_status, "status", "")).casefold() in {
        "cancelled", "canceled", "failed", "declined", "expired", "error",
    }:
        locked_payment.status = "failed"
    session.commit()


@router.get("/plans", response_model=list[SubscriptionPlanRead])
def list_subscription_plans() -> list[dict[str, Any]]:
    return list(PLANS.values())


@router.get("/settings", response_model=SubscriptionSettingRead)
def get_subscription_settings(session: Session = Depends(get_session)) -> dict[str, bool]:
    return {"enabled": _subscriptions_enabled(session)}


@router.put("/admin/settings", response_model=SubscriptionSettingRead)
def update_subscription_settings(
    request: SubscriptionSettingUpdate,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, bool]:
    _authorize_subscription_admin(authorization)
    setting = session.get(SubscriptionSetting, MONETISATION_SETTING_KEY)
    if setting is None:
        setting = SubscriptionSetting(key=MONETISATION_SETTING_KEY, enabled=request.enabled)
        session.add(setting)
    else:
        setting.enabled = request.enabled
    session.commit()
    return {"enabled": setting.enabled}


@router.post("/trial", response_model=SubscriptionTrialRead)
def create_subscription_trial(
    request: SubscriptionTrialCreate,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    return start_subscription_trial(request.email, session)


@router.post("/checkout", response_model=SubscriptionPaymentRead, status_code=status.HTTP_201_CREATED)
def create_subscription_checkout(
    request: SubscriptionCheckout,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _subscriptions_enabled(session):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Paid subscriptions are currently paused.",
        )
    plan = PLANS[request.plan]
    email = request.email.strip().casefold()
    subscription = _trial_subscription_for_checkout(email, session)
    now = datetime.now(timezone.utc)
    if subscription.status == "trialing" and subscription.trial_ends_at and _as_utc(subscription.trial_ends_at) <= now:
        subscription.status = "expired"
    subscription.phone_number = request.phone_number

    pending = session.scalar(
        select(SubscriptionPayment).where(
            SubscriptionPayment.subscription_id == subscription.id,
            SubscriptionPayment.status == "pending",
        )
    )
    if pending is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A payment for this email is already pending.")

    reference = f"ZSAI-{uuid.uuid4().hex.upper()}"
    payment_record = SubscriptionPayment(
        id=uuid.uuid4(),
        subscription_id=subscription.id,
        reference=reference,
        plan=request.plan,
        amount=plan["amount"],
        currency=plan["currency"],
        status="pending",
    )
    session.add(payment_record)
    session.commit()

    try:
        paynow = _configured_paynow()
        payment = paynow.create_payment(reference, email)
        payment.add(f"ZimShop AI {plan['name']} monthly subscription", float(plan["amount"]))
        response = paynow.send_mobile(payment, request.phone_number, "ecocash")
    except HTTPException:
        payment_record.status = "failed"
        session.commit()
        raise
    except Exception as exc:
        payment_record.status = "failed"
        session.commit()
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not start the Paynow EcoCash request.") from exc

    if not response.success or not response.poll_url:
        payment_record.status = "failed"
        session.commit()
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Paynow did not accept the payment request.")
    payment_record.poll_url = response.poll_url
    payment_record.instructions = str(getattr(response, "instructions", "") or "Approve the EcoCash payment prompt on your phone.")[:1000]
    session.commit()
    return _payment_read(payment_record, subscription)


@router.get("/{reference}", response_model=SubscriptionPaymentRead)
def get_subscription_payment_status(reference: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    if not re.fullmatch(r"ZSAI-[A-F0-9]{32}", reference):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment reference not found.")
    payment = session.scalar(select(SubscriptionPayment).where(SubscriptionPayment.reference == reference))
    if payment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment reference not found.")
    _verify_payment(payment, session)
    subscription = session.get(Subscription, payment.subscription_id)
    if subscription is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription record not found.")
    if subscription.status in {"active", "trialing"} and subscription.expires_at and _as_utc(subscription.expires_at) <= datetime.now(timezone.utc):
        subscription.status = "expired"
        session.commit()
    return _payment_read(payment, subscription)


@router.post("/paynow-result", status_code=status.HTTP_200_OK)
async def receive_paynow_result(request: Request, session: Session = Depends(get_session)) -> dict[str, str]:
    body = await request.body()
    if len(body) > 16_384:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Paynow result is too large.")
    integration_key = os.getenv("PAYNOW_INTEGRATION_KEY", "").strip()
    values = _parse_paynow_notification(body, integration_key)
    reference = values.get("reference", "")
    if not re.fullmatch(r"ZSAI-[A-F0-9]{32}", reference):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment reference not found.")
    payment = session.scalar(select(SubscriptionPayment).where(SubscriptionPayment.reference == reference))
    if payment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment reference not found.")
    _verify_payment(payment, session, values)
    return {"status": "received"}