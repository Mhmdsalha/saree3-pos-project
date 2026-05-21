# FlowPOS License Admin

هذه الأدوات مخصصة لإدارة رموز التفعيل خارج اللانشر.

## 1. أداة سطر الأوامر

توليد زوج مفاتيح:

```powershell
python backend/scripts/license_admin.py generate-keypair --out-dir %USERPROFILE%/.saree-license-admin
```

إصدار رمز تفعيل دائم:

```powershell
python backend/scripts/license_admin.py issue-license `
  --private-key-file %USERPROFILE%/.saree-license-admin/flowpos-license-private.b64 `
  --store-id flowpos-123456 `
  --installation-id inst-abcdef123456 `
  --license-type lifetime `
  --plan pro
```

إصدار رمز باشتراك ينتهي بتاريخ محدد:

```powershell
python backend/scripts/license_admin.py issue-license `
  --private-key-file %USERPROFILE%/.saree-license-admin/flowpos-license-private.b64 `
  --store-id flowpos-123456 `
  --installation-id inst-abcdef123456 `
  --license-type subscription `
  --plan advanced `
  --expiry-date 2027-05-02T15:30:00
```

فحص محتوى رمز تفعيل:

```powershell
python backend/scripts/license_admin.py inspect-token --token "FP1...."
```

## 2. أداة الديسكتوب

تشغيل النسخة البرمجية مباشرة:

```powershell
python backend/scripts/license_admin_desktop.py
```

بناء ملف exe مستقل:

```powershell
python backend/scripts/build_license_admin_desktop.py
```

ملف الإخراج سيكون عادةً في:

`backend/dist/flowpos-license-admin.exe`

### أنواع الاشتراك الجاهزة

- مدى الحياة
- شهر
- 3 أشهر
- 6 أشهر
- سنة

الأداة تختار تاريخ الانتهاء تلقائيًا بحسب النوع المختار.

## ملاحظة مهمة

حتى يقبل النظام الرموز المولدة، يجب أن يكون المفتاح العام المطابق للمفتاح الخاص محفوظًا في بيئة التشغيل عبر:

`FLOWPOS_LICENSE_PUBLIC_KEY_B64`

المفتاح الخاص يجب أن يبقى خارج نسخة التوزيع، ويفضل حفظه في مجلد إداري منفصل مثل:

`%USERPROFILE%\.saree-license-admin\`
