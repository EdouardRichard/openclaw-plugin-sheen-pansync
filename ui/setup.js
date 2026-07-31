(() => {
  "use strict";

  const keyName = "panSyncSetupAccessKey";
  const keyPattern = /^[A-Za-z0-9_-]{43}$/;
  const fragmentKey = window.location.hash.slice(1);
  if (keyPattern.test(fragmentKey)) {
    window.sessionStorage.setItem(keyName, fragmentKey);
  }
  if (window.location.hash.length > 0) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  const accessKey = window.sessionStorage.getItem(keyName) || "";

  const form = document.getElementById("credentials");
  const clientId = document.getElementById("clientId");
  const clientSecret = document.getElementById("clientSecret");
  const refreshToken = document.getElementById("refreshToken");
  const result = document.getElementById("result");
  const revalidate = document.getElementById("revalidate");
  const testUpload = document.getElementById("testUpload");
  const clearCredentials = document.getElementById("clearCredentials");
  const confirmClear = document.getElementById("confirmClear");
  const defaultDirectory = document.getElementById("defaultDirectory");
  const tokenGuide = document.getElementById("tokenGuide");

  const safeCodes = new Set([
    "CREDENTIALS_REQUIRED",
    "CREDENTIALS_INVALID",
    "REFRESH_TOKEN_REJECTED",
    "TOKEN_ENDPOINT_UNAVAILABLE",
    "RATE_LIMITED",
    "UPLOAD_FAILED",
    "REQUEST_FAILED",
  ]);

  function clearFormValues() {
    clientId.value = "";
    clientSecret.value = "";
    refreshToken.value = "";
  }

  function showSafeResult(value) {
    result.textContent = safeCodes.has(value) ? value : "REQUEST_FAILED";
  }

  function applyConfig(value) {
    if (value && value.credentials) {
      clientId.value = typeof value.credentials.clientId === "string" ? value.credentials.clientId : "";
      clientSecret.value = typeof value.credentials.clientSecret === "string" ? value.credentials.clientSecret : "";
      refreshToken.value = typeof value.credentials.refreshToken === "string" ? value.credentials.refreshToken : "";
    } else if (value && value.configured === false) {
      clearFormValues();
    }
    if (value && typeof value.defaultDirectory === "string") {
      defaultDirectory.textContent = value.defaultDirectory;
    }
    if (value && typeof value.tokenGuideUrl === "string") {
      const link = document.createElement("a");
      link.href = value.tokenGuideUrl;
      link.rel = "noreferrer noopener";
      link.textContent = "Open the initial Token guide";
      tokenGuide.replaceChildren(link);
      tokenGuide.hidden = false;
    }
  }

  async function api(path, options = {}) {
    if (!keyPattern.test(accessKey)) {
      throw new Error("missing setup access key");
    }
    const response = await window.fetch(path, {
      ...options,
      headers: {
        "Authorization": `PanSyncSetup ${accessKey}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.headers || {}),
      },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = value && typeof value.code === "string" ? value.code : "REQUEST_FAILED";
      const error = new Error("request rejected");
      error.safeCode = safeCodes.has(code) ? code : "REQUEST_FAILED";
      throw error;
    }
    return value;
  }

  async function run(action, successCode) {
    result.textContent = "Working…";
    try {
      const value = await action();
      applyConfig(value);
      result.textContent = successCode;
    } catch (error) {
      showSafeResult(error && typeof error.safeCode === "string" ? error.safeCode : "REQUEST_FAILED");
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(
      () => api("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          clientId: clientId.value,
          clientSecret: clientSecret.value,
          refreshToken: refreshToken.value,
        }),
      }),
      "SAVED_AND_VERIFIED",
    );
  });

  revalidate.addEventListener("click", () => {
    void run(() => api("/api/revalidate", { method: "POST" }), "REVALIDATED");
  });

  testUpload.addEventListener("click", () => {
    void run(() => api("/api/test-upload", { method: "POST" }), "TEST_UPLOAD_COMPLETE");
  });

  clearCredentials.addEventListener("click", () => {
    confirmClear.hidden = false;
    confirmClear.focus();
  });

  confirmClear.addEventListener("click", () => {
    confirmClear.hidden = true;
    void run(
      () => api("/api/config", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "CLEAR" }),
      }),
      "CREDENTIALS_CLEARED",
    );
  });

  window.addEventListener("pagehide", clearFormValues);
  void run(() => api("/api/config"), "READY");
})();
