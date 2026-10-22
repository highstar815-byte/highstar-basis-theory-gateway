=== High Star Payment Gateway ===
Contributors: highstarpayments
Tags: woocommerce, payment gateway, credit card, basis theory, tokenization
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 8.2
WC requires at least: 7.0
Stable tag: 0.3.5
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

= 0.3.5 =
* PHP 8.2-8.4 compatibility hardening (prompted by the Oct 2026 "php2shell"
  PHP-core security release, CVE-2026-109618 / CVE-2026-109619). The gateway's
  High Star / Basis Theory properties are now declared explicitly on the gateway
  class instead of being created dynamically in the constructor, so the plugin no
  longer emits "Creation of dynamic property" deprecation notices on PHP 8.2-8.4
  and remains safe on PHP 9.0 (where undeclared dynamic properties become a fatal
  error). Validated clean against PHP 8.4.27, the recommended patched runtime.
* Raised the minimum PHP requirement to 8.2 - the oldest PHP branch still
  receiving security fixes (8.1 and earlier are end-of-life and unpatched).
* No change to payment, tokenization, recurring/VIP, or checkout behaviour. The
  card flow, idempotency nonce, token-intent handling, and backend payload are
  byte-for-byte unchanged (this is a code-hardening patch only).
* Bumped "Tested up to" to WordPress 7.1 (latest stable) to clear the "not tested
  with your current version of WordPress" compatibility notice. Metadata only.

= 0.3.4 =
* Added support for VIP (recurring) products. When the cart contains a product
  tagged `VIP`, the checkout now additionally mints a reusable Basis Theory card
  token and passes its id to the backend so future billing cycles can be charged.
  Normal (non-VIP) products are unchanged - no reusable token is created. VIP
  detection is performed server-side so the browser cannot spoof it.

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