const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MEMORY_VERSION = 1;
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 20;
const MAX_ENTRIES = 2_000;

class MemoryService {
  constructor({ config }) {
    this.filePath = config.memoryFile;
    this.maxEntries = normalizePositiveInteger(config.memoryMaxEntries, MAX_ENTRIES);
  }

  remember({ key = "", category = "fact", content = "", tags = [], source = "", pinned = false } = {}) {
    const normalizedContent = normalizeText(content);
    if (!normalizedContent) {
      throw new Error("Memory content must not be empty.");
    }
    const normalizedKey = normalizeKey(key);
    const state = this.load();
    const now = new Date().toISOString();
    const existingIndex = normalizedKey
      ? state.entries.findIndex((entry) => entry.key === normalizedKey)
      : -1;
    const existing = existingIndex >= 0 ? state.entries[existingIndex] : null;
    const entry = normalizeMemoryEntry({
      id: existing?.id || `mem_${crypto.randomUUID()}`,
      key: normalizedKey,
      category,
      content: normalizedContent,
      tags,
      source,
      pinned,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
    if (existingIndex >= 0) {
      state.entries.splice(existingIndex, 1, entry);
    } else {
      state.entries.push(entry);
    }
    state.entries = trimEntries(state.entries, this.maxEntries);
    this.save(state);
    return { entry, created: existingIndex < 0 };
  }

  search({ query = "", categories = [], tags = [], limit = DEFAULT_SEARCH_LIMIT } = {}) {
    const state = this.load();
    const normalizedQuery = normalizeText(query);
    const categorySet = new Set(normalizeStringList(categories).map((item) => item.toLowerCase()));
    const tagSet = new Set(normalizeStringList(tags).map((item) => item.toLowerCase()));
    const queryTokens = tokenize(normalizedQuery);
    const maxResults = Math.min(MAX_SEARCH_LIMIT, normalizePositiveInteger(limit, DEFAULT_SEARCH_LIMIT));
    const scored = [];

    for (const entry of state.entries) {
      if (categorySet.size && !categorySet.has(entry.category.toLowerCase())) {
        continue;
      }
      if (tagSet.size && !entry.tags.some((tag) => tagSet.has(tag.toLowerCase()))) {
        continue;
      }
      const score = scoreMemoryEntry(entry, normalizedQuery, queryTokens);
      if (normalizedQuery && score <= 0 && !entry.pinned) {
        continue;
      }
      scored.push({ entry, score });
    }

    scored.sort((left, right) => (
      right.score - left.score
      || Date.parse(right.entry.updatedAt) - Date.parse(left.entry.updatedAt)
      || left.entry.id.localeCompare(right.entry.id)
    ));
    return {
      query: normalizedQuery,
      entries: scored.slice(0, maxResults).map(({ entry, score }) => ({ ...entry, score })),
      total: scored.length,
    };
  }

  forget({ identifier = "" } = {}) {
    const normalizedIdentifier = normalizeText(identifier);
    if (!normalizedIdentifier) {
      throw new Error("Memory identifier must not be empty.");
    }
    const normalizedKey = normalizeKey(normalizedIdentifier);
    const state = this.load();
    const removed = state.entries.filter((entry) => (
      entry.id === normalizedIdentifier || (normalizedKey && entry.key === normalizedKey)
    ));
    if (!removed.length) {
      return { removed: [], removedCount: 0 };
    }
    const removedIds = new Set(removed.map((entry) => entry.id));
    state.entries = state.entries.filter((entry) => !removedIds.has(entry.id));
    this.save(state);
    return { removed, removedCount: removed.length };
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const entries = Array.isArray(parsed?.entries)
        ? parsed.entries.map(normalizeMemoryEntry).filter((entry) => entry.id && entry.content)
        : [];
      return { version: MEMORY_VERSION, entries: trimEntries(entries, this.maxEntries) };
    } catch {
      return { version: MEMORY_VERSION, entries: [] };
    }
  }

  save(state) {
    const normalized = {
      version: MEMORY_VERSION,
      entries: trimEntries(Array.isArray(state?.entries) ? state.entries : [], this.maxEntries),
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.filePath);
    return normalized;
  }
}

function normalizeMemoryEntry(value = {}) {
  return {
    id: normalizeText(value.id),
    key: normalizeKey(value.key),
    category: normalizeText(value.category).toLowerCase() || "fact",
    content: normalizeText(value.content).slice(0, 8_000),
    tags: normalizeStringList(value.tags).slice(0, 20),
    source: normalizeText(value.source).slice(0, 500),
    pinned: value.pinned === true,
    createdAt: normalizeIsoTime(value.createdAt) || new Date().toISOString(),
    updatedAt: normalizeIsoTime(value.updatedAt) || normalizeIsoTime(value.createdAt) || new Date().toISOString(),
  };
}

function scoreMemoryEntry(entry, query, queryTokens) {
  const haystack = [entry.key, entry.category, entry.content, ...entry.tags].join(" ").toLowerCase();
  let score = entry.pinned ? 25 : 0;
  const normalizedQuery = query.toLowerCase();
  if (normalizedQuery && haystack.includes(normalizedQuery)) {
    score += 40;
  }
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += token.length >= 3 ? 4 : 2;
    }
  }
  if (/回复|怎么回|如何回|风格|语气|措辞/u.test(query) && entry.category === "style") {
    score += 30;
  }
  if (/提醒|主动|唤醒|check.?in/iu.test(query) && entry.tags.some((tag) => /主动|提醒|check.?in/iu.test(tag))) {
    score += 20;
  }
  return score;
}

function tokenize(value) {
  const normalized = normalizeText(value).toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9_@.-]{2,}|[\p{Script=Han}]{2,}/gu) || []);
  for (const segment of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.add(segment.slice(index, index + 2));
    }
  }
  return [...tokens];
}

function trimEntries(entries, maxEntries) {
  const normalized = entries.map(normalizeMemoryEntry).filter((entry) => entry.id && entry.content);
  if (normalized.length <= maxEntries) {
    return normalized;
  }
  const pinned = normalized.filter((entry) => entry.pinned);
  const ordinary = normalized
    .filter((entry) => !entry.pinned)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return [...pinned, ...ordinary].slice(0, maxEntries);
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(normalizeText).filter(Boolean))];
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9\p{Script=Han}_.:-]+/gu, "_").slice(0, 160);
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeIsoTime(value) {
  const text = normalizeText(value);
  const parsed = Date.parse(text);
  return text && Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  MemoryService,
  scoreMemoryEntry,
  tokenize,
};
