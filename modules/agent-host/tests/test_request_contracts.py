import unittest

from agent_host.bridge import request_contracts


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None, details: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}


class RequestContractsTests(unittest.TestCase):
    def error_factory(self, message: str, status: int, code: str | None) -> FakeBridgeError:
        return FakeBridgeError(message, status, code)

    def test_parse_body_accepts_json_and_form(self):
        json_body = request_contracts.parse_body(
            "application/json",
            b'{"prompt":"hello","metadata":{"client":"web-ui"}}',
            error_factory=self.error_factory,
        )
        form_body = request_contracts.parse_body(
            "application/x-www-form-urlencoded",
            b"prompt=hello&mode=readonly",
            error_factory=self.error_factory,
        )

        self.assertEqual(json_body["prompt"], "hello")
        self.assertEqual(json_body["metadata"], '{"client": "web-ui"}')
        self.assertEqual(form_body, {"prompt": "hello", "mode": "readonly"})

    def test_parse_body_rejects_non_object_json(self):
        with self.assertRaises(FakeBridgeError) as ctx:
            request_contracts.parse_body(
                "application/json",
                b'["not","an","object"]',
                error_factory=self.error_factory,
            )

        self.assertEqual(ctx.exception.status, 400)

    def test_api_error_payload_preserves_bridge_error_details(self):
        payload = request_contracts.api_error_payload(
            FakeBridgeError("denied", 403, "permission_denied", {"workspace": "demo"})
        )

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "permission_denied")
        self.assertEqual(payload["error"]["details"], {"workspace": "demo"})

    def test_adapter_metadata_and_source_validation(self):
        metadata = request_contracts.parse_adapter_metadata(
            '{"client":"web-ui"}',
            error_factory=self.error_factory,
        )
        compact = request_contracts.compact_adapter_metadata_object(
            metadata,
            error_factory=self.error_factory,
        )
        source = request_contracts.safe_adapter_source(
            "discord-thread",
            error_factory=self.error_factory,
        )
        key = request_contracts.safe_idempotency_key(
            "web:test-key",
            error_factory=self.error_factory,
        )
        receipt = request_contracts.parse_run_receipt("queued task_1\nidempotent=true\n")

        self.assertEqual(metadata["client"], "web-ui")
        self.assertEqual(compact, '{"client":"web-ui"}')
        self.assertEqual(source, "discord-thread")
        self.assertEqual(key, "web:test-key")
        self.assertTrue(receipt["idempotent_replay"])


if __name__ == "__main__":
    unittest.main()
