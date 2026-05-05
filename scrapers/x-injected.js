// Runs in the page's MAIN world at document_start, BEFORE X's bundle.
// Patches fetch + XHR so we can observe GraphQL/JSON responses and forward
// them to the isolated content script via window.postMessage.
(() => {
  if (window.__xScraperInjected) return;
  window.__xScraperInjected = true;

  const TAG = "XS_SCRAPER_CAPTURE";
  const MAX_BODY = 4 * 1024 * 1024;

  function shouldCapture(url) {
    if (!url) return false;
    return /\/graphql\/|\/i\/api\/graphql\/|\/i\/api\/\d+\/|\/2\/timeline\//i.test(url);
  }

  function forward(payload) {
    try { window.postMessage({ source: TAG, ...payload }, "*"); } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const res = await origFetch.apply(this, arguments);
    if (shouldCapture(url)) {
      try {
        const clone = res.clone();
        const ct = clone.headers.get("content-type") || "";
        if (/json|javascript/i.test(ct)) {
          clone.text().then((body) => {
            forward({
              kind: "fetch",
              url,
              status: res.status,
              contentType: ct,
              body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
              truncated: body.length > MAX_BODY,
              ts: Date.now(),
            });
          }).catch(() => {});
        }
      } catch (_) {}
    }
    return res;
  };

  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__xsUrl = url;
    this.__xsMethod = method;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  OrigXHR.prototype.send = function (body) {
    if (shouldCapture(this.__xsUrl)) {
      this.addEventListener("load", () => {
        try {
          const ct = this.getResponseHeader("content-type") || "";
          if (!/json|javascript/i.test(ct)) return;
          const text = this.responseType === "" || this.responseType === "text"
            ? this.responseText
            : "";
          forward({
            kind: "xhr",
            url: this.__xsUrl,
            method: this.__xsMethod,
            status: this.status,
            contentType: ct,
            body: text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text,
            truncated: text.length > MAX_BODY,
            ts: Date.now(),
          });
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
