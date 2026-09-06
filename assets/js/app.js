/**
 * Удостоверение личности — логика экрана (вёрстка копирует ultra-kas.vercel.app).
 *
 * Всё локально: файл читается в браузере, документ и реквизиты лежат
 * в localStorage этого устройства (ключи как в референсе: uploadedImage,
 * bioData). Сервера и базы нет.
 *
 * Загрузить можно PDF или картинку. PDF рисуется через pdf.js в одну
 * картинку в высоком разрешении, а из его текстового слоя автоматически
 * заполняются реквизиты. Все поля реквизитов остаются редактируемыми:
 * распознанное можно поправить руками, правки сохраняются сразу.
 */

import { parseDocument } from "./parser.js";

/* ---------- настройки ---------- */

const PDFJS_VERSION = "6.3.289";
const PDFJS_BASES = [
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`,
  `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`
];
const QR_SOURCES = [
  "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm",
  "https://esm.sh/qrcode@1.5.4"
];
const MAX_SIZE = 25 * 1024 * 1024;

/* качество отрисовки PDF: чем больше, тем чётче при увеличении */
const RENDER_MAX_WIDTH = 3000;
const RENDER_MAX_SCALE = 4;
const RENDER_MAX_AREA = 16e6; // предел площади холста на мобильных браузерах

/* пределы зума: меньше 1 — «резинка», больше 1 — остаётся как поставили */
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 6;

const LS = { image: "uploadedImage", bio: "bioData", saved: "isSaved" };

/** Поля экрана «Реквизиты»: id в разметке → ключ парсера → ключ в bioData. */
const FIELDS = [
  { id: "f-fio", parsed: "fio", bio: "fio", label: "ФИО" },
  { id: "f-iin", parsed: "iin", bio: "iin", label: "ИИН" },
  { id: "f-birth", parsed: "birthDate", bio: "birth", label: "Дата рождения" },
  { id: "f-docnum", parsed: "docNumber", bio: "docnum", label: "Номер документа" },
  { id: "f-viddata", parsed: "issueDate", bio: "viddata", label: "Дата выдачи" },
  { id: "f-expdata", parsed: "expiryDate", bio: "expdata", label: "Срок действия" }
];

/* ---------- состояние ---------- */

const state = {
  imageDataUrl: "",
  savedBio: {},                    // последнее сохранённое состояние реквизитов
  view: { scale: 1, x: 0, y: 0 }
};

let pdfjsLib = null;
let qrLib = null;

/* ---------- DOM ---------- */

const $ = (id) => document.getElementById(id);

const el = {
  tabDoc: $("tab-btn-1"),
  tabReq: $("tab-btn-2"),
  docPanel: $("doc-panel"),
  reqPanel: $("req"),
  docbtn: $("docbtn"),
  reqbtn: $("reqbtn"),
  imgUpload: $("imgUpload"),
  fileInput: $("idupload"),
  documentBox: $("document"),
  docImage: $("docImage"),
  docLoader: $("docLoader"),
  btnBack: $("btnBack"),
  btnSave: $("btnSave"),
  saveRow: $("saveRow"),
  btnPresent: $("btnftr1"),
  btnSendDoc: $("btnftr2"),
  btnSendReq: $("btnftr3"),
  popup: $("popup"),
  popupContent: $("popupContent"),
  popupNum: $("popupNum"),
  popupClose: $("popupClose"),
  qrBox: $("qrBox"),
  qrCanvas: $("qrCanvas"),
  toast: $("toast")
};

/* ---------- утилиты ---------- */

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add("is-shown"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove("is-shown");
    setTimeout(() => { el.toast.hidden = true; }, 200);
  }, 2600);
}

function readBio() {
  try {
    return JSON.parse(localStorage.getItem(LS.bio) || "{}") || {};
  } catch {
    return {};
  }
}

function currentBio() {
  const bio = {};
  for (const field of FIELDS) bio[field.bio] = ($(field.id).value || "").trim();
  return bio;
}

/** Сохраняет реквизиты и убирает кнопку «Сохранить». */
function writeBio() {
  state.savedBio = currentBio();
  try {
    localStorage.setItem(LS.bio, JSON.stringify(state.savedBio));
  } catch {
    /* localStorage может быть недоступен — тогда данные живут до перезагрузки */
  }
  updateSaveButton();
}

/** Кнопка «Сохранить» видна, только пока есть несохранённые правки. */
function updateSaveButton() {
  const current = currentBio();
  const unchanged = FIELDS.every((field) => current[field.bio] === (state.savedBio[field.bio] || ""));
  el.saveRow.hidden = unchanged;
}

/* ---------- библиотеки с CDN ---------- */

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  let lastError = null;
  for (const base of PDFJS_BASES) {
    try {
      const lib = await import(/* @vite-ignore */ `${base}pdf.min.mjs`);
      lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
      pdfjsLib = lib;
      return lib;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`PDF не открыть: нет доступа к движку просмотра (${lastError?.message || "нет сети"})`);
}

async function loadQr() {
  if (qrLib) return qrLib;
  for (const source of QR_SOURCES) {
    try {
      const mod = await import(/* @vite-ignore */ source);
      const lib = mod.default || mod;
      if (lib && typeof lib.toCanvas === "function") {
        qrLib = lib;
        return lib;
      }
    } catch {
      /* следующий источник */
    }
  }
  return null;
}

/* ---------- вкладки ---------- */

function showTab(name) {
  const isReq = name === "req";
  el.docPanel.hidden = isReq;
  el.reqPanel.hidden = !isReq;
  el.docbtn.hidden = isReq;
  el.reqbtn.hidden = !isReq;
}

/* ---------- загрузка файла ---------- */

function validateFile(file) {
  if (!file) return "Файл не выбран";
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImage = file.type.startsWith("image/");
  if (!isPdf && !isImage) return "Нужен PDF или картинка";
  if (!file.size) return "Файл пустой";
  if (file.size > MAX_SIZE) return `Файл больше 25 МБ (${(file.size / 1048576).toFixed(1)} МБ)`;
  return "";
}

async function handleFile(file) {
  const problem = validateFile(file);
  if (problem) { toast(problem); return; }

  el.imgUpload.hidden = true;
  el.documentBox.hidden = true;
  el.docLoader.hidden = false;

  try {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf) {
      const { dataUrl, canvas, lines } = await renderPdf(file);
      setDocumentImage(dataUrl, { canvas });
      fillFields(parseDocument(lines));
    } else {
      const dataUrl = await readAsDataUrl(file);
      setDocumentImage(dataUrl);
      toast("Картинка загружена. Реквизиты впишите вручную");
    }
  } catch (err) {
    console.error(err);
    el.docLoader.hidden = true;
    el.imgUpload.hidden = false;
    toast(err?.name === "PasswordException" ? "PDF защищён паролем" : (err?.message || "Не удалось открыть файл"));
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Файл не читается"));
    reader.readAsDataURL(file);
  });
}

/**
 * Рисует все страницы PDF в одну картинку в высоком разрешении
 * (до 3000 px по ширине) и отдаёт её текстовый слой.
 * Площадь холста ограничена, иначе на iPhone холст такого размера пустой.
 */
async function renderPdf(file) {
  const lib = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await openPdf(lib, buffer);

  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    pages.push(await pdf.getPage(number));
  }

  const bases = pages.map((page) => page.getViewport({ scale: 1 }));
  const baseWidth = Math.max(...bases.map((viewport) => viewport.width));
  const baseHeight = bases.reduce((sum, viewport) => sum + viewport.height, 0);

  let scale = Math.min(RENDER_MAX_SCALE, RENDER_MAX_WIDTH / baseWidth);
  const area = baseWidth * scale * baseHeight * scale;
  if (area > RENDER_MAX_AREA) scale *= Math.sqrt(RENDER_MAX_AREA / area);

  const gap = pages.length > 1 ? Math.round(10 * scale) : 0;
  const sheet = document.createElement("canvas");
  sheet.width = Math.max(1, Math.floor(baseWidth * scale));
  sheet.height = Math.max(1, Math.floor(baseHeight * scale) + gap * (pages.length - 1));

  const context = sheet.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, sheet.width, sheet.height);

  let offset = 0;
  for (const page of pages) {
    const viewport = page.getViewport({ scale });
    await page.render({
      canvas: sheet,
      viewport,
      background: "rgba(0,0,0,0)", // не затирать уже нарисованные страницы
      transform: [1, 0, 0, 1, Math.round((sheet.width - viewport.width) / 2), offset]
    }).promise;
    offset += viewport.height + gap;
  }

  return { dataUrl: encodeCanvas(sheet, 0.95), canvas: sheet, lines: await extractLines(pdf) };
}

/** WebP держит текст чётче при том же весе; если браузер не умеет — JPEG. */
function encodeCanvas(canvas, quality) {
  const webp = canvas.toDataURL("image/webp", quality);
  if (webp.startsWith("data:image/webp")) return webp;
  return canvas.toDataURL("image/jpeg", quality);
}

/** Открытие PDF; если защищён паролем — спрашиваем (до 3 попыток). */
async function openPdf(lib, buffer, password = undefined, attempt = 0) {
  try {
    return await lib.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      password,
      isEvalSupported: false,
      cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`
    }).promise;
  } catch (err) {
    if (err?.name === "PasswordException" && attempt < 3) {
      const entered = window.prompt(attempt === 0
        ? "PDF защищён паролем. Введите пароль:"
        : "Пароль не подошёл. Попробуйте ещё раз:");
      if (entered === null) throw new Error("Нужен пароль PDF");
      return openPdf(lib, buffer, entered, attempt + 1);
    }
    throw err;
  }
}

/** Текстовый слой PDF, собранный обратно в строки. */
async function extractLines(pdf) {
  const lines = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const rows = new Map();

    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = item.transform?.[5] ?? 0;
      const x = item.transform?.[4] ?? 0;
      const key = Math.round(y / 4);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ x, str: item.str });
    }

    for (const key of [...rows.keys()].sort((a, b) => b - a)) {
      const row = rows.get(key)
        .sort((a, b) => a.x - b.x)
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (row) lines.push(row);
    }
  }
  return lines;
}

/* ---------- показ документа ---------- */

function setDocumentImage(dataUrl, options = {}) {
  const { fromStorage = false, canvas = null } = options;
  state.imageDataUrl = dataUrl;
  el.docImage.src = dataUrl;
  el.docLoader.hidden = true;
  el.imgUpload.hidden = true;
  el.documentBox.hidden = false;
  resetView(false);

  if (fromStorage) return;
  if (!persistImage(dataUrl, canvas)) {
    toast("Документ открыт, но не сохранён: не хватает места в браузере");
  }
}

/**
 * Кладёт документ в localStorage. Если картинка не влезла — пробует
 * пожать сильнее, чтобы качество терялось только при нехватке места.
 */
function persistImage(dataUrl, canvas) {
  try {
    localStorage.removeItem(LS.image); // освобождаем место под новый документ
  } catch { /* localStorage недоступен */ }

  const attempts = [dataUrl];
  if (canvas) attempts.push(encodeCanvas(canvas, 0.8), encodeCanvas(canvas, 0.6));

  for (const candidate of attempts) {
    try {
      localStorage.setItem(LS.image, candidate);
      return true;
    } catch {
      /* пробуем вариант поменьше */
    }
  }
  return false;
}

function clearDocument() {
  state.imageDataUrl = "";
  el.docImage.removeAttribute("src");
  el.documentBox.hidden = true;
  el.imgUpload.hidden = false;
  el.fileInput.value = "";
  try {
    localStorage.removeItem(LS.image);
    localStorage.removeItem(LS.bio);
    localStorage.removeItem(LS.saved);
  } catch { /* нечего чистить */ }

  for (const field of FIELDS) $(field.id).value = "";
  state.savedBio = currentBio();
  updateSaveButton();
  showTab("doc");
  el.tabDoc.checked = true;
}

/* ---------- реквизиты ---------- */

/**
 * Подставляет распознанное из PDF. Поля остаются обычными полями ввода:
 * что угодно можно поправить руками, изменения сразу сохраняются локально.
 */
function fillFields(parsed) {
  const values = parsed.fields || {};
  let filled = 0;

  for (const field of FIELDS) {
    const value = values[field.parsed] || "";
    if (!value) continue;
    $(field.id).value = value;
    filled += 1;
  }
  writeBio();

  if (!parsed.hasText) toast("В PDF нет текстового слоя — впишите реквизиты вручную");
  else if (filled < FIELDS.length) toast(`Распознано ${filled} из ${FIELDS.length} реквизитов, остальное впишите вручную`);
  else toast("Реквизиты распознаны — можно поправить вручную");
}

function copyField(inputId) {
  const input = $(inputId);
  const text = (input.value || "").trim();
  if (!text) { toast("Пусто — нечего копировать"); return; }

  input.focus();
  input.select();
  input.setSelectionRange(0, text.length);

  let done = false;
  try {
    done = document.execCommand("copy");
  } catch {
    done = false;
  }
  input.blur();

  if (done) { toast("Скопировано"); return; }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast("Скопировано"), () => toast("Не удалось скопировать"));
  } else {
    toast("Не удалось скопировать");
  }
}

function summaryText() {
  const bio = currentBio();
  return [
    "Удостоверение личности:",
    ...FIELDS.map((field) => `${field.label}: ${bio[field.bio] || "—"}`)
  ].join("\n");
}

/* ---------- отправка ---------- */

async function sendDocument() {
  const dataUrl = state.imageDataUrl || localStorage.getItem(LS.image) || "";
  if (!dataUrl) { toast("Сначала загрузите документ"); return; }

  const blob = await (await fetch(dataUrl)).blob();
  const isPng = blob.type === "image/png";
  const file = new File([blob], isPng ? "document.png" : "document.jpg", { type: blob.type || "image/jpeg" });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title: "Удостоверение личности", text: summaryText(), files: [file] });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Документ сохранён в загрузки");
}

async function sendRequisites() {
  const text = summaryText();
  if (navigator.share) {
    try {
      await navigator.share({ title: "Поделиться реквизитами", text });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Реквизиты скопированы");
      return;
    } catch { /* ниже покажем ошибку */ }
  }
  toast("Не удалось отправить реквизиты");
}

/* ---------- предъявление документа ---------- */

async function openPopup() {
  el.popup.hidden = false;
  el.popupNum.textContent = String(Math.floor(1e5 + 9e5 * Math.random()));

  let value = "";
  try {
    value = btoa(encodeURIComponent(JSON.stringify(currentBio())));
  } catch {
    value = "";
  }

  const lib = await loadQr();
  if (!lib || !value) {
    el.qrBox.innerHTML = '<p class="popup-text">Нет реквизитов для генерации QR-кода</p>';
    return;
  }
  if (!el.qrBox.contains(el.qrCanvas)) {
    el.qrBox.innerHTML = "";
    el.qrBox.appendChild(el.qrCanvas);
  }
  try {
    await lib.toCanvas(el.qrCanvas, value, { width: 200, margin: 1 });
  } catch {
    el.qrBox.innerHTML = '<p class="popup-text">QR-код не сформирован</p>';
  }
}

function closePopup() {
  el.popup.hidden = true;
}

/* ---------- зум документа ----------
 * Документ стоит по ширине экрана.
 * Уменьшили (пальцами или Ctrl+колесо) — отпустили, и он плавно
 * возвращается на место. Увеличили — остаётся, пока сами не уменьшите.
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const view = state.view;

function applyView(animate = false) {
  if (animate) {
    el.docImage.classList.remove("is-live");
    void el.docImage.offsetWidth; // сброс стиля, чтобы плавный возврат точно сработал
  } else {
    el.docImage.classList.add("is-live");
  }
  el.docImage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  el.documentBox.classList.toggle("is-zoomed", view.scale > 1.001);
}

function resetView(animate = true) {
  view.scale = 1;
  view.x = 0;
  view.y = 0;
  applyView(animate);
}

/** Не даём увеличенному документу уехать за пределы видимой области. */
function clampPan() {
  const box = el.documentBox.getBoundingClientRect();
  const width = el.docImage.offsetWidth * view.scale;
  const height = el.docImage.offsetHeight * view.scale;
  const maxX = Math.max(0, (width - box.width) / 2);
  const maxY = Math.max(0, (height - box.height) / 2);
  view.x = clamp(view.x, -maxX, maxX);
  view.y = clamp(view.y, -maxY, maxY);
}

/** Вызывается, когда жест закончился. */
function settleView() {
  if (view.scale <= 1.001) {
    resetView(true);           // меньше исходного — возвращаем плавно
    return;
  }
  clampPan();                  // больше исходного — оставляем как есть
  applyView(true);
}

const pointers = new Map();
let pinch = null;

el.documentBox.addEventListener("pointerdown", (event) => {
  if (el.documentBox.hidden) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: view.scale };
  }

  el.documentBox.setPointerCapture(event.pointerId);
  if (view.scale > 1.001) el.documentBox.classList.add("is-dragging");
  el.docImage.classList.add("is-live");
});

el.documentBox.addEventListener("pointermove", (event) => {
  const previous = pointers.get(event.pointerId);
  if (!previous) return;
  const next = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, next);

  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    view.scale = clamp(pinch.scale * (distance / pinch.distance), ZOOM_MIN, ZOOM_MAX);
  } else if (view.scale > 1.001) {
    view.x += next.x - previous.x;
    view.y += next.y - previous.y;
  } else if (event.pointerType === "touch") {
    // документ не увеличен: палец прокручивает страницу, как обычно
    window.scrollBy(0, previous.y - next.y);
    return;
  } else {
    return;
  }
  applyView(false);
});

["pointerup", "pointercancel"].forEach((type) => {
  el.documentBox.addEventListener(type, (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      el.documentBox.classList.remove("is-dragging");
      settleView();
    }
  });
});

/* Колесо: Ctrl+колесо (или тачпад-пинч) масштабирует всегда,
   обычное колесо — только когда документ уже увеличен, чтобы не ломать скролл. */
let wheelTimer = null;
el.documentBox.addEventListener("wheel", (event) => {
  if (el.documentBox.hidden) return;
  const zoomGesture = event.ctrlKey || view.scale > 1.001;
  if (!zoomGesture) return;

  event.preventDefault();
  el.docImage.classList.add("is-live");
  const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025));
  view.scale = clamp(view.scale * factor, ZOOM_MIN, ZOOM_MAX);
  applyView(false);

  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(settleView, 260);
}, { passive: false });

el.documentBox.addEventListener("dblclick", () => {
  if (view.scale > 1.001) resetView(true);
  else { view.scale = 2; applyView(true); }
});

/* ---------- события ---------- */

el.fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) handleFile(file);
});

el.tabDoc.addEventListener("change", () => showTab("doc"));
el.tabReq.addEventListener("change", () => showTab("req"));

el.btnBack.addEventListener("click", () => {
  window.location.href = "https://kaspi.kz/";
});

for (const field of FIELDS) {
  // правки не сохраняются сами: появляется кнопка «Сохранить»
  $(field.id).addEventListener("input", updateSaveButton);
}

document.querySelectorAll("[data-copy]").forEach((icon) => {
  icon.addEventListener("click", () => copyField(icon.dataset.copy));
});

el.btnSave.addEventListener("click", () => {
  writeBio();
  toast("Реквизиты сохранены");
});

el.btnPresent.addEventListener("click", openPopup);
el.btnSendDoc.addEventListener("click", () => sendDocument().catch((err) => {
  console.error(err);
  toast("Не удалось отправить документ");
}));
el.btnSendReq.addEventListener("click", sendRequisites);

el.popupClose.addEventListener("click", closePopup);
el.popup.addEventListener("click", closePopup);
el.popupContent.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.popup.hidden) closePopup();
});

/* перетаскивание файла в окно */
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

/* ---------- восстановление из localStorage ---------- */

(function start() {
  const bio = readBio();
  for (const field of FIELDS) {
    if (bio[field.bio]) $(field.id).value = bio[field.bio];
  }
  state.savedBio = currentBio();
  updateSaveButton();
  const saved = localStorage.getItem(LS.image);
  if (saved) setDocumentImage(saved, { fromStorage: true });

  showTab(el.tabReq.checked ? "req" : "doc");
})();
