/**
 * High Star Payment Checkout
 * File path: assets/bt-checkout.js
 *
 * Uses separate Basis Theory Elements:
 * - cardNumber
 * - cardExpirationDate
 * - cardVerificationCode
 *
 * ---------------------------------------------------------------------------
 * Field-initialization hardening (per Basis Theory support guidance).
 *
 * Symptom reported by merchants: the card fields appear on the checkout page
 * but stay disabled — visible, but un-clickable, so the buyer cannot type a
 * card and cannot complete checkout. It is intermittent (seen on iPhone Safari)
 * and leaves no error on Basis Theory's side.
 *
 * Root cause (Basis Theory, John Ellis): each field is a cross-origin iframe
 * that downloads its own code after the frame itself appears. The frame shows
 * first; the script that makes it interactive arrives a moment later. If the
 * checkout page removes, re-renders, re-mounts OR re-parents the field
 * container while that script is still downloading, the browser CANCELS the
 * download (Safari in particular reloads/cancels an iframe the instant it is
 * moved in the DOM). The frame is left visible but dead — mounted yet never
 * "ready".
 *
 * The guidance, implemented here point-for-point:
 *   1. Mount each element ONCE and don't change its container afterwards —
 *      watch for conditional rendering, framework re-renders and route changes.
 *      => We no longer re-mount on every WooCommerce event / DOM mutation. We
 *         wait for the DOM to SETTLE (go quiet) before mounting, so we never
 *         mount into a container that is about to be replaced again, and we
 *         never re-mount while fields are healthy.
 *   2. If a field needs to be hidden, hide it with CSS rather than removing it.
 *      => We never empty/remove a container that holds live iframes; switching
 *         payment method relies on WooCommerce's CSS show/hide, which keeps the
 *         iframes alive instead of destroying them.
 *   3. Wait for each element's READY event before enabling checkout.
 *      => We attach on('ready') to all three elements and only treat the fields
 *         as usable (and only allow Place Order) once ALL THREE have fired. A
 *         resolved mount() promise is NOT enough — the frame can be mounted but
 *         not yet interactive, which is exactly this bug.
 *   4. If ready doesn't arrive within a few seconds, unmount and mount again,
 *      or show a reload option — so a buyer is never stuck.
 *      => A ready-timeout triggers an automatic unmount+remount (bounded), and
 *         if it still won't come up we surface a "reload the card fields"
 *         control and keep Place Order disabled with a clear message.
 *   5. Turn telemetry on when initializing the SDK so failures are visible to
 *      Basis Theory.
 *      => We initialize with disableTelemetry:false (see getBasisTheoryInstance).
 * ---------------------------------------------------------------------------
 */

(function ($) {
  let bt = null;
  let cardNumberElement = null;
  let cardExpirationDateElement = null;
  let cardVerificationCodeElement = null;
  // "Ready" now means every element has fired its own `ready` event — i.e. the
  // frames are not just mounted but interactive. A resolved mount() promise is
  // deliberately NOT treated as ready (that gap is the disabled-fields bug).
  let isReady = false;
  let isTokenizing = false;
  let isMounting = false;
  // Timestamp of the last mount attempt. Used to throttle the self-healing
  // re-mount so a persistently failing mount can never spin in a tight loop.
  let lastMountAttemptAt = 0;

  // Per-element ready tracking for the current mount attempt. Reset at the start
  // of every mount; all three must fire before checkout is enabled (guidance #3).
  const elementReady = { number: false, expiry: false, cvc: false };

  // Per-element "has the buyer typed anything" tracking. Used so an automatic
  // self-heal never silently wipes a card the shopper already entered into the
  // field(s) that DID come up — in that case we offer a manual reload instead.
  const fieldDirty = { number: false, expiry: false, cvc: false };

  // Monotonic id for the current set of elements. Bumped on every (re)mount and
  // teardown so a late `ready` event from a PREVIOUS, already-unmounted element
  // (possible during a self-heal cycle) can't flip the new attempt to "ready",
  // and so a superseded in-flight mount aborts cleanly when it resumes.
  let mountGeneration = 0;

  // Ready-timeout + bounded self-heal (guidance #4).
  // Touch/coarse-pointer devices (the reported iPhone Safari population) load the
  // cross-origin frames over slower mobile networks, so give them a longer first
  // window before any heal — destroying a frame that is still downloading only
  // restarts the download (Safari reloads a moved/recreated iframe).
  const IS_COARSE_POINTER =
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches) ||
    "ontouchstart" in window;
  const READY_TIMEOUT_MS = IS_COARSE_POINTER ? 10000 : 6000;
  const MAX_HEAL_ATTEMPTS = 2; // auto unmount+remount this many times before we
  //                              surface a manual reload control
  let readyTimer = null;
  let healAttempts = 0;
  // A frame that has already made progress (at least one field fired `ready`) is
  // granted ONE non-destructive grace extension before we tear it down, so a
  // nearly-finished slow frame is never cancelled mid-download. Per-episode.
  let graceUsed = false;
  // Durable "a recovery episode is unresolved" marker. Set the moment we begin
  // recovering (or surface the reload control) and cleared ONLY by resetHealBudget
  // at a genuine fresh-episode boundary. It survives the in-flight unmount/remount
  // of a heal attempt, so a frequent updated_checkout poller firing mid-recovery
  // can't be mistaken for a clean slate and re-grant the heal budget.
  let healInProgress = false;
  // One final, delayed auto-retry after the manual reload control is surfaced, so
  // a transient failure can still self-recover on a static page where the buyer
  // takes no action and no DOM mutation would otherwise re-trigger a mount. Used
  // once per stuck episode (reset when the fields finally come up).
  const EXHAUSTION_RETRY_MS = 15000;
  let exhaustionRetryTimer = null;
  let exhaustionRetryUsed = false;

  function showError(message) {
    $("#hsbt-card-error").text(message || "");
  }

  // Loading / reload affordances rendered by payment_fields() (guidance #4). All
  // guarded with length checks so a theme that strips them never throws.
  function showLoadingState() {
    $("#hsbt-card-loading").show();
    $("#hsbt-card-reload").hide();
  }

  function hideLoadingState() {
    $("#hsbt-card-loading").hide();
  }

  function showReloadOption() {
    $("#hsbt-card-loading").hide();
    $("#hsbt-card-reload").show();
    showError(
      "The secure card fields could not finish loading. Please reload them to continue."
    );
  }

  function hideReloadOption() {
    $("#hsbt-card-reload").hide();
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

  // ---------------------------------------------------------------------------
  // Fresh token-intent per RETRY (root-cause fix for "Failed to find one or more
  // token intent values").
  //
  // A Basis Theory token-intent is short-lived and single-use. If the previous
  // Place Order failed (card declined, backend/technical error, or a lost
  // response), the SAME token-intent must NOT be sent again — the backend proxy
  // can no longer resolve it, which surfaces as an "Invalid proxy request /
  // Failed to find token intent values" error. So on any checkout failure we
  // drop the cached token-intent id AND its nonce; the next Place Order then
  // re-tokenizes (createTokenIntent), producing a FRESH token-intent + a FRESH
  // nonce. The card the shopper typed is untouched (the BT iframes keep their
  // value), so a retry needs no re-entry.
  //
  // Safety net alongside this: the backend submission ledger replays the first
  // result for an identical (same-nonce) resubmission and refuses to charge an
  // order that already succeeded, so this clearing can never cause a double
  // charge even in the "charge succeeded but response was lost" case.
  // ---------------------------------------------------------------------------
  function clearTokenIntentForRetry() {
    $("#hsbt_token_intent_id").val("");
    $("#hsbt_payment_nonce").val("");
    // Also drop any reusable (VIP) token so the retry mints a fresh one.
    $("#hsbt_reusable_token_id").val("");
    // Allow the next Place Order click to tokenize again.
    isTokenizing = false;
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

  function cardWrapperPresent() {
    return (
      $("#hsbt-card-number").length > 0 &&
      $("#hsbt-card-expiry").length > 0 &&
      $("#hsbt-card-cvc").length > 0
    );
  }

  // ---------------------------------------------------------------------------
  // Place Order gating (guidance #3: wait for ready before enabling checkout).
  //
  // While High Star is the selected method and the fields aren't ready, the
  // Place Order button is disabled so a buyer can't submit into dead fields. We
  // only touch the button when our gateway is selected so we never interfere
  // with other payment methods. The hard guarantee lives in the submit handler
  // below (it blocks the order until ready); this is the matching UX.
  // ---------------------------------------------------------------------------
  function refreshCheckoutGate() {
    const $btn = $("#place_order");
    if (!$btn.length) {
      return;
    }

    if (isHighStarSelected() && !isReady) {
      $btn.prop("disabled", true).addClass("hsbt-awaiting-fields");
    } else {
      // Only release the lock we placed; don't fight WooCommerce's own state.
      if ($btn.hasClass("hsbt-awaiting-fields")) {
        $btn.prop("disabled", false).removeClass("hsbt-awaiting-fields");
      }
    }
  }

  function clearReadyTimer() {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  // Live, per-element readiness — the authoritative gate. isReady is a cached
  // latch of this; the submit path checks BOTH so a stale latch can't slip a
  // tokenization through against a frame that isn't actually interactive.
  function allElementsReady() {
    return elementReady.number && elementReady.expiry && elementReady.cvc;
  }

  function anyFieldDirty() {
    return fieldDirty.number || fieldDirty.expiry || fieldDirty.cvc;
  }

  function clearExhaustionRetryTimer() {
    if (exhaustionRetryTimer) {
      clearTimeout(exhaustionRetryTimer);
      exhaustionRetryTimer = null;
    }
  }

  // Reset the whole self-heal budget — call ONLY at genuine fresh-episode
  // boundaries (fields went ready, container replaced, method (re)selected, buyer
  // reloaded, bfcache restore). The grace extension is deliberately part of this
  // budget so it is granted ONCE PER EPISODE, not once per heal attempt — resetting
  // it on every remount is what would stack the stuck window to tens of seconds.
  function resetHealBudget() {
    healAttempts = 0;
    graceUsed = false;
    exhaustionRetryUsed = false;
    healInProgress = false;
    clearExhaustionRetryTimer();
  }

  // All three elements reported ready → the fields are genuinely interactive.
  function onAllElementsReady() {
    clearReadyTimer();
    isReady = true;
    isMounting = false;
    resetHealBudget();
    hideLoadingState();
    hideReloadOption();
    showError("");
    refreshCheckoutGate();
  }

  function markElementReady(key) {
    elementReady[key] = true;
    if (allElementsReady()) {
      onAllElementsReady();
    }
  }

  // Shared recovery for a mount that did NOT produce three interactive fields —
  // whether because the ready events timed out OR because init/mount threw.
  // Guidance #4: unmount+remount a bounded number of times, then fall back to a
  // visible reload control so the buyer is never stuck. If the buyer has already
  // typed into a field that came up, we DON'T silently wipe it with an automatic
  // remount — we go straight to the manual reload option instead.
  function recoverFromFailedMount() {
    if (isReady) {
      return; // raced with a late success — nothing to do
    }

    // The buyer switched to another method mid-load — don't burn the heal budget
    // or arm retries for a gateway that isn't even showing (guidance #1/#3).
    if (!isHighStarSelected()) {
      isMounting = false;
      refreshCheckoutGate();
      return;
    }

    // Mark the episode unresolved for the duration of this recovery, so a
    // concurrent updated_checkout can't mistake our own in-flight remount for a
    // fresh container and re-grant the heal budget.
    healInProgress = true;

    // Partial progress: the frames are still present and at least one field has
    // already become interactive, so the SDK + network are clearly working and a
    // slow frame is simply still downloading. Destroying it now would cancel that
    // in-flight download (Safari reloads a recreated iframe) and could turn a slow
    // load into a permanently dead one — the opposite of what we want. Grant ONE
    // non-destructive grace extension instead of remounting (guidance #1).
    if (
      !graceUsed &&
      hasMountedIframes() &&
      (elementReady.number || elementReady.expiry || elementReady.cvc)
    ) {
      graceUsed = true;
      startReadyTimer(mountGeneration);
      return;
    }

    if (anyFieldDirty()) {
      // The buyer has typed into a field that came up — never silently wipe it
      // with an automatic remount; offer a manual reload instead (guidance #4).
      isMounting = false;
      showReloadOption();
      refreshCheckoutGate();
      armExhaustionRetry();
      return;
    }

    if (healAttempts < MAX_HEAL_ATTEMPTS) {
      healAttempts += 1;
      // Tear the half-loaded frames down cleanly before trying again so we don't
      // stack iframes or leave a dead one in place.
      unmountCardElements();
      isMounting = false;
      mountCardElements();
      return;
    }

    // Out of automatic attempts — let the buyer trigger a fresh load themselves,
    // and arm one last delayed retry as a safety net for a static, idle page.
    isMounting = false;
    showReloadOption();
    refreshCheckoutGate();
    armExhaustionRetry();
  }

  // One-shot delayed retry after the reload control is surfaced. Fires only if we
  // are still stuck, nothing is being typed, and High Star is still selected —
  // then grants a fresh heal budget for a single more automatic attempt.
  function armExhaustionRetry() {
    if (exhaustionRetryUsed || exhaustionRetryTimer) {
      return;
    }
    exhaustionRetryTimer = setTimeout(function () {
      exhaustionRetryTimer = null;
      if (
        isReady ||
        isMounting ||
        !isHighStarSelected() ||
        anyFieldDirty()
      ) {
        return;
      }
      exhaustionRetryUsed = true;
      healAttempts = 0;
      graceUsed = false; // this delayed retry is a fresh cycle → fresh grace
      unmountCardElements();
      isMounting = false;
      lastMountAttemptAt = 0;
      scheduleMount();
    }, EXHAUSTION_RETRY_MS);
  }

  // Ready events didn't all arrive in time → run the shared recovery, but ONLY if
  // this watchdog still belongs to the current mount generation. A superseded
  // attempt's timer must never drive recovery for the live one (and must not taint
  // the submit handler's `!readyTimer` check).
  function handleReadyTimeout(generation) {
    readyTimer = null;
    if (generation !== mountGeneration) {
      return;
    }
    recoverFromFailedMount();
  }

  function startReadyTimer(generation) {
    clearReadyTimer();
    readyTimer = setTimeout(function () {
      handleReadyTimeout(generation);
    }, READY_TIMEOUT_MS);
  }

  // Tear down the current elements (used by the self-heal and before a rebuild).
  // Prefers the SDK's own unmount() (clean teardown of the cross-origin frame);
  // falls back to clearing the container if the method isn't available.
  function unmountCardElements() {
    const pairs = [
      [cardNumberElement, "#hsbt-card-number"],
      [cardExpirationDateElement, "#hsbt-card-expiry"],
      [cardVerificationCodeElement, "#hsbt-card-cvc"],
    ];

    pairs.forEach(function (pair) {
      const el = pair[0];
      const selector = pair[1];
      try {
        if (el && typeof el.unmount === "function") {
          el.unmount();
        } else {
          $(selector).empty();
        }
      } catch (e) {
        $(selector).empty();
      }
    });

    cardNumberElement = null;
    cardExpirationDateElement = null;
    cardVerificationCodeElement = null;
    isReady = false;
    elementReady.number = false;
    elementReady.expiry = false;
    elementReady.cvc = false;
    fieldDirty.number = false;
    fieldDirty.expiry = false;
    fieldDirty.cvc = false;
    // NOTE: graceUsed is intentionally NOT reset here. It is a per-EPISODE latch
    // (reset via resetHealBudget at genuine boundaries), so it must survive the
    // unmount+remount of a self-heal attempt — otherwise each heal would re-grant
    // a full grace window and stack the stuck time.
    // Drop the watchdog bound to the torn-down elements so it can't fire a stray
    // recovery or taint the submit handler's `!readyTimer` check.
    clearReadyTimer();
    // Invalidate any outstanding ready handlers from the torn-down elements.
    mountGeneration += 1;
  }

  // The checkout DOM was replaced out from under us (WooCommerce AJAX refresh, a
  // theme/Elementor re-render, or a mobile browser discarding the iframe): our
  // element objects now point at frames that no longer exist. Drop them so the
  // next mount rebuilds cleanly.
  function resetElementsIfCheckoutWasRefreshed() {
    if ((isReady || isMounting) && cardWrapperPresent() && !hasMountedIframes()) {
      cardNumberElement = null;
      cardExpirationDateElement = null;
      cardVerificationCodeElement = null;
      isReady = false;
      isMounting = false;
      elementReady.number = false;
      elementReady.expiry = false;
      elementReady.cvc = false;
      // NOTE: graceUsed and healInProgress are NOT reset here. This runs for our
      // OWN in-flight empty containers too (not only a genuine WooCommerce
      // replacement), so clearing the episode budget here would let a concurrent
      // updated_checkout re-grant grace/heal mid-recovery. They are reset only at
      // true boundaries via resetHealBudget().
      // Drop the watchdog bound to the now-destroyed elements (see above).
      clearReadyTimer();
      // Invalidate ready handlers bound to the now-destroyed elements.
      mountGeneration += 1;
    }
  }

  async function getBasisTheoryInstance(publicKey, environment) {
    if (typeof window.basistheory === "function") {
      return await window.basistheory(publicKey, {
        environment: environment,
        // Guidance #5: keep telemetry ON so Basis Theory receives the error and
        // performance reports from checkout and can see initialization failures
        // (like a cancelled frame load) directly. false is the SDK default; we
        // set it explicitly so it can never be silently turned off.
        disableTelemetry: false,
      });
    }

    if (window.BasisTheory && typeof window.BasisTheory.init === "function") {
      return await window.BasisTheory.init(publicKey, {
        elements: true,
        environment: environment,
        disableTelemetry: false,
      });
    }

    throw new Error("Basis Theory Elements failed to load.");
  }

  // Attach the ready (and, for the card number, brand-change) listeners to an
  // element. Listeners are wired before mount so we never miss an early ready.
  // `generation` pins the handler to the mount attempt that created the element:
  // a ready event from a superseded element (different generation) is ignored.
  function wireElementEvents(element, key, generation) {
    if (!element || typeof element.on !== "function") {
      return;
    }

    element.on("ready", function () {
      if (generation !== mountGeneration) {
        return; // stale ready from a previous (unmounted) element — ignore
      }
      markElementReady(key);
    });

    element.on("change", function (event) {
      // Remember (stickily) that the buyer has typed into this field, so a later
      // self-heal won't silently wipe what they entered.
      if (event && event.empty === false) {
        fieldDirty[key] = true;
      }

      // Card number drives the CVC element's brand-specific length/validation.
      if (
        key === "number" &&
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

  // Best-effort teardown of a single element (used to drop a superseded mount's
  // own frames without touching the current generation's state).
  function safeUnmount(element, selector) {
    try {
      if (element && typeof element.unmount === "function") {
        element.unmount();
      } else if (selector) {
        $(selector).empty();
      }
    } catch (e) {
      if (selector) {
        $(selector).empty();
      }
    }
  }

  async function mountCardElements() {
    // Capture the generation this attempt owns. Every `await` below yields to the
    // event loop, during which a checkout re-render (updated_checkout) or a
    // teardown can supersede us by bumping mountGeneration. We re-check after each
    // await and bail out cleanly if superseded, so two mounts can never race and
    // clobber each other's frames (guidance #1: mount once).
    let generation = mountGeneration;

    try {
      resetElementsIfCheckoutWasRefreshed();

      // Mount once (guidance #1): never rebuild while a mount is in flight or
      // while the fields are already up and interactive.
      if (isMounting || isReady) {
        return;
      }

      if (!window.hsbtData || !hsbtData.publicKey) {
        showError("High Star payment gateway is not configured.");
        return;
      }

      if (!cardWrapperPresent()) {
        return;
      }

      // Only mount when High Star is the active method (guidance #1/#2). Mounting
      // into a payment box that WooCommerce has hidden with display:none is a
      // known trigger for "mounted but never ready" on iOS Safari (hidden/offscreen
      // iframes get deprioritized), and would burn the self-heal budget for a
      // method the buyer isn't even using. payment_method_selected mounts us when
      // the buyer switches to High Star and the box becomes visible.
      if (!isHighStarSelected()) {
        return;
      }

      // Central data-loss guard (guidance #4): if frames are present and the buyer
      // has already typed into one that came up, NEVER destroy them with an
      // automatic rebuild — surface the manual reload instead. This single point
      // protects EVERY automatic caller (updated_checkout, the observer, the
      // settle timer, document.ready), not just the submit/method-switch paths.
      // Only the buyer-initiated reload button may intentionally discard input.
      // (We are past the isMounting/isReady guard, so !isReady holds here.)
      if (hasMountedIframes() && anyFieldDirty()) {
        healInProgress = true;
        showReloadOption();
        refreshCheckoutGate();
        armExhaustionRetry();
        return;
      }

      isMounting = true;
      lastMountAttemptAt = Date.now();
      showError("");
      hideReloadOption();
      showLoadingState();
      refreshCheckoutGate();

      // Reset per-element ready/dirty tracking for this attempt and advance the
      // generation so any late event from the previous elements is ignored.
      mountGeneration += 1;
      generation = mountGeneration;
      elementReady.number = false;
      elementReady.expiry = false;
      elementReady.cvc = false;
      fieldDirty.number = false;
      fieldDirty.expiry = false;
      fieldDirty.cvc = false;
      // graceUsed is per-episode (see resetHealBudget); a heal remount must NOT
      // re-grant grace, so it is deliberately not reset at mount start.
      isReady = false;

      // Arm the watchdog BEFORE initializing the SDK (guidance #4). It covers the
      // whole attempt — init, create AND mount+ready — so even if SDK init hangs
      // or never settles, recovery still runs instead of stranding isMounting=true.
      // Pinned to this generation so a superseded attempt's timer can't fire.
      startReadyTimer(generation);

      // We're about to (re)create the frames, so clear whatever is in the
      // containers first. This is the ONLY place a container is emptied, and only
      // right before we immediately mount fresh frames into it.
      $("#hsbt-card-number").empty();
      $("#hsbt-card-expiry").empty();
      $("#hsbt-card-cvc").empty();

      bt = await getBasisTheoryInstance(
        hsbtData.publicKey,
        hsbtData.environment || "us"
      );

      // Superseded during SDK init — a newer attempt owns the state and timer now.
      // Nothing was created yet, so just stand down.
      if (generation !== mountGeneration) {
        return;
      }

      const baseStyle = {
        color: "#222",
        fontSize: "16px",
        fontFamily: "Arial, sans-serif",
        "::placeholder": {
          color: "#999",
        },
      };

      const numberEl = bt.createElement("cardNumber", {
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

      const expiryEl = bt.createElement("cardExpirationDate", {
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

      const cvcEl = bt.createElement("cardVerificationCode", {
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

      cardNumberElement = numberEl;
      cardExpirationDateElement = expiryEl;
      cardVerificationCodeElement = cvcEl;

      // Wire ready/brand listeners BEFORE mounting so no early ready is missed.
      wireElementEvents(numberEl, "number", generation);
      wireElementEvents(expiryEl, "expiry", generation);
      wireElementEvents(cvcEl, "cvc", generation);

      await Promise.all([
        numberEl.mount("#hsbt-card-number"),
        expiryEl.mount("#hsbt-card-expiry"),
        cvcEl.mount("#hsbt-card-cvc"),
      ]);

      // Superseded while mounting — our frames are orphans (a newer attempt may
      // already own the containers). Unmount ONLY our own element objects via the
      // locals; pass no selector so we never .empty() a shared container that the
      // newer generation may have already mounted its live frames into (that would
      // kill them and recreate the dead-field symptom). Leave all shared
      // state/timers to the current generation.
      if (generation !== mountGeneration) {
        safeUnmount(numberEl, null);
        safeUnmount(expiryEl, null);
        safeUnmount(cvcEl, null);
        return;
      }

      // NOTE: we intentionally do NOT set isReady here. The frames are now
      // mounted, but "mounted" is not "ready" — the interactive code may still be
      // downloading. isReady flips only when all three `ready` events fire (see
      // onAllElementsReady), which is the whole point of this fix.
    } catch (error) {
      console.error("Basis Theory init/mount error:", error);

      // A newer attempt already took over — let it handle recovery.
      if (generation !== mountGeneration) {
        return;
      }

      clearReadyTimer();
      isReady = false;
      hideLoadingState();
      showError(
        error && error.message
          ? error.message
          : "Could not initialize card fields."
      );
      // Treat a mount/init failure exactly like a ready-timeout: self-heal a
      // bounded number of times, then surface the reload control (guidance #4) —
      // so the buyer always has a path forward instead of a dead-end error.
      recoverFromFailedMount();
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

    // VIP (recurring) products only: also mint a REUSABLE Basis Theory card
    // token so HighStar can charge future billing cycles. It stores number +
    // expiration but NOT the CVC (a CVC can't be retained for later
    // merchant-initiated charges, and off-session renewals don't need it).
    // Best-effort: a failure here never blocks the sale — the initial charge
    // still proceeds; recurring simply won't have a saved reference yet.
    if (window.hsbtData && hsbtData.vip) {
      try {
        await createReusableToken();
      } catch (reusableError) {
        console.warn(
          "High Star: reusable card token creation failed; recurring billing will have no saved method.",
          reusableError
        );
      }
    }

    return tokenIntent.id;
  }

  async function createReusableToken() {
    if (!bt || !cardNumberElement || !cardExpirationDateElement) {
      throw new Error("Card fields are not ready yet.");
    }

    const token = await bt.tokens.create({
      type: "card",
      data: {
        number: cardNumberElement,
        expiration_month: cardExpirationDateElement.month(),
        expiration_year: cardExpirationDateElement.year(),
      },
    });

    if (!token || !token.id) {
      throw new Error("Reusable card tokenization failed.");
    }

    $("#hsbt_reusable_token_id").val(token.id);
    return token.id;
  }

  // ---------------------------------------------------------------------------
  // Mount scheduling (guidance #1: mount once, don't thrash the container).
  //
  // WooCommerce's checkout AJAX (update_checkout) replaces the payment markup
  // with fresh empty containers, which unavoidably destroys the iframes — a
  // gateway plugin can't stop that. What we CAN control is WHEN we mount into
  // the new containers. If we mount immediately and WooCommerce (or a theme)
  // fires another re-render a moment later while the frame code is still
  // downloading, that download is cancelled and the field is left dead — the
  // exact failure Basis Theory described.
  //
  // So instead of re-mounting on every event, we debounce: each trigger pushes
  // the mount back, and we only mount once the DOM has been QUIET for a short
  // settle window. That guarantees we never mount into a container that is about
  // to be replaced again.
  // ---------------------------------------------------------------------------
  const MOUNT_SETTLE_MS = 450;
  const REMOUNT_COOLDOWN_MS = 1500;
  let mountSettleTimer = null;
  let observerStarted = false;

  function scheduleMount() {
    // A mount is already in flight — never arm a second one (guidance #1: mount
    // once). Callers that genuinely need to supersede an in-flight mount first
    // clear it via resetElementsIfCheckoutWasRefreshed(), which runs before they
    // call scheduleMount().
    if (isMounting) {
      return;
    }
    // Fields are already up and interactive — don't disturb them (guidance #1).
    if (isReady && hasMountedIframes()) {
      return;
    }
    // Reset the settle timer on every trigger so we mount only after the DOM has
    // gone quiet (no further re-renders for MOUNT_SETTLE_MS).
    if (mountSettleTimer) {
      clearTimeout(mountSettleTimer);
    }
    mountSettleTimer = setTimeout(function () {
      mountSettleTimer = null;
      mountCardElements();
    }, MOUNT_SETTLE_MS);
  }

  // Observer-driven recovery for re-renders that DON'T fire a WooCommerce event
  // (theme/Elementor rebuilds, a mobile browser discarding an off-screen frame).
  // It only acts when our container is present but its iframes have vanished, is
  // throttled against a failing-mount loop, and no-ops once the frames are back —
  // so it can't spin or fight a healthy mount.
  function remountIfFieldsMissing() {
    if (isMounting) {
      return; // a mount is finishing; it will populate the frames itself
    }
    if (!cardWrapperPresent()) {
      return; // gateway markup isn't on the page (different method / not checkout)
    }
    if (hasMountedIframes()) {
      return; // frames are present — nothing to recover
    }
    if (Date.now() - lastMountAttemptAt < REMOUNT_COOLDOWN_MS) {
      return; // just attempted; let the settle/ready-timeout logic run its course
    }
    scheduleMount();
  }

  let observerCheckTimer = null;
  function scheduleObserverCheck() {
    // Debounce: DOM mutations arrive in bursts; coalesce them into one check.
    if (observerCheckTimer) {
      return;
    }
    observerCheckTimer = setTimeout(function () {
      observerCheckTimer = null;
      remountIfFieldsMissing();
    }, 250);
  }

  function startCheckoutObserver() {
    if (observerStarted || typeof window.MutationObserver === "undefined") {
      return;
    }
    // Watch the whole document body so a full-section re-render by the theme /
    // Elementor is caught too (not just WooCommerce's in-form fragment swap).
    // The callback is a cheap no-op unless our iframes have actually vanished,
    // so unrelated page mutations cost next to nothing and never trigger a mount.
    const observer = new MutationObserver(scheduleObserverCheck);
    observer.observe(document.body, { childList: true, subtree: true });
    observerStarted = true;
  }

  // WooCommerce replaced the payment markup (address/shipping/coupon change) —
  // the containers are fresh and empty, so (re)mount after the DOM settles. We
  // also re-apply the Place Order gate because WooCommerce rebuilds the button
  // in an enabled state on every update.
  $(document.body).on("updated_checkout", function () {
    // The payment markup was just replaced, so our iframes are already gone even
    // though isReady may still read true from the previous render. Drop that
    // stale state FIRST so the Place Order gate immediately reflects "fields not
    // ready" and can't briefly allow a submit into dead frames.
    resetElementsIfCheckoutWasRefreshed();

    // A genuine markup replacement (fresh, empty containers) is a clean slate and
    // deserves a fresh self-heal budget — BUT only when we're not already in the
    // middle of a stuck-episode recovery. A page that fires updated_checkout often
    // (shipping / coupon / totals pollers) must not perpetually cancel the pending
    // exhaustion retry or re-grant the heal budget, which would un-bound the heal
    // loop and disarm the idle-page safety net. An active recovery — the reload
    // control is visible, or an exhaustion retry is already armed — is left intact.
    if (cardWrapperPresent() && !hasMountedIframes()) {
      // An unresolved recovery episode (healInProgress) means our OWN in-flight
      // remount emptied the containers — not a fresh WooCommerce replacement — so
      // we must not re-grant the budget. The timer/reload-visible terms are extra
      // belt-and-suspenders; healInProgress is the durable signal that survives the
      // mid-recovery unmount and mountCardElements' hideReloadOption().
      const stuckEpisodeActive =
        healInProgress ||
        !!exhaustionRetryTimer ||
        $("#hsbt-card-reload").is(":visible");
      if (!stuckEpisodeActive) {
        resetHealBudget();
      }
    }

    refreshCheckoutGate();
    scheduleMount();
  });

  // Switching the selected payment method does NOT destroy our iframes —
  // WooCommerce hides the unselected payment boxes with CSS and shows them again
  // on reselect (guidance #2: hide, don't remove). So healthy, already-interactive
  // fields are left completely alone.
  $(document.body).on("payment_method_selected", function () {
    refreshCheckoutGate();

    if (!isHighStarSelected()) {
      return; // another method is active — nothing for us to do
    }

    // Already up and interactive — leave it be (guidance #1: don't re-mount).
    if (isReady && hasMountedIframes()) {
      return;
    }

    // The buyer just switched TO High Star and its box is now visible. Give a
    // fresh self-heal budget and (re)build.
    resetHealBudget();

    // A present-but-not-ready frame that already holds typed data must not be
    // silently wiped by a rebuild — offer a manual reload instead (guidance #4).
    if (!isMounting && hasMountedIframes() && !isReady && anyFieldDirty()) {
      showReloadOption();
      refreshCheckoutGate();
      return;
    }

    // A dead frame pre-mounted while the box was hidden (no typed data) — drop it
    // so we rebuild cleanly in the now-visible container.
    if (!isMounting && hasMountedIframes() && !isReady) {
      unmountCardElements();
    }
    scheduleMount();
  });

  // Any failed checkout (card decline, backend/technical error, lost response)
  // invalidates the token-intent used for that attempt — drop it so the next
  // Place Order mints a fresh one instead of re-sending a consumed/expired
  // token-intent (which is what produced "Failed to find one or more token
  // intent values"). WooCommerce fires this on every failed place-order.
  $(document.body).on("checkout_error", function () {
    clearTokenIntentForRetry();
  });

  // Manual reload control (guidance #4): a buyer whose fields never came up can
  // force a fresh load without refreshing the whole page (which would lose the
  // address they already typed). Resets the self-heal budget and rebuilds.
  $(document).on("click", "#hsbt-card-reload-btn", function (e) {
    e.preventDefault();
    hideReloadOption();
    showError("");
    resetHealBudget();
    unmountCardElements();
    isMounting = false;
    lastMountAttemptAt = 0; // allow an immediate rebuild
    scheduleMount();
  });

  // Back/forward-cache restore (common on mobile Safari when the buyer navigates
  // back to checkout): cross-origin card frames are very likely stale because the
  // browser reloads iframes on restore. Don't trust latched readiness — tear the
  // old frames down and rebuild so the buyer never lands on visible-but-dead
  // fields (guidance #1/#3).
  $(window).on("pageshow", function (e) {
    const original = e && e.originalEvent;
    if (!original || !original.persisted) {
      return;
    }
    resetHealBudget();
    unmountCardElements();
    isMounting = false;
    lastMountAttemptAt = 0;
    refreshCheckoutGate();
    scheduleMount();
  });

  $(document).ready(function () {
    scheduleMount();
    startCheckoutObserver();
    refreshCheckoutGate();
  });

  $("form.checkout").on("checkout_place_order_hsbt_gateway", function () {
    if (!isHighStarSelected()) {
      return true;
    }

    // If the checkout DOM was swapped since the fields last became ready, our
    // iframes are gone but isReady can still read true — re-sync before gating so
    // we never tokenize against destroyed frames.
    resetElementsIfCheckoutWasRefreshed();

    // Guidance #3: never let a buyer submit into fields that aren't interactive
    // yet. We require the cached latch AND live per-element readiness AND present
    // iframes, so a stale latch (e.g. after a bfcache restore) can't slip a
    // tokenization through against a frame that isn't actually interactive.
    const fieldsUsable = isReady && allElementsReady() && hasMountedIframes();
    if (!fieldsUsable) {
      // Make sure a recovery is actually in flight. If nothing is pending (e.g. a
      // prior attempt already gave up and surfaced the reload control), clicking
      // Place Order itself kicks off a fresh mount instead of only showing text.
      if (!isMounting && !readyTimer) {
        if (anyFieldDirty()) {
          // The buyer already typed a card — surface the manual reload (its own
          // message explains) rather than wiping their input with a rebuild.
          showReloadOption();
        } else {
          resetHealBudget();
          if (hasMountedIframes()) {
            unmountCardElements();
          }
          scheduleMount();
          showError(
            "The secure card fields are still loading. Please wait a moment and try again."
          );
        }
      } else {
        // A mount/recovery is already in flight — just ask them to wait.
        showError(
          "The secure card fields are still loading. Please wait a moment and try again."
        );
      }
      refreshCheckoutGate();
      return false;
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

    // Tokenize the card, then submit. A tokenization failure reaches .catch and
    // shows an inline error without submitting the checkout form.
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
