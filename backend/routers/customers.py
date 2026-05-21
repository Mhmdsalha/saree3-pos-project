from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from schemas import CustomerActivationRequest, CustomerLookupOut, CustomerRecordOut, CustomerTelegramStatusOut
from routers.deps import get_current_user, require_manager
from services.customer_telegram_service import (
    create_activation_request,
    get_customer_by_phone,
    list_customers,
    search_customers,
    serialize_customer_status,
)

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("", response_model=list[CustomerRecordOut])
async def get_customers(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manager),
):
    customers = await list_customers(db)
    return [
        {
            "id": customer.id,
            "customer_name": customer.customer_name,
            "phone_number": customer.phone_number,
            "telegram_activation_status": customer.telegram_activation_status or "inactive",
            "telegram_status_label": serialize_customer_status(customer)["telegram_status_label"],
            "telegram_username": customer.telegram_username,
            "telegram_activated_at": customer.telegram_activated_at,
            "created_at": customer.created_at,
            "updated_at": customer.updated_at,
        }
        for customer in customers
    ]


@router.get("/search", response_model=list[CustomerLookupOut])
async def search_saved_customers(
    q: str,
    limit: int = 8,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    customers = await search_customers(db, q, limit=limit)
    return [
        {
            "id": customer.id,
            "customer_name": customer.customer_name,
            "phone_number": customer.phone_number,
            "telegram_activation_status": customer.telegram_activation_status,
        }
        for customer in customers
    ]


@router.get("/telegram/status", response_model=CustomerTelegramStatusOut)
async def get_customer_telegram_status(
    phone: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    customer = await get_customer_by_phone(db, phone)
    return serialize_customer_status(customer)


@router.post("/telegram/activation-request", response_model=CustomerTelegramStatusOut)
async def request_customer_telegram_activation(
    payload: CustomerActivationRequest,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    return await create_activation_request(
        db,
        user_id=user.id,
        customer_name=payload.customer_name,
        phone_number=payload.phone_number,
        session_token=payload.session_token,
    )
