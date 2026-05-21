import pytest
from datetime import datetime
from sqlalchemy import select
from services.timezone_service import utc_now


@pytest.mark.asyncio
async def test_attendance_endpoints_handle_null_last_activity(client, db, admin_token):
    from models import User, Session
    from auth import get_password_hash

    employee = User(
        name="موظف الحضور",
        username="attendance_cashier",
        hashed_password=get_password_hash("cashier123"),
        role="cashier",
        cashier_number=7,
        is_active=True,
    )
    db.add(employee)
    await db.flush()

    db.add(Session(
        user_id=employee.id,
        session_token="attendance-null-last-activity",
        is_active=True,
        opened_at=datetime(2026, 3, 10, 8, 0, 0),
        last_activity_at=None,
        closed_at=None,
        is_abnormal=False,
    ))
    await db.commit()

    headers = {"Authorization": f"Bearer {admin_token}"}

    status_resp = await client.get("/attendance/status", headers=headers)
    assert status_resp.status_code == 200, status_resp.text
    status_rows = status_resp.json()
    employee_status = next(row for row in status_rows if row["username"] == "attendance_cashier")
    assert employee_status["last_seen"] is not None

    monthly_resp = await client.get("/attendance/monthly?year=2026&month=3", headers=headers)
    assert monthly_resp.status_code == 200, monthly_resp.text
    monthly_rows = monthly_resp.json()
    employee_month = next(row for row in monthly_rows if row["name"] == "موظف الحضور")
    assert len(employee_month["daily"]) == 31
    march_10 = next(day for day in employee_month["daily"] if day["date"] == "2026-03-10")
    assert march_10["hours"] >= 0
    assert isinstance(march_10["is_abnormal"], bool)


@pytest.mark.asyncio
async def test_attendance_endpoints_require_manager_access(client, cashier_token):
    headers = {"Authorization": f"Bearer {cashier_token}"}

    status_resp = await client.get("/attendance/status", headers=headers)
    assert status_resp.status_code == 403

    monthly_resp = await client.get("/attendance/monthly?year=2026&month=3", headers=headers)
    assert monthly_resp.status_code == 403


@pytest.mark.asyncio
async def test_monthly_attendance_does_not_roll_session_into_next_day(client, db, admin_token):
    from models import User, Session
    from auth import get_password_hash

    employee = User(
        name="موظف منتصف الليل",
        username="midnight_cashier",
        hashed_password=get_password_hash("cashier123"),
        role="cashier",
        cashier_number=9,
        is_active=True,
    )
    db.add(employee)
    await db.flush()

    db.add(Session(
        user_id=employee.id,
        session_token="attendance-cross-midnight",
        is_active=False,
        opened_at=datetime(2026, 3, 9, 21, 0, 0),   # 23:00 local
        last_activity_at=datetime(2026, 3, 10, 1, 0, 0),  # 03:00 local
        closed_at=datetime(2026, 3, 10, 1, 0, 0),
        is_abnormal=False,
    ))
    await db.commit()

    headers = {"Authorization": f"Bearer {admin_token}"}
    monthly_resp = await client.get("/attendance/monthly?year=2026&month=3", headers=headers)
    assert monthly_resp.status_code == 200, monthly_resp.text

    monthly_rows = monthly_resp.json()
    employee_month = next(row for row in monthly_rows if row["username"] == "midnight_cashier")
    march_9 = next(day for day in employee_month["daily"] if day["date"] == "2026-03-09")
    march_10 = next(day for day in employee_month["daily"] if day["date"] == "2026-03-10")

    assert march_9["hours"] > 0
    assert march_9["first_connected"] is not None
    assert march_9["periods"]
    assert march_9["periods"][0]["connected_at"] is not None
    assert march_10["hours"] == 0
    assert march_10["first_connected"] is None
    assert march_10["periods"] == []


@pytest.mark.asyncio
async def test_monthly_attendance_returns_multiple_periods_for_same_day(client, db, admin_token):
    from models import User, Session
    from auth import get_password_hash

    employee = User(
        name="موظف الفترات",
        username="periods_cashier",
        hashed_password=get_password_hash("cashier123"),
        role="cashier",
        cashier_number=10,
        is_active=True,
    )
    db.add(employee)
    await db.flush()

    db.add_all([
        Session(
            user_id=employee.id,
            session_token="attendance-periods-1",
            is_active=False,
            opened_at=datetime(2026, 3, 15, 6, 0, 0),
            last_activity_at=datetime(2026, 3, 15, 8, 0, 0),
            closed_at=datetime(2026, 3, 15, 8, 0, 0),
            is_abnormal=False,
        ),
        Session(
            user_id=employee.id,
            session_token="attendance-periods-2",
            is_active=False,
            opened_at=datetime(2026, 3, 15, 10, 30, 0),
            last_activity_at=datetime(2026, 3, 15, 14, 30, 0),
            closed_at=datetime(2026, 3, 15, 14, 30, 0),
            is_abnormal=False,
        ),
    ])
    await db.commit()

    headers = {"Authorization": f"Bearer {admin_token}"}
    monthly_resp = await client.get("/attendance/monthly?year=2026&month=3", headers=headers)
    assert monthly_resp.status_code == 200, monthly_resp.text

    monthly_rows = monthly_resp.json()
    employee_month = next(row for row in monthly_rows if row["username"] == "periods_cashier")
    march_15 = next(day for day in employee_month["daily"] if day["date"] == "2026-03-15")

    assert march_15["sessions_count"] == 2
    assert len(march_15["periods"]) == 2
    assert march_15["periods"][0]["hours"] == 2.0
    assert march_15["periods"][1]["hours"] == 4.0


@pytest.mark.asyncio
async def test_open_session_replaces_stale_active_session(client, db, cashier_token):
    from models import User, Session

    cashier = (await db.execute(
        select(User).where(User.username == "test_cashier")
    )).scalar_one()

    stale = Session(
        user_id=cashier.id,
        session_token="stale-session-token",
        is_active=True,
        opened_at=datetime(2026, 3, 1, 7, 0, 0),
        last_activity_at=datetime(2026, 3, 1, 7, 0, 0),
        closed_at=None,
        is_abnormal=False,
    )
    db.add(stale)
    await db.commit()

    headers = {"Authorization": f"Bearer {cashier_token}"}
    resp = await client.post("/sessions/open", headers=headers)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["session_token"] != "stale-session-token"

    await db.refresh(stale)
    assert stale.is_active is False
    assert stale.disconnect_reason == "timeout"
    assert stale.is_abnormal is True


@pytest.mark.asyncio
async def test_first_websocket_presence_resets_placeholder_session_start(db):
    import importlib.util
    import pathlib
    import sys
    from models import User, Session
    from auth import get_password_hash

    backend_dir = pathlib.Path(__file__).parent.parent
    module_name = "attendance_main_test"
    spec = importlib.util.spec_from_file_location(module_name, backend_dir / "main.py")
    main_module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = main_module
    spec.loader.exec_module(main_module)

    employee = User(
        name="موظف سوكيت",
        username="socket_employee",
        hashed_password=get_password_hash("cashier123"),
        role="cashier",
        cashier_number=15,
        is_active=True,
    )
    db.add(employee)
    await db.flush()

    original_opened_at = datetime(2026, 3, 20, 8, 0, 0)
    session = Session(
        user_id=employee.id,
        session_token="socket-presence-token",
        is_active=True,
        opened_at=original_opened_at,
        last_activity_at=None,
        closed_at=None,
        is_abnormal=False,
    )
    db.add(session)
    await db.commit()

    await main_module._mark_session_connected(db, session)
    await db.refresh(session)

    assert session.opened_at > original_opened_at
    assert session.last_activity_at is not None
    assert abs((session.last_activity_at - session.opened_at).total_seconds()) < 1


@pytest.mark.asyncio
async def test_stale_websocket_reconnect_splits_session(db):
    import importlib.util
    import pathlib
    import sys
    from datetime import timedelta
    from models import User, Session
    from auth import get_password_hash

    backend_dir = pathlib.Path(__file__).parent.parent
    module_name = "attendance_main_reconnect_test"
    spec = importlib.util.spec_from_file_location(module_name, backend_dir / "main.py")
    main_module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = main_module
    spec.loader.exec_module(main_module)

    employee = User(
        name="موظف إعادة الاتصال",
        username="reconnect_employee",
        hashed_password=get_password_hash("cashier123"),
        role="cashier",
        cashier_number=16,
        is_active=True,
    )
    db.add(employee)
    await db.flush()

    original_token = "reconnect-token"
    old_opened_at = utc_now() - timedelta(hours=15, minutes=30)
    old_last_seen = utc_now() - timedelta(hours=15)
    session = Session(
        user_id=employee.id,
        session_token=original_token,
        is_active=True,
        opened_at=old_opened_at,
        last_activity_at=old_last_seen,
        closed_at=None,
        is_abnormal=False,
    )
    db.add(session)
    await db.commit()

    replacement = await main_module._prepare_socket_session(db, session)
    await db.refresh(session)

    assert replacement.id != session.id
    assert replacement.session_token == original_token
    assert replacement.opened_at > old_last_seen
    assert session.is_active is False
    assert session.closed_at == old_last_seen
    assert session.disconnect_reason == "timeout"


@pytest.mark.asyncio
async def test_attendance_telegram_employee_report_is_sent_as_pdf(client, db, admin_token, monkeypatch):
    import telegram_alerts
    from models import User, Session
    from auth import get_password_hash

    sent_documents = []

    async def fake_send_document(filename: str, data: bytes, caption: str | None = None) -> bool:
        sent_documents.append((filename, data, caption))
        return True

    monkeypatch.setattr(telegram_alerts, "send_document", fake_send_document)

    employee = User(
        name="موظف تيليغرام",
        username="telegram_cashier",
        hashed_password=get_password_hash("cashier123"),
        role="cashier",
        cashier_number=8,
        is_active=True,
    )
    db.add(employee)
    await db.flush()

    db.add(Session(
        user_id=employee.id,
        session_token="attendance-telegram-employee",
        is_active=False,
        opened_at=datetime(2026, 3, 12, 8, 0, 0),
        last_activity_at=datetime(2026, 3, 12, 18, 0, 0),
        closed_at=datetime(2026, 3, 12, 18, 0, 0),
        is_abnormal=False,
    ))
    await db.commit()

    headers = {"Authorization": f"Bearer {admin_token}"}
    resp = await client.post(
        "/attendance/send-telegram",
        headers=headers,
        json={"scope": "employee", "year": 2026, "month": 3, "employee_id": employee.id},
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert data["scope"] == "employee"
    assert sent_documents
    filename, payload, caption = sent_documents[0]
    assert filename.endswith(".pdf")
    assert payload.startswith(b"%PDF")
    assert "موظف تيليغرام" in caption
    assert "2026-03" in caption
    assert data["document_sent"] is True


@pytest.mark.asyncio
async def test_attendance_telegram_all_summary_is_sent_as_pdf(client, db, admin_token, monkeypatch):
    import telegram_alerts
    from models import User, Session
    from auth import get_password_hash

    sent_documents = []

    async def fake_send_document(filename: str, data: bytes, caption: str | None = None) -> bool:
        sent_documents.append((filename, data, caption))
        return True

    monkeypatch.setattr(telegram_alerts, "send_document", fake_send_document)

    users = [
        User(name="أحمد", username="att_a", hashed_password=get_password_hash("pass1"), role="cashier", cashier_number=11, is_active=True),
        User(name="سارة", username="att_b", hashed_password=get_password_hash("pass2"), role="supervisor", cashier_number=12, is_active=True),
    ]
    db.add_all(users)
    await db.flush()

    db.add_all([
        Session(
            user_id=users[0].id,
            session_token="attendance-telegram-all-1",
            is_active=False,
            opened_at=datetime(2026, 3, 5, 8, 0, 0),
            last_activity_at=datetime(2026, 3, 5, 18, 0, 0),
            closed_at=datetime(2026, 3, 5, 18, 0, 0),
            is_abnormal=False,
        ),
        Session(
            user_id=users[1].id,
            session_token="attendance-telegram-all-2",
            is_active=False,
            opened_at=datetime(2026, 3, 6, 9, 0, 0),
            last_activity_at=datetime(2026, 3, 6, 15, 0, 0),
            closed_at=datetime(2026, 3, 6, 15, 0, 0),
            is_abnormal=True,
        ),
    ])
    await db.commit()

    headers = {"Authorization": f"Bearer {admin_token}"}
    resp = await client.post(
        "/attendance/send-telegram",
        headers=headers,
        json={"scope": "all", "year": 2026, "month": 3},
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert data["scope"] == "all"
    assert data["employees_count"] >= 2
    assert sent_documents
    filename, payload, caption = sent_documents[0]
    assert filename == "attendance-summary-2026-03.pdf"
    assert payload.startswith(b"%PDF")
    assert "2026-03" in caption
    assert "حضور الموظفين" in caption
    assert data["document_sent"] is True
