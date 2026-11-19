"""Signing in the way Hermes's native apps do, and staying signed in."""

from __future__ import annotations

import json
import stat

import pytest

from lantern.auth import Auth, Http
from lantern.errors import NeedsSignIn
from lantern.fakehermes import FakeHermes


def test_sign_in_keeps_tokens_and_by_choice_the_password(run, short_tmp):
    async def main():
        fake = FakeHermes()
        await fake.start()
        try:
            store = short_tmp / "credentials.json"
            auth = Auth(fake.base, store)
            await auth.sign_in("ada", "pw", remember=True)
            saved = json.loads(store.read_text())
            assert saved["access_token"] in fake.tokens and saved["password"] == "pw"
            assert stat.S_IMODE(store.stat().st_mode) == 0o600
            await auth.sign_in("ada", "pw", remember=False)
            assert "password" not in json.loads(store.read_text())
            assert await Http(fake.base, auth).get("/api/sessions?profile=default")
        finally:
            await fake.stop()
    run(main())


def test_a_wrong_password_is_refused_in_plain_words(run, short_tmp):
    async def main():
        fake = FakeHermes()
        await fake.start()
        try:
            with pytest.raises(NeedsSignIn, match="not right"):
                await Auth(fake.base, short_tmp / "c.json").sign_in("ada", "nope", remember=True)
        finally:
            await fake.stop()
    run(main())


def test_tokens_are_refreshed_before_they_expire(run, short_tmp):
    async def main():
        fake = FakeHermes()
        fake.token_ttl = 30  # inside the two-minute early-refresh window
        await fake.start()
        try:
            auth = Auth(fake.base, short_tmp / "c.json")
            await auth.sign_in("ada", "pw", remember=False)
            first = auth.creds["access_token"]
            headers = await auth.headers()
            assert headers["Authorization"] != f"Bearer {first}"
            assert first not in fake.tokens
        finally:
            await fake.stop()
    run(main())


def test_a_dead_session_signs_in_again_with_the_saved_password(run, short_tmp):
    async def main():
        fake = FakeHermes()
        await fake.start()
        try:
            auth = Auth(fake.base, short_tmp / "c.json")
            await auth.sign_in("ada", "pw", remember=True)
            fake.expire_tokens()
            assert await Http(fake.base, auth).get("/api/sessions?profile=default")  # recovered by itself
            fake.expire_tokens()
            fake.password = "changed"
            with pytest.raises(NeedsSignIn):
                await Http(fake.base, auth).get("/api/sessions?profile=default")
            assert "password" not in auth.creds  # a refused password is never tried again
        finally:
            await fake.stop()
    run(main())


def test_without_a_saved_password_an_expired_session_asks_for_sign_in(run, short_tmp):
    async def main():
        fake = FakeHermes()
        await fake.start()
        try:
            auth = Auth(fake.base, short_tmp / "c.json")
            await auth.sign_in("ada", "pw", remember=False)
            fake.expire_tokens()
            with pytest.raises(NeedsSignIn, match="expired"):
                await Http(fake.base, auth).get("/api/sessions?profile=default")
            assert not auth.signed_in and auth.username == "ada"
        finally:
            await fake.stop()
    run(main())
