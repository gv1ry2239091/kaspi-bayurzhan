/**
 * Разбор реквизитов удостоверения личности РК из текстового слоя PDF.
 * Подписи полей двуязычные («ТЕГІ / ФАМИЛИЯ»), значение стоит либо в той же
 * строке, либо под ней. Запасные варианты: ИИН (в нём зашиты дата рождения
 * и пол), диапазон «дата выдачи - срок действия», MRZ-строка.
 */

const DATE_RE = /(\d{2})[.\-/](\d{2})[.\-/](\d{4})/;
const DATE_RE_G = /(\d{2})[.\-/](\d{2})[.\-/](\d{4})/g;
const NAME_CHARS = "A-Za-zА-ЯЁа-яёӘҒҚҢӨҰҮҺІәғқңөұүһі";
const NAME_RE = new RegExp(`[${NAME_CHARS}][${NAME_CHARS}'\\-]+`, "g");

/**
 * Подпись поля с «границами слова», которые работают и для кириллицы:
 * \b в JS считает буквой только латиницу, поэтому используем \p{L}.
 * Ведущий символ входит в совпадение — это учтено при вырезании остатка строки.
 */
const L = (source) => new RegExp(`(?:^|[^\\p{L}])(?:${source})(?![\\p{L}])`, "iu");

const LABELS = {
  fio: [L("ф\\.?\\s?и\\.?\\s?о\\.?"), L("аты[-\\s]?ж[өo]н[іi]"), L("full\\s*name")],
  surname: [L("тег[іi]"), L("фамилия"), L("surname")],
  given: [L("аты"), L("имя"), L("given\\s*names?")],
  patronymic: [L("[әa]кес[іi]н[іi]ң\\s*аты"), L("отчество"), L("patronymic")],
  iin: [L("жсн"), L("иин"), L("iin")],
  birthDate: [L("туған\\s*к[үy]н[іi]?"), L("дата\\s*рождения"), L("date\\s*of\\s*birth")],
  docNumber: [L("номер\\s*документа"), L("құжат(?:тың)?\\s*н[өo]м[іi]р[іi]?"), L("document\\s*(?:number|no)")],
  issueDate: [L("дата\\s*выдачи"), L("бер[іi]лген\\s*к[үy]н[іi]?"), L("date\\s*of\\s*issue")],
  expiryDate: [L("срок\\s*действия"), L("жарамдылық"), L("қолдану\\s*мерз[іi]м[іi]"), L("date\\s*of\\s*expiry"), L("действителен\\s*до")],
  birthPlace: [L("место\\s*рождения"), L("туған\\s*жер[іi]?"), L("place\\s*of\\s*birth")],
  nationality: [L("национальность"), L("ұлты")],
  citizenship: [L("гражданство"), L("азаматтығы"), L("nationality")],
  sex: [L("пол"), L("жынысы"), L("sex")],
  authority: [L("орган\\s*выдачи"), L("берген\\s*орган"), L("authority")]
};

const ALL_LABELS = Object.values(LABELS).flat();
const ALL_LABELS_G = ALL_LABELS.map((re) => new RegExp(re.source, "giu"));

function cleanLine(line) {
  return String(line)
    .replace(/\u00a0/g, " ")
    .replace(/[«»„“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLines(lines) {
  return lines.map(cleanLine).filter((line) => line.length > 0);
}

/** Убирает из строки подписи полей, оставляя только возможное значение. */
function stripLabels(text) {
  let out = String(text);
  for (const re of ALL_LABELS_G) {
    re.lastIndex = 0;
    out = out.replace(re, " ");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function matchLabel(line, patterns) {
  for (const re of patterns) {
    const m = String(line).match(re);
    if (m) return { index: m.index, length: m[0].length };
  }
  return null;
}

/** Ищет значение поля: сначала в остатке строки с подписью, затем ниже. */
function valueFor(lines, patterns, extract, options = {}) {
  const { lookahead = 2, exclude = [] } = options;
  for (let i = 0; i < lines.length; i += 1) {
    if (exclude.length && matchLabel(lines[i], exclude)) continue;
    const hit = matchLabel(lines[i], patterns);
    if (!hit) continue;

    const tail = stripLabels(lines[i].slice(hit.index + hit.length));
    const fromTail = extract(tail);
    if (fromTail) return fromTail;

    for (let j = 1; j <= lookahead && i + j < lines.length; j += 1) {
      const cleaned = stripLabels(lines[i + j]);
      if (!cleaned) continue;
      const value = extract(cleaned);
      if (value) return value;
    }
  }
  return "";
}

/* ---------- экстракторы ---------- */

/** Число ровно из `count` цифр, не приклеенное к другим цифрам. */
function matchDigits(text, count) {
  const re = new RegExp(`(?:^|\\D)(\\d{${count}})(?:\\D|$)`);
  const m = String(text).match(re);
  return m ? m[1] : "";
}

const extractDate = (s) => {
  const m = String(s).match(DATE_RE);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : "";
};

const extractIin = (s) => {
  const text = String(s);
  const direct = matchDigits(text, 12);
  if (direct) return direct;
  // ИИН иногда разбит пробелами: 070 322 550 835
  return matchDigits(text.replace(/(\d) (?=\d)/g, "$1"), 12);
};

const extractDocNumber = (s) => matchDigits(s, 9);

const extractName = (s, limit = 4) => {
  const text = String(s);
  if (DATE_RE.test(text) || /\d{4,}/.test(text)) return "";
  const words = (text.match(NAME_RE) || []).filter((word) => word.length > 1);
  return words.length ? titleCase(words.slice(0, limit).join(" ")) : "";
};

const extractWord = (s) => extractName(s, 3);

const extractSex = (s) => {
  const m = String(s).match(/(?:^|[^\p{L}])([МЖMF])(?![\p{L}])/iu);
  if (!m) return "";
  const value = m[1].toUpperCase();
  if (value === "F") return "Ж";
  if (value === "M") return "М";
  return value;
};

export function titleCase(str) {
  return String(str)
    .toLocaleLowerCase("ru-RU")
    .split(/(\s|-)/)
    .map((part) => (/^[\s-]$/.test(part) || !part
      ? part
      : part[0].toLocaleUpperCase("ru-RU") + part.slice(1)))
    .join("");
}

/* ---------- ИИН ---------- */

const IIN_W1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const IIN_W2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];

function weightedSum(digits, weights) {
  return digits.reduce((acc, digit, index) => acc + digit * weights[index], 0);
}

/**
 * Проверка ИИН РК и данные из него.
 * Структура: ГГММДД + век/пол + 4 цифры + контрольный разряд.
 */
export function parseIin(iin) {
  const result = { value: "", checksumOk: false, birthDate: "", sex: "", errors: [] };
  const raw = String(iin || "").replace(/\D/g, "");
  if (raw.length !== 12) {
    if (raw.length) result.errors.push("ИИН должен содержать 12 цифр");
    return result;
  }
  result.value = raw;

  const digits = raw.split("").map(Number);
  let rest = weightedSum(digits.slice(0, 11), IIN_W1) % 11;
  if (rest === 10) rest = weightedSum(digits.slice(0, 11), IIN_W2) % 11;
  result.checksumOk = rest !== 10 && rest === digits[11];
  if (!result.checksumOk) result.errors.push("контрольный разряд ИИН не сходится");

  const yy = raw.slice(0, 2);
  const mm = raw.slice(2, 4);
  const dd = raw.slice(4, 6);
  const centuries = { 1: 1800, 2: 1800, 3: 1900, 4: 1900, 5: 2000, 6: 2000 };
  const century = centuries[digits[6]];

  if (century) {
    const year = century + Number(yy);
    const month = Number(mm);
    const day = Number(dd);
    const date = new Date(Date.UTC(year, month - 1, day));
    const valid = month >= 1 && month <= 12
      && date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
    if (valid) result.birthDate = `${dd}.${mm}.${year}`;
    else result.errors.push("дата рождения в ИИН некорректна");
    result.sex = digits[6] % 2 === 1 ? "М" : "Ж";
  } else {
    result.errors.push("7-я цифра ИИН вне диапазона 1–6");
  }

  return result;
}

/* ---------- даты ---------- */

export function toDate(value) {
  const m = String(value || "").match(DATE_RE);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (date.getUTCDate() !== Number(dd) || date.getUTCMonth() !== Number(mm) - 1) return null;
  return date;
}

function allDates(lines) {
  const found = [];
  for (const line of lines) {
    for (const m of line.matchAll(DATE_RE_G)) {
      const value = `${m[1]}.${m[2]}.${m[3]}`;
      if (!found.includes(value)) found.push(value);
    }
  }
  return found;
}

/** Диапазон «30.07.2026 - 29.07.2036» → выдача и срок действия. */
function findDateRange(lines) {
  const re = /(\d{2}[.\-/]\d{2}[.\-/]\d{4})\s*[–—-]{1,2}\s*(\d{2}[.\-/]\d{2}[.\-/]\d{4})/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) return { from: m[1].replace(/[-/]/g, "."), to: m[2].replace(/[-/]/g, ".") };
  }
  return null;
}

/* ---------- MRZ ---------- */

/** Строка вида KOSBAYEV<<YERZHAN<<< */
function parseMrzName(lines) {
  for (const line of lines) {
    if (!line.includes("<<")) continue;
    const m = line.replace(/\s/g, "").match(/([A-Z]{2,})<<([A-Z]{2,})(?:<([A-Z]{2,}))?/);
    if (m) {
      return {
        surname: titleCase(m[1]),
        given: titleCase(m[2]),
        patronymic: m[3] ? titleCase(m[3]) : ""
      };
    }
  }
  return null;
}

/* ---------- поля экрана «Реквизиты» ---------- */

export const FIELD_ORDER = [
  { key: "fio", label: "ФИО" },
  { key: "iin", label: "ИИН" },
  { key: "birthDate", label: "Дата рождения" },
  { key: "docNumber", label: "Номер документа" },
  { key: "issueDate", label: "Дата выдачи" },
  { key: "expiryDate", label: "Срок действия" }
];

/**
 * @param {string[]} rawLines строки текстового слоя PDF
 * @returns {{fields: Object, notes: string[], validity: Object, hasText: boolean}}
 */
export function parseDocument(rawLines) {
  const lines = normalizeLines(rawLines || []);
  const notes = [];
  const hasText = lines.join("").replace(/[\s<]/g, "").length >= 10;

  const fields = {
    fio: "",
    iin: "",
    birthDate: "",
    docNumber: "",
    issueDate: "",
    expiryDate: "",
    sex: "",
    nationality: "",
    citizenship: "",
    birthPlace: "",
    authority: ""
  };

  if (!hasText) {
    notes.push("В PDF нет текстового слоя — реквизиты не распознаны.");
    return { fields, notes, validity: buildValidity(fields), hasText };
  }

  /* ФИО */
  const surname = valueFor(lines, LABELS.surname, (s) => extractName(s, 1));
  const given = valueFor(lines, LABELS.given, (s) => extractName(s, 1), {
    exclude: [...LABELS.patronymic, ...LABELS.fio]
  });
  const patronymic = valueFor(lines, LABELS.patronymic, (s) => extractName(s, 1));

  if (surname || given) {
    fields.fio = [surname, given, patronymic].filter(Boolean).join(" ");
  } else {
    fields.fio = valueFor(lines, LABELS.fio, (s) => extractName(s, 4));
  }
  if (!fields.fio) {
    const mrz = parseMrzName(lines);
    if (mrz) {
      fields.fio = [mrz.surname, mrz.given, mrz.patronymic].filter(Boolean).join(" ");
      notes.push("ФИО прочитано из машиночитаемой зоны (латиницей).");
    }
  }

  /* ИИН */
  fields.iin = valueFor(lines, LABELS.iin, extractIin);
  if (!fields.iin) {
    for (const line of lines) {
      const candidate = extractIin(line);
      if (candidate) { fields.iin = candidate; break; }
    }
  }
  const iinInfo = parseIin(fields.iin);

  /* Номер документа */
  fields.docNumber = valueFor(lines, LABELS.docNumber, extractDocNumber);
  if (!fields.docNumber) {
    for (const line of lines) {
      const withoutIin = fields.iin ? line.split(fields.iin).join(" ") : line;
      const candidate = extractDocNumber(withoutIin);
      if (candidate) { fields.docNumber = candidate; break; }
    }
  }

  /* Даты */
  fields.birthDate = valueFor(lines, LABELS.birthDate, extractDate) || iinInfo.birthDate;
  fields.issueDate = valueFor(lines, LABELS.issueDate, extractDate);
  fields.expiryDate = valueFor(lines, LABELS.expiryDate, extractDate);

  const range = findDateRange(lines);
  if (range) {
    if (!fields.issueDate) fields.issueDate = range.from;
    if (!fields.expiryDate || fields.expiryDate === range.from) fields.expiryDate = range.to;
  }

  if (!fields.issueDate || !fields.expiryDate) {
    const rest = allDates(lines)
      .filter((date) => date !== fields.birthDate)
      .sort((a, b) => {
        const aTime = toDate(a) ? toDate(a).getTime() : 0;
        const bTime = toDate(b) ? toDate(b).getTime() : 0;
        return aTime - bTime;
      });
    if (!fields.issueDate && rest.length) fields.issueDate = rest[0];
    if (!fields.expiryDate && rest.length > 1) fields.expiryDate = rest[rest.length - 1];
  }

  /* Дополнительные поля (в интерфейсе не показываются, идут в отправку) */
  fields.sex = valueFor(lines, LABELS.sex, extractSex) || iinInfo.sex;
  fields.nationality = valueFor(lines, LABELS.nationality, extractWord);
  fields.citizenship = valueFor(lines, LABELS.citizenship, extractWord);
  fields.birthPlace = valueFor(lines, LABELS.birthPlace, extractWord);
  fields.authority = valueFor(lines, LABELS.authority, (s) => {
    const m = String(s).match(/(МВД|ІІМ)\s*(РК|ҚР)?/i);
    return m ? m[0].toUpperCase().replace(/\s+/g, " ").trim() : extractWord(s);
  });

  const missing = FIELD_ORDER.filter((field) => !fields[field.key]).map((field) => field.label);
  if (missing.length) notes.push(`Не распознано: ${missing.join(", ")}.`);
  if (fields.iin && !iinInfo.checksumOk) notes.push("ИИН не проходит проверку контрольного разряда.");
  if (fields.iin && iinInfo.birthDate && fields.birthDate && iinInfo.birthDate !== fields.birthDate) {
    notes.push(`Дата рождения (${fields.birthDate}) не совпадает с датой в ИИН (${iinInfo.birthDate}).`);
  }

  return { fields, notes, validity: buildValidity(fields, iinInfo), hasText };
}

/**
 * Служебная проверка: срок действия и корректность ИИН.
 * В интерфейсе не показывается, но пригодится для проверки сотрудника.
 */
export function buildValidity(fields, iinInfo = null) {
  const info = iinInfo || parseIin(fields.iin);
  const expiry = toDate(fields.expiryDate);
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());

  let state = "ok";
  let text = "Документ действителен";
  let daysLeft = null;

  if (!expiry) {
    state = "warn";
    text = "Срок действия не распознан";
  } else {
    daysLeft = Math.round((expiry.getTime() - todayUtc) / 86400000);
    if (daysLeft < 0) {
      state = "err";
      text = `Срок действия истёк ${fields.expiryDate}`;
    } else if (daysLeft <= 60) {
      state = "warn";
      text = `Действителен до ${fields.expiryDate} — осталось ${daysLeft} дн.`;
    } else {
      text = `Действителен до ${fields.expiryDate}`;
    }
  }

  if (fields.iin && !info.checksumOk && state !== "err") {
    state = "warn";
    text += " · ИИН требует проверки";
  }

  return { state, text, iin: info, daysLeft };
}
