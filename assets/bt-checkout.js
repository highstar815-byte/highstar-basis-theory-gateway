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

  $(document.body).on("updated_checkout payment_method_selected", function () {
    setTimeout(mountCardElements, 500);
  });

  $(document).ready(function () {
    setTimeout(mountCardElements, 500);
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
