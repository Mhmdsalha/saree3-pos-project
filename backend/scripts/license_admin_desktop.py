from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Callable

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.license_admin import issue_license_package  # noqa: E402
from services.license_service import decode_activation_token_payload, generate_license_keypair_b64  # noqa: E402


APP_TITLE = "سريع | إدارة التفعيل"
DEFAULT_GEOMETRY = "1000x790"
DEFAULT_KEY_DIR = (Path.home() / ".saree-license-admin").resolve()
DEFAULT_PRIVATE_KEY_FILE = DEFAULT_KEY_DIR / "flowpos-license-private.b64"
TERM_OPTIONS = [
    ("مدى الحياة", "lifetime"),
    ("شهر", "monthly"),
    ("3 أشهر", "quarterly"),
    ("6 أشهر", "semiannual"),
    ("سنة", "yearly"),
]
TERM_LABEL_TO_KEY = {label: key for label, key in TERM_OPTIONS}
TERM_KEY_TO_LABEL = {key: label for label, key in TERM_OPTIONS}


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class LicenseAdminDesktop(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry(DEFAULT_GEOMETRY)
        self.minsize(940, 740)
        self.configure(bg="#f7f8fa")

        self.private_key_file = tk.StringVar(value=str(DEFAULT_PRIVATE_KEY_FILE) if DEFAULT_PRIVATE_KEY_FILE.exists() else "")
        self.store_id = tk.StringVar()
        self.installation_id = tk.StringVar()
        self.license_id = tk.StringVar()
        self.sequence_number = tk.StringVar()
        self.subscription_term = tk.StringVar(value=TERM_KEY_TO_LABEL["lifetime"])
        self.issue_date = tk.StringVar(value=now_iso())
        self.keygen_dir = tk.StringVar(value=str(DEFAULT_KEY_DIR))
        self.keygen_prefix = tk.StringVar(value="flowpos-license")

        self._configure_style()
        self._build_shell()

    def _configure_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass

        style.configure("App.TFrame", background="#f7f8fa")
        style.configure("Card.TFrame", background="#ffffff", relief="flat")
        style.configure("SectionTitle.TLabel", background="#ffffff", foreground="#1f2937", font=("Segoe UI", 11, "bold"))
        style.configure("Muted.TLabel", background="#ffffff", foreground="#6b7280", font=("Segoe UI", 9))
        style.configure("HeroTitle.TLabel", background="#ffffff", foreground="#111827", font=("Segoe UI", 18, "bold"))
        style.configure("HeroNote.TLabel", background="#ffffff", foreground="#6b7280", font=("Segoe UI", 10))
        style.configure("Primary.TButton", font=("Segoe UI", 10, "bold"))
        style.configure("Secondary.TButton", font=("Segoe UI", 10))

    def _build_shell(self) -> None:
        root = ttk.Frame(self, style="App.TFrame", padding=18)
        root.pack(fill="both", expand=True)

        hero = ttk.Frame(root, style="Card.TFrame", padding=18)
        hero.pack(fill="x", pady=(0, 14))
        ttk.Label(hero, text="أداة سريعة لإدارة رموز التفعيل المحلية", style="HeroTitle.TLabel").pack(anchor="e")
        ttk.Label(
            hero,
            text="ولّد المفاتيح وأنشئ رموز تفعيل موقعة محليًا. الرقم التسلسلي يتولد تلقائيًا لكل رمز جديد حتى يبقى كل تجديد مستقلًا.",
            style="HeroNote.TLabel",
            wraplength=860,
            justify="right",
        ).pack(anchor="e", pady=(6, 0))
        ttk.Label(
            hero,
            text=f"مجلد الإدارة الافتراضي: {DEFAULT_KEY_DIR}",
            style="Muted.TLabel",
            wraplength=860,
            justify="right",
        ).pack(anchor="e", pady=(8, 0))

        notebook = ttk.Notebook(root)
        notebook.pack(fill="both", expand=True)

        self.issue_tab = ttk.Frame(notebook, style="App.TFrame", padding=8)
        self.keys_tab = ttk.Frame(notebook, style="App.TFrame", padding=8)
        self.inspect_tab = ttk.Frame(notebook, style="App.TFrame", padding=8)

        notebook.add(self.issue_tab, text="إصدار رمز")
        notebook.add(self.keys_tab, text="توليد مفاتيح")
        notebook.add(self.inspect_tab, text="فحص رمز")

        self._build_issue_tab()
        self._build_keys_tab()
        self._build_inspect_tab()

    def _card(self, parent: ttk.Frame, title: str, note: str | None = None) -> ttk.Frame:
        card = ttk.Frame(parent, style="Card.TFrame", padding=18)
        ttk.Label(card, text=title, style="SectionTitle.TLabel").pack(anchor="e")
        if note:
            ttk.Label(card, text=note, style="Muted.TLabel", wraplength=820, justify="right").pack(anchor="e", pady=(4, 12))
        return card

    def _copy_text(self, value: str, success_message: str) -> None:
        text = str(value or "").strip()
        if not text:
            messagebox.showwarning(APP_TITLE, "لا يوجد نص لنسخه.")
            return
        self.clipboard_clear()
        self.clipboard_append(text)
        self.update()
        messagebox.showinfo(APP_TITLE, success_message)

    def _labeled_entry(
        self,
        parent: ttk.Frame,
        label: str,
        variable: tk.StringVar,
        *,
        browse: bool = False,
        browse_command: Callable[[], None] | None = None,
        readonly: bool = False,
        buttons: list[tuple[str, Callable[[], None]]] | None = None,
    ) -> ttk.Entry:
        wrapper = ttk.Frame(parent, style="Card.TFrame")
        wrapper.pack(fill="x", pady=6)
        ttk.Label(wrapper, text=label, style="Muted.TLabel").pack(anchor="e", pady=(0, 4))
        row = ttk.Frame(wrapper, style="Card.TFrame")
        row.pack(fill="x")

        if browse:
            ttk.Button(row, text="اختيار", command=browse_command, style="Secondary.TButton").pack(side="left")
        if buttons:
            buttons_frame = ttk.Frame(row, style="Card.TFrame")
            buttons_frame.pack(side="left", padx=(6, 0))
            for label_text, command in reversed(buttons):
                ttk.Button(buttons_frame, text=label_text, command=command, style="Secondary.TButton").pack(side="left", padx=(6, 0))

        entry = ttk.Entry(row, textvariable=variable, justify="right")
        entry.pack(side="right", fill="x", expand=True, padx=(8 if (browse or buttons) else 0, 0))
        if readonly:
            entry.configure(state="readonly")
        return entry

    def _text_box(self, parent: ttk.Frame, height: int = 8) -> tk.Text:
        text = tk.Text(parent, height=height, wrap="word", font=("Consolas", 10), relief="flat", bd=0)
        text.configure(background="#f8fafc", foreground="#111827", insertbackground="#111827")
        text.pack(fill="both", expand=True)
        return text

    def _set_text(self, widget: tk.Text, value: str) -> None:
        widget.delete("1.0", "end")
        widget.insert("1.0", value)

    def _get_text(self, widget: tk.Text) -> str:
        return widget.get("1.0", "end").strip()

    def _browse_private_key(self) -> None:
        file_path = filedialog.askopenfilename(
            title="اختيار ملف المفتاح الخاص",
            filetypes=[("Base64", "*.b64"), ("Text", "*.txt"), ("All Files", "*.*")],
        )
        if file_path:
            self.private_key_file.set(file_path)

    def _browse_keygen_dir(self) -> None:
        folder = filedialog.askdirectory(title="اختيار مجلد حفظ المفاتيح")
        if folder:
            self.keygen_dir.set(folder)

    def _build_issue_tab(self) -> None:
        card = self._card(
            self.issue_tab,
            "إصدار رمز تفعيل جديد",
            "املأ بيانات المتجر والجهاز فقط. سيُولَّد license_id و sequence_number تلقائيًا عند إصدار الرمز.",
        )
        card.pack(fill="both", expand=True)

        top_grid = ttk.Frame(card, style="Card.TFrame")
        top_grid.pack(fill="x")

        left = ttk.Frame(top_grid, style="Card.TFrame")
        right = ttk.Frame(top_grid, style="Card.TFrame")
        right.pack(side="right", fill="both", expand=True, padx=(0, 10))
        left.pack(side="left", fill="both", expand=True)

        self._labeled_entry(
            right,
            "ملف المفتاح الخاص",
            self.private_key_file,
            browse=True,
            browse_command=self._browse_private_key,
            buttons=[
                ("نسخ المسار", lambda: self._copy_text(self.private_key_file.get(), "تم نسخ مسار المفتاح الخاص.")),
            ],
        )
        self._labeled_entry(
            right,
            "store_id",
            self.store_id,
            buttons=[("نسخ", lambda: self._copy_text(self.store_id.get(), "تم نسخ store_id."))],
        )
        self._labeled_entry(
            right,
            "installation_id",
            self.installation_id,
            buttons=[("نسخ", lambda: self._copy_text(self.installation_id.get(), "تم نسخ installation_id."))],
        )
        self._labeled_entry(right, "تاريخ الإصدار", self.issue_date)

        ttk.Label(left, text="نوع الاشتراك", style="Muted.TLabel").pack(anchor="e", pady=(6, 4))
        ttk.Combobox(
            left,
            textvariable=self.subscription_term,
            values=[label for label, _key in TERM_OPTIONS],
            state="readonly",
            justify="right",
        ).pack(fill="x")

        action_notice = ttk.Frame(card, style="Card.TFrame", padding=12)
        action_notice.pack(fill="x", pady=(14, 8))
        ttk.Label(action_notice, text="إجراءات الرمز", style="SectionTitle.TLabel").pack(anchor="e")
        ttk.Label(
            action_notice,
            text="إذا لم يظهر أي رمز بعد التوليد فسيظهر هنا مباشرة، ويمكنك نسخه أو حفظه إلى ملف من نفس المنطقة.",
            style="Muted.TLabel",
            wraplength=820,
            justify="right",
        ).pack(anchor="e", pady=(4, 10))

        actions = ttk.Frame(card, style="Card.TFrame")
        actions.pack(fill="x", pady=(8, 10))
        generate_button = ttk.Button(actions, text="توليد الرمز", command=self._generate_token, style="Primary.TButton")
        generate_button.pack(side="right", ipadx=16, ipady=6)
        copy_button = ttk.Button(
            actions,
            text="نسخ الرمز",
            command=lambda: self._copy_text(self._get_text(self.issue_token_text), "تم نسخ رمز التفعيل."),
            style="Secondary.TButton",
        )
        copy_button.pack(side="right", padx=8, ipadx=12, ipady=6)
        save_button = ttk.Button(actions, text="حفظ إلى ملف", command=self._save_token_to_file, style="Secondary.TButton")
        save_button.pack(side="right", ipadx=12, ipady=6)

        meta_grid = ttk.Frame(card, style="Card.TFrame")
        meta_grid.pack(fill="x", pady=(0, 8))
        self._labeled_entry(
            meta_grid,
            "license_id",
            self.license_id,
            readonly=True,
            buttons=[("نسخ", lambda: self._copy_text(self.license_id.get(), "تم نسخ license_id."))],
        )
        self._labeled_entry(
            meta_grid,
            "sequence_number",
            self.sequence_number,
            readonly=True,
            buttons=[("نسخ", lambda: self._copy_text(self.sequence_number.get(), "تم نسخ sequence_number."))],
        )

        ttk.Label(card, text="رمز التفعيل", style="Muted.TLabel").pack(anchor="e", pady=(0, 4))
        self.issue_token_text = self._text_box(card, height=5)

        actions_bottom = ttk.Frame(card, style="Card.TFrame")
        actions_bottom.pack(fill="x", pady=(8, 8))
        ttk.Button(actions_bottom, text="توليد الرمز", command=self._generate_token, style="Primary.TButton").pack(side="right", ipadx=16, ipady=6)
        ttk.Button(
            actions_bottom,
            text="نسخ الرمز",
            command=lambda: self._copy_text(self._get_text(self.issue_token_text), "تم نسخ رمز التفعيل."),
            style="Secondary.TButton",
        ).pack(side="right", padx=8, ipadx=12, ipady=6)
        ttk.Button(actions_bottom, text="حفظ إلى ملف", command=self._save_token_to_file, style="Secondary.TButton").pack(side="right", ipadx=12, ipady=6)

        ttk.Label(card, text="محتوى الرمز", style="Muted.TLabel").pack(anchor="e", pady=(12, 4))
        self.issue_payload_text = self._text_box(card, height=5)

    def _build_keys_tab(self) -> None:
        card = self._card(
            self.keys_tab,
            "توليد زوج مفاتيح التفعيل",
            "المفتاح الخاص يبقى معك فقط. المفتاح العام هو الذي يجب إضافته إلى بيئة النظام عبر FLOWPOS_LICENSE_PUBLIC_KEY_B64.",
        )
        card.pack(fill="both", expand=True)

        self._labeled_entry(card, "مجلد الحفظ", self.keygen_dir, browse=True, browse_command=self._browse_keygen_dir)
        self._labeled_entry(card, "بادئة اسم الملف", self.keygen_prefix)

        actions = ttk.Frame(card, style="Card.TFrame")
        actions.pack(fill="x", pady=(12, 12))
        ttk.Button(actions, text="توليد وحفظ", command=self._generate_keypair, style="Primary.TButton").pack(side="right")
        ttk.Button(actions, text="نسخ المفتاح العام", command=lambda: self._copy_text(self._get_text(self.public_key_text), "تم نسخ المفتاح العام."), style="Secondary.TButton").pack(side="right", padx=8)

        ttk.Label(card, text="المفتاح الخاص (احتفظ به بسرية تامة)", style="Muted.TLabel").pack(anchor="e", pady=(0, 4))
        self.private_key_text = self._text_box(card, height=6)

        ttk.Label(card, text="المفتاح العام", style="Muted.TLabel").pack(anchor="e", pady=(14, 4))
        self.public_key_text = self._text_box(card, height=6)

    def _build_inspect_tab(self) -> None:
        card = self._card(
            self.inspect_tab,
            "فحص رمز تفعيل",
            "ألصق الرمز هنا لعرض الـ payload الداخلي والتأكد من المتجر والجهاز والرقم التسلسلي قبل الإرسال.",
        )
        card.pack(fill="both", expand=True)

        ttk.Label(card, text="رمز التفعيل", style="Muted.TLabel").pack(anchor="e", pady=(0, 4))
        self.inspect_token_text = self._text_box(card, height=8)

        actions = ttk.Frame(card, style="Card.TFrame")
        actions.pack(fill="x", pady=(12, 12))
        ttk.Button(actions, text="فحص الرمز", command=self._inspect_token, style="Primary.TButton").pack(side="right")

        ttk.Label(card, text="البيانات المقروءة", style="Muted.TLabel").pack(anchor="e", pady=(0, 4))
        self.inspect_payload_text = self._text_box(card, height=12)

    def _generate_token(self) -> None:
        try:
            private_key_file = self.private_key_file.get().strip()
            private_key_b64 = ""
            if private_key_file and Path(private_key_file).exists():
                private_key_b64 = Path(private_key_file).read_text(encoding="utf-8").strip()
            package = issue_license_package(
                private_key_b64=private_key_b64 or None,
                store_id=self.store_id.get().strip(),
                installation_id=self.installation_id.get().strip(),
                subscription_term=TERM_LABEL_TO_KEY[self.subscription_term.get()],
                license_type="subscription",
                plan="commercial",
                issue_date=self.issue_date.get().strip() or None,
            )
            token = str(package.get("activation_key") or "").strip()
            if not token:
                raise ValueError("تعذر توليد رمز التفعيل.")
            payload = package.get("payload") or decode_activation_token_payload(token)
            license_id = str(package.get("license_id") or payload.get("license_id") or "").strip()
            sequence_number = str(package.get("sequence_number") or payload.get("sequence_number") or "").strip()
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        self.license_id.set(license_id)
        self.sequence_number.set(sequence_number)
        self._set_text(self.issue_token_text, token)
        self._set_text(self.issue_payload_text, json.dumps(payload, ensure_ascii=False, indent=2))
        self._set_text(self.inspect_token_text, token)
        messagebox.showinfo(APP_TITLE, "تم توليد رمز التفعيل بنجاح.")

    def _save_token_to_file(self) -> None:
        token = self._get_text(self.issue_token_text)
        if not token:
            messagebox.showwarning(APP_TITLE, "لا يوجد رمز لتخزينه بعد.")
            return
        file_path = filedialog.asksaveasfilename(
            title="حفظ رمز التفعيل",
            defaultextension=".txt",
            filetypes=[("Text", "*.txt"), ("All Files", "*.*")],
        )
        if not file_path:
            return
        Path(file_path).write_text(token, encoding="utf-8")
        messagebox.showinfo(APP_TITLE, "تم حفظ رمز التفعيل.")

    def _generate_keypair(self) -> None:
        try:
            out_dir = Path(self.keygen_dir.get().strip())
            out_dir.mkdir(parents=True, exist_ok=True)
            prefix = self.keygen_prefix.get().strip() or "flowpos-license"
            private_key_b64, public_key_b64 = generate_license_keypair_b64()
            private_path = out_dir / f"{prefix}-private.b64"
            public_path = out_dir / f"{prefix}-public.b64"
            private_path.write_text(private_key_b64, encoding="utf-8")
            public_path.write_text(public_key_b64, encoding="utf-8")
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        self.private_key_file.set(str(private_path))
        self._set_text(self.private_key_text, private_key_b64)
        self._set_text(self.public_key_text, public_key_b64)
        messagebox.showinfo(APP_TITLE, "تم توليد المفاتيح وحفظها بنجاح.")

    def _inspect_token(self) -> None:
        token = self._get_text(self.inspect_token_text)
        if not token:
            messagebox.showwarning(APP_TITLE, "ألصق رمز التفعيل أولًا.")
            return
        try:
            payload = decode_activation_token_payload(token)
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return
        self._set_text(self.inspect_payload_text, json.dumps(payload, ensure_ascii=False, indent=2))


def main() -> int:
    app = LicenseAdminDesktop()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
