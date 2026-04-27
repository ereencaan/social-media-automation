# Hitrapost WordPress Connector

A drop-in WordPress plugin that forwards form submissions (Contact Form 7,
WPForms, Gravity Forms, Ninja Forms, Elementor Pro) to a Hitrapost workspace
as new leads.

## Build & distribute

The plugin is a single-folder WordPress plugin. To produce a distributable zip:

```bash
cd integrations/wordpress-plugin
zip -r hitrapost-connector-1.0.0.zip hitrapost-connector \
  -x "*.DS_Store" -x "*/.*"
```

Upload the zip via the WordPress admin (Plugins → Add new → Upload plugin),
or list it on https://wordpress.org/plugins/ via the standard SVN submission.

## Manual install (development)

```bash
# On the target WordPress server:
cp -R integrations/wordpress-plugin/hitrapost-connector /path/to/wordpress/wp-content/plugins/
```

Then activate via Plugins → Installed Plugins.

## How it works

* On plugin activation: nothing — the plugin lazy-registers form hooks.
* When the user pastes their intake URL under Settings → Hitrapost, the URL
  is stored in `wp_options.hitrapost_intake_url`.
* Each supported form plugin is hooked at its "submission complete" event:
  - Contact Form 7  → `wpcf7_mail_sent`
  - WPForms         → `wpforms_process_complete`
  - Gravity Forms   → `gform_after_submission`
  - Ninja Forms     → `ninja_forms_after_submission`
  - Elementor Pro   → `elementor_pro/forms/new_record`
* Each handler normalizes the form fields (name / email / phone / message)
  and POSTs JSON to the configured intake URL via `wp_remote_post(...,
  ['blocking' => false])` — fire-and-forget, no impact on form latency.
* The `source` field in the payload uses one of `wp_cf7`, `wpforms`,
  `gravity`, `ninja`, `elementor`. Hitrapost normalizes all of these to the
  single `wordpress_form` chip via `SOURCE_ALIASES` in `intake.service.js`.

## Token rotation

If a token leaks (e.g. someone fork-and-publishes the WordPress site), rotate
in Hitrapost: **Settings → Intake webhook → Rotate token**, then paste the
new URL into the WordPress plugin's settings page. The old URL is rejected
the moment rotation happens.
