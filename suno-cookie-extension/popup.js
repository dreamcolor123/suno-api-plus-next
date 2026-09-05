const IMPORTANT_NAMES = [
  "__client",
  "__client_uat",
  "__session",
  "__clerk_db_jwt",
  "ajs_anonymous_id",
  "ajs_user_id",
];

const statusPill = document.getElementById("statusPill");
const loginState = document.getElementById("loginState");
const clientState = document.getElementById("clientState");
const cookieCount = document.getElementById("cookieCount");
const cookieOutput = document.getElementById("cookieOutput");
const message = document.getElementById("message");
const extractBtn = document.getElementById("extractBtn");
const copyBtn = document.getElementById("copyBtn");
const openSunoBtn = document.getElementById("openSunoBtn");
const openAdminBtn = document.getElementById("openAdminBtn");
const adminUrl = document.getElementById("adminUrl");

function setMessage(text, type = "") {
  message.textContent = text || "";
  message.className = `message ${type}`.trim();
}

function setPill(text, type = "muted") {
  statusPill.textContent = text;
  statusPill.className = `pill pill-${type}`;
}

function prioritizeCookies(cookies) {
  const byName = new Map();
  for (const cookie of cookies) {
    if (!cookie?.name || cookie.value == null || cookie.value === "") continue;
    const score = (item) => {
      const domain = String(item.domain || "");
      if (domain.includes("clerk.suno.com")) return 3;
      if (domain.includes("suno.com")) return 2;
      return 1;
    };
    const current = byName.get(cookie.name);
    if (!current || score(cookie) >= score(current)) {
      byName.set(cookie.name, cookie);
    }
  }
  return [...byName.values()];
}

function buildCookieHeader(cookies) {
  const ordered = prioritizeCookies(cookies);
  const important = ordered.filter((c) => IMPORTANT_NAMES.includes(c.name));
  const rest = ordered.filter((c) => !IMPORTANT_NAMES.includes(c.name));
  return [...important, ...rest].map((c) => `${c.name}=${c.value}`).join("; ");
}

async function getSunoCookies() {
  const groups = await Promise.all([
    chrome.cookies.getAll({ domain: "suno.com" }),
    chrome.cookies.getAll({ domain: ".suno.com" }),
    chrome.cookies.getAll({ domain: "clerk.suno.com" }),
    chrome.cookies.getAll({ domain: ".clerk.suno.com" }),
  ]);
  return groups.flat();
}

async function refreshStatus(autoFill = false) {
  try {
    const cookies = await getSunoCookies();
    const unique = prioritizeCookies(cookies);
    const client = unique.find((c) => c.name === "__client" && c.value);
    cookieCount.textContent = String(unique.length);
    clientState.textContent = client ? "已找到" : "未找到";
    clientState.style.color = client ? "#1f9d6a" : "#c24b4b";
    loginState.textContent = client ? "已登录" : "未登录 / Cookie 失效";
    loginState.style.color = client ? "#1f9d6a" : "#c98512";

    if (client) {
      setPill("可提取", "ok");
      if (autoFill) {
        const header = buildCookieHeader(unique);
        cookieOutput.value = header;
        copyBtn.disabled = !header;
      }
    } else if (unique.length > 0) {
      setPill("缺 __client", "warn");
    } else {
      setPill("未登录", "bad");
    }
    return { cookies: unique, client };
  } catch (error) {
    setPill("失败", "bad");
    setMessage(error?.message || "读取 Cookie 失败", "bad");
    return { cookies: [], client: null };
  }
}

async function extractCookies() {
  setMessage("正在提取…");
  extractBtn.disabled = true;
  try {
    const { cookies, client } = await refreshStatus(false);
    if (!client) {
      cookieOutput.value = "";
      copyBtn.disabled = true;
      setMessage("未找到 __client。请先打开 suno.com 并登录，再重试。", "bad");
      return;
    }
    const header = buildCookieHeader(cookies);
    cookieOutput.value = header;
    copyBtn.disabled = !header;
    await chrome.storage.local.set({ lastCookie: header, lastExtractAt: Date.now() });
    setMessage(`提取成功，共 ${cookies.length} 个 Cookie。可复制到管理后台。`, "ok");
  } catch (error) {
    setMessage(error?.message || "提取失败", "bad");
  } finally {
    extractBtn.disabled = false;
  }
}

async function copyCookie() {
  const value = cookieOutput.value.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    setMessage("已复制到剪贴板", "ok");
  } catch {
    cookieOutput.focus();
    cookieOutput.select();
    document.execCommand("copy");
    setMessage("已复制到剪贴板", "ok");
  }
}

async function openSuno() {
  await chrome.tabs.create({ url: "https://suno.com/", active: true });
}

async function openAdmin() {
  const base = (adminUrl.value || "").trim().replace(/\/$/, "");
  if (!base) {
    setMessage("请先填写管理后台地址，例如 http://38.47.121.78:3000", "warn");
    return;
  }
  await chrome.storage.local.set({ adminBaseUrl: base });
  if (cookieOutput.value.trim()) {
    try {
      await navigator.clipboard.writeText(cookieOutput.value.trim());
    } catch {
      // ignore
    }
  }
  await chrome.tabs.create({ url: `${base}/admin`, active: true });
  setMessage("已打开管理后台，Cookie 已尽量复制到剪贴板。", "ok");
}

extractBtn.addEventListener("click", extractCookies);
copyBtn.addEventListener("click", copyCookie);
openSunoBtn.addEventListener("click", openSuno);
openAdminBtn.addEventListener("click", openAdmin);

chrome.storage.local.get(["adminBaseUrl", "lastCookie"]).then((data) => {
  if (data.adminBaseUrl) adminUrl.value = data.adminBaseUrl;
  if (data.lastCookie) {
    cookieOutput.value = data.lastCookie;
    copyBtn.disabled = false;
  }
});

refreshStatus(true);
