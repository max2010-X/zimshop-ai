import unittest
import hashlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.parse import urlencode

from sqlalchemy import create_engine, inspect

from backend.app.migrations import migrate_subscription_schema
from backend.app.models import SubscriptionSetting
from backend.app.schemas import SubscriptionCheckout, SubscriptionSettingUpdate
from backend.app.subscriptions import (
    PLANS,
    _add_month,
    _authorize_subscription_admin,
    _environment_subscriptions_enabled,
    _parse_paynow_notification,
    _subscriptions_enabled,
    _trial_subscription_for_checkout,
    _verify_payment,
    create_subscription_checkout,
    start_subscription_trial,
)
from fastapi import HTTPException


class SubscriptionCheckoutTests(unittest.TestCase):
    def test_existing_subscription_table_gets_trial_columns(self):
        engine = create_engine("sqlite://")
        with engine.begin() as connection:
            connection.exec_driver_sql("CREATE TABLE subscriptions (id TEXT PRIMARY KEY)")

        migrate_subscription_schema(engine)

        columns = {column["name"] for column in inspect(engine).get_columns("subscriptions")}
        self.assertIn("trial_started_at", columns)
        self.assertIn("trial_ends_at", columns)

    def test_plan_prices_are_monthly_usd(self):
        self.assertEqual(
            {plan_id: plan["amount"] for plan_id, plan in PLANS.items()},
            {
                "starter": Decimal("5.00"),
                "business": Decimal("15.00"),
                "premium": Decimal("30.00"),
            },
        )
        self.assertTrue(all(plan["currency"] == "USD" for plan in PLANS.values()))

    def test_subscriptions_default_to_disabled(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertFalse(_environment_subscriptions_enabled())

    def test_saved_subscription_setting_overrides_environment_default(self):
        session = MagicMock()
        session.get.return_value = SimpleNamespace(enabled=True)

        with patch.dict("os.environ", {"SUBSCRIPTIONS_ENABLED": "false"}):
            self.assertTrue(_subscriptions_enabled(session))

    def test_admin_setting_requires_a_long_configured_token(self):
        with patch.dict("os.environ", {"SUBSCRIPTIONS_ADMIN_TOKEN": "short"}):
            with self.assertRaisesRegex(HTTPException, "not configured"):
                _authorize_subscription_admin("Bearer short")

    def test_admin_setting_rejects_an_invalid_token(self):
        token = "a" * 32
        with patch.dict("os.environ", {"SUBSCRIPTIONS_ADMIN_TOKEN": token}):
            with self.assertRaisesRegex(HTTPException, "Invalid subscription admin token"):
                _authorize_subscription_admin("Bearer " + "b" * 32)

    def test_admin_setting_accepts_a_valid_token(self):
        token = "a" * 32
        with patch.dict("os.environ", {"SUBSCRIPTIONS_ADMIN_TOKEN": token}):
            _authorize_subscription_admin("Bearer " + token)

    def test_checkout_is_rejected_when_subscriptions_are_paused(self):
        request = SubscriptionCheckout(
            plan="starter",
            email="owner@example.com",
            phone_number="0771234567",
        )
        session = MagicMock()

        with patch("backend.app.subscriptions._subscriptions_enabled", return_value=False):
            with self.assertRaisesRegex(HTTPException, "Paid subscriptions are currently paused"):
                create_subscription_checkout(request, session)

        session.get.assert_not_called()
        session.add.assert_not_called()
        session.commit.assert_not_called()

    def test_admin_setting_can_be_persisted(self):
        from backend.app.subscriptions import update_subscription_settings

        token = "a" * 32
        session = MagicMock()
        session.get.return_value = None

        with patch.dict("os.environ", {"SUBSCRIPTIONS_ADMIN_TOKEN": token}):
            result = update_subscription_settings(
                SubscriptionSettingUpdate(enabled=True),
                authorization="Bearer " + token,
                session=session,
            )

        self.assertEqual(result, {"enabled": True})
        session.add.assert_called_once()
        self.assertIsInstance(session.add.call_args.args[0], SubscriptionSetting)
        session.commit.assert_called_once()

    def test_checkout_normalizes_ecocash_phone_number(self):
        checkout = SubscriptionCheckout(
            plan="business",
            email="owner@example.com",
            phone_number="+263 77 123 4567",
        )

        self.assertEqual(checkout.phone_number, "0771234567")

    def test_checkout_rejects_non_zimbabwe_mobile_number(self):
        with self.assertRaisesRegex(ValueError, "valid Zimbabwe EcoCash number"):
            SubscriptionCheckout(
                plan="starter",
                email="owner@example.com",
                phone_number="+14155550123",
            )

    def test_trial_starts_for_seven_days(self):
        session = MagicMock()
        session.scalar.return_value = None

        result = start_subscription_trial("owner@example.com", session)

        self.assertFalse(result["eligible"])
        self.assertEqual(result["subscription_status"], "trialing")
        self.assertIsNotNone(result["trial_started_at"])
        self.assertEqual(result["trial_ends_at"] - result["trial_started_at"], timedelta(days=7))
        session.add.assert_called_once()
        session.commit.assert_called_once()

    def test_starting_trial_again_does_not_extend_it(self):
        trial_end = datetime.now(timezone.utc) + timedelta(days=3)
        subscription = SimpleNamespace(
            trial_started_at=trial_end - timedelta(days=4),
            trial_ends_at=trial_end,
            expires_at=trial_end,
            status="trialing",
        )
        session = MagicMock()
        session.scalar.return_value = subscription

        result = start_subscription_trial("owner@example.com", session)

        self.assertFalse(result["eligible"])
        self.assertEqual(result["trial_ends_at"], trial_end)
        session.add.assert_not_called()

    def test_checkout_requires_trial_to_have_started(self):
        session = MagicMock()
        session.scalar.return_value = None

        with self.assertRaisesRegex(HTTPException, "Start your seven-day free trial"):
            _trial_subscription_for_checkout("owner@example.com", session)

    def test_pending_payment_does_not_activate_subscription(self):
        subscription = SimpleNamespace(
            status="inactive",
            plan="starter",
            period_starts_at=None,
            expires_at=None,
            renewal_reminder_at=None,
        )
        payment = SimpleNamespace(
            id="payment-id",
            status="pending",
            poll_url="https://paynow.example/poll",
            reference="ZSAI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            subscription_id="subscription-id",
            amount=Decimal("15.00"),
            paid_at=None,
        )
        session = MagicMock()
        session.scalar.return_value = payment
        session.get.return_value = subscription
        provider_status = SimpleNamespace(paid=False, status="Awaiting Delivery", amount=15.0, reference=payment.reference)
        paynow = MagicMock()
        paynow.check_transaction_status.return_value = provider_status

        with patch("backend.app.subscriptions._configured_paynow", return_value=paynow):
            _verify_payment(payment, session)

        self.assertEqual(subscription.status, "inactive")
        self.assertEqual(payment.status, "pending")
        session.commit.assert_called_once()

    def test_verified_payment_activates_one_month(self):
        subscription = SimpleNamespace(
            status="inactive",
            plan="starter",
            period_starts_at=None,
            expires_at=None,
            renewal_reminder_at=None,
        )
        payment = SimpleNamespace(
            id="payment-id",
            status="pending",
            poll_url="https://paynow.example/poll",
            reference="ZSAI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            subscription_id="subscription-id",
            plan="business",
            amount=Decimal("15.00"),
            paid_at=None,
        )
        session = MagicMock()
        session.scalar.return_value = payment
        session.get.return_value = subscription
        provider_status = SimpleNamespace(paid=True, status="Paid", amount=15.0, reference=payment.reference)
        paynow = MagicMock()
        paynow.check_transaction_status.return_value = provider_status

        with patch("backend.app.subscriptions._configured_paynow", return_value=paynow):
            _verify_payment(payment, session)

        self.assertEqual(subscription.status, "active")
        self.assertEqual(subscription.plan, "business")
        self.assertEqual(payment.status, "paid")
        self.assertIsNotNone(subscription.expires_at)
        self.assertEqual(subscription.expires_at, _add_month(subscription.period_starts_at))
        self.assertEqual(subscription.renewal_reminder_at, subscription.expires_at - timedelta(days=5))
        session.commit.assert_called_once()

    def test_unexpected_amount_does_not_activate_subscription(self):
        subscription = SimpleNamespace(
            status="inactive",
            plan="starter",
            period_starts_at=None,
            expires_at=None,
            renewal_reminder_at=None,
        )
        payment = SimpleNamespace(
            id="payment-id",
            status="pending",
            poll_url="https://paynow.example/poll",
            reference="ZSAI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            subscription_id="subscription-id",
            amount=Decimal("15.00"),
            paid_at=None,
        )
        session = MagicMock()
        session.get.return_value = subscription
        paynow = MagicMock()
        paynow.check_transaction_status.return_value = SimpleNamespace(
            paid=True, status="Paid", amount=10.0, reference=payment.reference,
        )

        with patch("backend.app.subscriptions._configured_paynow", return_value=paynow):
            with self.assertRaisesRegex(Exception, "unexpected payment amount"):
                _verify_payment(payment, session)

        self.assertEqual(subscription.status, "inactive")
        session.commit.assert_not_called()

    def test_paynow_notification_hash_is_validated(self):
        integration_key = "integration-key"
        pairs = [
            ("reference", "ZSAI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            ("amount", "15.00"),
            ("status", "Paid"),
            ("pollurl", "https://paynow.example/poll?invoice=15%20USD"),
        ]
        signature = hashlib.sha512(("".join(value for _, value in pairs) + integration_key).encode()).hexdigest().upper()
        body = f"{urlencode(pairs)}&hash={signature}".encode()

        fields = _parse_paynow_notification(body, integration_key)

        self.assertEqual(fields["reference"], pairs[0][1])
        self.assertEqual(fields["pollurl"], pairs[3][1])

    def test_invalid_paynow_notification_hash_is_rejected(self):
        body = b"reference=ZSAI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&amount=15.00&hash=invalid"

        with self.assertRaisesRegex(HTTPException, "hash is invalid"):
            _parse_paynow_notification(body, "integration-key")

    def test_missing_polled_amount_does_not_activate_subscription(self):
        payment = SimpleNamespace(
            id="payment-id",
            status="pending",
            poll_url="https://paynow.example/poll",
            reference="ZSAI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            subscription_id="subscription-id",
            amount=Decimal("15.00"),
        )
        session = MagicMock()
        paynow = MagicMock()
        paynow.check_transaction_status.return_value = SimpleNamespace(
            paid=True, status="Paid", reference=payment.reference,
        )

        with patch("backend.app.subscriptions._configured_paynow", return_value=paynow):
            with self.assertRaisesRegex(HTTPException, "unexpected payment amount"):
                _verify_payment(payment, session)

        session.get.assert_not_called()
        session.commit.assert_not_called()

    def test_already_paid_locked_payment_is_not_applied_twice(self):
        payment = SimpleNamespace(
            id="payment-id",
            status="pending",
            poll_url="https://paynow.example/poll",
            reference="ZSAI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            subscription_id="subscription-id",
            amount=Decimal("15.00"),
        )
        locked_payment = SimpleNamespace(status="paid")
        session = MagicMock()
        session.scalar.return_value = locked_payment
        paynow = MagicMock()
        paynow.check_transaction_status.return_value = SimpleNamespace(
            paid=True, status="Paid", amount=15.0, reference=payment.reference,
        )

        with patch("backend.app.subscriptions._configured_paynow", return_value=paynow):
            _verify_payment(payment, session)

        session.get.assert_not_called()
        session.commit.assert_not_called()

    def test_paynow_notification_must_match_invoice_amount_and_poll_url(self):
        payment = SimpleNamespace(
            status="pending",
            poll_url="https://paynow.example/poll",
            reference="ZSAI-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            amount=Decimal("15.00"),
        )

        with self.assertRaisesRegex(HTTPException, "amount does not match"):
            _verify_payment(payment, MagicMock(), {
                "reference": payment.reference,
                "amount": "10.00",
                "pollurl": payment.poll_url,
            })

        with self.assertRaisesRegex(HTTPException, "poll URL does not match"):
            _verify_payment(payment, MagicMock(), {
                "reference": payment.reference,
                "amount": "15.00",
                "pollurl": "https://paynow.example/other",
            })


if __name__ == "__main__":
    unittest.main()
