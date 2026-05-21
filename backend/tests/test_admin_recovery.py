import re

import pytest


@pytest.mark.asyncio
async def test_admin_recovery_requires_telegram_otp_and_secret_answer(db, monkeypatch):
    from auth import get_password_hash, verify_password
    from models import StoreProfile, SystemSetting, User
    from services.admin_recovery_service import (
        request_recovery_otp,
        reset_admin_credentials,
        save_initial_recovery_config,
        verify_recovery_otp,
        verify_secret_answer,
    )
    from services.system_settings_service import get_system_setting_value

    store = StoreProfile(
        store_id="flowpos-recovery-test",
        store_name="Recovery Test Store",
        country="PS",
        currency="ILS",
        store_type="supermarket",
    )
    admin = User(
        name="Admin",
        username="admin_owner",
        hashed_password=get_password_hash("old-password-123"),
        role="admin",
        is_active=True,
    )
    db.add(store)
    db.add(admin)
    db.add(SystemSetting(key="manager_telegram_chat_id", value="998877"))
    db.add(SystemSetting(key="manager_telegram_username", value="manager_test"))
    db.add(SystemSetting(key="telegram_recovery_enabled", value="true"))
    await db.commit()

    await save_initial_recovery_config(
        db,
        secret_question="What is your first store?",
        secret_answer="My Secret Store",
    )
    await db.commit()

    sent_messages: list[tuple[str, str]] = []

    async def fake_send_message_to_chat(chat_id: str, message: str) -> bool:
        sent_messages.append((chat_id, message))
        return True

    monkeypatch.setattr(
        "services.admin_recovery_service.telegram_alerts.send_message_to_chat",
        fake_send_message_to_chat,
    )

    await request_recovery_otp(db, installation_id="inst-test")

    assert sent_messages
    assert sent_messages[0][0] == "998877"
    otp_match = re.search(r"\b(\d{6})\b", sent_messages[0][1])
    assert otp_match

    otp_result = await verify_recovery_otp(db, otp=otp_match.group(1), installation_id="inst-test")
    assert otp_result["secret_question"] == "What is your first store?"

    secret_hash = await get_system_setting_value(db, "admin_recovery_secret_answer_hash", "")
    assert secret_hash
    assert "My Secret Store" not in secret_hash
    assert verify_password("my secret store", secret_hash)

    secret_result = await verify_secret_answer(
        db,
        recovery_token=otp_result["recovery_token"],
        answer="  MY   secret   STORE ",
        installation_id="inst-test",
    )
    assert secret_result["admin_username"] == "admin_owner"

    reset_result = await reset_admin_credentials(
        db,
        recovery_token=otp_result["recovery_token"],
        new_password="new-password-123",
        new_username="admin_owner_new",
        installation_id="inst-test",
    )
    assert reset_result["admin_username"] == "admin_owner_new"
    assert verify_password("new-password-123", admin.hashed_password)


@pytest.mark.asyncio
async def test_recovery_secret_answer_can_be_short_when_non_empty(db):
    from models import SystemSetting
    from services.admin_recovery_service import save_initial_recovery_config
    from services.system_settings_service import get_system_setting_value

    db.add(SystemSetting(key="manager_telegram_chat_id", value="112233"))
    db.add(SystemSetting(key="telegram_recovery_enabled", value="true"))
    await db.commit()

    await save_initial_recovery_config(db, secret_question="رمزك المفضل؟", secret_answer="7")
    await db.commit()

    secret_hash = await get_system_setting_value(db, "admin_recovery_secret_answer_hash", "")
    assert secret_hash
    assert secret_hash != "7"


@pytest.mark.asyncio
async def test_manager_telegram_setup_token_is_consumed_after_link(db):
    from services.admin_recovery_service import (
        SETUP_MANAGER_LINK_TOKEN_KEY,
        ensure_manager_telegram_setup_link,
        process_manager_telegram_start_token,
    )
    from services.system_settings_service import get_system_setting_value

    status = await ensure_manager_telegram_setup_link(db)
    token = status["link"].rsplit("start=", 1)[-1]

    first = await process_manager_telegram_start_token(
        db,
        token=token,
        chat_id="555001",
        telegram_username="first_manager",
    )
    assert first is True
    assert await get_system_setting_value(db, SETUP_MANAGER_LINK_TOKEN_KEY, "") == ""

    second = await process_manager_telegram_start_token(
        db,
        token=token,
        chat_id="555002",
        telegram_username="second_manager",
    )
    assert second is False
    assert await get_system_setting_value(db, "manager_telegram_chat_id", "") == "555001"
