=== High Star Payment Gateway ===
Contributors: highstarpayments
Tags: woocommerce, payment gateway, credit card, basis theory, tokenization
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
WC requires at least: 7.0
Stable tag: 0.3.3
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

WooCommerce custom payment gateway that tokenizes cards in the browser and charges through the secure High Star backend.

== Description ==

High Star Payment Gateway adds a WooCommerce credit-card payment method that
collects card details in Basis Theory hosted fields (so the raw card number
never touches the store), creates a token intent in the browser, and completes
the charge server-side through the High Star backend.

Updates are delivered straight from GitHub Releases, so merchants get the normal
"Update Now" button on the Plugins page instead of uploading a ZIP by hand.

== Installation ==

1. Upload the `highstar-basis-theory-gateway` folder to `/wp-content/plugins/`.
2. Activate the plugin through the "Plugins" menu in WordPress.
3. Go to WooCommerce > Settings > Payments > High Star Payments and enter your
   Public API Key, Private/Proxy Key, and Account ID.  

== Frequently Asked Questions ==

= How do updates work? =

The plugin checks its GitHub repository for new tagged releases and shows a
standard WordPress update notice. Patch releases (only the third number changes)
may install automatically; minor and major releases always wait for a manual
click, so a human ships every change that could affect checkout.

= Do I need a GitHub token? =

No. The repository is public, so updates download without any credentials. A
token is only needed for a private repository, and it would ship to every store
in plain text - which is why it is left empty by default.

== Changelog ==

= 0.3.3 =
* Fixed the recurring "Failed to find one or more token intent values" error on
  retries. A Basis Theory token-intent is short-lived and single-use, but a
  failed Place Order used to keep re-sending the same (now consumed) token-intent
  on every retry. The checkout now drops the cached token-intent and its
  idempotency nonce on any checkout failure, so the next attempt tokenizes the
  card afresh. The card the shopper typed is untouched, so a retry needs no
  re-entry. Works together with the backend's new submission ledger + duplicate
  charge guard, which replay the first result for an identical resubmission and
  never charge an order twice (this also removes the Stripe "PaymentMethod was
  previously used" error).
* Note: a brief Stripe Radar Session integration was added and then removed
  during internal testing before this release, so there is no net change to Radar
  behaviour versus 0.3.2 (the checkout does not load Stripe.js).

= 0.3.2 =
* Fixed the card fields going blank/disappearing after scrolling or when the
  WooCommerce checkout re-renders (AJAX update, or a theme/Elementor re-render
  that doesn't fire WooCommerce's update event). The hosted card-field iframes
  are destroyed whenever that DOM is replaced; the checkout now watches for this
  and automatically re-mounts the fields, so they reappear without a page reload.
  No change to payment or tokenization behaviour.

= 0.3.1 =
* update plugin