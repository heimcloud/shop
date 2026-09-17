export function layout({ title, body, lang = "de" }) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Heimcloud</title>
  <link rel="stylesheet" href="/css/shop.css" />
</head>
<body>
  <header class="site-header">
    <a class="logo" href="/">Heimcloud</a>
    <nav>
      <a href="/kit">Kit</a>
      <a href="/mini-pc">Mini-PC</a>
      <a href="/services">Services</a>
      <a href="/order">Order</a>
      <a href="/account">Account</a>
      <a href="/legal">Legal</a>
    </nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <p>CHF only · CH shipping · Month-end batch fulfill</p>
    <p><a href="/legal">Impressum / Privacy / AGB</a> · <a href="mailto:heimcloud@proton.me">heimcloud@proton.me</a></p>
  </footer>
</body>
</html>`;
}

/** Admin pages — same CSS, lean nav under ADMIN_PATH. */
export function adminLayout({ title, body, basePath = "/admin", readOnly = false, lang = "en" }) {
  const base = String(basePath || "/admin").replace(/\/$/, "") || "/admin";
  const ro = readOnly
    ? `<span class="example-tag" title="Mutating forms disabled">read-only</span>`
    : "";
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Admin · Heimcloud</title>
  <link rel="stylesheet" href="/css/shop.css" />
</head>
<body>
  <header class="site-header">
    <a class="logo" href="${base}/">Heimcloud Admin</a>
    <nav>
      <a href="${base}/">Overview</a>
      <a href="${base}/customers">Customers</a>
      <a href="${base}/orders">Orders</a>
      <a href="${base}/entitlements">Entitlements</a>
      <a href="${base}/jobs">Jobs</a>
      <a href="/">Storefront</a>
      ${ro}
    </nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <p>Shop admin · Tinyauth at edge · Storefront remains public</p>
  </footer>
</body>
</html>`;
}

/** Customer account portal — lean nav; separate from Tinyauth admin. */
export function accountLayout({ title, body, lang = "en" }) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Account · Heimcloud</title>
  <link rel="stylesheet" href="/css/shop.css" />
</head>
<body>
  <header class="site-header">
    <a class="logo" href="/account">Heimcloud Account</a>
    <nav>
      <a href="/account">Account</a>
      <a href="/account/ssh">SSH</a>
      <a href="/account/setup">Setup</a>
      <a href="/">Storefront</a>
      <form method="post" action="/account/logout" style="display:inline;margin:0">
        <button type="submit" class="btn secondary" style="padding:0.25rem 0.6rem;font-size:0.85rem">Logout</button>
      </form>
    </nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <p>Customer portal · Magic-link auth · Never paste your private key</p>
    <p><a href="mailto:heimcloud@proton.me">heimcloud@proton.me</a></p>
  </footer>
</body>
</html>`;
}

export function money(chf) {
  return `CHF ${Number(chf).toFixed(2)}`;
}

/** One-time vs monthly display. */
export function moneyLabel(chf, billing = "one_time") {
  const base = money(chf);
  if (billing === "month") return `${base}/mo`;
  return `${base} <span class="muted">one-time</span>`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
