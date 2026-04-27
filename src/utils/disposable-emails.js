// Disposable email blocklist.
//
// Curated list of the most common throwaway providers. We don't try to be
// comprehensive — bigger lists get out of date fast — but blocking the top
// ~100 cuts most automated abuse without false positives on real customers.
//
// Sources: cross-referenced from disposable-email-domains, mailcheck.io,
// and our own observed signup patterns.
//
// Maintenance: add a domain when we see automated abuse from it. Don't
// remove unless a paying customer is blocked.

const DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com',
  '33mail.com', '6paq.com',
  'asdasd.ru',
  'binkmail.com',
  'cock.li', 'cool.fr.nf',
  'deadaddress.com', 'despam.it', 'dispostable.com',
  'dodgeit.com', 'dodgit.com', 'dump-email.info',
  'easytrashmail.com',
  'fakeinbox.com', 'fastacura.com', 'fastemail.us',
  'getairmail.com', 'getnada.com', 'guerrillamail.com', 'guerrillamail.de',
  'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamail.biz', 'guerrillamailblock.com', 'mailnesia.com',
  'inboxalias.com', 'inboxbear.com',
  'jetable.com', 'jetable.fr.nf', 'jetable.org', 'jetable.net',
  'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailinator.net',
  'mailinator.org', 'mailmetrash.com', 'mailmoat.com', 'mailnator.com',
  'mailnesia.com', 'mailtemp.info', 'mailtothis.com', 'mintemail.com',
  'moakt.com', 'mohmal.com', 'mt2014.com', 'mvrht.com',
  'mytemp.email', 'mytrashmail.com',
  'nada.email', 'nada.ltd', 'noclickemail.com', 'no-spam.ws',
  'nowmymail.com',
  'onemoremail.com', 'one-time.email',
  'pookmail.com',
  'rmqkr.net', 'rppkn.com',
  'sharklasers.com', 'shitmail.me', 'sneakemail.com', 'sneakmail.de',
  'spam4.me', 'spambog.com', 'spambog.de', 'spambog.ru', 'spambox.org',
  'spambox.us', 'spamfree24.com', 'spamfree24.de', 'spamfree24.eu',
  'spamfree24.info', 'spamfree24.net', 'spamfree24.org', 'spamgourmet.com',
  'spamhole.com', 'spaminator.de', 'spamspot.com', 'spamthis.co.uk',
  'spamthisplease.com',
  'tempail.com', 'tempemail.co.za', 'tempemail.com', 'tempemail.net',
  'tempemailaddress.com', 'tempinbox.co.uk', 'tempinbox.com', 'tempmail.de',
  'tempmail.eu', 'tempmail.io', 'tempmail.org', 'tempmail.us', 'tempmail2.com',
  'tempmaildemand.com', 'tempmailer.com', 'tempmailo.com', 'tempmailaddress.com',
  'tempr.email', 'temp-mail.org', 'temp-mail.io', 'thankyou2010.com',
  'thisisnotmyrealemail.com', 'throwam.com', 'throwawayemailaddress.com',
  'throwawaymail.com', 'tmail.ws', 'tmailinator.com', 'trashmail.com',
  'trashmail.de', 'trashmail.net', 'trashmail.org', 'trbvm.com', 'tyldd.com',
  'wegwerfemail.com', 'wegwerfemail.de', 'wh4f.org', 'whyspam.me',
  'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'zetmail.com', 'zoemail.com',
]);

/**
 * True if the email's domain is in our blocklist. Case-insensitive.
 * Returns false for malformed emails — let the caller validate format.
 */
function isDisposable(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return DOMAINS.has(domain);
}

module.exports = { isDisposable, DOMAINS };
