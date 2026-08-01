(() => {
  "use strict";

  const keyName = "panSyncSetupAccessKey";
  const keyPattern = /^[A-Za-z0-9_-]{43}$/;
  const fragmentKey = window.location.hash.slice(1);
  if (window.location.hash.length > 0) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }

  let accessKey = keyPattern.test(fragmentKey) ? fragmentKey : "";
  try {
    if (accessKey.length > 0) {
      window.sessionStorage.setItem(keyName, accessKey);
    } else {
      accessKey = window.sessionStorage.getItem(keyName) || "";
    }
  } catch {
    // The fragment key remains usable for this page when storage is disabled.
  }

  const form = document.getElementById("credentials");
  const authorizationPageUrl = document.getElementById("authorizationPageUrl");
  const openAuthorizationPage = document.getElementById("openAuthorizationPage");
  const refreshApiUrl = document.getElementById("refreshApiUrl");
  const refreshToken = document.getElementById("refreshToken");
  const result = document.getElementById("result");
  const revalidate = document.getElementById("revalidate");
  const testUpload = document.getElementById("testUpload");
  const clearCredentials = document.getElementById("clearCredentials");
  const confirmClear = document.getElementById("confirmClear");
  const defaultDirectory = document.getElementById("defaultDirectory");

  const safeCodes = new Set([
    "CREDENTIALS_REQUIRED",
    "CREDENTIALS_INVALID",
    "REFRESH_TOKEN_REJECTED",
    "TOKEN_ENDPOINT_UNAVAILABLE",
    "RATE_LIMITED",
    "UPLOAD_FAILED",
    "REQUEST_FAILED",
  ]);
  let active = true;
  let requestGeneration = 0;
  const requestControllers = new Set();

  function clearFormValues() {
    authorizationPageUrl.value = "";
    refreshApiUrl.value = "";
    refreshToken.value = "";
    syncAuthorizationLink();
  }

  function syncAuthorizationLink() {
    if (authorizationPageUrl.value.length === 0) {
      openAuthorizationPage.removeAttribute("href");
    } else {
      openAuthorizationPage.href = authorizationPageUrl.value;
    }
  }

  function showSafeResult(value) {
    result.textContent = safeCodes.has(value) ? value : "REQUEST_FAILED";
  }

  function invalidateRequests() {
    requestGeneration += 1;
    for (const controller of requestControllers) {
      controller.abort();
    }
    requestControllers.clear();
  }

  function isCurrent(generation) {
    return active && generation === requestGeneration;
  }

  function applyConfig(value) {
    if (value && value.credentials) {
      authorizationPageUrl.value = typeof value.credentials.authorizationPageUrl === "string" ? value.credentials.authorizationPageUrl : "";
      refreshApiUrl.value = typeof value.credentials.refreshApiUrl === "string" ? value.credentials.refreshApiUrl : "";
      refreshToken.value = typeof value.credentials.refreshToken === "string" ? value.credentials.refreshToken : "";
      syncAuthorizationLink();
    } else if (value && value.configured === false) {
      clearFormValues();
    }
    if (value && typeof value.defaultDirectory === "string") {
      defaultDirectory.textContent = value.defaultDirectory;
    }
  }

  async function api(path, options, generation) {
    if (!keyPattern.test(accessKey)) {
      throw new Error("missing setup access key");
    }
    const controller = new AbortController();
    requestControllers.add(controller);
    try {
      const response = await window.fetch(path, {
        ...(options || {}),
        signal: controller.signal,
        headers: {
          "Authorization": `PanSyncSetup ${accessKey}`,
          ...(!options || options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...((options && options.headers) || {}),
        },
      });
      if (!isCurrent(generation)) return undefined;
      const value = await response.json().catch(() => ({}));
      if (!isCurrent(generation)) return undefined;
      if (!response.ok) {
        const code = value && typeof value.code === "string" ? value.code : "REQUEST_FAILED";
        const error = new Error("request rejected");
        error.safeCode = safeCodes.has(code) ? code : "REQUEST_FAILED";
        throw error;
      }
      return value;
    } finally {
      requestControllers.delete(controller);
    }
  }

  async function run(action, successCode, invalidateBefore = true) {
    if (!active) return;
    if (invalidateBefore) invalidateRequests();
    const generation = requestGeneration;
    result.textContent = "Working…";
    try {
      const value = await action(generation);
      if (!isCurrent(generation)) return;
      applyConfig(value);
      result.textContent = successCode;
    } catch (error) {
      if (!isCurrent(generation)) return;
      showSafeResult(error && typeof error.safeCode === "string" ? error.safeCode : "REQUEST_FAILED");
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(
      (generation) => api("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          authorizationPageUrl: authorizationPageUrl.value,
          refreshApiUrl: refreshApiUrl.value,
          refreshToken: refreshToken.value,
        }),
      }, generation),
      "SAVED_AND_VERIFIED",
    );
  });

  authorizationPageUrl.addEventListener("input", syncAuthorizationLink);

  revalidate.addEventListener("click", () => {
    void run((generation) => api("/api/revalidate", { method: "POST" }, generation), "REVALIDATED");
  });

  testUpload.addEventListener("click", () => {
    void run((generation) => api("/api/test-upload", { method: "POST" }, generation), "TEST_UPLOAD_COMPLETE");
  });

  clearCredentials.addEventListener("click", () => {
    confirmClear.hidden = false;
    confirmClear.focus();
  });

  confirmClear.addEventListener("click", () => {
    confirmClear.hidden = true;
    void run(
      (generation) => api("/api/config", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "CLEAR" }),
      }, generation),
      "CREDENTIALS_CLEARED",
    );
  });

  window.addEventListener("pagehide", () => {
    active = false;
    invalidateRequests();
    clearFormValues();
    accessKey = "";
  });
  void run((generation) => api("/api/config", undefined, generation), "READY", false);
})();
