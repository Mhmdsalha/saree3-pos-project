import pytest


@pytest.mark.asyncio
async def test_store_start_link_sends_welcome_message(db, monkeypatch):
    from models import StoreProfile
    from services.customer_telegram_service import process_telegram_start_token

    store = StoreProfile(
        store_id="flowpos-store-123",
        store_name="FlowPOS Market",
        country="PS",
        currency="ILS",
        store_type="supermarket",
    )
    db.add(store)
    await db.commit()

    sent_messages: list[tuple[str, str]] = []

    async def fake_send_message_to_chat(chat_id: str, message: str) -> bool:
        sent_messages.append((chat_id, message))
        return True

    monkeypatch.setattr(
        "services.customer_telegram_service.telegram_alerts.send_message_to_chat",
        fake_send_message_to_chat,
    )

    result = await process_telegram_start_token(
        db,
        token="flowpos-store-123",
        chat_id="999999",
        telegram_username="store_test_user",
    )

    assert result is None
    assert sent_messages
    assert sent_messages[0][0] == "999999"
    assert "FlowPOS Market" in sent_messages[0][1]
    assert "تفعيل تيليجرام" in sent_messages[0][1]


@pytest.mark.asyncio
async def test_new_store_does_not_inherit_legacy_telegram_toggle(db, monkeypatch):
    from models import SystemSetting
    from services.launcher_service import get_telegram_settings, setup_store

    db.add(SystemSetting(key="telegram_enabled", value="true"))
    db.add(SystemSetting(key="telegram_auto_send", value="true"))
    db.add(SystemSetting(key="telegram_mode", value="text"))
    db.add(SystemSetting(key="manager_telegram_chat_id", value="123456"))
    db.add(SystemSetting(key="telegram_recovery_enabled", value="true"))
    await db.commit()

    await setup_store(
        db,
        store_name="متجر جديد",
        country="PS",
        currency="ILS",
        store_type="supermarket",
        phone=None,
        address=None,
        logo_path=None,
        server_port=8000,
        admin_name="المدير",
        admin_username="owner_new_store",
        admin_password="secret123",
        secret_question="Recovery question?",
        secret_answer="answer123",
    )

    async def fake_bot_username():
        return "central_bot"

    monkeypatch.setattr("services.launcher_service.telegram_alerts.get_bot_username", fake_bot_username)

    settings = await get_telegram_settings(db)

    assert settings["telegram_enabled"] is False
    assert settings["telegram_auto_send"] is False
    assert settings["telegram_mode"] == "pdf"


@pytest.mark.asyncio
async def test_store_start_link_activates_store_telegram_settings(db, monkeypatch):
    from models import StoreProfile
    from services.customer_telegram_service import process_telegram_start_token
    from services.launcher_service import get_telegram_settings

    store = StoreProfile(
        store_id="flowpos-store-activate-1",
        store_name="متجر التفعيل",
        country="PS",
        currency="ILS",
        store_type="supermarket",
    )
    db.add(store)
    await db.commit()

    async def fake_send_message_to_chat(chat_id: str, message: str) -> bool:
        return True

    async def fake_bot_username():
        return "central_bot"

    monkeypatch.setattr(
        "services.customer_telegram_service.telegram_alerts.send_message_to_chat",
        fake_send_message_to_chat,
    )
    monkeypatch.setattr("services.launcher_service.telegram_alerts.get_bot_username", fake_bot_username)

    result = await process_telegram_start_token(
        db,
        token="flowpos-store-activate-1",
        chat_id="999888",
        telegram_username="store_manager_bot",
    )

    settings = await get_telegram_settings(db)

    assert result is None
    assert settings["telegram_enabled"] is True
    assert settings["store_linked"] is True
    assert settings["store_linked_username"] == "store_manager_bot"
    assert settings["store_linked_at"] is not None


@pytest.mark.asyncio
async def test_customer_telegram_status_does_not_expose_chat_id_or_token(db, monkeypatch):
    from services.customer_telegram_service import create_activation_request, serialize_customer_status
    from models import Customer, Session, User
    from auth import get_password_hash
    from sqlalchemy import select

    user = User(
        name="Cashier",
        username="telegram_privacy_cashier",
        hashed_password=get_password_hash("cashier123"),
        role="cashier",
        is_active=True,
    )
    db.add(user)
    await db.flush()
    session = Session(user_id=user.id, session_token="telegram-privacy-session", is_active=True)
    db.add(session)
    await db.commit()

    async def fake_bot_username():
        return "central_bot"

    monkeypatch.setattr("services.customer_telegram_service.telegram_alerts.get_bot_username", fake_bot_username)

    pending = await create_activation_request(
        db,
        user_id=user.id,
        customer_name="Private Customer",
        phone_number="0599999999",
        session_token="telegram-privacy-session",
    )
    assert pending["activation_url"]
    assert pending["activation_token"] is None
    assert pending["telegram_chat_id"] is None

    customer = (await db.execute(select(Customer).where(Customer.phone_number == "0599999999"))).scalar_one()
    customer.telegram_chat_id = "987654321"
    customer.telegram_activation_status = "activated"
    customer.last_activation_token = "secret-token"
    await db.commit()

    safe_status = serialize_customer_status(customer)
    assert safe_status["telegram_chat_id"] is None
    assert safe_status["activation_token"] is None
