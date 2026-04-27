=== Hitrapost Connector ===
Contributors: hitrapost
Tags: crm, leads, contact form, webhook, hitrapost
Requires at least: 5.6
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Forwards form submissions from Contact Form 7, WPForms, Gravity Forms, Ninja Forms, and Elementor Pro to your Hitrapost CRM.

== Description ==

Every time someone submits a form on your WordPress site, this plugin POSTs the
submission to your Hitrapost workspace as a new lead. No email parsing, no
zaps, no manual copy-paste.

Supported form plugins (auto-detected — install whichever you already use):

* Contact Form 7
* WPForms (Lite or Pro)
* Gravity Forms
* Ninja Forms
* Elementor Pro forms

== Setup ==

1. Sign in to https://hitrapost.co.uk
2. Settings → Intake webhook → copy your intake URL
3. In WordPress: Settings → Hitrapost → paste the URL → Save
4. Submit a test form. The lead should appear in Hitrapost within seconds with
   a "WordPress" source chip.

== Frequently Asked Questions ==

= How are fields mapped? =

The plugin tries common field labels (name, your-name, full_name; email,
your-email; phone, tel, mobile; message, comments, body) and forwards every
scalar field on the form. The Hitrapost intake endpoint is forgiving — see
the docs at https://hitrapost.co.uk/docs/intake.

= What happens to fields the plugin doesn't recognise? =

They're attached to the lead's activity log so nothing is lost.

= Does this slow down form submission? =

No. The HTTP request is fire-and-forget (`blocking => false`).

= How do I rotate the URL if it leaks? =

In Hitrapost: Settings → Intake webhook → Rotate token. Then paste the new URL
into the plugin settings.

== Changelog ==

= 1.0.0 =
* Initial release. Hooks Contact Form 7, WPForms, Gravity, Ninja, Elementor Pro.
