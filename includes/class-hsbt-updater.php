<?php
/**
 * High Star Payment Gateway - GitHub Releases updater.
 *
 * Wires the Plugin Update Checker (PUC) library to this plugin's GitHub
 * repository so merchants see a normal "Update Now" button on the Plugins page.
 *
 * Everything here is fail-safe: if PUC is missing, or the API surface differs,
 * or anything would otherwise throw, the payment gateway keeps working and
 * update checking simply goes quiet. No update HTTP calls ever run on checkout.
 *
 * @package HighStar\Gateway
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * GitHub personal access token used to authenticate update checks.
 *
 * Leave EMPTY for a public repository (this is the shipped default and the
 * correct value for this plugin). Only set a token for a PRIVATE repo.
 *
 * SECURITY WARNING: any token placed here is distributed in PLAIN TEXT to
 * EVERY merchant who installs the plugin. A leaked token can expose the whole
 * repository. Prefer a public repo; if the repo must stay private, use a
 * fine-grained, read-only token scoped to this single repository only.
 */
if (!defined('HSBT_GITHUB_TOKEN')) {
    define('HSBT_GITHUB_TOKEN', '');
}

if (!class_exists('HSBT_Updater')) {

    /**
     * Coordinates the PUC update checker, patch-only auto-updates, and the
     * version-compare upgrade routine.
     */
    class HSBT_Updater {

        /** GitHub repository that hosts the tagged releases. */
        const REPO_URL = 'https://github.com/highstar815-byte/highstar-basis-theory-gateway';

        /** Plugin slug. MUST match the installed plugin folder name. */
        const SLUG = 'highstar-basis-theory-gateway';

        /** Release branch to track. */
        const BRANCH = 'main';

        /** Option key that remembers the last-installed version for migrations. */
        const VERSION_OPTION = 'hsbt_installed_version';

        /**
         * Register all hooks. Called once when this file is loaded.
         *
         * @return void
         */
        public static function init() {
            // Build the update checker only in admin or during cron. Gating here
            // guarantees no update HTTP calls can ever run on the storefront /
            // checkout page. See setup_update_checker() for the runtime guard.
            add_action('init', array(__CLASS__, 'setup_update_checker'), 5);

            // Decide background auto-update eligibility (patch releases only).
            add_filter('auto_update_plugin', array(__CLASS__, 'filter_auto_update'), 10, 2);

            // Run forward-only migrations after all plugins have loaded.
            add_action('plugins_loaded', array(__CLASS__, 'maybe_upgrade'), 20);
        }

        /**
         * Build and configure the PUC update checker.
         *
         * Fail-safe at every step: a missing library or an unexpected API simply
         * returns without touching anything.
         *
         * @return void
         */
        public static function setup_update_checker() {
            // Belt-and-suspenders: never run update checks off the admin/cron path.
            if (!is_admin() && !wp_doing_cron()) {
                return;
            }

            $puc = HSBT_PLUGIN_DIR . 'lib/plugin-update-checker/plugin-update-checker.php';

            // Fail safe: no library, no updates - but the gateway still works.
            if (!file_exists($puc)) {
                return;
            }

            require_once $puc;

            $factory = '\\YahnisElsts\\PluginUpdateChecker\\v5\\PucFactory';
            if (!class_exists($factory)) {
                return;
            }

            $update_checker = $factory::buildUpdateChecker(
                self::REPO_URL,
                HSBT_PLUGIN_FILE,
                self::SLUG
            );

            if (!is_object($update_checker)) {
                return;
            }

            if (method_exists($update_checker, 'setBranch')) {
                $update_checker->setBranch(self::BRANCH);
            }

            // Pull the ZIP attached to each GitHub Release instead of GitHub's
            // auto-generated source archive (which would carry the wrong folder
            // name and dev-only files). Guarded so a PUC build lacking the method
            // cannot fatal.
            if (method_exists($update_checker, 'getVcsApi')) {
                $vcs_api = $update_checker->getVcsApi();
                if (is_object($vcs_api) && method_exists($vcs_api, 'enableReleaseAssets')) {
                    $vcs_api->enableReleaseAssets();
                }
            }

            // Authenticate ONLY when a token is actually configured. On a public
            // repo this stays off entirely.
            //
            // WARNING: on a private repo the token below ships in plain text to
            // every merchant. See the HSBT_GITHUB_TOKEN definition above.
            if (HSBT_GITHUB_TOKEN !== '' && method_exists($update_checker, 'setAuthentication')) {
                $update_checker->setAuthentication(HSBT_GITHUB_TOKEN);
            }
        }

        /**
         * Allow WordPress background auto-updates ONLY for patch releases of THIS
         * plugin (same MAJOR and same MINOR, e.g. 1.4.2 -> 1.4.3).
         *
         * Why so conservative: this is a live payment gateway running on ~10
         * stores. A bad minor/major that silently auto-installs could break
         * checkout on every one of them with no human in the loop. So we opt in
         * to patch releases only, and leave WordPress's default completely
         * untouched for every other plugin.
         *
         * @param bool|null $update Whether to auto-update. Returned unchanged for
         *                          any plugin that is not ours.
         * @param object    $item   The update offer object.
         * @return bool|null
         */
        public static function filter_auto_update($update, $item) {
            // Only ever influence THIS plugin - never change anyone else's default.
            if (!is_object($item) || empty($item->slug) || $item->slug !== self::SLUG) {
                return $update;
            }

            $current = defined('HSBT_VERSION') ? HSBT_VERSION : '';
            $new     = isset($item->new_version) ? $item->new_version : '';

            // Can't reason about it safely -> defer to the existing default.
            if ($current === '' || $new === '') {
                return $update;
            }

            $current_parts = explode('.', $current);
            $new_parts     = explode('.', $new);

            // Need at least MAJOR.MINOR on both sides to compare.
            if (count($current_parts) < 2 || count($new_parts) < 2) {
                return $update;
            }

            $same_major = $current_parts[0] === $new_parts[0];
            $same_minor = $current_parts[1] === $new_parts[1];

            // Patch release (major & minor unchanged) that is genuinely newer ->
            // auto-update. Anything else (minor/major bump) is blocked so a human
            // ships it deliberately.
            if ($same_major && $same_minor && version_compare($new, $current, '>')) {
                return true;
            }

            return false;
        }

        /**
         * Forward-only upgrade routine.
         *
         * Runs migrations once when the stored version is older than the code
         * version, then records the new version. It NEVER deletes an existing
         * option - merchants have live gateway settings keyed to those options.
         *
         * @return void
         */
        public static function maybe_upgrade() {
            $code_version      = defined('HSBT_VERSION') ? HSBT_VERSION : '0.0.0';
            $installed_version = get_option(self::VERSION_OPTION, '');

            // First install (nothing stored): record the version, nothing to migrate.
            if ($installed_version === '') {
                update_option(self::VERSION_OPTION, $code_version);
                return;
            }

            // Already current (or somehow ahead): nothing to do.
            if (version_compare($installed_version, $code_version, '>=')) {
                return;
            }

            /*
             * -----------------------------------------------------------------
             * MIGRATIONS (intentionally empty for now).
             *
             * Add forward-only, additive steps here as the schema evolves, e.g.:
             *
             *   if (version_compare($installed_version, '0.3.0', '<')) {
             *       // add a new option or backfill a value - never delete one.
             *   }
             *
             * RULES:
             *   - Only ADD or UPDATE options. Never delete an existing option key;
             *     merchants have live gateway settings keyed to them.
             *   - Keep each step idempotent and guarded by a version_compare().
             * -----------------------------------------------------------------
             */

            // Record the version we have now migrated up to.
            update_option(self::VERSION_OPTION, $code_version);
        }
    }

    HSBT_Updater::init();
}
