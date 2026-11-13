import unittest
from unittest.mock import MagicMock, patch
import json
from urllib.parse import parse_qs, urlsplit

from backend.app.analysis import analyze_enquiry, greet_customer, local_analysis
from backend.app.bot import route_message, send_sms_message, starter_workflow, whatsapp_purchase_link


class LocalAnalysisTests(unittest.TestCase):
    def test_complaint_takes_precedence_over_pricing(self):
        result = local_analysis("The item is broken. Can I get a refund or replacement price?")

        self.assertEqual(result["intent"], "Complaint / support")
        self.assertEqual(result["priority"], "High")

    def test_unmatched_message_gets_general_enquiry(self):
        result = local_analysis("Could you send the product details?")

        self.assertEqual(result["intent"], "General enquiry")
        self.assertIn("reply", result)

    def test_greeting_is_not_duplicated(self):
        self.assertEqual(greet_customer("Hello Alex, thanks!", "Alex"), "Hello Alex, thanks!")

    def test_ai_request_does_not_send_customer_name(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"message": {"content": json.dumps({
                "intent": "General enquiry",
                "priority": "Low",
                "next_step": "Reply",
                "reply": "Thanks for your message.",
            })}}]
        }).encode()
        with patch.dict("os.environ", {"OPENAI_API_KEY": "test-key"}, clear=True):
            with patch("backend.app.analysis.request.urlopen", return_value=response) as urlopen:
                analyze_enquiry("Where is my order?", "Sensitive Customer")

        request = urlopen.call_args.args[0]
        self.assertNotIn("Sensitive Customer", request.data.decode())
        self.assertIn("Where is my order?", request.data.decode())

    def test_groq_key_uses_groq_chat_completions(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"message": {"content": json.dumps({
                "intent": "General enquiry",
                "priority": "Low",
                "next_step": "Reply",
                "reply": "Thanks for your message.",
            })}}]
        }).encode()
        with patch.dict("os.environ", {"GROQ_API_KEY": "groq-test"}, clear=True):
            with patch("backend.app.analysis.request.urlopen", return_value=response) as urlopen:
                result = analyze_enquiry("Where is my order?", "Customer")

        sent_request = urlopen.call_args.args[0]
        self.assertEqual(result["mode"], "Groq")
        self.assertEqual(sent_request.full_url, "https://api.groq.com/openai/v1/chat/completions")
        self.assertEqual(sent_request.get_header("Authorization"), "Bearer groq-test")

    def test_cloudflare_key_and_account_id_use_workers_ai(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "result": {"response": json.dumps({
                "intent": "General enquiry",
                "priority": "Low",
                "next_step": "Reply",
                "reply": "Thanks for your message.",
            })}
        }).encode()
        with patch.dict("os.environ", {
            "CLOUDFLARE_API_TOKEN": "cf-test",
            "CLOUDFLARE_ACCOUNT_ID": "account-test",
        }, clear=True):
            with patch("backend.app.analysis.request.urlopen", return_value=response) as urlopen:
                result = analyze_enquiry("Where is my order?", "Customer")

        sent_request = urlopen.call_args.args[0]
        self.assertEqual(result["mode"], "Cloudflare AI")
        self.assertIn("/accounts/account-test/ai/run/", sent_request.full_url)
        self.assertEqual(sent_request.get_header("Authorization"), "Bearer cf-test")


class BotWorkflowTests(unittest.TestCase):
    def test_whatsapp_chat_link_prefills_product_details_and_catalog_request(self):
        product = type("Product", (), {
            "name": "Blue shirt",
            "description": "Cotton, short sleeve",
            "price": "$15",
            "availability": "In stock",
        })()

        link = whatsapp_purchase_link("https://wa.me/263771234567", product)
        message = parse_qs(urlsplit(link).query)["text"][0]

        self.assertTrue(link.startswith("https://wa.me/263771234567?text="))
        self.assertIn("Blue shirt", message)
        self.assertIn("full WhatsApp catalog", message)

    def test_whatsapp_catalog_and_regular_purchase_links_are_preserved(self):
        product = type("Product", (), {"name": "Hat"})()

        catalog_link = "https://wa.me/c/263771234567"
        website_link = "https://shop.example/products/hat"

        self.assertEqual(whatsapp_purchase_link(catalog_link, product), catalog_link)
        self.assertEqual(whatsapp_purchase_link(website_link, product), website_link)

    def test_first_message_sends_welcome_and_waits_for_choice(self):
        result = route_message(starter_workflow(), "Hi")

        self.assertIn("What would you like to do?", result["replies"][0])
        self.assertEqual(result["state"], {"waiting_for": "choice"})

    def test_customer_choice_routes_to_catalog(self):
        result = route_message(starter_workflow(), "Show me your products", {"waiting_for": "choice"})

        self.assertEqual(result["route"], "Products")
        self.assertIn("catalog", result["replies"][0].lower())
        self.assertEqual(result["state"], {})

    def test_order_path_asks_for_purchase_details_without_inventing_prices(self):
        result = route_message(starter_workflow(), "I want to order", {"waiting_for": "choice"})

        self.assertEqual(result["route"], "Order")
        self.assertIn("quantities", result["replies"][0])
        self.assertIn("confirm availability", result["replies"][0])

    def test_support_path_escalates_to_a_person(self):
        workflow = starter_workflow()
        support = route_message(workflow, "Support", {"waiting_for": "choice"})
        result = route_message(workflow, "delivery", support["state"])

        self.assertEqual(result["route"], "Delivery")
        self.assertEqual(result["replies"], ["I'll check the confirmed shop details for you."])
        handoff = route_message(workflow, "human help", {"waiting_for": "support_type"})
        self.assertTrue(handoff["state"]["needs_human"])

    def test_unmatched_choice_keeps_decision_state(self):
        result = route_message(starter_workflow(), "Maybe later", {"waiting_for": "choice"})

        self.assertEqual(result["route"], "unmatched")
        self.assertEqual(result["state"], {"waiting_for": "choice"})

    def test_human_handoff_stops_automated_replies(self):
        workflow = starter_workflow()
        handoff = route_message(workflow, "Human help", {"waiting_for": "choice"})
        followup = route_message(workflow, "Any update?", handoff["state"])

        self.assertTrue(handoff["state"]["needs_human"])
        self.assertEqual(followup["route"], "human_handoff")
        self.assertEqual(followup["replies"], [])

    def test_opt_out_suppresses_later_automation_until_start(self):
        workflow = starter_workflow()
        opt_out = route_message(workflow, "STOP", {"waiting_for": "choice"})
        suppressed = route_message(workflow, "Hi again", opt_out["state"])
        resumed = route_message(workflow, "START", opt_out["state"])

        self.assertEqual(opt_out["route"], "opt_out")
        self.assertEqual(suppressed["replies"], [])
        self.assertNotEqual(resumed["route"], "opted_out")


class SmsSafetyTests(unittest.TestCase):
    def test_gateway_sending_is_disabled_by_default(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "SMS sending is disabled"):
                send_sms_message("+263771234567", "Test", "message-1")


if __name__ == "__main__":
    unittest.main()