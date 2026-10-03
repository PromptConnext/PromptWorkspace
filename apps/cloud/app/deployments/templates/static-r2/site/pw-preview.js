// Tells PromptWorkspace's Preview tab that this page actually rendered inside its
// iframe.
//
// Why this exists: a browser cannot tell an embedded page apart from a blocked
// one. A frame refused by X-Frame-Options or a CSP still fires `load` and never
// fires `error`, and its document is unreadable cross-origin — so from the
// outside, "embedded fine", "refused embedding" and "404" look identical.
// This message is the only positive proof, and it proves all three at once:
// the frame was allowed, the page was found, and its scripts ran.
//
// Its absence proves nothing, and PromptWorkspace treats it that way: it falls back
// to showing a link instead of claiming the app refuses embedding. Deleting
// this file is therefore safe — you get the link card.
(function () {
  function announce() {
    if (window.parent === window) return; // not embedded; nothing to say
    try {
      // "*" rather than a fixed origin: the same built site is served from
      // preview storage, a custom domain, and localhost, and a mismatch here
      // would silently drop the message. The payload carries no secrets — it
      // is a liveness ping, not a channel.
      window.parent.postMessage({ pz: "preview-ready", href: location.href }, "*");
    } catch (err) {
      // A sandbox strict enough to block postMessage is exactly the case the
      // link-card fallback exists for.
    }
  }

  if (document.readyState === "complete") announce();
  else window.addEventListener("load", announce);
})();
