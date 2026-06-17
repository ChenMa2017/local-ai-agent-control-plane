import unittest
from dataclasses import dataclass

import auth_policy


@dataclass(frozen=True)
class FakePrincipal:
    user: str
    role: str = "user"


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class AuthPolicyTests(unittest.TestCase):
    def error_factory(self, message: str, status: int, code: str | None) -> FakeBridgeError:
        return FakeBridgeError(message, status, code)

    def test_validate_auth_accepts_allowlisted_token_and_user(self):
        auth_policy.validate_auth(
            {"token": "token-1", "user_name": "chenma"},
            mattermost_tokens=("token-1",),
            allowed_users=("chenma",),
            error_factory=self.error_factory,
        )

    def test_validate_auth_rejects_bad_mattermost_token(self):
        with self.assertRaises(FakeBridgeError) as ctx:
            auth_policy.validate_auth(
                {"token": "wrong", "user_name": "chenma"},
                mattermost_tokens=("token-1",),
                allowed_users=("chenma",),
                error_factory=self.error_factory,
            )

        self.assertEqual(ctx.exception.status, 403)

    def test_authenticate_bearer_accepts_valid_token(self):
        principal = auth_policy.authenticate_bearer(
            "Bearer bearer-1",
            auth_tokens={"bearer-1": FakePrincipal(user="chenma", role="admin")},
            allowed_users=("chenma",),
            error_factory=self.error_factory,
        )

        self.assertEqual(principal.user, "chenma")
        self.assertEqual(principal.role, "admin")

    def test_authenticate_bearer_rejects_non_allowlisted_user(self):
        with self.assertRaises(FakeBridgeError) as ctx:
            auth_policy.authenticate_bearer(
                "Bearer bearer-2",
                auth_tokens={"bearer-2": FakePrincipal(user="unknown", role="user")},
                allowed_users=("chenma",),
                error_factory=self.error_factory,
            )

        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, "permission_denied")

    def test_reject_frontend_identity_blocks_user_fields(self):
        with self.assertRaises(FakeBridgeError) as ctx:
            auth_policy.reject_frontend_identity(
                {"task_id": "task_1", "user_name": "chenma"},
                error_factory=self.error_factory,
            )

        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.code, "invalid_request")

    def test_access_helpers_use_admin_or_owner(self):
        admin = FakePrincipal(user="chenma", role="admin")
        owner = FakePrincipal(user="chenma", role="user")
        other = FakePrincipal(user="alice", role="user")

        self.assertTrue(auth_policy.is_admin(admin))
        self.assertTrue(auth_policy.can_access_task({"user": "someone-else"}, admin))
        self.assertTrue(auth_policy.can_access_task({"user": "chenma"}, owner))
        self.assertFalse(auth_policy.can_access_task({"user": "chenma"}, other))
        self.assertTrue(auth_policy.can_access_intake({"user": "chenma"}, owner))
        self.assertFalse(auth_policy.can_access_intake({"user": "chenma"}, other))


if __name__ == "__main__":
    unittest.main()
