import re
from datetime import datetime
from typing import Literal
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AnalyzeRequest(BaseModel):
    customer: str = Field(default="", max_length=200)
    message: str = Field(min_length=1, max_length=10000)


class AnalysisResult(BaseModel):
    intent: str
    priority: Literal["High", "Medium", "Low"]
    next_step: str
    reply: str
    mode: str


class FollowupCreate(AnalysisResult):
    customer: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=10000)


class FollowupRead(FollowupCreate):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class SubscriptionCheckout(BaseModel):
    plan: Literal["starter", "business", "premium"]
    email: str = Field(min_length=5, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    phone_number: str = Field(min_length=10, max_length=20)

    @field_validator("phone_number")
    @classmethod
    def validate_ecocash_number(cls, value: str) -> str:
        phone = re.sub(r"[\s()-]", "", value)
        if phone.startswith("+263"):
            phone = "0" + phone[4:]
        elif phone.startswith("263"):
            phone = "0" + phone[3:]
        if not re.fullmatch(r"07[0-9]{8}", phone):
            raise ValueError("Enter a valid Zimbabwe EcoCash number, such as 0771234567.")
        return phone


class SubscriptionTrialCreate(BaseModel):
    email: str = Field(min_length=5, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class SubscriptionTrialRead(BaseModel):
    eligible: bool
    subscription_status: str
    trial_started_at: datetime | None
    trial_ends_at: datetime | None
    expires_at: datetime | None


class SubscriptionPlanRead(BaseModel):
    id: str
    name: str
    amount: Decimal
    currency: str
    billing_period: str
    description: str


class SubscriptionPaymentRead(BaseModel):
    invoice_reference: str
    plan: str
    amount: Decimal
    currency: str
    payment_status: str
    subscription_status: str
    instructions: str
    expires_at: datetime | None
    renewal_reminder_at: datetime | None


class SubscriptionSettingUpdate(BaseModel):
    enabled: bool


class SubscriptionSettingRead(BaseModel):
    enabled: bool


class BotChoice(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    keywords: list[str] = Field(min_length=1, max_length=12)
    next: str = Field(min_length=1, max_length=80)


class BotNode(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal["trigger", "message", "decision", "action"]
    title: str = Field(min_length=1, max_length=100)
    body: str = Field(default="", max_length=2000)
    next: str | None = Field(default=None, max_length=80)
    choices: list[BotChoice] = Field(default_factory=list, max_length=8)


class BotWorkflowUpdate(BaseModel):
    business_name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    sms_mode: Literal["android", "iphone_manual"] = "android"
    workflow: list[BotNode] = Field(min_length=2, max_length=30)
    active: bool = False


class BotWorkflowRead(BotWorkflowUpdate):
    model_config = ConfigDict(from_attributes=True)

    phone_number: str | None
    gateway_device_id: str | None
    gateway_last_seen: datetime | None
    updated_at: datetime


class BotGenerateRequest(BaseModel):
    business_name: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=10, max_length=4000)


class BotSimulationRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    state: dict = Field(default_factory=dict)
    workflow: list[BotNode] | None = Field(default=None, min_length=2, max_length=30)


class BotSimulationResult(BaseModel):
    replies: list[str]
    state: dict
    route: str


class BotDashboardRead(BaseModel):
    workflow: BotWorkflowRead | None
    contacts: int
    messages: int
    sms_gateway_configured: bool
    sms_connected: bool
    phone_number: str | None
    sms_mode: Literal["android", "iphone_manual"]


class BotContactUpsert(BaseModel):
    phone_number: str = Field(min_length=7, max_length=40, pattern=r"^\+?[0-9][0-9 ()-]{6,38}$")
    profile_name: str = Field(default="", max_length=200)
    sms_consent: bool = False
    marketing_consent: bool = False
    interests: list[str] = Field(default_factory=list, max_length=20)


class BotContactRead(BaseModel):
    id: UUID
    phone_number: str
    profile_name: str
    sms_consent: bool
    marketing_consent: bool
    consent_updated_at: datetime | None
    interests: list[str]
    lead_status: str
    inquiry_count: int
    created_at: datetime


class BotCampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: Literal["promotion", "seasonal", "reminder", "follow_up"]
    message: str = Field(min_length=1, max_length=1600)
    interest_filter: str | None = Field(default=None, max_length=100)
    scheduled_at: datetime


class BotCampaignRead(BaseModel):
    id: UUID
    name: str
    category: Literal["promotion", "seasonal", "reminder", "follow_up"]
    message: str
    interest_filter: str | None
    scheduled_at: datetime
    status: str
    queued_count: int
    sent_count: int
    delivered_count: int
    failed_count: int
    reply_count: int
    created_at: datetime
    completed_at: datetime | None


class BotProductCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    price: str = Field(default="", max_length=80)
    availability: str = Field(default="Available", max_length=80)
    purchase_url: str | None = Field(default=None, max_length=500, pattern=r"^https?://")
    interests: list[str] = Field(default_factory=list, max_length=20)
    active: bool = True


class BotProductRead(BotProductCreate):
    id: UUID
    created_at: datetime


class BotBusinessProfileUpdate(BaseModel):
    business_hours: str = Field(default="", max_length=1000)
    location: str = Field(default="", max_length=1000)
    delivery_policy: str = Field(default="", max_length=2000)
    returns_policy: str = Field(default="", max_length=2000)
    payment_instructions: str = Field(default="", max_length=2000)
    support_contact: str = Field(default="", max_length=200)


class BotBusinessProfileRead(BotBusinessProfileUpdate):
    updated_at: datetime


class MarketplaceSellerRegister(BaseModel):
    email: str = Field(min_length=5, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=10, max_length=128)
    business_name: str = Field(min_length=2, max_length=200)
    phone_number: str = Field(min_length=7, max_length=40, pattern=r"^\+?[0-9][0-9 ()-]{6,38}$")
    location: str = Field(min_length=2, max_length=120)
    physical_address: str = Field(min_length=5, max_length=500)
    legal_status: Literal["individual", "sole_proprietor", "partnership", "company", "other"]
    registration_details: str = Field(default="", max_length=200)
    terms_accepted: Literal[True]
    delivery_available: bool = False
    delivery_areas: str = Field(default="", max_length=1000)


class MarketplaceSellerLogin(BaseModel):
    email: str = Field(min_length=5, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=1, max_length=128)


class MarketplaceBusinessUpdate(BaseModel):
    business_name: str = Field(min_length=2, max_length=200)
    phone_number: str = Field(min_length=7, max_length=40, pattern=r"^\+?[0-9][0-9 ()-]{6,38}$")
    location: str = Field(min_length=2, max_length=120)
    physical_address: str = Field(min_length=5, max_length=500)
    legal_status: Literal["individual", "sole_proprietor", "partnership", "company", "other"]
    registration_details: str = Field(default="", max_length=200)
    delivery_available: bool = False
    delivery_areas: str = Field(default="", max_length=1000)


class MarketplaceBusinessRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    business_name: str
    phone_number: str
    location: str
    physical_address: str
    legal_status: str
    registration_details: str
    delivery_available: bool
    delivery_areas: str
    active: bool
    updated_at: datetime


class MarketplaceProductCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)
    price: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    currency: Literal["USD", "ZWG"] = "USD"
    condition: Literal["new", "used", "refurbished", "reconditioned", "grey_market"] = "new"
    image_url: str | None = Field(default=None, max_length=1000, pattern=r"^(https://|/uploads/[a-f0-9]+\.(jpg|png|webp)$)")
    in_stock: bool = True
    active: bool = True


class MarketplaceProductRead(MarketplaceProductCreate):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    business_id: UUID
    details_confirmed_at: datetime
    created_at: datetime
    updated_at: datetime


class MarketplaceSearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=120)
    max_budget: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    currency: Literal["USD", "ZWG"] = "USD"
    location: str = Field(default="", max_length=120)
    condition: Literal["any", "new", "used", "refurbished", "reconditioned", "grey_market"] = "any"
    sort_by: Literal["best_match", "price"] = "best_match"


class MarketplaceSearchResult(BaseModel):
    id: UUID
    source: Literal["marketplace", "bot_catalog"]
    product_name: str
    description: str
    price: str
    currency: str | None = None
    condition: str | None = None
    image_url: str | None = None
    in_stock: bool | None = None
    availability: str | None = None
    details_confirmed_at: datetime
    business_name: str | None = None
    phone_number: str | None = None
    location: str | None = None
    delivery_available: bool | None = None
    delivery_areas: str | None = None
    purchase_url: str | None = None
    match_score: int
    match_reasons: list[str]


class MarketplaceSearchResponse(BaseModel):
    results: list[MarketplaceSearchResult]
    searched_at: datetime
    understanding_mode: str


class GatewaySendRequest(BaseModel):
    phone_number: str = Field(min_length=7, max_length=40, pattern=r"^\+?[0-9][0-9 ()-]{6,38}$")
    message: str = Field(min_length=1, max_length=1600)
    device_id: str | None = Field(default=None, max_length=100)
    sim_number: int | None = Field(default=None, ge=1, le=3)


class GatewayWebhookCreate(BaseModel):
    url: str = Field(min_length=8, max_length=1000, pattern=r"^https://")
    event: Literal[
        "sms:received", "sms:sent", "sms:delivered", "sms:failed",
        "sms:cancelled", "app:started", "system:ping",
    ]
    device_id: str | None = Field(default=None, max_length=100)