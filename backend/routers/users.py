"""router: /users/*"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from database import get_db
from models import User
from schemas import UserCreate, UserUpdate, UserOut
from auth import get_password_hash
from routers.deps import get_current_user, require_admin_only

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserOut)
async def get_me(user=Depends(get_current_user)):
    return user


@router.get("", response_model=list[UserOut])
async def get_users(db: AsyncSession = Depends(get_db), _=Depends(require_admin_only)):
    result = await db.execute(select(User))
    return result.scalars().all()


@router.post("", response_model=UserOut)
async def create_user(
    data: UserCreate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin_only),
):
    result = await db.execute(select(User).where(User.username == data.username))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="اسم المستخدم موجود مسبقاً")
    new_user = User(
        name=data.name, username=data.username, phone=data.phone,
        hashed_password=get_password_hash(data.password),
        role=data.role, cashier_number=data.cashier_number,
    )
    db.add(new_user)
    await db.commit()
    await db.refresh(new_user)
    return new_user


@router.put("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int,
    data: UserUpdate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin_only),
):
    result = await db.execute(select(User).where(User.id == user_id))
    u = result.scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="المستخدم غير موجود")
    for k, v in data.dict(exclude_unset=True).items():
        if k == "password":
            u.hashed_password = get_password_hash(v)
        else:
            setattr(u, k, v)
    await db.commit()
    await db.refresh(u)
    return u


@router.delete("/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin_only),
):
    result = await db.execute(select(User).where(User.id == user_id))
    u = result.scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="المستخدم غير موجود")
    u.is_active = False
    await db.commit()
    return {"ok": True}
