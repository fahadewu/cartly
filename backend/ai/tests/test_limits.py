import asyncio

import pytest

from app import redis_client, usage
from app.brain import limits

from .fakes import FakeRedis, Settings


@pytest.fixture
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(redis_client, "get_redis", lambda: fake)
    monkeypatch.setattr(usage, "get_redis", lambda: fake)
    s = Settings()
    s(pip_strikes=3, pip_strike_window=1800, pip_cooldown=600, pip_daily_turns_account=200, pip_daily_turns_session=80,
      pip_daily_turns_guest_ip=1000, claude_daily_budget=0, pip_soft_cap_ratio=0.8)
    yield fake
    s.restore()


def run(coro):
    return asyncio.run(coro)


def test_who_the_shopper_is(redis):
    assert limits.identities({"userId": "u1", "sessionId": "s", "client": "c"}) == ("u:u1", [("u:u1", 200)])
    assert limits.identities({"sessionId": "s", "client": "c"}) == ("s:s", [("s:s", 80), ("g:c", 1000)])
    assert limits.identities({"sessionId": "s"}) == ("s:s", [("s:s", 80)])
    assert limits.identities({}) == (None, [])


def test_strikes_open_a_cooldown_that_ends(redis):
    ctx = {"sessionId": "s1"}
    key = limits.strike_key("s:s1")
    assert run(limits.strike(ctx)) == 1 and redis.ttls[key] == 1800  # the window starts at the first strike
    assert run(limits.strike(ctx)) == 2 and redis.ttls[key] == 1800
    assert not run(limits.standing(ctx)).cooling_down
    assert run(limits.strike(ctx)) == 3 and redis.ttls[key] == 600  # the limit starts the cooldown
    assert run(limits.standing(ctx)).cooling_down
    del redis.data[key]  # the cooldown ran out
    assert not run(limits.standing(ctx)).cooling_down
    assert redis.hashes[usage.day_key()]["pip:strikes"] == "3.0"


def test_strangers_on_one_network_never_share_a_cooldown(redis):
    """One IP is often thousands of shoppers (mobile carrier NAT): each guest chat keeps its own strikes."""
    for sid in ("a", "b", "c"):  # three strangers, one off-topic message each
        run(limits.strike({"sessionId": sid, "client": "net"}))
    assert not run(limits.standing({"sessionId": "d", "client": "net"})).cooling_down
    assert limits.strike_key("g:net") not in redis.data
    for _ in range(2):
        run(limits.strike({"sessionId": "a", "client": "net"}))
    assert run(limits.standing({"sessionId": "a", "client": "net"})).cooling_down  # its own 3 strikes do
    assert not run(limits.standing({"sessionId": "d", "client": "net"})).cooling_down


def test_strikes_and_cooldown_can_be_off(redis):
    s = Settings()
    s(pip_strikes=0)
    try:
        assert run(limits.strike({"sessionId": "s"})) == 0 and not redis.data
    finally:
        s.restore()
    s(pip_cooldown=0)
    try:
        for _ in range(3):
            run(limits.strike({"sessionId": "s"}))
        assert not run(limits.standing({"sessionId": "s"})).cooling_down
    finally:
        s.restore()


def test_daily_quotas_count_the_session_and_the_network(redis):
    s = Settings()
    s(pip_daily_turns_session=2, pip_daily_turns_guest_ip=3)
    try:
        a, b = {"sessionId": "a", "client": "net"}, {"sessionId": "b", "client": "net"}
        run(limits.count_turn(a))
        assert not run(limits.standing(a)).over_quota
        run(limits.count_turn(a))
        assert run(limits.standing(a)).over_quota and not run(limits.standing(b)).over_quota
        run(limits.count_turn(b))
        assert run(limits.standing(b)).over_quota  # the network's third turn today
        assert redis.ttls[limits.turns_key("s:a")] == limits.TURNS_TTL and redis.data[limits.turns_key("g:net")] == "3"
    finally:
        s.restore()


def test_a_signed_in_quota_follows_the_account(redis):
    s = Settings()
    s(pip_daily_turns_account=1)
    try:
        run(limits.count_turn({"userId": "u", "sessionId": "a"}))
        assert run(limits.standing({"userId": "u", "sessionId": "b"})).over_quota
        assert limits.turns_key("s:a") not in redis.data  # a signed-in shopper is counted once, on the account
    finally:
        s.restore()


def test_zero_means_no_quota(redis):
    s = Settings()
    s(pip_daily_turns_session=0, pip_daily_turns_guest_ip=0)
    try:
        for _ in range(5):
            run(limits.count_turn({"sessionId": "a", "client": "net"}))
        assert not redis.data and not run(limits.standing({"sessionId": "a", "client": "net"})).over_quota
    finally:
        s.restore()


def test_the_soft_cap_is_for_guests_with_an_empty_cart(redis):
    s = Settings()
    s(claude_daily_budget=10.0, pip_soft_cap_ratio=0.8)
    try:
        redis.hashes[usage.day_key()] = {"claude:cost": "7.9"}
        assert not run(limits.standing({"sessionId": "a"})).soft_capped
        redis.hashes[usage.day_key()]["claude:cost"] = "8.0"
        assert run(limits.standing({"sessionId": "a"})).soft_capped
        assert not run(limits.standing({"userId": "u"})).soft_capped
        assert not run(limits.standing({"sessionId": "a", "cart": [{"id": 1}]})).soft_capped
        s(claude_daily_budget=0)
        assert not run(limits.standing({"sessionId": "a"})).soft_capped
    finally:
        s.restore()


def test_limits_never_stop_a_turn(monkeypatch):
    class Down:
        def __getattr__(self, name):
            raise ConnectionError("Redis is down")

    monkeypatch.setattr(redis_client, "get_redis", lambda: Down())
    s = Settings()
    s(claude_daily_budget=10.0)
    try:
        assert run(limits.standing({"sessionId": "a", "client": "net"})) == limits.Standing()
        assert run(limits.strike({"sessionId": "a"})) == 0
        run(limits.count_turn({"sessionId": "a"}))
    finally:
        s.restore()
