=== High Star Payment Gateway ===
Contributors: highstarpayments
Tags: woocommerce, payment gateway, credit card, basis theory, tokenization
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
WC requires at least: 7.0
Stable tag: 0.2.7
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

= 0.2.7 =
* Added automatic updates via GitHub Releases (Plugin Update Checker), so
  merchants get a normal "Update Now" button instead of installing a ZIP by hand.
* Added a version constant (HSBT_VERSION) plus plugin path/URL constants, and
  used the version constant to cache-bust the enqueued checkout script so buyers
  always receive the current bt-checkout.js after an update.

= 0.2.6 =
* Fixed mobile card-field mounting: the Basis Theory card number, expiry, and
  CVC fields now re-mount reliably when the checkout fragment is refreshed or the
  payment method is re-selected on mobile.
* Added dns-prefetch and preconnect resource hints for the Basis Theory host to
  speed up card-field loading on the checkout page.
