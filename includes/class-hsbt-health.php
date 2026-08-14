<?php
/**
 * High Star Payment Gateway - Plugin Monitoring health endpoint.
 *
 * Exposes a public, read-only REST route the High Star backend polls to monitor
 * every merchant store:
 *
 *   GET  /wp-json/highstar/v1/health
 *
 * The monitoring sweep (cron, every 24h) and the admin "Check Now" action both
 * call this endpoint and read the JSON snapshot below. It self-reports one of
 * three health states — Healthy / Warning / Error — plus the plugin, WooCommerce,
 * WordPress and PHP versions so the admin dashboard can flag outdated or
 * mis-configured installs.
 *
 * The route is intentionally PUBLIC (no auth): the monitor identifies itself only
 * by User-Agent, and the response carries no secrets — never the API/proxy keys,
 * never customer data. It only reports whether the gateway is present, enabled,
 * and configured (booleans), plus non-sensitive environment versions.
 *
 * Fail-safe: registered at the top level (independent of the gateway class) so it
 * still answers — reporting wooCommerceActive:false / healthStatus:Error — even
 * when WooCommerce itself is inactive. That lets the monitor tell "site up but
 * Woo down" apart from "site unreachable".
 *
 * @package HighStar\Gateway
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!class_exists('HSBT_Health')) {

    /**
     * Registers and answers the /wp-json/highstar/v1/health monitoring endpoint.
     */
    class HSBT_Health {

        /** REST namespace + route. Full path: /wp-json/highstar/v1/health. */
        const REST_NAMESPACE = 'highstar/v1';
        const REST_ROUTE     = '/health';

        /** WooCommerce payment gateway id this plugin registers. */
        const GATEWAY_ID = 'hsbt_gateway';

        /**
         * Register hooks. Called once when this file is loaded.
         *
         * @return void
         */
        public static function init() {
            add_action('rest_api_init', array(__CLASS__, 'register_routes'));
        }

        /**
         * Register the public health route.
         *
         * @return void
         */
        public static function register_routes() {
            register_rest_route(
                self::REST_NAMESPACE,
                self::REST_ROUTE,
                array(
                    'methods'  => 'GET',
                    'callback' => array(__CLASS__, 'handle'),
                    // Public: the backend monitor authenticates only by User-Agent
                    // and the response exposes no secrets. A permission callback is
                    // still required by the REST API, so return true explicitly.
                    'permission_callback' => '__return_true',
                )
            );
        }

        /**
         * Build the health snapshot the monitoring backend consumes.
         *
         * @return WP_REST_Response
         */
        public static function handle() {
            $started = microtime(true);

            $woo_active  = class_exists('WooCommerce');
            $woo_version = ($woo_active && defined('WC_VERSION')) ? WC_VERSION : null;

            // Is the gateway actually registered with WooCommerce? Prefer the live
            // registry; fall back to class existence if the registry isn't ready.
            $gateway_registered = false;
            if ($woo_active && function_exists('WC') && WC()->payment_gateways) {
                $gateways = WC()->payment_gateways->payment_gateways();
                $gateway_registered = isset($gateways[self::GATEWAY_ID]);
            } elseif (class_exists('WC_Gateway_HSBT')) {
                $gateway_registered = true;
            }

            // Read the saved gateway settings straight from the option so this
            // stays cheap and side-effect free (no gateway instantiation).
            $settings = get_option('woocommerce_' . self::GATEWAY_ID . '_settings', array());
            if (!is_array($settings)) {
                $settings = array();
            }

            $gateway_enabled = isset($settings['enabled']) && $settings['enabled'] === 'yes';

            $plugin_configured = !empty($settings['bt_public_key'])
                && !empty($settings['bt_private_key'])
                && !empty($settings['connected_account_id']);

            // Classify health. WooCommerce/gateway missing is a hard Error; a
            // disabled or unconfigured gateway is a Warning; everything wired up
            // and switched on is Healthy.
            if (!$woo_active) {
                $health  = 'Error';
                $message = 'WooCommerce is not active.';
            } elseif (!$gateway_registered) {
                $health  = 'Error';
                $message = 'High Star payment gateway is not registered with WooCommerce.';
            } elseif (!$plugin_configured) {
                $health  = 'Warning';
                $message = 'Gateway is not fully configured (API keys or Account ID missing).';
            } elseif (!$gateway_enabled) {
                $health  = 'Warning';
                $message = 'Gateway is installed but currently disabled.';
            } else {
                $health  = 'Healthy';
                $message = 'Plugin is active, configured, and enabled.';
            }

            $response_ms = (int) round((microtime(true) - $started) * 1000);

            $payload = array(
                'pluginInstalled'    => true,
                'pluginActive'       => true,
                'pluginVersion'      => defined('HSBT_VERSION') ? HSBT_VERSION : null,
                'gatewayRegistered'  => $gateway_registered,
                'gatewayEnabled'     => $gateway_enabled,
                'gatewayStatus'      => $gateway_enabled ? 'enabled' : 'disabled',
                'pluginConfigured'   => $plugin_configured,
                'wooCommerceActive'  => $woo_active,
                'wooCommerceVersion' => $woo_version,
                'wordPressVersion'   => get_bloginfo('version'),
                'phpVersion'         => PHP_VERSION,
                'siteName'           => get_bloginfo('name'),
                'siteUrl'            => home_url(),
                'environment'        => function_exists('wp_get_environment_type')
                    ? wp_get_environment_type()
                    : 'production',
                'paymentGatewayId'   => self::GATEWAY_ID,
                'healthStatus'       => $health,
                'statusMessage'      => $message,
                'responseTime'       => $response_ms . 'ms',
                'timestamp'          => gmdate('c'),
            );

            return new WP_REST_Response($payload, 200);
        }
    }

    HSBT_Health::init();
}
