/**
 * High Star Payment Checkout
 * File path: assets/bt-checkout.js
 *
 * Uses separate Basis Theory Elements:
 * - cardNumber
 * - cardExpirationDate
 * - cardVerificationCode
 */

(function ($) {
  let bt = null;
  let cardNumberElement = null;
  let cardExpirationDateElement = null;
  let cardVerificationCodeElement = null;
  let isReady = false;
  let isTokenizing = false;
  let isMounting = false;
  // Timestamp of the last mount attempt. Used to throttle the self-healing
  // re-mount so a persistently failing mount can never spin in a tight loop.
  let lastMountAttemptAt = 0;

  function showError(message) {
    $("#hsbt-card-error").text(message || "");
  }

  /**
   * Fresh per-submit idempotency nonce. Generated for each deliberate "Place
   * Order" click that produces a fresh tokenization, so the backend can tell an
   * accidental retransmission of the SAME submission (same nonce → Stripe safely
   * deduplicates) apart from a deliberate retry (new click → new token → new
   * nonce → processed as a new attempt). Carries no card data — just a random id.
   */
  function generateNonce() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        // RFC 4122 v4 layout.
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.prototype.map
          .call(bytes, function (b) {
            return ("0" + b.toString(16)).slice(-2);
          })
          .join("");
        return (
          hex.slice(0, 8) +
          "-" +
          hex.slice(8, 12) +
          "-" +
          hex.slice(12, 16) +
          "-" +
          hex.slice(16, 20) +
          "-" +
          hex.slice(20)
        );
      }
    } catch (e) {
      // Fall through to the non-crypto fallback below.
    }
    // Last-resort fallback for very old browsers without Web Crypto.
    return (
      "hsbt-" +
      Date.now().toString(16) +
      "-" +
      Math.random().toString(16).slice(2) +
      Math.random().toString(16).slice(2)
    );
  }

  // Write a brand-new nonce (called when a fresh token intent is created).
  function setPaymentNonce() {
    $("#hsbt_payment_nonce").val(generateNonce());
  }

  // Guarantee a nonce exists without replacing an already-set one (so a
  // retransmitted submission keeps the same value).
  function ensurePaymentNonce() {
    if (!$("#hsbt_payment_nonce").val()) {
      setPaymentNonce();
    }
  }

  function getSelectedPaymentMethod() {
    return $('input[name="payment_method"]:checked').val();
  }

  function isHighStarSelected() {
    const selected = getSelectedPaymentMethod();

    if (selected === "hsbt_gateway") {
      return true;
    }

    return $("#hsbt-card-wrapper").length > 0 && (!selected || selected === "");
  }

  function hasMountedIframes() {
    return (
      $("#hsbt-card-number iframe").length > 0 &&
      $("#hsbt-card-expiry iframe").length > 0 &&
      $("#hsbt-card-cvc iframe").length > 0
    );
  }

  function resetElementsIfCheckoutWasRefreshed() {
    if (isReady && !hasMountedIframes()) {
      bt = null;
      cardNumberElement = null;
      cardExpirationDateElement = null;
      cardVerificationCodeElement = null;
      isReady = false;
      isMounting = false;
    }
  }

  async function getBasisTheoryInstance(publicKey, environment) {
    if (typeof window.basistheory === "function") {
      return await window.basistheory(publicKey, { environment: environment });
    }

    if (window.BasisTheory && typeof window.BasisTheory.init === "function") {
      return await window.BasisTheory.init(publicKey, {
        elements: true,
        environment: environment,
      });
    }

    throw new Error("Basis Theory Elements failed to load.");
  }

  async function mountCardElements() {
    try {
      resetElementsIfCheckoutWasRefreshed();

      if (isMounting || isReady) {
        return;
      }

      if (!window.hsbtData || !hsbtData.publicKey) {
        showError("High Star payment gateway is not configured.");
        return;
      }

      if (
        $("#hsbt-card-number").length === 0 ||
        $("#hsbt-card-expiry").length === 0 ||
        $("#hsbt-card-cvc").length === 0
      ) {
        return;
      }

      isMounting = true;
      lastMountAttemptAt = Date.now();
      showError("");

      $("#hsbt-card-number").empty();
      $("#hsbt-card-expiry").empty();
      $("#hsbt-card-cvc").empty();

      bt = await getBasisTheoryInstance(
        hsbtData.publicKey,
        hsbtData.environment || "us"
      );

      const baseStyle = {
        color: "#222",
        fontSize: "16px",
        fontFamily: "Arial, sans-serif",
        "::placeholder": {
          color: "#999",
        },
      };

      cardNumberElement = bt.createElement("cardNumber", {
        targetId: "hsbt-card-number-input",
        placeholder: "Card number",
        autoComplete: "cc-number",
        style: {
          base: baseStyle,
          invalid: {
            color: "#d63638",
          },
        },
      });

      cardExpirationDateElement = bt.createElement("cardExpirationDate", {
        targetId: "hsbt-card-expiry-input",
        placeholder: "MM / YY",
        autoComplete: "cc-exp",
        style: {
          base: baseStyle,
          invalid: {
            color: "#d63638",
          },
        },
      });

      cardVerificationCodeElement = bt.createElement("cardVerificationCode", {
        targetId: "hsbt-card-cvc-input",
        placeholder: "CVC",
        autoComplete: "cc-csc",
        style: {
          base: baseStyle,
          invalid: {
            color: "#d63638",
          },
        },
      });

      await Promise.all([
        cardNumberElement.mount("#hsbt-card-number"),
        cardExpirationDateElement.mount("#hsbt-card-expiry"),
        cardVerificationCodeElement.mount("#hsbt-card-cvc"),
      ]);

      if (typeof cardNumberElement.on === "function") {
        cardNumberElement.on("change", function (event) {
          if (
            event &&
            event.cardBrand &&
            cardVerificationCodeElement &&
            typeof cardVerificationCodeElement.update === "function"
          ) {
            cardVerificationCodeElement.update({
              cardBrand: event.cardBrand,
            });
          }
        });
      }

      isReady = true;
      isMounting = false;
      showError("");
    } catch (error) {
      isReady = false;
      isMounting = false;
      console.error("Basis Theory init/mount error:", error);
      showError(
        error && error.message
          ? error.message
          : "Could not initialize card fields."
      );
    }
  }

  async function createTokenIntent() {
    if (
      !bt ||
      !cardNumberElement ||
      !cardExpirationDateElement ||
      !cardVerificationCodeElement
    ) {
      throw new Error("Card fields are not ready yet.");
    }

    const tokenIntent = await bt.tokenIntents.create({
      type: "card",
      data: {
        number: cardNumberElement,
        expiration_month: cardExpirationDateElement.month(),
        expiration_year: cardExpirationDateElement.year(),
        cvc: cardVerificationCodeElement,
      },
    });

    if (!tokenIntent || !tokenIntent.id) {
      throw new Error("Card tokenization failed.");
    }

    $("#hsbt_token_intent_id").val(tokenIntent.id);
    // A fresh tokenization is a fresh deliberate submission → new idempotency
    // nonce. A network/AJAX retransmission of the same submit does not re-run
    // this, so the nonce stays stable for that identical request.
    setPaymentNonce();
    return tokenIntent.id;
  }

  // ---------------------------------------------------------------------------
  // Self-healing re-mount (root-cause fix for "fields disappear on scroll /
  // checkout update").
  //
  // The card fields are cross-origin iframes mounted into the #hsbt-card-* divs.
  // Anything that replaces or re-renders that DOM destroys the iframes and blanks
  // the fields: WooCommerce's checkout AJAX refresh (update_checkout) swaps the
  // payment markup for fresh empty divs; an Elementor/theme re-render or iframe
  // lazy-loader can rebuild the section; some mobile browsers discard off-screen
  // iframes on scroll. Only the WooCommerce case fires `updated_checkout`, so the
  // theme/scroll cases would otherwise leave the fields blank until a page reload.
  //
  // A MutationObserver watches the checkout DOM and re-mounts whenever the
  // container is present but its iframes have vanished — so the fields reappear
  // on their own, no matter what removed them. It never runs while a mount is in
  // progress, is throttled against a failing-mount loop, and no-ops once the
  // iframes are present, so it can't double-mount or spin.
  // ---------------------------------------------------------------------------

  const REMOUNT_COOLDOWN_MS = 1200;
  let remountCheckTimer = null;
  let observerStarted = false;

  function cardWrapperPresent() {
    return (
      $("#hsbt-card-number").length > 0 &&
      $("#hsbt-card-expiry").length > 0 &&
      $("#hsbt-card-cvc").length > 0
    );
  }

  function remountIfFieldsMissing() {
    // A mount already in progress will finish and populate the iframes itself.
    if (isMounting) {
      return;
    }
    // Gateway markup isn't on the page (e.g. a different payment method) — skip.
    if (!cardWrapperPresent()) {
      return;
    }
    // Iframes are still mounted — the fields are fine.
    if (hasMountedIframes()) {
      return;
    }
    // Throttle: if a mount was just attempted, don't immediately try again (this
    // also breaks any showError → mutation → re-mount feedback loop on failure).
    if (Date.now() - lastMountAttemptAt < REMOUNT_COOLDOWN_MS) {
      return;
    }
    // Container present but its iframes are gone → rebuild them.
    mountCardElements();
  }

  function scheduleRemountCheck() {
    // Debounce: DOM re-renders arrive in bursts; coalesce them into one check.
    if (remountCheckTimer) {
      return;
    }
    remountCheckTimer = setTimeout(function () {
      remountCheckTimer = null;
      remountIfFieldsMissing();
    }, 200);
  }

  function startCheckoutObserver() {
    if (observerStarted || typeof window.MutationObserver === "undefined") {
      return;
    }
    // Watch the whole document body so a full-section re-render by the theme /
    // Elementor is caught too (not just WooCommerce's in-form fragment swap).
    // The callback is a cheap no-op unless our iframes have actually vanished.
    const observer = new MutationObserver(scheduleRemountCheck);
    observer.observe(document.body, { childList: true, subtree: true });
    observerStarted = true;
  }

  $(document.body).on("updated_checkout payment_method_selected", function () {
    setTimeout(mountCardElements, 500);
  });

  $(document).ready(function () {
    setTimeout(mountCardElements, 500);
    startCheckoutObserver();
  });

  $("form.checkout").on("checkout_place_order_hsbt_gateway", function () {
    if (!isHighStarSelected()) {
      return true;
    }

    if ($("#hsbt_token_intent_id").val()) {
      // Token already created for this submission — make sure it carries a nonce
      // (it normally does, set when the token was created) before it submits.
      ensurePaymentNonce();
      return true;
    }

    if (isTokenizing) {
      return false;
    }

    isTokenizing = true;
    showError("");

    createTokenIntent()
      .then(function () {
        isTokenizing = false;
        $("form.checkout").trigger("submit");
      })
      .catch(function (error) {
        isTokenizing = false;
        console.error("Basis Theory tokenization error:", error);
        showError(
          error && error.message
            ? error.message
            : "Card tokenization failed. Please try again."
        );
        $(document.body).trigger("checkout_error");
      });

    return false;
  });
})(jQuery);
