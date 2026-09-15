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
      <a href="/legal">Legal</a>
    </nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <p>CHF only · CH shipping · Month-end batch fulfill</p>
    <p><a href="/legal">Impressum / Privacy / AGB</a></p>
  </footer>
</body>
</html>`;
}

export function money(chf) {
  return `CHF ${Number(chf).toFixed(2)}`;
}
