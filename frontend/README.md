# FlowPOS Frontend Foundation

هذا المجلد هو بداية الترحيل الآمن من الواجهة الحالية أحادية الملف إلى:

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui compatible structure
- TanStack Query

المهم:

- هذا المجلد هو الواجهة المعتمدة الحالية للديسكتوب والجوال
- يتم بناء الملفات إلى [frontend/dist](/D:/supermarket-pos/pos/frontend/dist)
- ويقوم الـ backend بتقديمها من:
  - `/frontend-react/`
  - `/mobile-react/`

## الوضع الحالي

- shell جديد يحافظ على نفس فكرة:
  - sidebar
  - topbar
  - main content
  - invoice panel
- login الجديد يستخدم نفس مفاتيح التخزين الحالية:
  - `pos_server`
  - `pos_token`
  - `pos_user`
  - `pos_session`
- data layer الجديدة تبدأ من:
  - `api-client`
  - `auth storage`
  - `QueryClient`

## تشغيل التطوير

```bash
npm install
npm run dev
```

المنفذ الافتراضي:

- `http://localhost:3001`

والـ proxy موجّه إلى:

- `http://localhost:8000`

## البناء

```bash
npm run build
```

بعد البناء، يتم إنتاج ملفات static في:

- [frontend/dist](/D:/supermarket-pos/pos/frontend/dist)

والباكند أصبح يوفّرها بشكل مستقل من:

- `/frontend-react/`

## الحالة الحالية

1. الواجهة الحديثة هي المسار المعتمد للتشغيل
2. الديسكتوب يعمل من `/frontend-react/`
3. الجوال يعمل من `/mobile-react/`
4. أي تطوير جديد يجب أن يتم على هذا المسار فقط
