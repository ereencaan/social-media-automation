<?php
/**
 * Plugin Name:       Hitrapost Connector
 * Plugin URI:        https://hitrapost.co.uk/connect/wordpress
 * Description:       Forwards form submissions (Contact Form 7, WPForms, Gravity Forms, Ninja Forms, Elementor) to your Hitrapost CRM.
 * Version:           1.0.0
 * Author:            Hitrapost
 * Author URI:        https://hitrapost.co.uk
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Text Domain:       hitrapost-connector
 *
 * Sends form submissions to POST <intake URL>/api/intake/<token>. Token is
 * configured under Settings → Hitrapost. We POST application/json with the
 * fields `name`, `email`, `phone`, `message`, `source`, plus the raw form
 * payload. The Hitrapost intake endpoint is forgiving on field names — see
 * src/services/intake.service.js for the full alias list.
 */

if (!defined('ABSPATH')) { exit; }

define('HITRAPOST_OPTION_KEY', 'hitrapost_intake_url');
define('HITRAPOST_VERSION', '1.0.0');

// =============================================================================
//   Settings page
// =============================================================================

add_action('admin_menu', function () {
    add_options_page(
        __('Hitrapost', 'hitrapost-connector'),
        __('Hitrapost', 'hitrapost-connector'),
        'manage_options',
        'hitrapost-connector',
        'hitrapost_render_settings_page'
    );
});

add_action('admin_init', function () {
    register_setting('hitrapost_settings', HITRAPOST_OPTION_KEY, [
        'type'              => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'default'           => '',
    ]);
});

function hitrapost_render_settings_page() {
    if (!current_user_can('manage_options')) { return; }
    $url = get_option(HITRAPOST_OPTION_KEY, '');
    ?>
    <div class="wrap">
        <h1><?php esc_html_e('Hitrapost Connector', 'hitrapost-connector'); ?></h1>
        <p>
            <?php esc_html_e('Paste your Hitrapost intake URL below. You can find it in Hitrapost under Settings → Intake webhook.', 'hitrapost-connector'); ?>
        </p>
        <form method="post" action="options.php">
            <?php settings_fields('hitrapost_settings'); ?>
            <?php do_settings_sections('hitrapost_settings'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row">
                        <label for="hitrapost_intake_url"><?php esc_html_e('Intake URL', 'hitrapost-connector'); ?></label>
                    </th>
                    <td>
                        <input
                            id="hitrapost_intake_url"
                            name="<?php echo esc_attr(HITRAPOST_OPTION_KEY); ?>"
                            type="url"
                            class="regular-text code"
                            placeholder="https://hitrapost.co.uk/api/intake/abcd1234..."
                            value="<?php echo esc_attr($url); ?>"
                            autocomplete="off"
                        />
                        <p class="description">
                            <?php esc_html_e('The plugin POSTs every form submission to this URL. Until it is set, submissions are not forwarded.', 'hitrapost-connector'); ?>
                        </p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>

        <h2><?php esc_html_e('Status', 'hitrapost-connector'); ?></h2>
        <ul>
            <li>Contact Form 7: <strong><?php echo class_exists('WPCF7') ? '✅ detected' : '— not installed'; ?></strong></li>
            <li>WPForms:        <strong><?php echo function_exists('wpforms') ? '✅ detected' : '— not installed'; ?></strong></li>
            <li>Gravity Forms:  <strong><?php echo class_exists('GFForms') ? '✅ detected' : '— not installed'; ?></strong></li>
            <li>Ninja Forms:    <strong><?php echo class_exists('Ninja_Forms') ? '✅ detected' : '— not installed'; ?></strong></li>
            <li>Elementor Pro:  <strong><?php echo did_action('elementor_pro/init') ? '✅ detected' : '— not installed'; ?></strong></li>
        </ul>
    </div>
    <?php
}

// =============================================================================
//   Core: send a normalized payload to the intake URL
// =============================================================================

/**
 * Forward a normalized payload to the configured Hitrapost intake URL.
 * Silent on missing config so we never break a form submission for a user
 * who hasn't finished setup. Errors are logged via error_log().
 *
 * @param array $fields  Associative — name|email|phone|message all optional,
 *                       at least one must be present.
 * @param string $source One of the SOURCE_ALIASES the server recognises:
 *                       wp_cf7|wpforms|gravity|ninja|elementor (or anything,
 *                       falls through to wordpress_form chip).
 * @param array $raw     The full form payload, attached for the activity log.
 */
function hitrapost_forward(array $fields, string $source, array $raw = []) {
    $url = trim(get_option(HITRAPOST_OPTION_KEY, ''));
    if (empty($url)) { return; }

    $payload = array_merge([
        'source'   => $source,
        'name'     => $fields['name']    ?? null,
        'email'    => $fields['email']   ?? null,
        'phone'    => $fields['phone']   ?? null,
        'message'  => $fields['message'] ?? null,
        'raw'      => $raw,
    ], $fields);

    // Drop nulls — keeps the intake log readable.
    $payload = array_filter($payload, function ($v) { return !is_null($v) && $v !== ''; });

    $response = wp_remote_post($url, [
        'timeout'  => 6,
        'blocking' => false,                // fire-and-forget
        'headers'  => [
            'Content-Type' => 'application/json',
            'User-Agent'   => 'HitrapostConnector/' . HITRAPOST_VERSION . ' WordPress/' . get_bloginfo('version'),
        ],
        'body'     => wp_json_encode($payload),
    ]);

    if (is_wp_error($response)) {
        error_log('[hitrapost] intake POST failed: ' . $response->get_error_message());
    }
}

/** Best-effort field extraction. Looks at common name patterns case-insensitively. */
function hitrapost_extract($map) {
    $lower = [];
    foreach ($map as $k => $v) { $lower[strtolower((string) $k)] = $v; }

    $get = function ($keys) use ($lower) {
        foreach ($keys as $k) {
            if (isset($lower[$k]) && is_scalar($lower[$k]) && trim((string) $lower[$k]) !== '') {
                return trim((string) $lower[$k]);
            }
        }
        return null;
    };

    return [
        'name'    => $get(['your-name', 'name', 'fullname', 'full_name', 'full-name', 'contact', 'contact-name']),
        'email'   => $get(['your-email', 'email', 'email_address', 'emailaddress']),
        'phone'   => $get(['your-phone', 'phone', 'tel', 'mobile', 'phone_number', 'phonenumber']),
        'message' => $get(['your-message', 'message', 'comments', 'comment', 'body', 'text', 'note', 'notes']),
    ];
}

// =============================================================================
//   Contact Form 7
// =============================================================================
add_action('wpcf7_mail_sent', function ($contact_form) {
    if (!class_exists('WPCF7_Submission')) { return; }
    $submission = WPCF7_Submission::get_instance();
    if (!$submission) { return; }
    $data = $submission->get_posted_data();
    if (!is_array($data)) { return; }
    hitrapost_forward(hitrapost_extract($data), 'wp_cf7', $data);
}, 20, 1);

// =============================================================================
//   WPForms
// =============================================================================
add_action('wpforms_process_complete', function ($fields, $entry, $form_data, $entry_id) {
    $flat = [];
    foreach ((array) $fields as $f) {
        // Normalize WPForms field types to canonical names.
        $name = strtolower((string) ($f['name'] ?? ''));
        $val  = $f['value'] ?? '';
        if (is_scalar($val) && $val !== '') {
            // First-class fields: use canonical names; everything else passes
            // through under its label so server-side aliases can pick it up.
            if (!empty($f['type'])) {
                if ($f['type'] === 'name')  { $flat['name']  = $val; }
                if ($f['type'] === 'email') { $flat['email'] = $val; }
                if ($f['type'] === 'phone') { $flat['phone'] = $val; }
                if ($f['type'] === 'textarea' && empty($flat['message'])) { $flat['message'] = $val; }
            }
            $flat[$name] = $val;
        }
    }
    hitrapost_forward(hitrapost_extract($flat), 'wpforms', $flat);
}, 10, 4);

// =============================================================================
//   Gravity Forms
// =============================================================================
add_action('gform_after_submission', function ($entry, $form) {
    $flat = [];
    if (!is_array($form['fields'] ?? null)) { return; }
    foreach ($form['fields'] as $field) {
        $label = strtolower((string) ($field->label ?? ''));
        $val   = rgar($entry, (string) $field->id);
        if (is_scalar($val) && trim((string) $val) !== '') {
            $flat[$label] = $val;
            // Type-aware shortcuts for canonical fields.
            if ($field->type === 'name')   { $flat['name']  = $val; }
            if ($field->type === 'email')  { $flat['email'] = $val; }
            if ($field->type === 'phone')  { $flat['phone'] = $val; }
            if ($field->type === 'textarea' && empty($flat['message'])) { $flat['message'] = $val; }
        }
    }
    hitrapost_forward(hitrapost_extract($flat), 'gravity', $flat);
}, 10, 2);

// =============================================================================
//   Ninja Forms
// =============================================================================
add_action('ninja_forms_after_submission', function ($form_data) {
    $flat = [];
    if (!is_array($form_data['fields'] ?? null)) { return; }
    foreach ($form_data['fields'] as $f) {
        $key = strtolower((string) ($f['key'] ?? ''));
        $val = $f['value'] ?? '';
        if (is_scalar($val) && trim((string) $val) !== '') {
            $flat[$key] = $val;
            // Ninja Forms' default field keys often look like
            // name_1234, email_1234 — try to detect.
            if (strpos($key, 'name')    === 0 && empty($flat['name']))    { $flat['name']    = $val; }
            if (strpos($key, 'email')   === 0 && empty($flat['email']))   { $flat['email']   = $val; }
            if (strpos($key, 'phone')   === 0 && empty($flat['phone']))   { $flat['phone']   = $val; }
            if (strpos($key, 'message') === 0 && empty($flat['message'])) { $flat['message'] = $val; }
        }
    }
    hitrapost_forward(hitrapost_extract($flat), 'ninja', $flat);
}, 10, 1);

// =============================================================================
//   Elementor Pro forms
// =============================================================================
add_action('elementor_pro/forms/new_record', function ($record, $handler) {
    if (!is_object($record)) { return; }
    $raw_fields = $record->get('fields');
    if (!is_array($raw_fields)) { return; }
    $flat = [];
    foreach ($raw_fields as $id => $f) {
        $val = $f['value'] ?? '';
        if (is_scalar($val) && trim((string) $val) !== '') {
            $flat[strtolower((string) $id)] = $val;
        }
    }
    hitrapost_forward(hitrapost_extract($flat), 'elementor', $flat);
}, 10, 2);

// =============================================================================
//   Plugin uninstall — clear the option
// =============================================================================
register_uninstall_hook(__FILE__, 'hitrapost_uninstall');
function hitrapost_uninstall() {
    delete_option(HITRAPOST_OPTION_KEY);
}
