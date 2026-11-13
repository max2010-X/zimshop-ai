import unittest
from unittest.mock import patch

from backend.app.smsgate import _api_root, _endpoint


class SMSGateModeTests(unittest.TestCase):
    def test_cloud_defaults_to_public_api_root(self):
        with patch.dict("os.environ", {"SMSGATE_MODE": "cloud"}, clear=True):
            self.assertEqual(_api_root(), "https://api.sms-gate.app/3rdparty/v1")
            self.assertEqual(_endpoint("devices"), "https://api.sms-gate.app/3rdparty/v1/devices")

    def test_cloud_hostname_gets_api_path(self):
        with patch.dict("os.environ", {
            "SMSGATE_MODE": "cloud",
            "SMSGATE_API_URL": "https://api.sms-gate.app",
        }, clear=True):
            self.assertEqual(_api_root(), "https://api.sms-gate.app/3rdparty/v1")

    def test_private_server_inserts_api_prefix(self):
        with patch.dict("os.environ", {
            "SMSGATE_MODE": "private",
            "SMSGATE_API_URL": "https://sms.example.test",
        }, clear=True):
            self.assertEqual(_api_root(), "https://sms.example.test/api/3rdparty/v1")

    def test_local_server_uses_direct_paths_and_singular_message_route(self):
        with patch.dict("os.environ", {
            "SMSGATE_MODE": "local",
            "SMSGATE_API_URL": "http://192.168.1.40:8080",
        }, clear=True):
            self.assertEqual(_endpoint("messages"), "http://192.168.1.40:8080/message")
            self.assertEqual(_endpoint("inbox/refresh"), "http://192.168.1.40:8080/inbox/refresh")


if __name__ == "__main__":
    unittest.main()
