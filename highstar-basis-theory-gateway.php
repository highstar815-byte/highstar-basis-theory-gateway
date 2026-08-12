<?php
/**
 * Plugin Name: High Star Payment Gateway
 * Description: WooCommerce custom payment gateway using Secure payment gateway configuration.
 * Version: 0.2.7
 * Author: High Star Payments
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * WC requires at least: 7.0
 * Update URI: https://github.com/highstarpayments/highstar-basis-theory-gateway
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Plugin constants. Each guarded with defined() so a double-load cannot fatal.
 */
if (!defined('HSBT_VERSION')) {
    define('HSBT_VERSION', '0.2.7');
}
if (!defined('HSBT_PLUGIN_FILE')) {
    define('HSBT_PLUGIN_FILE', __FILE__);
}
if (!defined('HSBT_PLUGIN_DIR')) {
    define('HSBT_PLUGIN_DIR', plugin_dir_path(__FILE__));
}
if (!defined('HSBT_PLUGIN_URL')) {
    define('HSBT_PLUGIN_URL', plugin_dir_url(__FILE__));
}

/**
 * GitHub Releases based updater. Loaded only if present so a missing updater
 * file can never break checkout (fail-safe: the gateway keeps working).
 */
if (file_exists(HSBT_PLUGIN_DIR . 'includes/class-hsbt-updater.php')) {
    require_once HSBT_PLUGIN_DIR . 'includes/class-hsbt-updater.php';
}

add_action('plugins_loaded', 'hsbt_init_gateway');

function hsbt_init_gateway() {
    if (!class_exists('WC_Payment_Gateway')) {
        return;
    }

    class WC_Gateway_HSBT extends WC_Payment_Gateway {

        public function __construct() {
            $this->id                 = 'hsbt_gateway';
            $this->method_title       = 'High Star Payments';
            $this->method_description = 'Secure payment gateway configuration.';
            $this->has_fields         = true;
            $this->supports           = array('products');

            // Hardcoded values requested by client.
            $this->highstar_api_url     = 'https://highstarpayments.com/api/payments/create';
            $this->bt_environment       = 'us';

            $this->init_form_fields();
            $this->init_settings();

            $this->enabled              = $this->get_option('enabled');
            $this->title                = $this->get_option('title');
            $this->description          = $this->get_option('description');

            $this->bt_public_key        = $this->get_option('bt_public_key');
            $this->bt_private_key       = $this->get_option('bt_private_key');
            $this->connected_account_id = $this->get_option('connected_account_id');

            add_action(
                'woocommerce_update_options_payment_gateways_' . $this->id,
                array($this, 'process_admin_options')
            );

            add_action('wp_enqueue_scripts', array($this, 'enqueue_scripts'));
        }

        public function init_form_fields() {
            $this->form_fields = array(
                'enabled' => array(
                    'title'   => 'Enable/Disable',
                    'type'    => 'checkbox',
                    'label'   => 'Enable High Star Payments',
                    'default' => 'yes',
                ),

                'title' => array(
                    'title'   => 'Title',
                    'type'    => 'text',
                    'default' => 'Credit Card',
                ),

                'description' => array(
                    'title'   => 'Description',
                    'type'    => 'textarea',
                    'default' => 'Pay securely by card.',
                ),

                'bt_public_key' => array(
                    'title' => 'Public API Key',
                    'type'  => 'text',
                ),

                'bt_private_key' => array(
                    'title' => 'Private/Proxy Key',
                    'type'  => 'password',
                ),

                'connected_account_id' => array(
                    'title' => 'Account ID',
                    'type'  => 'text',
                ),
            );
        }

        public function payment_fields() {
            if ($this->description) {
                echo wpautop(wp_kses_post($this->description));
            }

            echo '<div id="hsbt-card-wrapper" style="margin:10px 0;">';
            echo '  <div id="hsbt-card-number" style="min-height:44px;padding:12px;border:1px solid #ddd;border-radius:6px;margin-bottom:10px;background:#fff;"></div>';
            echo '  <div style="display:flex;gap:10px;">';
            echo '    <div id="hsbt-card-expiry" style="width:50%;min-height:44px;padding:12px;border:1px solid #ddd;border-radius:6px;background:#fff;"></div>';
            echo '    <div id="hsbt-card-cvc" style="width:50%;min-height:44px;padding:12px;border:1px solid #ddd;border-radius:6px;background:#fff;"></div>';
            echo '  </div>';
            echo '</div>';

            echo '<input type="hidden" name="hsbt_token_intent_id" id="hsbt_token_intent_id" value="">';
            echo '<div id="hsbt-card-error" style="color:red;margin-top:8px;font-size:14px;"></div>';
        }

        public function enqueue_scripts() {
            if (!is_checkout() || $this->enabled !== 'yes') {
                return;
            }

            wp_enqueue_script(
                'hsbt-basis-theory-elements',
                'https://js.basistheory.com/web-elements/2.12.2/index.js',
                array(),
                null,
                true
            );

            wp_enqueue_script(
                'hsbt-checkout',
                HSBT_PLUGIN_URL . 'assets/bt-checkout.js',
                array('jquery', 'hsbt-basis-theory-elements'),
                HSBT_VERSION,
                true
            );

            wp_localize_script('hsbt-checkout', 'hsbtData', array(
                'publicKey'   => $this->bt_public_key,
                'environment' => 'us',
                'gatewayId'   => $this->id,
            ));
        }

        private function get_error_message($result, $fallback = 'Payment failed.') {
            if (!empty($result['error']['message'])) {
                return $result['error']['message'];
            }

            if (!empty($result['message'])) {
                return $result['message'];
            }

            if (!empty($result['error'])) {
                return is_string($result['error']) ? $result['error'] : $fallback;
            }

            return $fallback;
        }

        private function clean_meta_value($value, $max_length = 450) {
            $value = is_scalar($value) ? (string) $value : '';
            $value = wp_strip_all_tags($value);
            $value = preg_replace('/\s+/', ' ', $value);
            $value = trim($value);

            if (strlen($value) > $max_length) {
                $value = substr($value, 0, $max_length);
            }

            return $value;
        }

        private function get_customer_name($order) {
            $name = trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name());

            if (empty($name)) {
                $name = $order->get_billing_email();
            }

            return $name;
        }

        private function get_shipping_name($order) {
            $shipping_name = trim($order->get_shipping_first_name() . ' ' . $order->get_shipping_last_name());

            if (empty($shipping_name)) {
                $shipping_name = $this->get_customer_name($order);
            }

            return $shipping_name;
        }

        private function get_plain_billing_address($order) {
            $parts = array_filter(array(
                $order->get_billing_address_1(),
                $order->get_billing_address_2(),
                $order->get_billing_city(),
                $order->get_billing_state(),
                $order->get_billing_postcode(),
                $order->get_billing_country(),
            ));

            return implode(', ', $parts);
        }

        private function get_plain_shipping_address($order) {
            $line1 = $order->get_shipping_address_1();
            if (empty($line1)) {
                $line1 = $order->get_billing_address_1();
            }

            $line2 = $order->get_shipping_address_2();
            if (empty($line2)) {
                $line2 = $order->get_billing_address_2();
            }

            $city = $order->get_shipping_city();
            if (empty($city)) {
                $city = $order->get_billing_city();
            }

            $state = $order->get_shipping_state();
            if (empty($state)) {
                $state = $order->get_billing_state();
            }

            $postcode = $order->get_shipping_postcode();
            if (empty($postcode)) {
                $postcode = $order->get_billing_postcode();
            }

            $country = $order->get_shipping_country();
            if (empty($country)) {
                $country = $order->get_billing_country();
            }

            $parts = array_filter(array(
                $line1,
                $line2,
                $city,
                $state,
                $postcode,
                $country,
            ));

            return implode(', ', $parts);
        }

        private function get_line_items_payload($order) {
            $items = array();

            foreach ($order->get_items() as $item_id => $item) {
                $product = $item->get_product();

                $items[] = array(
                    'name'       => $this->clean_meta_value($item->get_name(), 200),
                    'quantity'   => (int) $item->get_quantity(),
                    'subtotal'   => (string) $order->get_line_subtotal($item, false, false),
                    'total'      => (string) $order->get_line_total($item, false, false),
                    'product_id' => $product ? (string) $product->get_id() : '',
                    'sku'        => $product ? $this->clean_meta_value($product->get_sku(), 100) : '',
                );
            }

            return $items;
        }

        private function call_highstar_backend($payload, $order) {
            $api_url = esc_url_raw($this->highstar_api_url);

            $headers = array(
                'Content-Type' => 'application/json',
                'Accept'       => 'application/json',
            );

            $response = wp_remote_post($api_url, array(
                'timeout' => 60,
                'headers' => $headers,
                'body'    => wp_json_encode($payload),
            ));

            if (is_wp_error($response)) {
                return array(
                    'success' => false,
                    'message' => $response->get_error_message(),
                );
            }

            $status_code = (int) wp_remote_retrieve_response_code($response);
            $raw_body    = wp_remote_retrieve_body($response);
            $result      = json_decode($raw_body, true);

            if (!is_array($result)) {
                return array(
                    'success' => false,
                    'message' => 'Invalid response from High Star backend.',
                    'status'  => $status_code,
                );
            }

            if ($status_code < 200 || $status_code >= 300) {
                return array(
                    'success' => false,
                    'message' => $this->get_error_message($result, 'High Star backend payment failed.'),
                    'status'  => $status_code,
                    'result'  => $result,
                );
            }

            return array(
                'success' => true,
                'status'  => $status_code,
                'result'  => $result,
            );
        }

        public function process_payment($order_id) {
            $order = wc_get_order($order_id);

            if (!$order) {
                wc_add_notice('Invalid order.', 'error');
                return array('result' => 'failure');
            }

            $token_intent_id = isset($_POST['hsbt_token_intent_id'])
                ? sanitize_text_field($_POST['hsbt_token_intent_id'])
                : '';

            if (empty($token_intent_id)) {
                wc_add_notice('Card tokenization failed. Please try again.', 'error');
                return array('result' => 'failure');
            }

            if (
                empty($this->bt_private_key) ||
                empty($this->connected_account_id)
            ) {
                wc_add_notice('Payment gateway is not configured.', 'error');
                return array('result' => 'failure');
            }

            $amount   = (int) round((float) $order->get_total() * 100);
            $currency = strtolower($order->get_currency());

            $billing_name    = $this->get_customer_name($order);
            $shipping_name   = $this->get_shipping_name($order);
            $billing_address = $this->get_plain_billing_address($order);
            $shipping_addr   = $this->get_plain_shipping_address($order);

            $payload = array(
                'account_id'        => $this->connected_account_id,
                'token_intent_id'   => $token_intent_id,
                'private_proxy_key' => $this->bt_private_key,

                'amount'      => $amount,
                'currency'    => $currency,
                'order_id'    => (string) $order_id,
                'order_key'   => $order->get_order_key(),
                'order_total' => (string) $order->get_total(),

                'customer_data' => array(
                    'id'    => (string) $order->get_customer_id(),
                    'name'  => $billing_name,
                    'email' => $order->get_billing_email(),
                    'phone' => $order->get_billing_phone(),
                ),

                'billing_data' => array(
                    'first_name'  => $order->get_billing_first_name(),
                    'last_name'   => $order->get_billing_last_name(),
                    'name'        => $billing_name,
                    'email'       => $order->get_billing_email(),
                    'phone'       => $order->get_billing_phone(),
                    'address'     => $billing_address,
                    'line1'       => $order->get_billing_address_1(),
                    'line2'       => $order->get_billing_address_2(),
                    'city'        => $order->get_billing_city(),
                    'state'       => $order->get_billing_state(),
                    'postal_code' => $order->get_billing_postcode(),
                    'country'     => $order->get_billing_country(),
                ),

                'shipping_data' => array(
                    'name'        => $shipping_name,
                    'phone'       => $order->get_billing_phone(),
                    'address'     => $shipping_addr,
                    'line1'       => $order->get_shipping_address_1() ? $order->get_shipping_address_1() : $order->get_billing_address_1(),
                    'line2'       => $order->get_shipping_address_2() ? $order->get_shipping_address_2() : $order->get_billing_address_2(),
                    'city'        => $order->get_shipping_city() ? $order->get_shipping_city() : $order->get_billing_city(),
                    'state'       => $order->get_shipping_state() ? $order->get_shipping_state() : $order->get_billing_state(),
                    'postal_code' => $order->get_shipping_postcode() ? $order->get_shipping_postcode() : $order->get_billing_postcode(),
                    'country'     => $order->get_shipping_country() ? $order->get_shipping_country() : $order->get_billing_country(),
                    'method'      => $order->get_shipping_method(),
                ),

                'metadata' => array(
                    'woo_order_id'      => (string) $order_id,
                    'payment_source'    => 'WooCommerce',
                    'gateway'           => 'High Star Payment Gateway',
                    'charge_type'       => 'direct_charge',
                    'connected_account' => $this->connected_account_id,
                    'customer_email'    => $this->clean_meta_value($order->get_billing_email()),
                    'customer_phone'    => $this->clean_meta_value($order->get_billing_phone()),
                    'order_currency'    => $this->clean_meta_value($order->get_currency()),
                    'order_total'       => $this->clean_meta_value($order->get_total()),
                ),

                'line_items' => $this->get_line_items_payload($order),
                'idempotency_key' => 'woo_' . $order_id . '_' . $order->get_order_key(),
            );

            $api_result = $this->call_highstar_backend($payload, $order);

            if (empty($api_result['success'])) {
                $message = !empty($api_result['message'])
                    ? $api_result['message']
                    : 'Payment failed through High Star backend.';

                $order->add_order_note('High Star backend payment failed: ' . $message);
                wc_add_notice($message, 'error');

                return array('result' => 'failure');
            }

            $result = $api_result['result'];

            if (empty($result['success'])) {
                $message = $this->get_error_message($result, 'Payment failed.');
                $order->add_order_note('High Star backend payment failed: ' . $message);
                wc_add_notice($message, 'error');

                return array('result' => 'failure');
            }

            $payment_intent_id = !empty($result['payment_intent_id']) ? $result['payment_intent_id'] : '';
            $stripe_status     = !empty($result['status']) ? $result['status'] : '';
            $app_fee_amount    = isset($result['application_fee_amount']) ? (int) $result['application_fee_amount'] : 0;

            $order->add_order_note('High Star backend payment status: ' . $stripe_status);

            if (!empty($payment_intent_id)) {
                $order->add_order_note('Stripe PaymentIntent ID: ' . $payment_intent_id);
            }

            $order->add_order_note('Direct charge connected account: ' . $this->connected_account_id);

            if ($app_fee_amount > 0) {
                $order->add_order_note(
                    'Application fee amount: ' . wc_price($app_fee_amount / 100, array('currency' => strtoupper($currency)))
                );
            }

            if (in_array($stripe_status, array('succeeded', 'processing'), true)) {
                $order->payment_complete($payment_intent_id);
                $order->add_order_note('Payment successful through High Star backend. Stripe PaymentIntent: ' . $payment_intent_id);

                WC()->cart->empty_cart();

                return array(
                    'result'   => 'success',
                    'redirect' => $this->get_return_url($order),
                );
            }

            if ($stripe_status === 'requires_action') {
                wc_add_notice('This card requires additional authentication. Please use another card or try again.', 'error');
                return array('result' => 'failure');
            }

            $message = 'Payment failed. Stripe status: ' . $stripe_status;
            $order->add_order_note($message);
            wc_add_notice($message, 'error');

            return array('result' => 'failure');
        }
    }
}

add_filter('woocommerce_payment_gateways', 'hsbt_add_gateway');

function hsbt_add_gateway($gateways) {
    $gateways[] = 'WC_Gateway_HSBT';
    return $gateways;
}
