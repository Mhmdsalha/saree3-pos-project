# 🛒 FlowPOS

نظام كاشير متكامل للسوبرماركت مع واجهة React حديثة للديسكتوب والجوال ودعم مسح الباركود عبر الجوال.

---

## 📁 هيكل المشروع

```
supermarket-pos/
├── backend/          ← Python FastAPI (السيرفر)
└── frontend/         ← واجهة React للديسكتوب والجوال
```

---

## 🚀 تشغيل المشروع

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
python seed.py          # إنشاء المدير وبيانات أولية
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**بيانات الدخول الأولية:**
- المستخدم: `admin`
- كلمة السر: `admin123`

### 2. Frontend React

```bash
cd frontend
npm install
npm run dev
```

أو بعد البناء من الـ backend:

- الديسكتوب: `/frontend-react/`
- الجوال: `/mobile-react/`

---

## 📱 ربط الجوال بالديسكتوب

1. شغّل البيكند على الحاسوب
2. افتح واجهة الديسكتوب وسجّل دخول
3. ستجد QR Code تلقائي في قسم الفاتورة
4. افتح التطبيق على الجوال وصوّر الـ QR
5. الجوال متصل الآن ✅

---

## 👤 الأدوار والصلاحيات

| الدور | الصلاحيات |
|-------|-----------|
| admin | كل الصلاحيات |
| supervisor | تعديل أسعار، تقارير، إلغاء فواتير |
| cashier | فتح فواتير ومسح باركود فقط |

---

## ⚡ التقنيات المستخدمة

| الطبقة | التقنية |
|--------|---------|
| Backend | Python 3.12 + FastAPI + SQLAlchemy |
| Database | SQLite (للتطوير) / PostgreSQL (للإنتاج) |
| Real-time | WebSocket مدمج |
| Auth | JWT + bcrypt |
| Frontend | React + Vite + TanStack Query |
| Mobile Scanner | Web APIs + Quagga2 + BarcodeDetector |
| Fonts | Cairo (Google Fonts) |

---

## 🔧 المتغيرات البيئية

```env
DATABASE_URL=sqlite:///./supermarket.db
SECRET_KEY=your-secret-key-change-in-production
```

---

## 📊 API Endpoints

| Method | Path | الوصف |
|--------|------|-------|
| POST | /auth/login | تسجيل دخول |
| GET | /products | قائمة المنتجات |
| GET | /products/barcode/{code} | بحث بالباركود |
| POST | /products | إضافة منتج |
| PUT | /products/{id} | تعديل منتج |
| GET | /users | قائمة المستخدمين |
| POST | /users | إضافة مستخدم |
| POST | /sessions/open | فتح جلسة |
| POST | /sessions/close | إغلاق جلسة |
| POST | /invoices | حفظ فاتورة |
| GET | /invoices | قائمة الفواتير |
| GET | /reports/daily | تقرير اليوم |
| WS | /ws/{token} | WebSocket للمزامنة |

---

## 🗺️ الخطوات القادمة

- [ ] تقرير نهاية اليوم (تيليغرام)
- [ ] طباعة الفواتير (Thermal Printer)
- [ ] إرسال الفاتورة على واتساب
- [ ] تواريخ انتهاء الصلاحية
- [ ] العروض والخصومات
- [ ] استيراد المنتجات من Excel
- [ ] نسخ احتياطي تلقائي
