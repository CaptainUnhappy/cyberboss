const fs = require("fs");
const path = require("path");

// Keep ordinary replies in one WeChat bubble whenever practical. The value is
// the preferred natural-boundary cut point; the hard channel limit is 4000.
const DEFAULT_MIN_WEIXIN_CHUNK = 3600;
const MAX_MIN_WEIXIN_CHUNK = 4000;

function loadWeixinConfig(config) {
  const filePath = config?.weixinConfigFile;
  const envDefault = normalizeMinChunkChars(
    config?.weixinMinChunkChars,
    DEFAULT_MIN_WEIXIN_CHUNK,
  );
  if (!filePath) {
    return { minChunkChars: envDefault };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      minChunkChars: normalizeMinChunkChars(parsed?.minChunkChars, envDefault),
    };
  } catch {
    return { minChunkChars: envDefault };
  }
}

function saveWeixinConfig(config, values) {
  const filePath = config?.weixinConfigFile;
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        minChunkChars: normalizeMinChunkChars(values?.minChunkChars),
      },
      null,
      2,
    ),
  );
}

function normalizeMinChunkChars(value, defaultValue = DEFAULT_MIN_WEIXIN_CHUNK) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_MIN_WEIXIN_CHUNK) {
    return parsed;
  }
  return defaultValue;
}

module.exports = {
  loadWeixinConfig,
  saveWeixinConfig,
  DEFAULT_MIN_WEIXIN_CHUNK,
  MAX_MIN_WEIXIN_CHUNK,
  normalizeMinChunkChars,
};
