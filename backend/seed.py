"""
Run once to create admin user and sample data:
  python seed.py
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models import Base, User, Category
from auth import get_password_hash
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./supermarket.db")
engine = create_engine(DATABASE_URL)
Base.metadata.create_all(engine)
Session = sessionmaker(engine)

with Session() as db:
    # Admin user
    if not db.query(User).filter(User.username == "admin").first():
        db.add(User(
            name="المدير العام",
            username="admin",
            hashed_password=get_password_hash("admin123"),
            role="admin",
            cashier_number=0,
        ))

    # Default categories
    categories = [
        ("مواد غذائية", "🥫", "#F59E0B"),
        ("ألبان وأجبان", "🥛", "#3B82F6"),
        ("لحوم ومجمدات", "🥩", "#EF4444"),
        ("مشروبات", "🥤", "#10B981"),
        ("خضار وفواكه", "🍎", "#84CC16"),
        ("مخبوزات", "🍞", "#F97316"),
        ("منظفات", "🧴", "#8B5CF6"),
        ("عناية شخصية", "💊", "#EC4899"),
        ("متفرقات", "📦", "#6B7280"),
    ]
    for name, icon, color in categories:
        if not db.query(Category).filter(Category.name == name).first():
            db.add(Category(name=name, icon=icon, color=color))

    db.commit()
    print("✅ Admin created: admin / admin123")
    print("✅ Categories created")
